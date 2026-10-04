// 运行时配置覆盖层（app_settings + lib/settings + routes/settings）：
// 覆盖优先/env 回落/掩码回显/整形校验/写面限流 全链钉住。
// DATA_DIR 隔离 + 直接 require 持久层——DB 行为用真库（seed stub 测不出 upsert 语义）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-settings-');
const require = createRequire(import.meta.url);

let settings, repo, aiLib, settingsRoute;
before(() => {
  settings = require('../src/server/lib/settings.js');
  repo = require('../src/server/repositories/settings.js');
  aiLib = require('../src/server/lib/ai.js');
  settingsRoute = require('../src/server/routes/settings.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const ENV_KEYS = ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_TIMEOUT_MS',
  'BILI_COOKIE', 'QQ_COOKIE', 'NEW_QQ_COOKIE'];
const envBackup = {};
before(() => { for (const k of ENV_KEYS) { envBackup[k] = process.env[k]; delete process.env[k]; } });
after(() => { for (const k of ENV_KEYS) {
  if (envBackup[k] === undefined) delete process.env[k];
  else process.env[k] = envBackup[k];
} });

// ── effective 解析：DB 覆盖 > env > 未配置 ──

test('settings.effective：无配置 → 未配置态', () => {
  assert.deepEqual(settings.effective('ai_model'), { value: null, source: null });
});

test('settings.effective：env 回落与 DB 覆盖优先级', () => {
  process.env.AI_MODEL = 'env-model';
  assert.deepEqual(settings.effective('ai_model'), { value: 'env-model', source: 'env' });
  repo.set('ai_model', 'db-model');
  assert.deepEqual(settings.effective('ai_model'), { value: 'db-model', source: 'override' });
  repo.del('ai_model');
  // 覆盖清除后回到 env 而非未配置
  assert.deepEqual(settings.effective('ai_model'), { value: 'env-model', source: 'env' });
  delete process.env.AI_MODEL;
});

test('settings.aiConfig：聚合读取 + timeout 夹取沿用 ai.js 口径', () => {
  process.env.AI_BASE_URL = 'http://127.0.0.1:8317/v1/';
  process.env.AI_API_KEY = 'sk-x';
  process.env.AI_MODEL = 'm1';
  const c1 = settings.aiConfig();
  assert.equal(c1.baseUrl, 'http://127.0.0.1:8317/v1/'); // aiConfig 原样回读——归一化在写入侧
  assert.equal(c1.timeoutMs, 30000); // 缺省
  process.env.AI_TIMEOUT_MS = '999999';
  assert.equal(settings.aiConfig().timeoutMs, 300000); // 上夹
  process.env.AI_TIMEOUT_MS = 'abc';
  assert.equal(settings.aiConfig().timeoutMs, 30000); // 非数字回落
  delete process.env.AI_TIMEOUT_MS;
});

test('settings：aiEnabled 经 settings 层生效——覆盖写库即启用无需重启', () => {
  assert.equal(aiLib.aiEnabled(), true); // 上例 env 三件套仍在
  repo.set('ai_api_key', 'db-key');
  assert.equal(aiLib.aiEnabled(), true);
  delete process.env.AI_API_KEY;
  assert.equal(aiLib.aiEnabled(), true); // DB 覆盖顶上
  repo.del('ai_api_key');
  assert.equal(aiLib.aiEnabled(), false); // 两端都没了
  process.env.AI_API_KEY = 'sk-x';
});

// ── 掩码回显：密值不出进程 ──

test('settings.describeSettings：非密值回显/密值只出 set+hint', () => {
  repo.set('bili_cookie', 'SESSDATA=abcdef123456');
  const d = settings.describeSettings();
  assert.equal(d.ai_model.source, 'env');
  assert.equal(d.ai_model.value, process.env.AI_MODEL); // 'm1'（前测试留存）
  const b = d.bili_cookie;
  assert.equal(b.set, true);
  assert.equal(b.source, 'override');
  assert.equal(b.hint, '••••3456'); // 尾 4 识别，本体不出
  assert.ok(!('value' in b));
  repo.del('bili_cookie');
});

// ── 整形校验 ──

test('settings.normalizeOverride：base_url 归一化/timeout 纯数字/cookie ASCII', () => {
  assert.deepEqual(settings.normalizeOverride('ai_base_url', ' http://x/v1/ ').value, 'http://x/v1');
  assert.equal(settings.normalizeOverride('ai_timeout_ms', '15000').ok, true);
  assert.ok(settings.normalizeOverride('ai_timeout_ms', '15s').error);
  assert.ok(settings.normalizeOverride('bili_cookie', 'a=1\nb=2').error); // 换行=非 ASCII
  assert.equal(settings.normalizeOverride('bili_cookie', 'SESSDATA=x; other=y').ok, true);
  assert.ok(settings.normalizeOverride('nope', 'v').error);
});

test('settings.normalizeOverride：base_url 写时验 scheme/userinfo', () => {
  assert.ok(settings.normalizeOverride('ai_base_url', 'javascript:alert(1)').error);
  assert.ok(settings.normalizeOverride('ai_base_url', 'file:///etc/passwd').error);
  assert.ok(settings.normalizeOverride('ai_base_url', 'not-a-url').error);
  assert.ok(settings.normalizeOverride('ai_base_url', '///').error); // 归一化后空串不 phantom 落库
  // userinfo 内嵌凭据会被 GET 原文回显——Bearer 之外的第二认证通道必须挡
  assert.ok(settings.normalizeOverride('ai_base_url', 'https://user:pass@gateway/v1').error);
  // query/fragment 会被 postChat 裸拼接吞掉路径——test 绿而真实调用 404
  assert.ok(settings.normalizeOverride('ai_base_url', 'http://x/v1?foo=bar').error);
  assert.ok(settings.normalizeOverride('ai_base_url', 'http://x/v1#frag').error);
});

test('settings.normalizeOverride：掩码尾标不可回写为密钥本体', () => {
  // ai_api_key/cookie 全走 secretAscii——'•' 超出 latin1 必被挡
  assert.ok(settings.normalizeOverride('ai_api_key', '••••3456').error);
  assert.ok(settings.normalizeOverride('ai_api_key', 'sk-含中文').error); // 非 ASCII 同挡
  assert.equal(settings.normalizeOverride('ai_api_key', 'sk-normal_ascii123').ok, true);
});

test('settings.aiKeyBoundTo：env 密钥绑定其配置网关 origin', () => {
  process.env.AI_BASE_URL = 'http://gw-a:8317/v1';
  process.env.AI_API_KEY = 'sk-env-key';
  // env 对：密钥随行
  assert.equal(settings.aiKeyBoundTo('http://gw-a:8317/v1'), 'sk-env-key');
  // override URL 同源放行（同网关改路径）
  assert.equal(settings.aiKeyBoundTo('http://gw-a:8317/v2'), 'sk-env-key');
  // override URL 异源——env 密钥不随行（改址即泄 Bearer 的通道）
  assert.equal(settings.aiKeyBoundTo('https://attacker.example'), null);
  // DB 覆盖密钥是管理员显式入值——绑定豁免
  repo.set('ai_api_key', 'sk-db-key');
  assert.equal(settings.aiKeyBoundTo('https://attacker.example'), 'sk-db-key');
  repo.del('ai_api_key');
  // aiConfig 聚合后同口径：异源 override 使 env 密钥缺席 → AI 停用而非泄露
  repo.set('ai_base_url', 'https://attacker.example');
  assert.equal(settings.aiConfig().apiKey, null);
  assert.equal(aiLib.aiEnabled(), false);
  repo.del('ai_base_url');
});

test('settings.persistRenewedQqCookie：续期按来源归位，在飞改动不被旧值盖掉', () => {
  process.env.QQ_COOKIE = 'env-account-A';
  try {
    // DB override（账号 B）发起的续期——回 DB，不写 env 槽：
    // 否则清掉 override 后回落到的是账号 B 而非 env 的账号 A（静默换主）
    repo.set('qq_cookie', 'cookie-B');
    settings.persistRenewedQqCookie('renewed-B', 'cookie-B');
    assert.equal(repo.get('qq_cookie'), 'renewed-B');
    assert.equal(process.env.NEW_QQ_COOKIE, undefined);

    // env 链（账号 A）发起的续期——回 NEW_QQ_COOKIE
    repo.del('qq_cookie');
    settings.persistRenewedQqCookie('renewed-A', 'env-account-A');
    assert.equal(process.env.NEW_QQ_COOKIE, 'renewed-A');

    // 在飞窗口内 override 被改：旧凭据续期值既不盖新 override 也不渗 env
    repo.set('qq_cookie', 'cookie-v2');
    settings.persistRenewedQqCookie('renewed-v1', 'cookie-v1');
    assert.equal(repo.get('qq_cookie'), 'cookie-v2');
    assert.equal(process.env.NEW_QQ_COOKIE, 'renewed-A'); // 未被 renewed-v1 污染

    // 在飞窗口内 env 被换：envCur 与快照不符 → 不盖新 env
    process.env.QQ_COOKIE = 'env-account-C';
    delete process.env.NEW_QQ_COOKIE;
    settings.persistRenewedQqCookie('renewed-A2', 'env-account-A');
    assert.equal(process.env.NEW_QQ_COOKIE, undefined);
  } finally {
    repo.del('qq_cookie');
    delete process.env.QQ_COOKIE;
    delete process.env.NEW_QQ_COOKIE;
  }
});

test('settings.persistRenewedQqCookie：脏行归一化后吻合也照写', () => {
  // 写库侧挡过非 ASCII，但旧库/手工行可能带脏——比对口径须与 qqCookie()
  // 消费口径一致，否则续期值在 override 阴影下永远落不进 DB
  repo.set('qq_cookie', ' cookie-dirty\u4e2d ');
  settings.persistRenewedQqCookie('renewed-dirty', 'cookie-dirty');
  assert.equal(repo.get('qq_cookie'), 'renewed-dirty');
  repo.del('qq_cookie');
  delete process.env.NEW_QQ_COOKIE;
});

test('settings.aiKeyBoundTo：非法字符的 env 密钥按未配置处理', () => {
  // env 直配未过写入校验——带 \n 的 key 会在 undici 头校验异常里被原文
  // 回显，绑定层必须拒发（不读值、不落日志）
  process.env.AI_BASE_URL = 'http://gw:8317';
  process.env.AI_API_KEY = 'sk-bad\nkey';
  assert.equal(settings.aiKeyBoundTo('http://gw:8317'), null);
  assert.equal(settings.aiConfig().apiKey, null);
  process.env.AI_API_KEY = 'sk-good';
  assert.equal(settings.aiKeyBoundTo('http://gw:8317'), 'sk-good');
});

test('settings.describeSettings：qq_cookie 认 NEW_QQ_COOKIE 续期链首命中', () => {
  process.env.QQ_COOKIE = 'orig-cookie-aaaa';
  process.env.NEW_QQ_COOKIE = 'renewed-cookie-bbbb';
  const d = settings.describeSettings();
  assert.equal(d.qq_cookie.set, true);
  assert.equal(d.qq_cookie.source, 'env');
  assert.equal(d.qq_cookie.hint, '••••bbbb'); // 尾标出自续期值而非原始值
  delete process.env.NEW_QQ_COOKIE;
});

// ── 路由层：GET/PUT 全链 ──

test('GET /settings：字段投影 + ai 汇总', async () => {
  const res = await settingsRoute.request('http://t/settings');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.code, 200);
  assert.equal(body.fields.ai_base_url.source, 'env');
  assert.equal(body.ai.enabled, true);
});

test('PUT /settings：写覆盖 → 清空回落 env → 整单生效', async () => {
  let res = await settingsRoute.request('http://t/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai_model: 'ui-model', ai_timeout_ms: '60000' }),
  });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.fields.ai_model.value, 'ui-model');
  assert.equal(body.fields.ai_model.source, 'override');
  assert.equal(settings.aiConfig().timeoutMs, 60000);

  // '' 清覆盖回落 env——「留空读服务端配置」语义
  res = await settingsRoute.request('http://t/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai_model: '', ai_timeout_ms: null }),
  });
  body = await res.json();
  assert.equal(body.fields.ai_model.source, 'env');
  assert.equal(body.fields.ai_timeout_ms.source, null);
});

