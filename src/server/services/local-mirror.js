// 本地歌单（local_pl_*/saved_queue_*）镜像落库：客户端 tracks 活在 localStorage，
// 服务端下载要落 playlist_tracks 才有持久行可消费。upsert + 整表替换同事务，
// 内容签名未变时跳过重写（行级下载每首都重镜像，无短路会是 O(N) 写放大）
const { getDb } = require('../db/client');
const playlistsRepo = require('../repositories/playlists');
const playlistTracksRepo = require('../repositories/playlistTracks');
const { deletingPlaylists, isNeteasePlaylistDeleting } = require('../lib/deletion-locks');
const { httpError } = require('../lib/http-error');
const {
  QQ_SONG_ID_RE, BV_TRACK_ID_RE, YT_TRACK_ID_RE,
  SONGMID_RE, BVID_RE, YT_ID_RE, NETEASE_ID_RE
} = require('../../shared/predicates.js');

// 来源侧日期合法性窗（规格要求各文件就地实现同一公式）：
//   下限 2000-01-01（YT 2005/B 站 2009 上线前不存在真发布日，再早必脏）；
//   上限 now+24h（容忍时钟偏差；真实未来首播/预售超出此界按未知处理——
//   发布日尚在未来极罕见的视频此刻也播不了，损失可忽略）
const sanePublishMs = (v) => {
  const ms = Number(v);
  return Number.isFinite(ms) && ms >= 946684800000 && ms <= Date.now() + 86400e3 ? ms : 0;
};

// 上载曲投影的白名单消毒：只留服务端可下载的曲目——网易云数字 id +
// qq_<songmid>/bv_<bvid>[_pN]/yt_<videoId> 自有源前缀；其余形态计入 skipped
// 让前端提示，不整单 400。字段逐位收窄（ar 只留 {name}、provider 只收流定位
// 与词源字段）防任意对象整只落 raw_json。
// 镜像路由与远端单 localDelta 建队共用同一份——先过滤后截断：
// 前 2000 个可下载曲进入结果；skipped=不支持 id 数，truncated=超上限截尾数
function sanitizeMirrorTracks(allTracks) {
  const numeric = allTracks.filter(t => t && (/^\d+$/.test(String(t.id ?? ''))
    || QQ_SONG_ID_RE.test(String(t.id ?? ''))
    || BV_TRACK_ID_RE.test(String(t.id ?? ''))
    || YT_TRACK_ID_RE.test(String(t.id ?? ''))));
  const tracks = numeric.slice(0, 2000)
    .map(t => ({
      id: String(t.id),
      name: String(t.name || '未知歌曲').slice(0, 200),
      // ar 收窄成 {name} 标量组——客户端投影同口径；任意形状对象不该整只落 raw_json
      ar: (Array.isArray(t.ar || t.artists) ? (t.ar || t.artists) : [])
        .slice(0, 20)
        .map(a => ({ name: String(typeof a === 'string' ? a : a?.name ?? '').slice(0, 200) })),
      al: (t.al && typeof t.al === 'object') ? t.al
        : (t.album && typeof t.album === 'object') ? t.album : {},
      dt: Number.isFinite(+t.dt) ? +t.dt : (+t.duration || 0),
      // qq 源私有字段只收 mediaMid（vkey filename 键）+ publishedAt（发行日
      // 证据——与 bv/yt 同轴，providerData/签名域都吃）——其余下载链用不上；
      // 形态校验防任意对象进 raw_json
      ...(t.qq && SONGMID_RE.test(String(t.qq.mediaMid || ''))
        ? { qq: {
            mediaMid: String(t.qq.mediaMid),
            publishedAt: sanePublishMs(t.qq.publishedAt) || null
          } } : {}),
      // bv_/yt_ 曲同理只收流定位字段（bvid/cid/page、videoId）+ neteaseId
      // 词源 + title/author——下载链的歌词归属核验要靠来源标题与作者
      // 构造 verdict 签名，不整只落 provider 对象
      ...(t.bilibili && BVID_RE.test(String(t.bilibili.bvid || ''))
        ? { bilibili: {
            bvid: String(t.bilibili.bvid),
            cid: /^\d+$/.test(String(t.bilibili.cid ?? '')) ? String(t.bilibili.cid) : null,
            page: Math.max(1, parseInt(t.bilibili.page, 10) || 1),
            title: String(t.bilibili.title || '').slice(0, 300) || null,
            author: String(t.bilibili.author || '').slice(0, 120) || null,
            // 发布日（epoch ms）入签名域——缺席/脏值归 null 不落 0 键，
            // 与 title/author 的缺席归 null 同口径
            publishedAt: sanePublishMs(t.bilibili.publishedAt) || null
          } } : {}),
      ...(t.youtube && YT_ID_RE.test(String(t.youtube.videoId || ''))
        ? { youtube: {
            videoId: String(t.youtube.videoId),
            title: String(t.youtube.title || '').slice(0, 300) || null,
            author: String(t.youtube.author || '').slice(0, 120) || null,
            publishedAt: sanePublishMs(t.youtube.publishedAt) || null
          } } : {}),
      ...(NETEASE_ID_RE.test(String(t.neteaseId ?? ''))
        ? { neteaseId: String(t.neteaseId) } : {})
    }));
  return { tracks, skipped: allTracks.length - numeric.length, truncated: numeric.length - tracks.length };
}

