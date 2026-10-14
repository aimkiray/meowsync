// server/lib/bilibili.js 曲库面钉板（搜索=SSR pinia 数据岛、建议=suggest、
// 相关=archive/related）——fetch 全局桩截断，无网络：
//   biliSearchVideos — pinia 岛提取（对象字面量/IIFE/自赋 window 三形态）→
//     video 桶 data[] 归一行；岛缺席/畸形/超时/形态漂移一律抛（路由转 502——
//     静默空态会把上游改版伪装成「没搜到」）；result[] 合法但无 video 桶
//     = 合法零视频词归空态不抛；search.bilibili.com 属 www 域系不带
//     Cookie（biliCookie 是 api 域专属）；302 逐跳域闸（manual redirect，
//     建连前验 host——异源跳不发生连接）、体积闸 2MB；岛求值安全面
//     （逃逸链/微任务/拒绝外溢/多语句截救）逐项钉
//   biliSuggest     — result.tag[].value 归一（em 剥洗 + name 兜底）
//   biliRelated     — data[] 同孔径归一（owner.name/tid/tname 字段族）
//   videoItemToRow/musicZoneOf — duration 双形态、pic 协议补齐、白名单
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDataDir } from './helpers.mjs';

const require = createRequire(import.meta.url);

// biliCookie 经 settings 层读 app_settings——不隔离 DATA_DIR 会开真实 dev 库
process.env.DATA_DIR = tmpDataDir('meowsync-bili-search-');
// 登录态在位——pinia 页请求不得携带 Cookie（域闸：api.bilibili.com 专属）
process.env.BILI_COOKIE = 'SESSDATA=fake';
const {
  biliSearchVideos, biliSuggest, biliRelated, musicZoneOf, videoItemToRow,
} = require('../src/server/lib/bilibili.js');

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: opts.headers || {}, signal: opts.signal, redirect: opts.redirect });
    return handler(u, opts);
  };
  return calls;
}

// ── pinia 岛打样（实机契约：window.__pinia=<IIFE> 内嵌 searchAllResponse）──
// 搜索桶条目字段族实测：{bvid,title:'含<em class="keyword">高亮',author,
// duration:'M:SS' 字符串,typeid:'130' 字符串,typename,pubdate:unix秒,pic:'//…'}
const V = (over = {}) => ({
  bvid: 'BV1xx411c7XE',
  title: '周杰伦《<em class="keyword">青花瓷</em>》官方MV',
  author: '杰威尔音乐',
  duration: '4:0',
  typeid: '193',
  typename: 'MV',
  pubdate: 1193932800,
  pic: '//i1.hdslb.com/bfs/archive/x.jpg',
  ...over,
});
const piniaOf = (data) => ({
  searchResponse: {
    searchAllResponse: {
      seid: '15243', page: 1, pagesize: 42, numResults: 1000, numPages: 50,
      result: [
        // 非 video 桶（tips/user/media_bangumi 等）必须忽略
        { result_type: 'bili_user', data: [{ mid: 1, uname: 'x' }] },
        { result_type: 'video', data },
      ],
    },
  },
});
// 三种产出形态都打：裸对象字面量 / 返回值 IIFE / 自赋 window 的 IIFE
const htmlIsl = {
  literal: (p) => `<html><body><script>window.__pinia=${JSON.stringify(p)};</script></body></html>`,
  iife: (p) => `<html><body><script>window.__pinia=(function(){return ${JSON.stringify(p)}})();</script></body></html>`,
  selfAssign: (p) => `<html><body><script>window.__pinia=(function(w){w.__pinia=${JSON.stringify(p)}})(window);</script></body></html>`,
};
const htmlRes = (html) => ({ ok: true, status: 200, text: async () => html });
const okJson = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });

test('biliSearchVideos：pinia 岛三形态 → video 桶归一行（剥 em/pic 协议/duration/typeid 转数）', async () => {
  for (const form of ['literal', 'iife', 'selfAssign']) {
    const calls = stubFetch(() => htmlRes(htmlIsl[form](piniaOf([V(), V({ bvid: 'BV1xx411c7XF', duration: '55:17', typeid: '130' })]))));
    const r = await biliSearchVideos('青花瓷');
    assert.equal(r.seid, '15243');
    assert.equal(r.numResults, 1000);
    assert.equal(r.items.length, 2, `${form} 形态`);
    const it = r.items[0];
    assert.equal(it.bvid, 'BV1xx411c7XE');
    assert.equal(it.title, '周杰伦《青花瓷》官方MV', 'em 高亮剥洗');
    assert.equal(it.author, '杰威尔音乐');
    assert.equal(it.durationSec, 240, "'4:0' → 240s");
    assert.equal(it.pic, 'https://i1.hdslb.com/bfs/archive/x.jpg', '协议相对补 https:');
    assert.equal(it.typeid, 193, "typeid 字符串 '193' → 数字");
    assert.equal(it.typename, 'MV');
    assert.equal(it.pubdate, 1193932800);
    assert.equal(r.items[1].durationSec, 3317, "'55:17' → 3317s");
    // 请求面：search.bilibili.com + 公共头（Referer 防盗链）+ Cookie 不出 api 域
    assert.match(calls[0].url, /^https:\/\/search\.bilibili\.com\/video\?keyword=/);
    assert.ok(calls[0].url.includes(encodeURIComponent('青花瓷')));
    assert.equal(calls[0].headers.Referer, 'https://www.bilibili.com');
    assert.ok(calls[0].headers['User-Agent']);
    assert.equal(calls[0].headers.Cookie, undefined, 'pinia 页在 www 域系——cookie 不外泄');
    assert.ok(calls[0].signal, '级联断连 signal 在位');
  }
});

test('biliSearchVideos：无 bvid 脏条目不进行', async () => {
  stubFetch(() => htmlRes(htmlIsl.literal(piniaOf([V(), V({ bvid: '' }), V({ bvid: 42 })]))));
  const r = await biliSearchVideos('x');
  assert.equal(r.items.length, 1);
});

test('biliSearchVideos：岛缺席/畸形/形态漂移/非 200 一律抛', async () => {
  // 无 pinia 锚点
  stubFetch(() => htmlRes('<html><body>no island</body></html>'));
  await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
  // 锚点在但 RHS 是垃圾表达式——vm 求值炸
  stubFetch(() => htmlRes('<script>window.__pinia={{{垃圾</script>'));
  await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
  // 岛在但 searchAllResponse 缺席——形态漂移（上游改版）
  stubFetch(() => htmlRes(htmlIsl.literal({ other: 1 })));
  await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
  // result[] 里桶非对象——桶表形态非法按漂移抛
  stubFetch(() => htmlRes(htmlIsl.literal({
    searchResponse: { searchAllResponse: { seid: 'x', result: ['脏', null] } },
  })));
  await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
  // video 桶在但 data 非数组——同样按漂移抛
  stubFetch(() => htmlRes(htmlIsl.literal(piniaOf(null))));
  await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
  // HTTP 非 200 先于解析抛
  stubFetch(() => ({ ok: false, status: 500, text: async () => '' }));
  await assert.rejects(() => biliSearchVideos('x'), /search HTTP 500/);
});

test('biliSearchVideos：result[] 合法但无 video 桶 → 空态不归 502（合法零视频词）', async () => {
  // 词只命中直播/用户分区时上游不下发 video 桶——桶表合法即非漂移
  stubFetch(() => htmlRes(htmlIsl.literal({
    searchResponse: {
      searchAllResponse: {
        seid: 'x9', numResults: 3,
        result: [
          { result_type: 'bili_user', data: [{ mid: 1 }] },
          { result_type: 'live', data: [{ roomid: 2 }] },
                    // video 桶整桶缺席
        ],
      },
    },
  })));
  const r = await biliSearchVideos('x');
  assert.deepEqual(r.items, []);
  assert.equal(r.seid, 'x9');
  assert.equal(r.numResults, 3);
});

test('biliSearchVideos：岛内死循环表达式被 vm 超时掐断 → 抛；截断重试共享总预算不叠加', async () => {
  stubFetch(() => htmlRes('<script>window.__pinia=(function(){while(1){}})()</script>'));
  await assert.rejects(() => biliSearchVideos('x', { evalTimeoutMs: 250 }), /数据岛解析失败/);
  // 总预算收口钉板：首评+截断刀共享同一 timeoutMs——带 , 刀口的死循环岛
  // 首评烧满 250ms 后截断再评，独立满额会叠出 ≥2×timeout 的同步冻结；
  // 共享预算下第二刀余额 <50ms 直接弃，wall 与单份预算同阶
  stubFetch(() => htmlRes('<script>window.__pinia=(function(){while(1){}})(),x=1</script>'));
  const t0 = Date.now();
  await assert.rejects(() => biliSearchVideos('x', { evalTimeoutMs: 250 }), /数据岛解析失败/);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `截断重试不得叠预算（实测 ${elapsed}ms，独立满额 ≥500ms）`);
});

