// 本地歌单（local_pl_*/saved_queue_*）镜像落库：客户端 tracks 活在 localStorage，
// 服务端下载要落 playlist_tracks 才有持久行可消费。upsert + 整表替换同事务，
// 内容签名未变时跳过重写（行级下载每首都重镜像，无短路会是 O(N) 写放大）
const { getDb } = require('../db/client');
const playlistsRepo = require('../repositories/playlists');
const playlistTracksRepo = require('../repositories/playlistTracks');
const { deletingPlaylists } = require('../lib/deletion-locks');
const { httpError } = require('../lib/http-error');

/**
 * @returns {object} 镜像歌单行（{id, netease_playlist_id, ...}）
 * @throws {httpError} 409 歌单正在删除中（墓碑窗口内重导撞上）
 */
function mirrorLocalPlaylist(localId, name, coverImgUrl, tracks) {
  const db = getDb();
  return db.transaction(() => {
    const row = playlistsRepo.upsertPlaylist({
      neteasePlaylistId: localId,
      name,
      coverImgUrl,
      creatorNickname: '本地歌单',
      trackCount: tracks.length,
      source: 'local'
    });
    if (!row) throw httpError(500, '镜像歌单写入失败');
    // 墓碑前置检查后，本地 id 级联拿的新行仍可能正被删——事务内按内部行 id 复查
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
