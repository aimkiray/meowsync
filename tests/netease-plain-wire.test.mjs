// netease/request.js 明文 /api wire 形态钉板：stub globalThis.fetch 捕获
// (url, init)，断言 request() 实际发出的 HTTP 面——此前没有任何测试钉过
// 出站请求的真实形态。防回目标：
//   - weapi/eapi 密文通道复活（/eapi//weapi/ URL、params=/encSecKey= 键、
//     interface 域、iPhone 缝合 UA）
//   - _ntes_nuid 产 64hex 旧缺陷（hex(32) 误用，上游是 randomBytes(16)）
//   - data 夹带 csrf_token 伪造值直铺上 wire（须被 cookie __csrf/空串覆写）
//   - 非 200 改抛 Error（playlist-sync/music.js isUpstreamAnswer 靠形态识别）
//   - 明文通道被静默改名/加前缀（URL 逐字符钉死）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { request } = require('../src/server/services/netease/request.js');
const { ENDPOINTS } = require('../src/server/services/netease/endpoints.js');

// 同 netease-redirect.test.mjs 惯例：stub 只换一跳，组装/AbortSignal 全真。
// 额外落证 calls[]——本文件就是要读捕获到的 (url, init)
const withFetch = async (responder, fn) => {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return typeof responder === 'function' ? responder(url, init) : responder;
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = saved;
  }
};

const okJson = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

// Cookie 头是 'k=v; k=v' 串（cookieObjToString 键值均 encodeURIComponent，
// _ntes_nnid 值里的 ',' 会成 %2C）——必须 decode 回 map 才能断言值形态
const parseCookieHeader = (header) => Object.fromEntries(
  header.split('; ').map((pair) => {
    const i = pair.indexOf('=');
    return [pair.slice(0, i), decodeURIComponent(pair.slice(i + 1))];
  }),
);

test('wire：URL=明文 /api 逐字拼接，POST + web 表单头面', async () => {
  await withFetch(okJson({ code: 200 }), async (calls) => {
    const r = await request('/api/cloudsearch/pc', { s: 'test', type: 1 });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1, '一次 request 应恰好一跳 fetch');
    const { url, init } = calls[0];
    // 明文通道钉死：不是 /eapi/ /weapi/，不去 interface 域
    assert.equal(url, 'https://music.163.com/api/cloudsearch/pc');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(init.headers.Referer, 'https://music.163.com');
    // Chrome/Edge 桌面串（eapi 的 iPhone 缝合头随加密通道退役）
    assert.match(init.headers['User-Agent'], /Chrome\/\d+/);
    assert.match(init.headers['User-Agent'], /Edg\/\d+/);
    assert.doesNotMatch(init.headers['User-Agent'], /iPhone|Android/);
    // 固定域上游无合法重定向语义 + 超时真取消的 signal 接线
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
  });
});

test('wire：Cookie 头注风控指纹——NMTID/_ntes_nuid/_ntes_nnid 形态钉', async () => {
  await withFetch(okJson({ code: 200 }), async (calls) => {
    await request('/api/cloudsearch/pc', { s: 'test', type: 1 });
    const raw = calls[0].init.headers.Cookie;
    assert.match(raw, /NMTID=/);
    assert.match(raw, /_ntes_nuid=/);
    assert.match(raw, /_ntes_nnid=/);
    const cookie = parseCookieHeader(raw);
    // 上游 randomBytes(16)=32 小写 hex——nuid 曾 hex(32) 产 64 字符（风控异常信号）
    assert.match(cookie.NMTID, /^[0-9a-f]{32}$/);
    assert.match(cookie._ntes_nuid, /^[0-9a-f]{32}$/);
    // nnid = 同款 nuid + ',' + 时间戳，与 nuid 键联动
    assert.match(cookie._ntes_nnid, /^[0-9a-f]{32},\d+$/);
    assert.ok(cookie._ntes_nnid.startsWith(`${cookie._ntes_nuid},`));
    // 匿名态兜底空 MUSIC_A（!MUSIC_U 门内注入）
    assert.equal(cookie.MUSIC_A, '');
  });
});

test('wire：form 体业务字段直铺 + csrf_token 存在，无密文键', async () => {
  await withFetch(okJson({ code: 200 }), async (calls) => {
    await request('/api/cloudsearch/pc', { s: 'test', type: 1 });
    const body = calls[0].init.body;
    assert.equal(typeof body, 'string', 'body 应是 urlencoded 字符串');
    const form = new URLSearchParams(body);
    // 业务字段直铺——明文通道无 params=/encSecKey= 密文信封
    assert.equal(form.get('s'), 'test');
    assert.equal(form.get('type'), '1');
    assert.ok(form.has('csrf_token'));
    assert.ok(!form.has('params'), 'weapi 密文键 params 不得复活');
    assert.ok(!form.has('encSecKey'), 'weapi 密文键 encSecKey 不得复活');
  });
});