test('PUT /settings：非法值整单 400——部分落库的半配置态不存在', async () => {
  const res = await settingsRoute.request('http://t/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai_model: 'should-not-land', ai_timeout_ms: 'NaN' }),
  });
  assert.equal(res.status, 400);
  assert.equal(repo.get('ai_model'), null); // 首键也未落
});

test('PUT /settings：未知键不挡白名单键（looseObject 口径一致）', async () => {
  const res = await settingsRoute.request('http://t/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hacker_key: 'x', ai_model: 'fine-model' }),
  });
  assert.equal(res.status, 200);
  assert.equal(repo.get('ai_model'), 'fine-model');
  repo.del('ai_model');
});

test('POST /settings/ai-test：密钥回落过 origin 绑定 + 上游形态映射', async (t) => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const okRes = (payload) => ({
    ok: true, status: 200,
    // 路由经 Readable.fromWeb 读体——stub 必须产真 web ReadableStream
    body: Readable.toWeb(Readable.from([Buffer.from(JSON.stringify(payload))])),
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    return okRes({ data: [{ id: 'm1' }, { id: 'm2' }] });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  // env 对：base/key/model 均 env——留空探测走生效配置
  process.env.AI_BASE_URL = 'http://gw-a:8317/v1';
  process.env.AI_API_KEY = 'sk-env';
  process.env.AI_MODEL = 'm1';
  let res = await settingsRoute.request('http://t/settings/ai-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  let body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.modelCount, 2);
  assert.equal(body.modelFound, true);
  assert.equal(calls.at(-1).url, 'http://gw-a:8317/v1/models');
  assert.equal(calls.at(-1).auth, 'Bearer sk-env');

  // 草稿 URL 异源 + 留空 key——不得拿 env 密钥去测（B1 收口钉）
  res = await settingsRoute.request('http://t/settings/ai-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://attacker.example' }),
  });
  body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'key-bound'); // 密钥在位但被 origin 绑定扣下
  assert.equal(calls.length, 1); // 未发出任何上游请求

  // 显式草稿 key + 异源 URL——管理员自输的密钥允许随行
  res = await settingsRoute.request('http://t/settings/ai-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://gw-b.example', apiKey: 'sk-draft' }),
  });
  body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(calls.at(-1).auth, 'Bearer sk-draft');

  // 非法 base_url 短路与未配齐短路
  res = await settingsRoute.request('http://t/settings/ai-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'javascript:x', apiKey: 'k' }),
  });
  assert.equal((await res.json()).reason, 'bad-url');

  // 草稿 URL 异源 + env 密钥在位 → key-bound（区分「没配」与「绑定扣下」）
  res = await settingsRoute.request('http://t/settings/ai-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://attacker.example' }),
  });
  assert.equal((await res.json()).reason, 'key-bound');

  // 含非法字符的草稿 key → bad-key，不触达上游、不回显值
  res = await settingsRoute.request('http://t/settings/ai-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'http://gw-a:8317', apiKey: 'sk-a\nb' }),
  });
  body = await res.json();
  assert.equal(body.reason, 'bad-key');
  assert.equal(body.message.includes('sk-a'), false); // 错误文案不携密钥
});

