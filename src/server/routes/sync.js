// 多端同步路由：通用 KV 同步面，item_key 三前缀命名空间
//   playlist:<id>  歌单粒度 LWW 单元（value=slimTrack 后的歌单对象）
//   doc:<lsKey>    整文档 LWW（播放状态/历史/偏好等 localStorage 键）
//   lib:index      歌单库级元数据（歌单顺序 + removedDefaultPlaylists 删除名单）
// 服务端只校验 key 形状不解释语义——新命名空间前端自定，服务端零改动。
// user_id 分域：登录态=users.id；无会话（开放局域网/DOWNLOAD_TOKEN 旁路）
// 落 'default' 单桶——多用户接口预留点，表结构第一天就按 user 分域。
// 时序分层：updatedAt=客户端钟只当 LWW 判优；交付水位线走服务端单调
// seq（pull 的 since 是 seq 域）——两侧时钟域不混用。
// 门禁：两端点都在 authGate 后（登录态数据）；push 另加 csrfOriginOk 纵深
// + protectedWrite 前缀集（server.js）；两端点各有独立限流桶。
const { Hono } = require('hono');
const { csrfOriginOk, sessionTokenFromCookie } = require('../lib/auth-gate');
const { rateLimit } = require('../lib/rate-limit');
const { readJsonBody } = require('../lib/http-body');
const { fail, handleError } = require('../lib/http-error');
const sessionsRepo = require('../repositories/sessions');
const syncItems = require('../repositories/syncItems');

const app = new Hono();

// 单页上限：歌单库全量回拉可达千级 slimTrack 项——防巨型响应；
// 续拉天然 keyset：回包末行 seq 喂回 since 即下一页（无独立游标）
const PAGE_SIZE = 2000;
// 批量/单值硬顶：超限整批拒——静默截断后回 "成功" 的同步是最难排的
// 数据损坏；body 另加 8MB 硬顶防内存型 DoS（理论 500×256KB=128MB 不收，
// 真到量级的客户端自行分批——changes 上限本来就是分批协议）
const MAX_CHANGES = 500;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// 单页字节预算（pull）：PAGE_SIZE×MAX_VALUE_BYTES 的理论最坏 ~512MB/页——
// 超预算即截页置 hasMore，客户端以页末行 seq 续拉（keyset 语义不变）
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
// 整批 value 字节预算（push）：单值 256KB×500 条理论面 ~128MB/请求，配合
// 30/min 的限流桶仍是 ~14GB/h 的磁盘膨胀通道——请求级总预算 4MB 与 pull
// 单页预算同量级收口。表级总配额（SUM(LENGTH(value_json)) 式存量核算）
// 没有廉价落点（要全桶扫/额外汇总表），本次只收请求级预算
const MAX_BATCH_VALUE_BYTES = 4 * 1024 * 1024;
// 客户端未来戳宽容窗：钟漂 5min 内放行（设备校时误差常态），
// 超窗该条诚拒进 rejected——静默 clamp 会藏起钟坏设备
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// user_id 取值链：authGate 已验会话挂 c.get('user')（登录态主路径）；
// cookie 兜底解析覆盖路由直挂（不经 authGate）与 DOWNLOAD_TOKEN 旁路
// （无 cookie → 'default' 单桶）。
// 会话解析器分路径：GET 用 peekSession 纯读判定——resolveSession 的
// 滑动续期 WAL 写在高频轮询读路径是纯放大；写路径保留 resolveSession
// （续期语义本就该随活跃写走）。裸 token 切分收敛在 auth-gate.js 的
// sessionTokenFromCookie——两份拷贝曾各写一遍解析半区
function syncUserId(c, resolve) {
  const sess = c.get('user') || resolve(sessionTokenFromCookie(c.req.header('cookie')));
  return sess ? String(sess.userId) : 'default';
}

