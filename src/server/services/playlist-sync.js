const { callNeteaseApi } = require('./netease-api');
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

async function fetchRemotePlaylist(neteasePlaylistId) {
  const detailResponse = await callNeteaseApi('playlist_detail', { id: neteasePlaylistId });
  const playlist = detailResponse.body?.playlist || {};

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
  const savedPlaylist = upsertPlaylist({
    neteasePlaylistId,
    name: remotePlaylist.name,
    coverImgUrl: remotePlaylist.coverImgUrl,
    creatorNickname: remotePlaylist.creator?.nickname,
    trackCount: remotePlaylist.trackCount || remotePlaylist.tracks?.length || 0,
    source: 'netease',
    isDefault: Boolean(options.isDefault)
  });

  replaceTracksForPlaylist(savedPlaylist.id, remotePlaylist.tracks || []);
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