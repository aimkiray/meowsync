// NetEase 端点描述表——替代 NeteaseCloudMusicApi/module/ 目录的 356 个动态装载
// 模块。每个条目复刻对应上游模块的 uri/加密通道/data 构造/transform。
// crypto 默认 'eapi'（上游 APP_CONF.encrypt=true 的默认通道），weapi 为显式标注。
// 注意 crypto 字段是死元数据：运行时通道只由 handler 内经 opts() 显式传
// 'weapi' 决定（缺省 eapi），本字段仅作上游通道分布的文档留档（
// netease-layer.test.mjs 按它对拍分布）——改字段值不改行为
const { request } = require('./request');

const ENDPOINTS = {
  search: {
    crypto: 'eapi',
    handler: (q, ctx) => {
      if (q.type && q.type == '2000') {
        return request('/api/search/voice/get', {
          keyword: q.keywords, scene: 'normal',
          limit: q.limit || 30, offset: q.offset || 0,
        }, opts(q, ctx));
      }
      return request('/api/search/get', {
        s: q.keywords, type: q.type || 1,
        limit: q.limit || 30, offset: q.offset || 0,
      }, opts(q, ctx));
    },
  },
  cloudsearch: {
    crypto: 'eapi',
    handler: (q, ctx) => request('/api/cloudsearch/pc', {
      s: q.keywords, type: q.type || 1,
      limit: q.limit || 30, offset: q.offset || 0, total: true,
    }, opts(q, ctx)),
  },
  search_suggest: {
    crypto: 'weapi',
    handler: (q, ctx) => request(
      `/api/search/suggest/${q.type === 'mobile' ? 'keyword' : 'web'}`,
      { s: q.keywords || '' }, opts(q, ctx, 'weapi')),
  },
  search_hot: {
    crypto: 'eapi',
    handler: (q, ctx) => request('/api/search/hot', { type: 1111 }, opts(q, ctx)),
  },
  playlist_detail: {
    crypto: 'eapi',
    handler: (q, ctx) => request('/api/v6/playlist/detail', {
      id: q.id, n: 100000, s: q.s || 8,
    }, opts(q, ctx)),
  },
  playlist_track_all: {
    crypto: 'eapi',
    // 两跳编排：detail 拿 trackIds → 分片 → /api/v3/song/detail（eapi）
    handler: async (q, ctx) => {
      const res = await request('/api/v6/playlist/detail', {
        id: q.id, n: 100000, s: q.s || 8,
      }, opts(q, ctx));
      const limit = parseInt(q.limit) || 1000;
      const offset = parseInt(q.offset) || 0;
      const trackIds = res.body?.playlist?.trackIds || [];
      return request('/api/v3/song/detail', {
        c: '[' + trackIds.slice(offset, offset + limit)
          .map(item => '{"id":' + item.id + '}').join(',') + ']',
      }, opts(q, ctx));
    },
  },
  toplist: {
    crypto: 'eapi',
    handler: (q, ctx) => request('/api/toplist', {}, opts(q, ctx)),
  },
  song_url: {
    crypto: 'eapi',
    handler: async (q, ctx) => {
      const ids = String(q.id).split(',');
      const res = await request('/api/song/enhance/player/url', {
        ids: JSON.stringify(ids), br: parseInt(q.br || 999000),
      }, opts(q, ctx));
      // 上游把结果按请求 id 序重排（res.body.data 顺序不保证）
      const result = res.body.data;
      if (Array.isArray(result)) {
        result.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
      }
      return { status: 200, body: { code: 200, data: result }, cookie: res.cookie };
    },
  },
  song_url_v1: {
    crypto: 'eapi',
    handler: (q, ctx) => {
      const data = { ids: '[' + q.id + ']', level: q.level, encodeType: 'flac' };
      if (data.level === 'sky') data.immerseType = 'c51';
      return request('/api/song/enhance/player/url/v1', data, opts(q, ctx));
    },
  },
  song_detail: {
    crypto: 'weapi',
    handler: (q, ctx) => request('/api/v3/song/detail', {
      c: '[' + String(q.ids || '').split(/\s*,\s*/)
        .filter(Boolean).map(id => '{"id":' + id + '}').join(',') + ']',
    }, opts(q, ctx, 'weapi')),
  },
  lyric: {
    crypto: 'eapi',
    handler: (q, ctx) => request('/api/song/lyric', {
      id: q.id, tv: -1, lv: -1, rv: -1, kv: -1, _nmclfl: 1,
    }, opts(q, ctx)),
  },
  lyric_new: {
    crypto: 'eapi',
    handler: (q, ctx) => request('/api/song/lyric/v1', {
      id: q.id, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0,
    }, opts(q, ctx)),
  },
  check_music: {
    crypto: 'weapi',
    handler: async (q, ctx) => {
      const res = await request('/api/song/enhance/player/url', {
        ids: '[' + parseInt(q.id) + ']', br: parseInt(q.br || 999000),
      }, opts(q, ctx, 'weapi'));
      const playable = res.body?.code == 200 && res.body?.data?.[0]?.code == 200;
      res.body = playable
        ? { code: 200, success: true, message: 'ok' }
        : { code: 200, success: false, message: '亲爱的,暂无版权' };
      return res;
    },
  },
  album: {
    crypto: 'weapi',
    handler: (q, ctx) => request(`/api/v1/album/${q.id}`, {}, opts(q, ctx, 'weapi')),
  },
  artists: {
    crypto: 'weapi',
    handler: (q, ctx) => request(`/api/v1/artist/${q.id}`, {}, opts(q, ctx, 'weapi')),
  },
  banner: {
    crypto: 'eapi',
    handler: (q, ctx) => request('/api/v2/banner/get', {
      clientType: ({ 0: 'pc', 1: 'android', 2: 'iphone', 3: 'ipad' })[q.type || 0] || 'pc',
    }, opts(q, ctx)),
  },
  personalized: {
    crypto: 'weapi',
    handler: (q, ctx) => request('/api/personalized/playlist', {
      limit: q.limit || 30, total: true, n: 1000,
    }, opts(q, ctx, 'weapi')),
  },
};

// cookie 从 params 读（网关白名单过滤后透传）；timeoutMs/signal 走调用方
// 的 ctx（callNeteaseApi 的 options），不透传为上游业务参数
function opts(q, ctx, cryptoMode) {
  const o = { cookie: q.cookie, timeoutMs: ctx?.timeoutMs, signal: ctx?.signal };
  if (cryptoMode) o.crypto = cryptoMode;
  return o;
}

module.exports = { ENDPOINTS };