/**
 * @returns {object} 镜像歌单行（{id, netease_playlist_id, ...}）
 * @throws {httpError} 409 歌单正在删除中（墓碑窗口内重导撞上）
 */
function mirrorLocalPlaylist(localId, name, coverImgUrl, tracks) {
  const db = getDb();
  return db.transaction(() => {
    // 墓碑复查收敛在服务层：路由层前置检查（downloads.js mirror 路由）与本写
    // 之间一旦插入 await/新增调用方就开窗——行删后 upsert 以同 netease id 复活
    // 新行，路由的检查点与下面的行 id 复查都够不着这个复活窗。
    // 注意：对 local_pl_*/saved_queue_* 本地 id 这句墓碑检查恒 false——
    // deletePlaylistCascade 只为纯数字 netease id 立碑（其 NETEASE_ID_RE 闸），
    // 本地命名空间永远查不到墓碑；留着它作纵深无害。真正的复活防线是下方
    // 行 id 复查，其成立押在一条承重不变量上：
    //   deletePlaylistCascade 的行删 db.transaction() 提交 → finally 释放
    //   deletingPlaylists 锁之间永不许插 await（文件清扫已异步化为分离
    //   Promise.resolve().then 调度——不占同步段，不变量仍成立）。一旦该段出现挂起点，本事务可在「旧行已删、锁未放」的
    //   窗口里以新本地 id 复活行且复查放行——本检查随之整体失效
    if (isNeteasePlaylistDeleting(localId)) throw httpError(409, '该歌单正在删除中');
    const row = playlistsRepo.upsertPlaylist({
      neteasePlaylistId: localId,
      name,
      coverImgUrl,
      creatorNickname: '本地歌单',
      trackCount: tracks.length,
      source: 'local'
    });
    if (!row) throw httpError(500, '镜像歌单写入失败');
    // 墓碑前置检查后，本地 id 级联拿的新行仍可能正被删——事务内按内部行 id 复查。
    // 复查在 upsert 之后：锁内跑镜像时行还在（级联事务未提交），upsert 命中
    // 既有行原 id 返回——has(row.id) 真实命中级联锁；若行已删完，upsert 会以
    // 新本地 id 复活新行，has(新 id) 查不到旧锁——这正是上方不变量要堵的窗
    if (deletingPlaylists.has(row.id)) throw httpError(409, '该歌单正在删除中');
    // mediaMid/bvid/videoId/neteaseId 入签名：老镜像（无 provider 字段）重传
    // 时触发一次重写补写源定位与词源元数据。
    // ar/al 同样入签名——歌手/专辑改了不重写会让旧名滞留 raw_json
    // （下载文件名取 artist，旧名落盘）。JSON 串而非分隔符拼接——艺术家名含
    // , / : 会撞签（"Earth, Wind & Fire" vs ["Earth","Wind & Fire"]）
    const sigOf = (t) => JSON.stringify([
      t.id, t.name,
      (t.ar || []).map(a => typeof a === 'string' ? a : a?.name || ''),
      typeof t.al === 'string' ? t.al : t.al?.name || '',
      // 封面独立入签——picUrl 变而 al.name 不变时单靠专辑名会漏重写
      (t.al && typeof t.al === 'object') ? (t.al.picUrl || t.al.pic_str || '') : '',
      t.dt || 0, t.qq?.mediaMid || '',
      t.bilibili?.bvid || '', t.bilibili?.cid || '', t.bilibili?.page || 0,
      // 来源 title/author 入签：老镜像重传触发一次重写补齐——下载链的
      // 歌词归属核验靠它们构造 verdict 签名
      t.bilibili?.title || '', t.bilibili?.author || '',
      t.youtube?.videoId || '',
      t.youtube?.title || '', t.youtube?.author || '',
      // 发布日入签名域：老镜像库里 provider 块没有该字段时签名变化，下次
      // 客户端带新字段重传触发一次性重写自愈（publishedAt 从无到有落
      // raw_json）；双方同缺席同得 0 不扰动既有签名
      t.qq?.publishedAt || 0,
      t.bilibili?.publishedAt || 0,
      t.youtube?.publishedAt || 0,
      t.neteaseId || ''
    ]);
    const existing = playlistTracksRepo.listTracksByPlaylistId(row.id);
    const unchanged = existing.length === tracks.length
      && existing.every((t, i) => sigOf(t) === sigOf(tracks[i]));
    if (!unchanged) playlistTracksRepo.replaceTracksForPlaylist(row.id, tracks);
    return row;
  })();
}

module.exports = { mirrorLocalPlaylist, sanitizeMirrorTracks };