test('wire：undefined 值键缺席（qs 干净形态，非 "key=undefined" 字面量）', async () => {
  await withFetch(okJson({ code: 200 }), async (calls) => {
    await request('/api/cloudsearch/pc', { s: 'x', drop: undefined });
    const form = new URLSearchParams(calls[0].init.body);
    assert.ok(!form.has('drop'));
    assert.doesNotMatch(calls[0].init.body, /undefined/);
  });
});

test('wire：data 夹带 csrf_token 伪造值被覆写（cookie.__csrf/空串优先）', async () => {
  // responder 用工厂：同一 Response 实例 body 只能 text() 一次，
  // 两跳 request 复用同一实例会让第二跳 502（Body is unusable）
  await withFetch(() => okJson({ code: 200 }), async (calls) => {
    // 无 cookie.__csrf → 覆写成空串而非透传 'evil'
    await request('/api/cloudsearch/pc', { s: 'x', csrf_token: 'evil' });
    const form1 = new URLSearchParams(calls[0].init.body);
    assert.notEqual(form1.get('csrf_token'), 'evil');
    assert.equal(form1.get('csrf_token'), '');
    // 有 cookie.__csrf → 覆写成真值
    await request('/api/cloudsearch/pc', { csrf_token: 'evil' }, { cookie: '__csrf=tk' });
    assert.equal(new URLSearchParams(calls[1].init.body).get('csrf_token'), 'tk');
  });
});

test('wire：cookie 字符串透传——MUSIC_U 进 Cookie 头、__csrf 进 form', async () => {
  await withFetch(okJson({ code: 200 }), async (calls) => {
    await request('/api/cloudsearch/pc', { s: 'x' }, { cookie: 'MUSIC_U=abc; __csrf=tk' });
    const cookie = parseCookieHeader(calls[0].init.headers.Cookie);
    assert.equal(cookie.MUSIC_U, 'abc');
    const form = new URLSearchParams(calls[0].init.body);
    assert.equal(form.get('csrf_token'), 'tk');
    // 登录态不注 MUSIC_A 兜底（!map.MUSIC_U 门）
    assert.ok(!('MUSIC_A' in cookie));
  });
});

test('wire：200 应答 resolve {status, body, cookie[]} 契约 + Set-Cookie Domain 剥除', async () => {
  await withFetch(
    new Response(JSON.stringify({ code: 200, data: [1] }), {
      status: 200,
      headers: { 'set-cookie': 'NMTID=abc; Domain=.music.163.com; Path=/' },
    }),
    async () => {
      const r = await request('/api/cloudsearch/pc', {});
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { code: 200, data: [1] });
      assert.ok(Array.isArray(r.cookie));
      assert.equal(r.cookie.length, 1);
      assert.match(r.cookie[0], /NMTID=abc/);
      assert.doesNotMatch(r.cookie[0], /Domain/i);
    },
  );
});

test('wire：body.code=460 → reject(answer)，status=460 且非 Error 形态', async () => {
  await withFetch(okJson({ code: 460 }), async () => {
    await assert.rejects(
      request('/api/cloudsearch/pc', {}),
      (err) => {
        // isUpstreamAnswer 消费面：非 Error + 整型 status
        assert.ok(!(err instanceof Error));
        assert.equal(err.status, 460);
        return true;
      },
    );
  });
});

test('wire：fetch 抛网络错 → reject(answer) status=502 envelope', async () => {
  await withFetch(async () => { throw new TypeError('fetch failed'); }, async () => {
    await assert.rejects(
      request('/api/cloudsearch/pc', {}),
      (err) => {
        assert.ok(!(err instanceof Error));
        assert.equal(err.status, 502);
        assert.equal(err.body.code, 502);
        assert.equal(err.body.msg, 'fetch failed');
        return true;
      },
    );
  });
});

