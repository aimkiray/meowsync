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
    // mediaMid 入签名：老镜像（无 qq 字段）重传时触发一次重写补写 provider 元数据
    const sigOf = (t) => `${t.id}:${t.name}:${t.dt || 0}:${t.qq?.mediaMid || ''}`;
    const existing = playlistTracksRepo.listTracksByPlaylistId(row.id);
    const unchanged = existing.length === tracks.length
      && existing.every((t, i) => sigOf(t) === sigOf(tracks[i]));
    if (!unchanged) playlistTracksRepo.replaceTracksForPlaylist(row.id, tracks);
    return row;
  })();
}

module.exports = { mirrorLocalPlaylist };
