const { callNeteaseApi } = require('./netease-api');
const { getDb } = require('../db/client');
const {
  upsertPlaylist,
  findPlaylistById,
  listPlaylists
} = require('../repositories/playlists');
const {
  replaceTracksForPlaylist,
  listTracksByPlaylistId
} = require('../repositories/playlistTracks');
const { httpError } = require('../lib/http-error');
const { deletingPlaylists, isNeteasePlaylistDeleting, beginNeteasePlaylistImport, endNeteasePlaylistImport } = require('../lib/deletion-locks');
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

  // trackIds 是上游返回的完整曲目清单（含付费/无版权曲目的 id），trackCount
  // 只是展示计数（会滞后）。playlist_track_all 内部实现是 trackIds.slice(
  // offset, offset+limit) 后单次 song/detail——limit 传大值会把上千 id 塞进
  // 一个请求被上游 400 拒掉，传 trackCount 又会在漂移时截断尾部。
  // 因此这里直接用 trackIds 自己按 500/批走 song_detail：长度无上限、
  // 顺序权威、天然无缺失
  const trackIds = Array.isArray(playlist.trackIds)
    ? playlist.trackIds.map(t => t?.id).filter(id => Number.isInteger(id))
    : null;

  let songs;
  if (trackIds && trackIds.length === 0) {
    // 空歌单：trackIds 权威为空就不必再跑 track_all 的上游往返
    songs = [];
  } else if (trackIds) {
    const byId = new Map();
    for (let i = 0; i < trackIds.length; i += 500) {
      const chunkResp = await callUpstream('song_detail', {
        ids: trackIds.slice(i, i + 500).join(',')
      }, { timeoutMs: 120000 });
      const chunkSongs = chunkResp.body?.songs;
      // 与 track_all 同款的 resolve-200 陷阱：不校验 code 会把瞬时失败
      // 写成"这些歌不存在"并清空对应曲目（refresh 路径最危险）
      if (chunkResp.body?.code !== 200 || !Array.isArray(chunkSongs)) {
        throw httpError(502, `网易云曲目接口返回异常（第 ${i / 500 + 1} 批，code=${chunkResp.body?.code ?? '未知'}）`);
      }
      for (const s of chunkSongs) {
        if (s && s.id != null && !byId.has(s.id)) byId.set(s.id, s);
      }
    }
    // 按 trackIds 权威顺序重建；被版权过滤的歌在上游 detail 里缺席，保持缺席
    songs = trackIds.map(id => byId.get(id)).filter(Boolean);
    // code:200 但全空/大比例缺失更像上游瞬时故障而非版权剔除——全空直接
    // 判失败（否则 refresh 会把整个歌单清成 0 行），部分缺失仅告警
    if (songs.length === 0) {
      throw httpError(502, '网易云曲目接口返回空列表（疑似上游故障）');
    }
    if (songs.length < trackIds.length) {
      console.warn(`[playlist] 曲目对账缺失: 歌单 ${neteasePlaylistId} 应有 ${trackIds.length} 首，实际 ${songs.length} 首`);
    }
  } else {
    // trackIds 缺失的兼容路径：退回 track_all。limit 是内部 slice 上限——
    // 大值会把全部 id 塞进单个 song/detail 请求被上游 400 拒，保持默认页大小
    const trackResponse = await callUpstream('playlist_track_all', {
      id: neteasePlaylistId,
      limit: 1000,
      offset: 0
    }, { timeoutMs: 120000 });

    songs = trackResponse.body?.songs;
    if (trackResponse.body?.code !== 200 || !Array.isArray(songs)) {
      throw httpError(502, `网易云曲目接口返回异常（code=${trackResponse.body?.code ?? '未知'}）`);
    }
  }

  return {
    ...playlist,
    // track_count 反映实际落库行数而非上游展示计数——两者漂移时
    // 本地统计才是前端"已下载 x/y"的分母真值
    trackCount: songs.length,
    tracks: songs
  };
}

async function importPlaylistFromNetease(neteasePlaylistId, options = {}) {
  // 在途登记先于上游往返：多腿串行抓取可远超墓碑 TTL——删除方在此期间落的
  // 墓碑靠本计数续命到导入结束，"删除先于在途 fetch 返回→复活行"的窗口被
  // 结构性关死（原 130s 固定 TTL 对千曲歌单不够用）
  beginNeteasePlaylistImport(neteasePlaylistId);
  try {
  const remotePlaylist = await fetchRemotePlaylist(neteasePlaylistId);

  // 歌单行 + 曲目表两写同事务：中途失败不留"有歌单没曲目"的半导入数据。
  // 删除锁在事务内复查：路由层的前置检查与本写之间隔了上游往返（秒级），
  // 删除可能在此期间开始——upsert 会把已删歌单复活。deletingPlaylists 按本地
  // id（行还在时有效），deletingNeteasePlaylists 按网易云 id（行删后新行也拦）
  const savedPlaylist = getDb().transaction(() => {
    // 墓碑复查必须在 upsert 之前：删除锁按本地 id 记，而 upsert 以
    // netease_playlist_id 冲突键复活新行——先查 netease 墓碑再写
    if (isNeteasePlaylistDeleting(neteasePlaylistId)) {
      throw httpError(409, '该歌单正在删除中');
    }
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

  const detail = getPlaylistDetail(savedPlaylist.id);
  // 提交后与回读之间可能插入级联删除（墓碑生命周期不覆盖此窗口）——
  // 行已不在时返回 404 而非 200 + playlist:null
  if (!detail) {
    throw httpError(404, '歌单在导入后被删除');
  }
  return detail;
  } finally {
    endNeteasePlaylistImport(neteasePlaylistId);
  }
}

function getPlaylistDetail(id) {
  const playlist = findPlaylistById(id);
  if (!playlist) return null;
  return {
    ...playlist,
    tracks: listTracksByPlaylistId(id)
  };
}

function listSavedPlaylists() {
  return listPlaylists();
}

module.exports = {
  importPlaylistFromNetease,
  getPlaylistDetail,
  listSavedPlaylists
};