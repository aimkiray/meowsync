const fs = require('fs');
const os = require('os');
const path = require('path');

function ensureAnonymousToken(tokenPath = path.join(os.tmpdir(), 'anonymous_token')) {
  try {
    if (!fs.existsSync(tokenPath)) {
      fs.writeFileSync(tokenPath, '', 'utf8');
    }
  } catch (error) {
    // tmpdir 不可写或路径冲突时仅告警，不阻断启动
    console.warn('[init] 无法创建 anonymous_token 文件:', error.message);
  }

  return tokenPath;
}

module.exports = { ensureAnonymousToken };
