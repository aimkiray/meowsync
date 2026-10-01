// users 表：登录主体。username NOCASE UNIQUE——登录大小写不敏感；
// password_hash 是 PHC 自描述串（lib/password.js），本层不验只管存取
const { getDb } = require('../db/client');

function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function findByUsername(username) {
  return getDb().prepare(
    'SELECT id, username, password_hash, role FROM users WHERE username = ?'
  ).get(String(username || ''));
}

// UNIQUE(username) 是并发 setup 的最后防线——重复插入抛错由路由层转 409
function createUser(username, passwordHash, role = 'admin') {
  const r = getDb().prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).run(String(username), String(passwordHash), String(role));
  return { id: r.lastInsertRowid, username, role };
}

function updatePasswordHash(userId, passwordHash) {
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(String(passwordHash), userId);
}

module.exports = { countUsers, findByUsername, createUser, updatePasswordHash };
