// app_settings KV 持久层——运行时配置覆盖（留空=回落环境变量）。
// 键白名单与读取语义在 lib/settings.js，这里只管原样存取
const { getDb } = require('../db/client');

function get(key) {
  return getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
}

function set(key, value) {
  getDb().prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(key, String(value));
}

function del(key) {
  getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}

// 多键写事务化——半落库的混合配置态比整单失败更难排查
function applyOps(ops) {
  const db = getDb();
  db.transaction(() => {
    for (const op of ops) {
      if (op.value == null) del(op.key);
      else set(op.key, op.value);
    }
  })();
}

module.exports = { get, set, del, applyOps };
