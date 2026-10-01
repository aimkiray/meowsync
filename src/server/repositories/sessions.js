// sessions 表：opaque token 会话。id 存 sha256(token)——DB 泄露不等于会话泄露。
// 滑动续期节流：last_seen_at 距今 < TOUCH_MIN_INTERVAL 不写字（/audio-proxy
// 的 Range 请求高频，逐请求写 WAL 是纯放大）；expires_at 滑到 not_after 封顶。
const { getDb } = require('../db/client');
const crypto = require('crypto');

const IDLE_TTL_MS = 14 * 24 * 3600 * 1000;   // 空闲 14 天过期
const ABSOLUTE_TTL_MS = 90 * 24 * 3600 * 1000; // 绝对 90 天上限（重登录周期）
const TOUCH_MIN_INTERVAL_MS = 15 * 60 * 1000; // 写节流：15min 内不重复 UPDATE

function tokenId(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function createSession(userId, { ip = '', userAgent = '' } = {}) {
  const db = getDb();
  const now = Date.now();
  const raw = crypto.randomBytes(32).toString('base64url');
  db.prepare(`
    INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, not_after, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tokenId(raw), userId, now, now, now + IDLE_TTL_MS, now + ABSOLUTE_TTL_MS,
    String(ip).slice(0, 64), String(userAgent).slice(0, 256));
  return raw;
}

// 命中返回 {userId, username, role}；节流滑动续期；过期/未知返回 null
function resolveSession(rawToken) {
  if (!rawToken) return null;
  const db = getDb();
  const now = Date.now();
  const row = db.prepare(`
    SELECT s.id, s.user_id, s.last_seen_at, s.expires_at, s.not_after,
           u.username, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(tokenId(rawToken));
  if (!row) return null;
  if (row.expires_at <= now || row.not_after <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }
  if (now - row.last_seen_at > TOUCH_MIN_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(now, Math.min(now + IDLE_TTL_MS, row.not_after), row.id);
  }
  return { userId: row.user_id, username: row.username, role: row.role };
}

// 只读探活版 resolve：不写 last_seen/不删过期行（/auth/status 是 GET——
// 读路径带写副作用会让爬虫/预取/双击都触发 WAL 写；过期行留给 sweeper）
function peekSession(rawToken) {
  if (!rawToken) return null;
  const db = getDb();
  const now = Date.now();
  const row = db.prepare(`
    SELECT s.expires_at, s.not_after, s.user_id, u.username, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(tokenId(rawToken));
  if (!row || row.expires_at <= now || row.not_after <= now) return null;
  return { userId: row.user_id, username: row.username, role: row.role };
}

function deleteSession(rawToken) {
  if (!rawToken) return;
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(tokenId(rawToken));
}

// 改密/「登出所有设备」用
function deleteAllForUser(userId) {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// 过期行清扫（启动即跑 + 每小时，定时器 unref 不拦退出）
function sweepExpired() {
  getDb().prepare('DELETE FROM sessions WHERE expires_at < ? OR not_after < ?')
    .run(Date.now(), Date.now());
}

module.exports = {
  createSession, resolveSession, peekSession, deleteSession, deleteAllForUser,
  sweepExpired, IDLE_TTL_MS, ABSOLUTE_TTL_MS
};