// GET /sync/pull?since=<seq>
// since 是交付水位线：服务端单调 seq 域（非时钟域！）——seq > since
// 严格大于；缺省/0=全量（含墓碑行——删除靠墓碑传播）。客户端续拉拿
// 回包末行 seq 喂回 since。{items[{key,value,updatedAt,deleted,seq}],
// serverTime(诊断用，勿回喂 since), hasMore?, reset?}
// reset：since 越顶（>本桶 max(seq)——旧契约 ms 大数/服务端重建遗留）
// 触发的自愈全量重发标记（repo 层判定），仅诊断提示不携带语义
app.get('/sync/pull', (c) => {
  // 登录态/个人数据面：session 分支 authGate 已盖 no-store，token 旁路/
  // 开放态路径不被盖——显式补齐（与 /settings GET 同口径）
  c.header('Cache-Control', 'no-store');
  if (!rateLimit(c, 'sync-pull', 30)) {
    return fail(c, 429, '请求太频繁，稍后再试');
  }
  // since：脏值（非有限/负数）按 400 拦——静默吞成全量拉会把"增量丢数据"
  // 的客户端 bug 藏成"每次全量都正常"的假象
  const rawSince = c.req.query('since');
  let since = 0;
  if (rawSince !== undefined && rawSince !== '') {
    since = Number(rawSince);
    if (!Number.isFinite(since) || since < 0) {
      return fail(c, 400, '非法 since');
    }
  }
  // cursor 退役兼容位：在途旧客户端仍会带上——收下但不校验不解释
  // （seq 序天然 keyset，since 本身就是续拉游标）；响应不再发 nextCursor
  try {
    const page = syncItems.listChanges(
      syncUserId(c, sessionsRepo.peekSession),
      { since, limit: PAGE_SIZE, maxBytes: MAX_PAGE_BYTES });
    return c.json({
      code: 200,
      items: page.items,
      serverTime: Date.now(),
      ...(page.hasMore ? { hasMore: true } : {}),
      ...(page.reset ? { reset: true } : {})
    });
  } catch (error) {
    return handleError(c, error, '[sync/pull]');
  }
});

// POST /sync/push {changes:[{key,value,updatedAt,deleted}]}
// 逐条 LWW：updatedAt 大者赢进 applied；平局/过期进 conflicts（回包服务端
// 现值含 key/seq，客户端采纳对齐）；条目级非法（key 形状/updatedAt 非有限
// 正数/超未来戳窗）进 rejected——整批不炸。体量级超限（changes>500 /
// 单 value>256KB / 整批 value 总字节>4MB）整批 400
app.post('/sync/push', async (c) => {
  // 写请求 CSRF 纵深（与 routes/match.js 同口径）：session 写 authGate 已查，
  // 但 DOWNLOAD_TOKEN 旁路/开放部署不经那一道——无登录态下跨站 POST 也能
  // 改库，不是登录态专属风险
  if (!csrfOriginOk(c)) return fail(c, 403, 'Forbidden');
  if (!rateLimit(c, 'sync-push', 30)) {
    return fail(c, 429, '请求太频繁，稍后再试');
  }
  let body;
  try {
    body = await readJsonBody(c, MAX_BODY_BYTES);
  } catch (e) {
    if (e?.exposed === true && e?.status === 413) {
      return fail(c, 413, 'Payload Too Large');
    }
    throw e;
  }
  const changes = body?.changes;
  if (!Array.isArray(changes)) return fail(c, 400, 'changes 须为数组');
  if (changes.length > MAX_CHANGES) {
    return fail(c, 400, `changes 超过单次 ${MAX_CHANGES} 条上限`);
  }
  const serverNow = Date.now();
  // 逐条整形：条目级非法入 rejected（整批不炸）；体量级超限整批拒。
  // batchBytes 只累计过形状闸的条目——被拒条目不占写盘预算
  const valid = [];
  const rejected = [];
  let batchBytes = 0;
  for (const ch of changes) {
    const key = typeof ch?.key === 'string' ? ch.key : '';
    if (!syncItems.ITEM_KEY_RE.test(key)) {
      rejected.push({ key: key || null, reason: 'invalid key' });
      continue;
    }
    if (!(Number.isFinite(ch?.updatedAt) && ch.updatedAt > 0)) {
      rejected.push({ key, reason: 'invalid updatedAt' });
      continue;
    }
    if (ch.updatedAt > serverNow + FUTURE_TOLERANCE_MS) {
      rejected.push({ key, reason: 'future-timestamp' });
      continue;
    }
    // 严格布尔：'false'/'1' 这类脏值不得成墓碑（Boolean('false')===true
    // 会把活数据写成删除态——数据丢失方向）。按归一值算串形——字节闸
    // 量的是真实落库 payload，不是原始请求的脏形态
    const deleted = ch.deleted === true;
    const valueJson = syncItems.valueJsonOf({ value: ch.value, deleted });
    const valueBytes = Buffer.byteLength(valueJson, 'utf8');
    if (valueBytes > MAX_VALUE_BYTES) {
      return fail(c, 400, `单条 value 超过 ${MAX_VALUE_BYTES / 1024}KB 上限（${key}）`);
    }
    batchBytes += valueBytes;
    if (batchBytes > MAX_BATCH_VALUE_BYTES) {
      return fail(c, 400, `整批 value 总字节超过 ${MAX_BATCH_VALUE_BYTES / 1024 / 1024}MB 上限`);
    }
    valid.push({ key, value: ch.value, updatedAt: ch.updatedAt, deleted });
  }
  try {
    const { applied, conflicts } = syncItems.applyChanges(
      syncUserId(c, sessionsRepo.resolveSession), valid);
    return c.json({ code: 200, applied, conflicts, rejected });
  } catch (error) {
    return handleError(c, error, '[sync/push]');
  }
});

module.exports = app;