test('wire：200 + 64hex 密文应答体 → console.warn 一次，resolve 形态不变', async () => {
  const raw = '0123456789abcdef'.repeat(4); // 64 hex——上游偶发的 eapi 密文应答面
  const savedWarn = console.warn;
  let warns = 0;
  console.warn = () => { warns++; };
  try {
    await withFetch(new Response(raw, { status: 200 }), async () => {
      const r = await request('/api/cloudsearch/pc', {});
      assert.equal(warns, 1, '密文应答应恰好 warn 一次留痕');
      assert.equal(r.status, 200); // body 无 code → HTTP 200 成 answer.status
      assert.equal(r.body, raw);   // 不可解析体归 raw 字符串，不新造错误路径
    });
  } finally {
    console.warn = savedWarn;
  }
});

test('wire：JSON 壳 data 字段塞 32+hex → 密文 warn 同样留痕', async () => {
  // 密文第二种包装面：JSON 可解析但 data 是整段 hex——parse 成功的形态
  // 也要命中 warn（M3 扩面），且不误伤正常 {code,data:{...}} 应答
  const hexData = 'ab'.repeat(32);
  const savedWarn = console.warn;
  let warns = 0;
  console.warn = () => { warns++; };
  try {
    await withFetch(() => okJson({ code: 200, data: hexData }), async () => {
      const r = await request('/api/cloudsearch/pc', {});
      assert.equal(warns, 1);
      assert.equal(r.status, 200);
      assert.equal(r.body.data, hexData);
    });
    warns = 0;
    await withFetch(okJson({ code: 200, data: { url: 'https://x' } }), async () => {
      await request('/api/cloudsearch/pc', {});
      assert.equal(warns, 0, '正常对象 data 不得误判密文');
    });
  } finally {
    console.warn = savedWarn;
  }
});

// M1 实机证实：'["id","id"]' 字符串元素形态上游拒答 data:undefined；
// 数字元素形态 '[id,id]'（上游 module 同款构造）被接受——带空格 id 串
// 必须逐段 trim，旧 JSON.stringify(split(',')) 会把 ' 2' 原样带上
test('wire：song_url ids 数字元素形态——带空格 id 串 trim 后拼 [a,b]', async () => {
  await withFetch(okJson({ code: 200, data: [] }), async (calls) => {
    await ENDPOINTS.song_url.handler({ id: '3378803529, 1486998323' }, {});
    const form = new URLSearchParams(calls[0].init.body);
    assert.equal(form.get('ids'), '[3378803529,1486998323]');
    assert.equal(form.get('br'), '999000'); // br 缺省兜底
  });
});

test('song_url：data 按请求 id 序重排；空 id 产 [] 且 body 缺 data 不炸', async () => {
  await withFetch(okJson({ code: 200, data: [{ id: 1486998323 }, { id: 3378803529 }] }), async () => {
    const r = await ENDPOINTS.song_url.handler({ id: '3378803529, 1486998323' }, {});
    // 上游乱序回——handler 按请求 id 序 sort（trim 后字符串键 indexOf）
    assert.deepEqual(r.body.data.map(d => d.id), [3378803529, 1486998323]);
  });
  // id='' → ids='[]'（与上游空参形态一致）；应答无 data 键时
  // res.body?.data 归 undefined 透出而非 TypeError
  await withFetch(okJson({ code: 200 }), async (calls) => {
    const r = await ENDPOINTS.song_url.handler({ id: '' }, {});
    assert.equal(new URLSearchParams(calls[0].init.body).get('ids'), '[]');
    assert.equal(r.status, 200);
    assert.equal(r.body.data, undefined);
  });
});

// 同 playlist_track_all 一跳语义：song_url 重拼 envelope 时 code 不得
// 恒写 200——SPECIAL_BODY_CODES resolve-200 的 400/502/801 业务码须原样
// 透出，洗白成 200 会让路由层/前端把上游真实失败当空 data 正常渲染
test('song_url：一跳业务码原样透出——envelope code 不洗白成 200', async () => {
  await withFetch(okJson({ code: 400 }), async () => {
    const r = await ENDPOINTS.song_url.handler({ id: '3378803529' }, {});
    assert.equal(r.status, 200);    // resolve-200：HTTP 语义不变
    assert.equal(r.body.code, 400); // 业务码真值透出
  });
});

// M2：detail 一跳业务失败（400/502/801 等 SPECIAL_BODY_CODES resolve-200
// 的应答）必须原样透出——旧逻辑透下去被空 trackIds 洗成空歌单
test('playlist_track_all：一跳 code 非 200 原样透出且不付二跳', async () => {
  await withFetch(okJson({ code: 400 }), async (calls) => {
    const r = await ENDPOINTS.playlist_track_all.handler({ id: '24381616' }, {});
    assert.equal(calls.length, 1, '一跳失败不应再打 song/detail');
    assert.equal(r.body.code, 400);
  });
});