test('biliSearchVideos：vm 逃逸链断——window/this/eval 三型逃逸面归零归 null → 抛', async () => {
  // 逃逸面归零钉板：三条逃逸通道在逃逸成功时产出合法 pinia 形——若逃逸
  // 真能拿到可执行代码面（codeGeneration/strings 闸被摘、或逃逸摸到
  // 宿主 Function），岛返回 pinia → items 非空 → 本断言转红；旧钉产
  // 42/{a:1}，逃逸成功仍归 null 照绿——摘闸检测不到的弱钉。
  // 当前语义：window 是 context 内 var 建的 {}，constructor 链落在
  // context 域 Object→Function；codeGeneration.strings=false 把 context
  // 域 Function/eval 的字符串代码生成掐死成 EvalError——逃逸"成功"也
  // 只拿 context 域内建，宿主面归零。PINIA_OBJ 与三型 frag 刻意无 ;/,——
  // 截断重试找不着刀口，逃逸判定的成败只看首评
  const PINIA_OBJ = "{searchResponse:{searchAllResponse:{result:[{result_type:'video',data:[{bvid:'BV1xx411c7XE'}]}]}}}";
  // window.constructor.constructor 逃逸：context 域 Function 被 strings 闸掐
  stubFetch(() => htmlRes(`<script>window.__pinia=(function(){return window.constructor.constructor("return ${PINIA_OBJ}")()})()</script>`));
  await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
  // this 逃逸：IIFE 非严格 this 落 context 全局——同链 context Function 掐断
  stubFetch(() => htmlRes(`<script>window.__pinia=(function(){return this.constructor.constructor("return ${PINIA_OBJ}")()})()</script>`));
  await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
  // 直接 eval——codeGeneration.strings=false 关死字符串代码生成
  stubFetch(() => htmlRes(`<script>window.__pinia=(function(){return eval("(${PINIA_OBJ})")})()</script>`));
  await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
});

test('biliSearchVideos：岛内微任务通道死绝——Promise 已影子化，命名通道求值期同步炸', async () => {
  // Promise.resolve().then(()=>while(1)) 在 context 里是 TypeError（Promise
  // 全局已置 undefined）——不排水不耗预算；归 null→抛，进程安然存活。
  // async/await 语法级残面（#38503 排水掐断损坏 async_hooks 栈）在
  // node --test 下会崩 runner，这里刻意不钉——语义注释见 lib 块注释
  stubFetch(() => htmlRes('<script>window.__pinia=(function(){Promise.resolve().then(()=>{while(1){}});return{a:1}})()</script>'));
  await assert.rejects(() => biliSearchVideos('x', { evalTimeoutMs: 200 }), /数据岛解析失败/);
});

test('biliSearchVideos：岛内 promise 拒绝不外溢宿主 unhandledRejection', async () => {
  // (async()=>{throw})() 走语法级内建 promise——拒绝仍向宿主上报；
  // eval 窗口内 promiseHooks 已给岛内 promise 挂 swallow-catch。
  // （Promise.reject 命名通道已被 Promise=undefined 影子化同步炸死，
  // 这里钉的是钻过影子化的内建形态）
  let escaped = null;
  const onRej = (r) => { escaped = r; };
  process.on('unhandledRejection', onRej);
  try {
    stubFetch(() => htmlRes('<script>window.__pinia=(function(){(async()=>{throw new Error("island-boom")})();return null})()</script>'));
    await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
    // 岛覆写 context Promise.prototype.then 再排拒绝——swallow 走宿主
    // 内建 Promise.prototype.then.call，覆写钓不走吞咽
    // （裸 promise.then(...) 会被覆写钓走，拒绝照样外溢）
    stubFetch(() => htmlRes('<script>window.__pinia=(function(){var P=(async()=>{})().constructor;P.prototype.then=function(){return this};(async()=>{throw new Error("island-boom2")})();return null})()</script>'));
    await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
    await new Promise(r => setTimeout(r, 30)); // 给逃逸面上报一个事件循环窗口
    assert.equal(escaped, null, '岛内 promise 拒绝不得逃逸到宿主');
  } finally {
    process.removeListener('unhandledRejection', onRej);
  }
});

