// 运行时配置覆盖层：设置页写入 app_settings 表，留空（无行）回落环境变量。
// 各 env 消费点改为经本层取值——DB 覆盖优先于 process.env。
//
// 键注册表即文档与校验单点：
//   env      — 回落的环境变量名
//   secret   — true 时 GET 只回存在性+尾标，值不出进程（同 BILI_COOKIE 口径）
//   maxLen   — 入库上限（cookie 级长串 4000，其余短值）
//   secretAscii — 请求头负载（cookie/authorization 要求 latin1）：含非 ASCII
//                 控制字符的粘贴串会在 undici 头校验静默炸掉整源请求——写入前
//                 直接 400 比落库后逐请求报错诚实
const repo = require('../repositories/settings');

const DEFS = Object.assign(Object.create(null), {
  ai_base_url: {
    env: 'AI_BASE_URL', secret: false, maxLen: 500,
    norm: (v) => v.trim().replace(/\/+$/, ''),
  },
  ai_api_key: { env: 'AI_API_KEY', secret: true, maxLen: 500, secretAscii: true },
  ai_model: { env: 'AI_MODEL', secret: false, maxLen: 200 },
  ai_timeout_ms: {
    env: 'AI_TIMEOUT_MS', secret: false, maxLen: 10,
    norm: (v) => String(v).trim(),
  },
  bili_cookie: { env: 'BILI_COOKIE', secret: true, maxLen: 4000, secretAscii: true },
  // env 链首命中：NEW_QQ_COOKIE 是续期回写的最新凭据（qm_keyst ~3d 轮换），
  // QQ_COOKIE 是管理员原始配置——回显与回退都必须先认新值
  qq_cookie: { env: ['NEW_QQ_COOKIE', 'QQ_COOKIE'], secret: true, maxLen: 4000, secretAscii: true },
  // YouTube 登录态 cookie：匿名 Innertube 全形态吃反机器人墙（「请登录，
  // 以便我们确认你不是聊天机器人」→ /stream 502）——登录态 WEB 档绕行；
  // SAPISID 系键供 SAPISIDHASH 签名（消费侧在 lib/youtube.js）
  yt_cookie: { env: 'YT_COOKIE', secret: true, maxLen: 4000, secretAscii: true },
  // YouTube 出站代理（http(s)://[user:pass@]host:port）：secret 管——
  // URL 可内嵌代理凭据，GET 只回存在性；消费侧三面接线在 lib/yt-proxy.js
  yt_proxy: {
    env: 'YT_PROXY', secret: true, maxLen: 500, secretAscii: true,
    // 尾标先剥 userinfo：短 host 值（'http://u:p@h'）的原值尾 4 会带上
    // 密码尾——尾标只许出自 host/port/路径段；畸形值干脆无标
    hintOf: (v) => {
      try {
        const u = new URL(v);
        u.username = u.password = '';
        return u.href;
      } catch { return ''; }
    },
  },
});

const KEYS = Object.keys(DEFS);

// 覆盖值校验/整形：返回 {ok, value} 或 {error}——路由层把 error 变 400。
// ''/null 语义=清覆盖回落 env，不进本函数（路由层 delete 分流）
function normalizeOverride(key, raw) {
  const def = DEFS[key];
  if (!def) return { error: `未知配置项 ${key}` };
  const v = String(raw ?? '').trim();
  if (!v) return { error: '空值请传 null 或空串语义（由路由层清覆盖）' };
  if (v.length > def.maxLen) return { error: `${key} 超长（上限 ${def.maxLen}）` };
  if (def.secretAscii && /[^\x20-\x7e]/.test(v)) {
    return { error: `${key} 含非 ASCII 字符——本字段只能纯 ASCII` };
  }
  const normed = def.norm ? def.norm(v) : v;
  if (key === 'ai_timeout_ms' && !/^\d+$/.test(normed)) {
    return { error: 'ai_timeout_ms 须为正整数毫秒' };
  }
  // 写时验 scheme——javascript:/file: 类值落库后 aiEnabled 照亮、
  // 每次调用才在 fetch 层炸，比落库前的 400 难排查得多
  if (key === 'ai_base_url') {
    try {
      const u = new URL(normed);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
      // userinfo 内嵌凭据会被 GET 原文回显——Bearer 已是认证通道，URL 不许带密
      if (u.username || u.password) throw new Error('userinfo');
      // query/fragment 会被 postChat 裸拼接吞掉路径（?q=/chat/completions）——
      // 写时拒掉，否则 ai-test 绿而真实调用全 404
      if (u.search || u.hash) throw new Error('query');
    } catch {
      return { error: 'ai_base_url 须为不含凭据的合法 http(s) 地址' };
    }
  }
  // 代理 URL 写时验：与 ai_base_url 相反——userinfo（u:p@）恰是代理凭据的
  // 常规位，不挡；只验可解析 + scheme。SOCKS 不收的理由见 lib/yt-proxy.js
  // 头注；环境变量直配的畸形值由消费侧 youtubeProxy() 按未配置降级兜底
  if (key === 'yt_proxy') {
    try {
      const u = new URL(normed);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
      // ':0' 能过 URL parser（port 归一成 '0'）但不是可拨端口——agent
      // 建连才炸不如写时即拒（超界端口 parser 自拒，这里只补 0）
      if (u.port === '0') throw new Error('port');
      // userinfo 的 percent 形态消费侧要 decodeURIComponent——'%zz' 能过
      // URL parser 但拆凭据时炸，写时即拒（消费侧 youtubeProxy 同款兜底）
      if (u.username || u.password) {
        decodeURIComponent(u.username);
        decodeURIComponent(u.password);
      }
    } catch {
      return { error: 'yt_proxy 须为合法 http(s) 代理地址（可内嵌 user:pass@ 凭据）' };
    }
  }
  return { ok: true, value: normed };
}

