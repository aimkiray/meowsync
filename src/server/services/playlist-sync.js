const { callNeteaseApi } = require('./netease-api');
const { getDb } = require('../db/client');
const {
  upsertPlaylist,
  findPlaylistById,
  findPlaylistByNeteaseId,
  listPlaylists
} = require('../repositories/playlists');
const {
  replaceTracksForPlaylist,
  listTracksByPlaylistId
} = require('../repositories/playlistTracks');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function fetchRemotePlaylist(neteasePlaylistId) {
  const detailResponse = await callNeteaseApi('playlist_detail', { id: neteasePlaylistId });
  const playlist = detailResponse.body?.playlist;
  // 上游对不存在的 id 也返回 200 + playlist:null——必须区分，否则向 DB 写空名字的脏行
  if (!playlist || typeof playlist !== 'object' || !playlist.name) {
    throw httpError(404, '网易云歌单不存在');
  }

  const trackResponse = await callNeteaseApi('playlist_track_all', {
    id: neteasePlaylistId,
    limit: playlist.trackCount || 1000,
    offset: 0
  });

  return {
    ...playlist,
    tracks: trackResponse.body?.songs || []
  };
}

async function importPlaylistFromNetease(neteasePlaylistId, options = {}) {
  const remotePlaylist = await fetchRemotePlaylist(neteasePlaylistId);

  // 歌单行 + 曲目表两写同事务：中途失败不留"有歌单没曲目"的半导入数据
  const savedPlaylist = getDb().transaction(() => {
    const row = upsertPlaylist({
      neteasePlaylistId,
      name: remotePlaylist.name,
      coverImgUrl: remotePlaylist.coverImgUrl,
      creatorNickname: remotePlaylist.creator?.nickname,
      trackCount: remotePlaylist.trackCount || remotePlaylist.tracks?.length || 0,
      source: 'netease',
      isDefault: Boolean(options.isDefault)
    });
    replaceTracksForPlaylist(row.id, remotePlaylist.tracks || []);
    return row;
  })();

  return getPlaylistDetail(savedPlaylist.id);
}

function getPlaylistDetail(id) {
  const playlist = findPlaylistById(id);
  if (!playlist) return null;
  return {
    ...playlist,
    tracks: listTracksByPlaylistId(id)
  };
}

function getPlaylistDetailByNeteaseId(neteasePlaylistId) {
  const playlist = findPlaylistByNeteaseId(neteasePlaylistId);
  if (!playlist) return null;
  return getPlaylistDetail(playlist.id);
}

function listSavedPlaylists() {
  return listPlaylists();
}

module.exports = {
  importPlaylistFromNetease,
  getPlaylistDetail,
  getPlaylistDetailByNeteaseId,
  listSavedPlaylists
};