test('biliSearchVideos：同步 throw/非对象 RHS 归 null → 抛；多语句岛截断重试救回', async () => {
  // IIFE 内同步 throw
  stubFetch(() => htmlRes('<script>window.__pinia=(function(){throw new Error("x")})()</script>'));
  await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
  // RHS 非对象
  stubFetch(() => htmlRes('<script>window.__pinia=42</script>'));
  await assert.rejects(() => biliSearchVideos('x'), /数据岛解析失败/);
  // 多语句岛：RHS 后混同 script 块其它语句——从尾往前截 ; 救回 pinia 段
  stubFetch(() => htmlRes(`<script>window.__pinia=${JSON.stringify(piniaOf([V()]))};window.__x=1;track()</script>`));
  const r = await biliSearchVideos('x');
  assert.equal(r.items.length, 1, '多语句岛截断重试应救回完整 pinia 段');
  // 尾逗号碎片：表达式合法但值非 pinia——截 , 重试成活
  stubFetch(() => htmlRes(`<script>window.__pinia=${JSON.stringify(piniaOf([V()]))},undefined</script>`));
  const r2 = await biliSearchVideos('x');
  assert.equal(r2.items.length, 1, '尾逗号碎片截断重试应救回');
});

test('biliSearchVideos：302 逐跳域闸（manual redirect——异源跳建连前拒）+ 读体体积闸', async () => {
  // 302 → 异源域：建连前拒——裸 follow 会先把连接打到 evil 再验 res.url
  // （盲 SSRF），逐跳闸后异源跳连第二次连接都不发生
  const redir = (loc) => ({
    ok: false, status: 302,
    headers: { get: (k) => (k === 'location' ? loc : null) },
    body: { cancel: async () => {} },
  });
  const c1 = stubFetch(() => redir('https://evil.example.com/x'));
  await assert.rejects(() => biliSearchVideos('x'), /越域/);
  assert.equal(c1.length, 1, '异源跳不得发生第二次连接');
  assert.equal(c1[0].redirect, 'manual', '必须 manual redirect——裸 follow 即盲 SSRF');
  // 302 → b23.tv 不收：短链跳解跳房归 resolveBiliLink 链，本链只认 bilibili.com 本系
  const c2 = stubFetch(() => redir('https://b23.tv/abc123'));
  await assert.rejects(() => biliSearchVideos('x'), /越域/);
  assert.equal(c2.length, 1, 'b23.tv 跳同样建连前拒');
  // 302 → file: scheme / 非标端口——normalizeOutboundUrl 闸在域判之前
  for (const bad of ['file:///etc/passwd', 'https://www.bilibili.com:8443/x']) {
    stubFetch(() => redir(bad));
    await assert.rejects(() => biliSearchVideos('x'), /目标非法/, `应拒 ${bad}`);
  }
  // 域内跳解照常跟：302 → *.bilibili.com（含相对 location）再 200 出 pinia
  for (const loc of ['https://www.bilibili.com/hopped?x=1', '/video?keyword=rel']) {
    let n = 0;
    stubFetch(() => (++n === 1 ? redir(loc) : htmlRes(htmlIsl.literal(piniaOf([V()])))));
    const ok = await biliSearchVideos('x');
    assert.equal(ok.items.length, 1, `域内跳 ${loc} 后跟到 200`);
  }
  // 跳数上限 ≤3：链上恒 302 回同系域——首发+3 跳（4 请求）后弃
  const c3 = stubFetch((u) => redir(`${u}&h=1`));
  await assert.rejects(() => biliSearchVideos('x'), /跳数超限/);
  assert.equal(c3.length, 4, '跳数上限后不再建连');
  // 3xx 无 location——按终态处理走 HTTP 错误档
  stubFetch(() => ({ ok: false, status: 304, headers: { get: () => null }, body: { cancel: async () => {} } }));
  await assert.rejects(() => biliSearchVideos('x'), /HTTP 304/);
  // content-length 声明超限——头侧早拒不拉体（text 被调即失败）
  stubFetch(() => ({
    ok: true, status: 200,
    headers: { get: (k) => (k === 'content-length' ? String(3 * 1024 * 1024) : null) },
    body: { cancel: async () => {} },
    text: async () => { throw new Error('不应读体'); },
  }));
  await assert.rejects(() => biliSearchVideos('x'), /超限/);
  // 流侧谎报兜底：无 content-length 但分块累计超界即断流
  const big = new Uint8Array(1024 * 1024);
  stubFetch(() => ({
    ok: true, status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => {
        let n = 0;
        return {
          read: async () => (++n <= 3 ? { done: false, value: big } : { done: true }),
          cancel: async () => {},
        };
      },
    },
  }));
  await assert.rejects(() => biliSearchVideos('x'), /超/);
});

