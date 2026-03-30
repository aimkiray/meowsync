const fs = require('fs');
const os = require('os');
const path = require('path');

function ensureAnonymousToken(tokenPath = path.join(os.tmpdir(), 'anonymous_token')) {
  if (!fs.existsSync(tokenPath)) {
    fs.writeFileSync(tokenPath, '', 'utf8');
  }

  return tokenPath;
}

module.exports = { ensureAnonymousToken };