test('POST /settings/ai-test：上游非 2xx 与异常形态', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => ({
    ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0),
  });
  let res = await settingsRoute.request('http://t/settings/ai-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'http://gw-a:8317', apiKey: 'k' }),
  });
  let body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, 401);

  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  res = await settingsRoute.request('http://t/settings/ai-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'http://gw-a:8317', apiKey: 'k' }),
  });
  body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.message, /ECONNREFUSED/);
});

test('PUT /settings：空 body/纯未知键 → 400 无可写项', async () => {
  let res = await settingsRoute.request('http://t/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 400);
  res = await settingsRoute.request('http://t/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unknown_only: 'x' }),
  });
  assert.equal(res.status, 400);
});

test('PUT /settings：原型链继承成员名过不了键白名单', async () => {
  // DEFS 是 null-proto 映射——'toString'/'constructor' 不再 truthy，
  // 全部落进未知键过滤；单发它们=无有效键 → 400，混发=只写白名单键
  let res = await settingsRoute.request('http://t/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toString: 'x', constructor: 'y' }),
  });
  assert.equal(res.status, 400);
  assert.equal(repo.get('toString'), null);
  assert.equal(repo.get('constructor'), null);
  res = await settingsRoute.request('http://t/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hasOwnProperty: 'z', ai_model: 'still-fine' }),
  });
  assert.equal(res.status, 200);
  assert.equal(repo.get('ai_model'), 'still-fine');
  assert.equal(repo.get('hasOwnProperty'), null);
  repo.del('ai_model');
});