test('videoItemToRow：双字段族通吃——搜索桶(author/typeid 字符串)与 related 桶(owner.name/tid 数字)', async () => {
  const search = videoItemToRow(V({ duration: '1:02:03' }));
  assert.equal(search.durationSec, 3723, "'1:02:03' → H:MM:SS 解析");
  const rel = videoItemToRow({
    bvid: 'BV1xx411c7XG', title: '相关稿',
    owner: { name: 'UP主', mid: 9 }, duration: 200, // related 是秒数数字
    tid: 130, tname: '音乐综合', pic: 'https://i0.hdslb.com/y.jpg', pubdate: 1700000000,
  });
  assert.equal(rel.author, 'UP主');
  assert.equal(rel.durationSec, 200);
  assert.equal(rel.typeid, 130);
  assert.equal(rel.typename, '音乐综合');
  assert.equal(rel.pic, 'https://i0.hdslb.com/y.jpg');
  // 坏形态防御：duration 脏值归 0；pic 非 http(s) 不落；字段缺席不炸
  const bad = videoItemToRow({ bvid: 'BV1xx411c7XH', duration: 'abc', pic: 'javascript:x' });
  assert.equal(bad.durationSec, 0);
  assert.equal(bad.pic, '');
  assert.equal(videoItemToRow(null).bvid, '');
  assert.equal(videoItemToRow({ bvid: 'BV1xx411c7XI', duration: '1:2:3:4' }).durationSec, 0, '四段非时长');
});

test('musicZoneOf：音乐分区白名单（typeid 字符串入参）', async () => {
  for (const t of [28, 29, 30, 31, 59, 130, 193, 265, 266, 267]) {
    assert.equal(musicZoneOf(String(t)), true, `typeid ${t} 在音乐白名单`);
  }
  for (const t of [243, 244, 17, 0, 'abc', null]) {
    assert.equal(musicZoneOf(t), false, `typeid ${t} 剔除`);
  }
});

test('biliSuggest：result.tag[].value 归一 + em 剥洗 + name 兜底 + code!==0 抛', async () => {
  const calls = stubFetch(() => okJson({
    result: {
      tag: [
        { value: '青花瓷', term: 0, name: '<em class="keyword">青花</em>瓷', spid: 4 },
        { value: '<em class="keyword">青花瓷</em> 粤语', name: 'x', spid: 4 }, // value 带高亮防御
        { name: '只有 name 的兜底' },
        { value: '   ' }, // 纯空白剔除
      ],
    },
  }));
  const words = await biliSuggest('青花');
  assert.deepEqual(words, ['青花瓷', '青花瓷 粤语', '只有 name 的兜底']);
  assert.match(calls[0].url, /api\.bilibili\.com\/x\/web-interface\/suggest\?term=/);
  // 上游业务码非 0 抛（biliFetch 统一闸）
  stubFetch(() => ({ ok: true, status: 200, json: async () => ({ code: -412, message: '风控' }) }));
  await assert.rejects(() => biliSuggest('x'), /code=-412/);
  // tag 缺席/非数组 → 空表不炸
  stubFetch(() => okJson({ result: {} }));
  assert.deepEqual(await biliSuggest('x'), []);
});

test('biliRelated：data[] 归一行 + code!==0 抛', async () => {
  const calls = stubFetch(() => okJson([
    {
      bvid: 'BV1xx411c7XJ', title: '相关一',
      owner: { name: 'UP一', mid: 7 }, duration: 200,
      pic: '//i0.hdslb.com/r1.jpg', pubdate: 1700000000,
    },
    { bvid: 'BV1xx411c7XK', title: '相关二', owner: { name: 'UP二' }, duration: '3:21' },
    { title: '无 bvid 脏条目' },
  ]));
  const items = await biliRelated('BV1xx411c7XE');
  assert.equal(items.length, 2);
  assert.equal(items[0].bvid, 'BV1xx411c7XJ');
  assert.equal(items[0].author, 'UP一');
  assert.equal(items[0].durationSec, 200);
  assert.equal(items[0].pic, 'https://i0.hdslb.com/r1.jpg');
  assert.equal(items[1].durationSec, 201, 'related 侧兼容 M:SS 字符串');
  assert.match(calls[0].url, /api\.bilibili\.com\/x\/web-interface\/archive\/related\?bvid=BV1xx411c7XE/);
  stubFetch(() => ({ ok: true, status: 200, json: async () => ({ code: -404, message: '啥都木有' }) }));
  await assert.rejects(() => biliRelated('BV1xx411c7XE'), /code=-404/);
  // data 非数组 → 空表
  stubFetch(() => okJson(null));
  assert.deepEqual(await biliRelated('BV1xx411c7XE'), []);
});
