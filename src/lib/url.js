// 共享 URL 工具：HTTPS 页面下 http:// 外链（网易图床 *.music.126.net、
// 各解锁源 CDN 等均支持 TLS）会被浏览器混拦为 mixed content——统一升级。
// 仅在 HTTPS 页面升级：纯 HTTP 部署（自托管常态）下服务端回链
// （/audio-proxy?url=... 由 requestOrigin 拼出，scheme 跟随入站请求）就是
// 合法 http 地址，对只讲 HTTP 的源做 TLS 会握手失败；http 页面本就没有混拦
export function httpsCover(url) {
  const s = String(url || '');
  // 非浏览器环境（worker/测试/SSR 复用）同样不升级——对只讲 HTTP 的源做
  // TLS 必然握手失败，未知协议环境下保持原样是更安全的默认
  if (typeof window === 'undefined' || window.location?.protocol !== 'https:') {
    return s;
  }
  return s.replace(/^http:\/\//i, 'https://');
}

// 输入谓词唯一真相源在 src/shared/predicates.js（服务端 require(ESM) 同消费）。
// 此处 re-export 保持既有调用面不变
export {
  SONGMID_RE,
  isSongmidLike,
  isNeteasePlaylist,
  BVID_RE,
  NETEASE_ID_RE,
  NETEASE_ID_BOUNDED_RE,
  QQ_SONG_ID_RE,
  BV_TRACK_ID_RE,
  YT_TRACK_ID_RE,
  YT_ID_RE,
  SINGLE_SONG_PREFIX,
  SAVED_QUEUE_PREFIX,
  LOCAL_PLAYLIST_PREFIX,
  isLocalPlaylistId,
  isEphemeralPlaylistId,
  isSingleSongShellId,
  parseNumericId,
  isBilibiliInput,
  extractBiliFavlistId,
  extractYouTubeId,
  isYouTubeInput,
  isQQInput,
  extractQQPlaylistId,
  pickQqFromUrl,
  extractNeteaseSongId,
} from '../shared/predicates.js';
