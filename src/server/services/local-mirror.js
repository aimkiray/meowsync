// 本地歌单（local_pl_*/saved_queue_*）镜像落库：客户端 tracks 活在 localStorage，
// 服务端下载要落 playlist_tracks 才有持久行可消费。upsert + 整表替换同事务，
// 内容签名未变时跳过重写（行级下载每首都重镜像，无短路会是 O(N) 写放大）
const { getDb } = require('../db/client');
const playlistsRepo = require('../repositories/playlists');
const playlistTracksRepo = require('../repositories/playlistTracks');
const { deletingPlaylists, isNeteasePlaylistDeleting } = require('../lib/deletion-locks');
const { httpError } = require('../lib/http-error');

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
    //   deletingPlaylists 锁之间永不许插 await（当前 cleanupPlaylistFilesAndDirs
    //   同步收尾）。一旦该段出现挂起点，本事务可在「旧行已删、锁未放」的
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
      t.neteaseId || ''
    ]);
    const existing = playlistTracksRepo.listTracksByPlaylistId(row.id);
    const unchanged = existing.length === tracks.length
      && existing.every((t, i) => sigOf(t) === sigOf(tracks[i]));
    if (!unchanged) playlistTracksRepo.replaceTracksForPlaylist(row.id, tracks);
    return row;
  })();
}

module.exports = { mirrorLocalPlaylist };
