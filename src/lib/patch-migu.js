/**
 * Monkey-patch for @unblockneteasemusic/server migu provider.
 * The old search endpoint (m.music.migu.cn/migu/remoting/scr_search_tag) is defunct.
 * This patch replaces the search function with the new MIGUM3.0 API.
 */

const Module = require('module');
const path = require('path');

const MIGU_PATH = path.resolve(
  __dirname,
  '../../node_modules/@unblockneteasemusic/server/src/provider/migu.js'
);

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
  })();

  if (resolved !== MIGU_PATH) {
    return originalLoad.apply(this, arguments);
  }

  // Return cached patched module if already loaded
  if (Module._cache[resolved]?.patchedByMeowSync) {
    return Module._cache[resolved].exports;
  }

  // Load original module first
  const original = originalLoad.apply(this, arguments);

  // Patch: replace search with new MIGUM3.0 endpoint
  const request_ = require(path.resolve(
    __dirname,
    '../../node_modules/@unblockneteasemusic/server/src/request.js'
  ));
  const select = require(path.resolve(
    __dirname,
    '../../node_modules/@unblockneteasemusic/server/src/provider/select.js'
  ));

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
  const { getManagedCacheStorage } = require(path.resolve(
    __dirname,
    '../../node_modules/@unblockneteasemusic/server/src/cache.js'
  ));
  const cs = getManagedCacheStorage('provider/migu-patched');
  const patchedCheck = (info) => cs.cache(info, () => search(info)).then(original.track);

  const patched = { check: patchedCheck, track: original.track };

  // Replace cached module exports
  if (Module._cache[resolved]) {
    Module._cache[resolved].exports = patched;
    Module._cache[resolved].patchedByMeowSync = true;
  }

  return patched;
};
