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
const { httpError } = require('../lib/http-error');

// callNeteaseApi 对上游非 200 是 reject(answer{status,body,cookie})——不是 Error、
// 不带 exposed 标记。冒泡到路由层会被一律压成 500"服务器错误"，丢失"上游拒绝/
// 限流"的语义。归一化为 502 并带上 body.msg（注意不碰 body.cookie——那是登录态）
async function callUpstream(apiName, params) {
  try {
    return await callNeteaseApi(apiName, params);
  } catch (error) {
    const upstreamMsg = error?.body?.msg || error?.body?.message || error?.message;
    const detail = upstreamMsg && String(upstreamMsg).length < 120 ? `：${upstreamMsg}` : '';
    throw httpError(502, `网易云接口请求失败${detail}`);
  }
}

async function fetchRemotePlaylist(neteasePlaylistId) {
  const detailResponse = await callUpstream('playlist_detail', { id: neteasePlaylistId });
  const playlist = detailResponse.body?.playlist;
  // 上游对不存在的 id 也返回 200 + playlist:null——必须区分，否则向 DB 写空名字的脏行
  if (!playlist || typeof playlist !== 'object' || !playlist.name) {
    throw httpError(404, '网易云歌单不存在');
  }

  const trackResponse = await callUpstream('playlist_track_all', {
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