// 生效值解析：DB 覆盖 > env（链首命中）> 未配置
function effective(key) {
  const def = DEFS[key];
  if (!def) return { value: null, source: null };
  const ov = repo.get(key);
  if (ov != null && ov !== '') return { value: ov, source: 'override' };
  const envs = Array.isArray(def.env) ? def.env : [def.env];
  for (const name of envs) {
    const v = (process.env[name] || '').trim();
    if (v) return { value: v, source: 'env' };
  }
  return { value: null, source: null };
}

const effectiveValue = (key) => effective(key).value;

const sameOrigin = (a, b) => {
  try { return new URL(a).origin === new URL(b).origin } catch { return false }
};

// 按值去重——坏值热改换新要重新告警，同一坏值不重复刷日志（值不落日志）
let warnedUnsafeKey = '';

// 密钥↔网关绑定：env AI_API_KEY 只发往 env AI_BASE_URL 的同源地址——
// 覆盖层（会话可写）把 base_url 指到别站时 env 密钥不随行，否则
// PUT 一次改址即把 Bearer 泄到陌生主机。override 层密钥是管理员
// 显式入值的，绑定豁免。返回 null = 该址不可携带生效密钥
function aiKeyBoundTo(url) {
  if (!url) return null;
  const k = effective('ai_api_key');
  if (!k.value) return null;
  // header 负载要求 latin1：env 直配未过写入校验——带控制字符/非 ASCII
  // 的密钥会在 undici 头校验异常里被原文回显，按未配置处理
  if (/[^\x20-\x7e]/.test(k.value)) {
    if (warnedUnsafeKey !== k.value) {
      warnedUnsafeKey = k.value;
      console.warn('[settings] AI_API_KEY 含非法字符（header 只允许 latin1）——按未配置处理');
    }
    return null;
  }
  if (k.source === 'override') return k.value;
  return sameOrigin((process.env.AI_BASE_URL || '').trim(), url) ? k.value : null;
}

// AI 配置聚合（lib/ai.js 消费）：timeout 沿用 ai.js 原解析口径——
// 非数字回落 30000、夹取 [1000,300000]
function aiConfig() {
  const baseUrl = effectiveValue('ai_base_url');
  return {
    baseUrl,
    apiKey: aiKeyBoundTo(baseUrl),
    model: effectiveValue('ai_model'),
    timeoutMs: Math.min(Math.max(
      parseInt(effectiveValue('ai_timeout_ms'), 10) || 30000, 1000), 300000),
  };
}

// QQ cookie 的 DB 覆盖判定：只答「DB 有没有覆盖行」。env 链编排
// （override > NEW_QQ_COOKIE > QQ_COOKIE）在 qq.js qqCookie() 里——
// 与 effective() 的回落语义等价，但本函数还要区分「覆盖存在性」给续期写回用
function qqCookieOverride() {
  const v = repo.get('qq_cookie');
  return v != null && v !== '' ? v : null;
}

// 续期写回按来源归位：被续的是 override 串 → 回 DB；是 env 链串 → 回
// NEW_QQ_COOKIE。两层混写会让覆盖账号的凭据渗进 env 回落位——清掉
// override 后静默换成另一个账号在线（有效凭据、错误主体）。
// expectedCookie=发起续期时读到的串：在飞期间 override/env 任一被改
// 就不许旧凭据的续期值盖掉新值（refresh_token 会把旧账号链一路续下去）
function persistRenewedQqCookie(value, expectedCookie) {
  const strip = (s) => (s || '').trim().replace(/[^\x20-\x7e]/g, '');
  const cur = repo.get('qq_cookie');
  if (cur != null && strip(cur) === expectedCookie) {
    repo.set('qq_cookie', value);
    return;
  }
  const envCur = strip(process.env.NEW_QQ_COOKIE || process.env.QQ_COOKIE);
  if (envCur === expectedCookie) process.env.NEW_QQ_COOKIE = value;
}

// GET /settings 响应投影：非密值全量回显（输入框可当占位符），
// 密值只出 {set, hint}——密钥类值不出进程的既有口径不因设置页开口
// ≥10 才出尾标——短密钥露 4 位等于把有效熵砍掉大半
const maskHint = (v) => (v && v.length >= 10 ? `••••${v.slice(-4)}` : '••••');

function describeSettings() {
  const out = {};
  for (const key of KEYS) {
    const def = DEFS[key];
    const e = effective(key);
    out[key] = def.secret
      ? { source: e.source, set: e.value != null, hint: e.value ? maskHint(def.hintOf ? def.hintOf(e.value) : e.value) : null }
      : { source: e.source, value: e.value };
  }
  return out;
}

module.exports = {
  DEFS, KEYS, normalizeOverride, effective, effectiveValue,
  aiConfig, aiKeyBoundTo, qqCookieOverride, persistRenewedQqCookie, describeSettings,
};
