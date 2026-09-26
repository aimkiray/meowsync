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
const { deletingPlaylists } = require('../lib/deletion-locks');
const { stripAbsolutePaths } = require('../lib/sanitize');

// callNeteaseApi 对上游非 200 是 reject(answer{status,body,cookie})——不是 Error、
// 不带 exposed 标记。冒泡到路由层会被一律压成 500"服务器错误"，丢失"上游拒绝/
// 限流"的语义。归一化为 502 并带上 body.msg（注意不碰 body.cookie——那是登录态）
async function callUpstream(apiName, params, options = {}) {
  try {
    return await callNeteaseApi(apiName, params, options);
  } catch (error) {
    // body.msg 可能是 Error 对象（上游 axios 失败路径），只取其 message；
    // 字符串消息可能带服务器绝对路径（fs ENOENT 等）——剥掉再透出
    let upstreamMsg = error?.body?.msg || error?.body?.message || error?.message;
    if (upstreamMsg && typeof upstreamMsg === 'object') upstreamMsg = upstreamMsg.message;
    upstreamMsg = stripAbsolutePaths(upstreamMsg);
    const detail = upstreamMsg && upstreamMsg.length < 120 ? `：${upstreamMsg}` : '';
    throw httpError(502, `网易云接口请求失败${detail}`);
  }
}

async function fetchRemotePlaylist(neteasePlaylistId) {
  // 大歌单（千曲级）上游往返慢于通用 30s 上限——detail/track_all 放宽到 120s
  const detailResponse = await callUpstream('playlist_detail', { id: neteasePlaylistId }, { timeoutMs: 120000 });
  const playlist = detailResponse.body?.playlist;
  // 上游对不存在的 id 也返回 200 + playlist:null——必须区分，否则向 DB 写空名字的脏行。
  // code 非 200 的 resolve 路径同上：先判业务码再判对象，错误语义才不乱
  if (detailResponse.body?.code !== undefined && detailResponse.body.code !== 200) {
    throw httpError(502, `网易云歌单接口返回异常（code=${detailResponse.body.code}）`);
  }
  if (!playlist || typeof playlist !== 'object' || !playlist.name) {
    throw httpError(404, '网易云歌单不存在');
  }

  const trackResponse = await callUpstream('playlist_track_all', {
    id: neteasePlaylistId,
    limit: playlist.trackCount || 1000,
    offset: 0
  }, { timeoutMs: 120000 });

  // 上游对某些错误码（460/502 等被 request 层映射成 HTTP 200）走 resolve 而非
  // reject——callUpstream 的 catch 拦不到。不校验 code 就 || [] 会把瞬时失败
  // 写成"歌单有 0 首歌"并清空本地曲目（refresh 路径最危险）
  const songs = trackResponse.body?.songs;
  if (trackResponse.body?.code !== 200 || !Array.isArray(songs)) {
    throw httpError(502, `网易云曲目接口返回异常（code=${trackResponse.body?.code ?? '未知'}）`);
  }

  return {
    ...playlist,
    tracks: songs
  };
}

async function importPlaylistFromNetease(neteasePlaylistId, options = {}) {
  const remotePlaylist = await fetchRemotePlaylist(neteasePlaylistId);

  // 歌单行 + 曲目表两写同事务：中途失败不留"有歌单没曲目"的半导入数据。
  // 删除锁在事务内复查：路由层的前置检查与本写之间隔了上游往返（秒级），
  // 删除可能在此期间开始——upsert 会把已删歌单复活。单线程下本事务与级联
  // 的删除事务天然串行，这里看到锁说明级联已启动，放弃写入
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
    if (deletingPlaylists.has(row.id)) {
      throw httpError(409, '该歌单正在删除中');
    }
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