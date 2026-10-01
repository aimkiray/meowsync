/**
 * Monkey-patch for @unblockneteasemusic/server migu provider.
 * The old search endpoint (m.music.migu.cn/migu/remoting/scr_search_tag) is defunct.
 * This patch replaces the search function with the new MIGUM3.0 API.
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

// 通过 Node 模块解析定位 migu.js，兼容 pnpm/PnP/嵌套 hoisting 等非扁平布局
function resolveMiguPath() {
  try {
    return require.resolve('@unblockneteasemusic/server/src/provider/migu.js');
  } catch {
    return path.resolve(__dirname, '../../../node_modules/@unblockneteasemusic/server/src/provider/migu.js');
  }
}

const MIGU_PATH = resolveMiguPath();
// Windows 下 _resolveFilename 与 path.resolve 的盘符大小写可能不一致
const normalizePath = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const MIGU_PATH_NORM = normalizePath(MIGU_PATH);
// 兄弟文件（request.js / select.js / cache.js）相对于 migu.js 的实际位置推导
const PROVIDER_DIR = path.dirname(MIGU_PATH); // src/provider

if (!fs.existsSync(MIGU_PATH)) {
  console.warn('[patch-migu] 未找到 migu provider 文件，补丁未生效');
} else try {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const resolved = (() => {
      try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
    })();

    if (resolved === null || normalizePath(resolved) !== MIGU_PATH_NORM) {
      return originalLoad.apply(this, arguments);
    }

    // Return cached patched module if already loaded
    if (Module._cache[resolved]?.patchedByMeowSync) {
      return Module._cache[resolved].exports;
    }

    // Load original module first
    const original = originalLoad.apply(this, arguments);

    try {
      // track 非函数说明上游模块结构已变化（.then(undefined) 会把 search 出的
      // 歌曲 id 错当成 track 结果透传），此时回退原版而非产出半坏补丁
      if (!original || typeof original.track !== 'function') {
        console.warn('[patch-migu] 原模块缺少 track()，结构已变化，补丁未生效');
        // 标记缓存避免之后每次 require 重复告警；early-return 读到的 exports 即 original，语义不变
        if (Module._cache[resolved]) Module._cache[resolved].patchedByMeowSync = true;
        return original;
      }
      const request_ = require(path.join(PROVIDER_DIR, '../request.js'));
      const select = require(path.join(PROVIDER_DIR, 'select.js'));
      const { getManagedCacheStorage } = require(path.join(PROVIDER_DIR, '../cache.js'));

      const headers = {
        channel: '0146921',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 9; MI 9 Build/PKQ1.181121.001) AppleWebKit/537.36',
      };

      const format = (song) => {
        const singers = song.singers || [];
        return {
          id: song.id,
          name: song.name,
          album: { id: (song.albums || [])[0]?.id || '', name: (song.albums || [])[0]?.name || '' },
          artists: singers.map((s) => ({ id: s.id, name: s.name })),
        };
      };

      const search = (info) => {
        const url =
          'https://app.c.nf.migu.cn/MIGUM3.0/v1.0/content/search_all.do?' +
          'text=' + encodeURIComponent(info.keyword) +
          '&pageSize=20&pageNo=1&searchSwitch=%7B%22song%22%3A1%7D';

        return request_('GET', url, headers)
          .then((response) => response.json())
          .then((jsonBody) => {
            const list = ((jsonBody?.songResultData?.result) || []).map(format);
            const matched = select(list, info);
            return matched ? matched.id : Promise.reject(new Error('migu: no match'));
          });
      };

      // Rebuild check with patched search, keep original track
      const cs = getManagedCacheStorage('provider/migu-patched');
      const patchedCheck = (info) => cs.cache(info, () => search(info)).then(original.track);

      const patched = { check: patchedCheck, track: original.track };

      // Replace cached module exports
      if (Module._cache[resolved]) {
        Module._cache[resolved].exports = patched;
        Module._cache[resolved].patchedByMeowSync = true;
      }

      return patched;
    } catch (error) {
      // 上游内部结构变化导致补丁失败时回退原版，不阻断启动
      console.warn('[patch-migu] 补丁应用失败，回退原版 migu provider:', error.message);
      // 同上：标记已处理，后续 require 直接短路返回原始 exports
      if (Module._cache[resolved]) Module._cache[resolved].patchedByMeowSync = true;
      return original;
    }
  };
} catch (error) {
  console.warn('[patch-migu] 补丁注册失败:', error.message);
}
