// 本家声明解析层回归网——parseOriginalRef 纯函数矩阵 + resolveOriginalInfo
// 回源链。fetch 层桩法与 youtube-playlist-parse.test.mjs 同口径：stub
// globalThis.fetch 喂真实 player 响应形态，fetchPlayer 用真实现。
// lib/settings 预播种 stub（effectiveValue 恒 null）——真 settings 会经
// repositories/settings 开 dev DB，env YT_COOKIE/YT_PROXY 也会改变认证
// 轮替链/出口（youtube-cookie.test.mjs 同手法，yt-proxy 同受这道种）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seed } from './helpers.mjs';

const require = createRequire(import.meta.url);
// 必须在 require youtube.js 之前——lib/youtube 在加载时解构绑定
// effectiveValue；命中缓存种子后真 settings 不装载，repositories/getDb
// 整条链根本不进进程
seed('../src/server/lib/settings.js', { effectiveValue: () => null });
const { parseOriginalRef, resolveOriginalInfo } = require('../src/server/lib/youtube.js');

// ── parseOriginalRef：标记词×链接的行级矩阵 ─────────────────────────
// 行内含本家标记词且含 YouTube 链接 → 首个非自指 videoId；否则 null

test('parseOriginalRef：各标记词形态都命中（实案语料）', () => {
  const cases = [
    ['original:https://youtu.be/hcjyRnPbCWc', 'hcjyRnPbCWc'],          // 实案粘连形态
    ['本家：https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['本家様： https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['御本家 https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['原曲: https://www.youtube.com/watch?v=kJQP7kiw5Fk', 'kJQP7kiw5Fk'],
    ['元曲 https://youtube.com/shorts/kJQP7kiw5Fk', 'kJQP7kiw5Fk'],
    ['元動画 → https://youtu.be/kJQP7kiw5Fk', 'kJQP7kiw5Fk'],
    ['オリジナル：https://youtu.be/kJQP7kiw5Fk', 'kJQP7kiw5Fk'],
    ['ORIGINAL: https://youtu.be/kJQP7kiw5Fk', 'kJQP7kiw5Fk'],
    ['Source: https://youtu.be/kJQP7kiw5Fk', 'kJQP7kiw5Fk'],
    ['原视频 https://youtu.be/kJQP7kiw5Fk', 'kJQP7kiw5Fk'],
    // watch?v= 非首参 / embed / live / nocookie 形态
    ['本家 https://www.youtube.com/watch?list=PLx&v=kJQP7kiw5Fk', 'kJQP7kiw5Fk'],
    ['original https://www.youtube.com/embed/kJQP7kiw5Fk', 'kJQP7kiw5Fk'],
    ['本家 https://www.youtube.com/live/kJQP7kiw5Fk', 'kJQP7kiw5Fk'],
    // 多行描述里标记行命中（前文歌词/名单噪声不挡）
    ['歌ってみた\nvo. 某人\n本家: https://youtu.be/hcjyRnPbCWc\n请多关照', 'hcjyRnPbCWc'],
  ];
  for (const [desc, id] of cases) {
    assert.deepEqual(parseOriginalRef(desc, 'selfid00001'), { videoId: id },
      `应命中: ${JSON.stringify(desc)}`);
  }
});

test('parseOriginalRef：无标记词的链接行不采（跨行拼接不收）', () => {
  assert.equal(parseOriginalRef('听听这个 https://youtu.be/dQw4w9WgXcQ'), null);
  // 标记词与链接分行——行级语义，跨行不拼
  assert.equal(parseOriginalRef('本家はこちら\nhttps://youtu.be/dQw4w9WgXcQ'), null);
  // 标记行无 YouTube 链接
  assert.equal(parseOriginalRef('本家：周杰伦'), null);
  // 非 YouTube 域链接不采
  assert.equal(parseOriginalRef('original: https://example.com/dQw4w9WgXcQ'), null);
  assert.equal(parseOriginalRef('本家: https://www.nicovideo.jp/watch/sm12345'), null);
  // 空描述/非串输入
  assert.equal(parseOriginalRef(''), null);
  assert.equal(parseOriginalRef(null), null);
  assert.equal(parseOriginalRef(undefined), null);
});

test('parseOriginalRef：拉丁标记词词边界——resources/originality 不误吃', () => {
  // 'resources'/'originality' 词干内嵌 'source'/'original' 但无词边界
  assert.equal(parseOriginalRef('resources: https://youtu.be/dQw4w9WgXcQ'), null);
  assert.equal(parseOriginalRef('originality: https://youtu.be/dQw4w9WgXcQ'), null);
  // 词边界两侧合法形态照收
  assert.deepEqual(parseOriginalRef('originality高い。original:https://youtu.be/dQw4w9WgXcQ'),
    { videoId: 'dQw4w9WgXcQ' });
});

test('parseOriginalRef：自指链跳过——取行内下一个非自指链接', () => {
  // 行内仅自指 → null（引流/互推不构成出处）
  assert.equal(parseOriginalRef('original:https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'), null);
  // 行内自指在前、真本家在后 → 跳过自指取后者
  assert.deepEqual(
    parseOriginalRef('本家 https://youtu.be/dQw4w9WgXcQ と https://youtu.be/hcjyRnPbCWc', 'dQw4w9WgXcQ'),
    { videoId: 'hcjyRnPbCWc' });
  // 首行全自指 → 继续扫后续标记行
  assert.deepEqual(
    parseOriginalRef('本家:https://youtu.be/dQw4w9WgXcQ\n原曲:https://youtu.be/hcjyRnPbCWc', 'dQw4w9WgXcQ'),
    { videoId: 'hcjyRnPbCWc' });
});

test('parseOriginalRef：行序优先、同行取首个链接', () => {
  // 两条声明行 → 首行的链接
  assert.deepEqual(
    parseOriginalRef('原曲: https://youtu.be/AAAAAAAAAAA\n本家: https://youtu.be/BBBBBBBBBBB'),
    { videoId: 'AAAAAAAAAAA' });
  // 同行多链接 → 位置序首个
  assert.deepEqual(
    parseOriginalRef('本家 https://youtu.be/AAAAAAAAAAA mirror https://youtu.be/BBBBBBBBBBB'),
    { videoId: 'AAAAAAAAAAA' });
});

// ── parseOriginalRef：文本声明形态（标记词[:] + 'Artist - Title'）─────
// 标记词行内无 YT 链接时，标记词[:]后的文本按 'Artist - Title' 拆
// {author,title}（videoId 缺席）——niconico 本家/免链声明同样是一手证据

test('parseOriginalRef：文本声明形态命中矩阵', () => {
  const cases = [
    // 实案：全角冒号 + 纯文本声明
    ['original：ポップしなないで - 早く帰りたい', { author: 'ポップしなないで', title: '早く帰りたい' }],
    ['original: Artist - Title', { author: 'Artist', title: 'Title' }],
    ['本家：shima - Moonlight', { author: 'shima', title: 'Moonlight' }],
    ['本家様：A - B', { author: 'A', title: 'B' }],                     // 敬称连接尾
    ['本家はこちら: A - B', { author: 'A', title: 'B' }],               // 助词尾
    ['オリジナルMV：A - B', { author: 'A', title: 'B' }],               // 短 ASCII 词缀尾
    ['歌ってみた\n本家：A - B\n请多关照', { author: 'A', title: 'B' }],   // 多行命中
    ['本家：「A - B」', { author: 'A', title: 'B' }],                   // 整串外层括号剥除
    ['original: A - B（full ver.）', { author: 'A', title: 'B' }],      // 尾随括注剥除
    ['original: A - B #cover', { author: 'A', title: 'B' }],            // 尾标签截断
    ['本家：A - B（https://nicovideo.jp/watch/sm9）', { author: 'A', title: 'B' }], // 尾括注含外链
    ['本家：A - B - C', { author: 'A', title: 'B - C' }],               // 首个 ' - ' 分隔，尾段归 title
  ];
  for (const [desc, want] of cases) {
    assert.deepEqual(parseOriginalRef(desc, 'selfid00001'), want,
      `应命中: ${JSON.stringify(desc)}`);
  }
});

test('parseOriginalRef：文本声明边界——形态不符归 null 不硬猜', () => {
  const bad = [
    'original：',              // 标记词后空串
    'original:',
    'original：   ',
    '本家：周杰伦',             // 无 ' - ' 分隔
    '本家：A-B',               // 连字符两侧无空白
    '本家：- B',               // artist 缺侧
    '本家：A -',               // title 缺侧
    '本家 A - B',              // 缺冒号不收
    '本家：【A - B',            // 未闭合括号整串剥空 → null
    '本家：https://www.nicovideo.jp/watch/sm9 - A - B', // 外链截断后无声明残
    'originality: A - B',      // 词边界外——标记词根本没立
    'source material: A - B',  // 连接尾超词缀上限（material > 4）
  ];
  for (const desc of bad) {
    assert.equal(parseOriginalRef(desc, 'selfid00001'), null,
      `应拒收: ${JSON.stringify(desc)}`);
  }
});

test('parseOriginalRef：同行链接优先于文本声明', () => {
  // 文本声明与 YT 链同存一行 → 链接证据（可回源反解）
  assert.deepEqual(
    parseOriginalRef('original：A - B https://youtu.be/dQw4w9WgXcQ'),
    { videoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(
    parseOriginalRef('本家 https://youtu.be/hcjyRnPbCWc（原曲 A - B）'),
    { videoId: 'hcjyRnPbCWc' });
  // 行序优先对文本形态同效——首行声明不成立才轮到次行
  assert.deepEqual(
    parseOriginalRef('本家：周杰伦\n原曲：A - B'),
    { author: 'A', title: 'B' });
  assert.deepEqual(
    parseOriginalRef('本家：周杰伦\n原曲：https://youtu.be/hcjyRnPbCWc'),
    { videoId: 'hcjyRnPbCWc' });
});

// ── resolveOriginalInfo：回源链（globalThis.fetch 桩）────────────────
// fetchPlayer 成功契约：playabilityStatus OK + streamingData 在——
// videoDetails.shortDescription/title/author 是本链消费面

const realFetch = globalThis.fetch;
const playerBody = (over = {}) => ({
  playabilityStatus: { status: 'OK' },
  streamingData: { adaptiveFormats: [] },
  videoDetails: { videoId: 'x', title: 'T', author: 'A', shortDescription: '', ...over },
});
// players[vid]=player 体 | Error | undefined(=无流数据)
let players = {};
const fetchCalls = [];   // 每次 fetch 记的 videoId（player 端点）/url 原文（其它）
const stubFetch = () => {
  fetchCalls.length = 0;
  globalThis.fetch = async (url, opt) => {
    let vid = null;
    try { vid = JSON.parse(opt?.body || '{}')?.videoId ?? null; } catch { /* 非 player 调用 */ }
    fetchCalls.push(vid ?? String(url));
    if (!vid) throw new Error('非 player 调用不给响应');
    const p = players[vid];
    if (p instanceof Error) throw p;
    if (!p) return { ok: true, status: 200, json: async () => ({ playabilityStatus: { status: 'OK' } }) };
    return { ok: true, status: 200, json: async () => p };
  };
};
const restore = () => { globalThis.fetch = realFetch; players = {}; };
const playerFetches = () => fetchCalls.filter(c => /^[A-Za-z0-9_-]{11}$/.test(c));

test('resolveOriginalInfo：描述在手直用——只回本家一跳', async () => {
  stubFetch();
  try {
    players = { hcjyRnPbCWc: playerBody({ title: 'Boi - ポリスピカデリー feat. 可不', author: 'ポリスピカデリー' }) };
    const r = await resolveOriginalInfo({
      videoId: 'selfid00001', description: '歌ってみた\noriginal:https://youtu.be/hcjyRnPbCWc',
    });
    assert.deepEqual(r, {
      videoId: 'hcjyRnPbCWc',
      title: 'Boi - ポリスピカデリー feat. 可不',
      author: 'ポリスピカデリー',
    });
    assert.deepEqual(playerFetches(), ['hcjyRnPbCWc']);   // self 不回源
  } finally { restore(); }
});

test('resolveOriginalInfo：描述缺席补 self 跳；无声明零回本家跳', async () => {
  stubFetch();
  try {
    players = {
      selfid00001: playerBody({ shortDescription: '本家:https://youtu.be/hcjyRnPbCWc' }),
      hcjyRnPbCWc: playerBody({ title: 'Moonlight', author: 'shima' }),
    };
    const r = await resolveOriginalInfo({ videoId: 'selfid00001' });
    assert.deepEqual(r, { videoId: 'hcjyRnPbCWc', title: 'Moonlight', author: 'shima' });
    assert.deepEqual(playerFetches(), ['selfid00001', 'hcjyRnPbCWc']);

    // self 描述无本家链 → 解析即止，不白打第二跳
    fetchCalls.length = 0;
    players = { selfid00001: playerBody({ shortDescription: '只是歌词而已' }) };
    assert.equal(await resolveOriginalInfo({ videoId: 'selfid00001' }), null);
    assert.deepEqual(playerFetches(), ['selfid00001']);
  } finally { restore(); }
});

test('resolveOriginalInfo：描述为空串视为已知空——零回源', async () => {
  stubFetch();
  try {
    assert.equal(await resolveOriginalInfo({ videoId: 'selfid00001', description: '' }), null);
    assert.equal(fetchCalls.length, 0);
  } finally { restore(); }
});

test('resolveOriginalInfo：fail-soft——任一环节失败/缺字段归 null 不抛', async () => {
  stubFetch();
  try {
    // self 跳失败（全形态阵亡）→ null
    players = { selfid00001: new Error('闸控') };
    assert.equal(await resolveOriginalInfo({ videoId: 'selfid00001' }), null);

    // 本家跳失败 → null（不向上冒）
    players = {
      selfid00001: playerBody({ shortDescription: 'original:https://youtu.be/hcjyRnPbCWc' }),
      hcjyRnPbCWc: new Error('不可播放: LOGIN_REQUIRED'),
    };
    assert.equal(await resolveOriginalInfo({ videoId: 'selfid00001' }), null);

    // 本家 player 缺 title → null
    players = {
      selfid00001: playerBody({ shortDescription: 'original:https://youtu.be/hcjyRnPbCWc' }),
      hcjyRnPbCWc: playerBody({ title: '', author: '某人' }),
    };
    assert.equal(await resolveOriginalInfo({ videoId: 'selfid00001' }), null);
  } finally { restore(); }
});

test('resolveOriginalInfo：文本声明形态——零回源直交，videoId 缺席', async () => {
  stubFetch();
  try {
    const r = await resolveOriginalInfo({
      videoId: 'selfid00001',
      description: '歌ってみた\noriginal：ポップしなないで - 早く帰りたい',
    });
    // 文本形态返回 {title,author}——videoId 键整个缺席（无可回源对象）
    assert.deepEqual(r, { title: '早く帰りたい', author: 'ポップしなないで' });
    assert.equal(fetchCalls.length, 0);   // 描述在手 + 文本形态无本家跳
  } finally { restore(); }
});

test('resolveOriginalInfo：文本形态经 self 跳取描述——不再回本家跳', async () => {
  stubFetch();
  try {
    players = { selfid00001: playerBody({ shortDescription: '本家：shima - Moonlight' }) };
    const r = await resolveOriginalInfo({ videoId: 'selfid00001' });
    assert.deepEqual(r, { title: 'Moonlight', author: 'shima' });
    assert.deepEqual(playerFetches(), ['selfid00001']);   // 只有 self 一跳
  } finally { restore(); }
});
