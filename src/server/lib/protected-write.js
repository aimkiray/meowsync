// 可选写操作鉴权（DOWNLOAD_TOKEN 写闸）：token 设置后，前缀表内路径的
// 非 GET/HEAD 请求必须携带匹配的 x-download-token 头——局域网部署时防止
// 任意主机触发下载把磁盘写满/改库。同一 token 在 authGate 里是服务对服务/
// 脚本的全量 API 旁路凭据（含 GET）；浏览器登录态（session cookie）视为
// 等效凭据：启用登录后浏览器不再构建期注入 token。
// 原为 server.js 内联中间件——lib 化让闸面可挂测（与 authGate 同款），
// 路径表与令牌判定各只有一份真相。
// 懒读 env（每请求取）而非启动快照——启动时未设、运行后注入
// DOWNLOAD_TOKEN 也必须生效，与 authGate 的口径一致
const { sessionFromCookieHeader } = require('./auth-gate');
const { tokenMatches } = require('./token-eq');

// 写面首段表：命中段的非 GET/HEAD 请求入闸（GET/HEAD 读面恒豁免——
// 闸只挡写）。/lyric 段覆盖手选词面的写端点（/lyric/manual POST 绑词会
// 触发上游取词+整行落库、DELETE 解绑写库）；同段的 /lyric/candidates 与
// /lyric/external 是 GET-only——形态在表内但方法豁免，读面不受影响。
// /lyric-align 是独立首段（'/lyric/' 前缀匹配不到它），本就单列在表；
// '/unlock' 同型——/unlock/manual 的 POST/DELETE 会写库+触发上游取流
// 验证，属写面；同段 /unlock/candidates 是 GET-only 不受影响
const PROTECTED_WRITE_PREFIXES = [
  '/downloads', '/playlists', '/ai', '/settings', '/song-meta',
  '/match', '/uploads', '/lyric-align', '/lyric', '/unlock', '/sync',
];
const isProtectedWritePath = (p) => PROTECTED_WRITE_PREFIXES
  .some((px) => p === px || String(p).startsWith(`${px}/`));

async function protectedWrite(c, next) {
  const downloadToken = process.env.DOWNLOAD_TOKEN || '';
  if (!downloadToken) return next();
  if (!isProtectedWritePath(c.req.path)
    || c.req.method === 'GET' || c.req.method === 'HEAD') {
    return next();
  }
  // 已登录会话放行（authGate 已验过并 set('user')——直接消费不二次查库）
  if (c.get('user') || sessionFromCookieHeader(c.req.header('cookie'))) return next();
  // 与 authGate/remote.js/qq.js 同一份 tokenMatches——手写 sha256+
  // timingSafeEqual 的又一拷贝会漂（且裸 digest 比较缺空值保护）
  if (!tokenMatches(c.req.header('x-download-token'), downloadToken)) {
    return c.json({ code: 401, message: '未授权：缺少或错误的下载令牌' }, 401);
  }
  return next();
}

module.exports = { protectedWrite, isProtectedWritePath, PROTECTED_WRITE_PREFIXES };
