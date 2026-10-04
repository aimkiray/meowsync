// 管理员密码重置：脱困通道——argon2 不可用的运行时（Node <24.7）里 a2id 哈希
// 无法登录、/auth/setup 在 users 非空时又已关闭，只能直接改库。
// 用法：node scripts/reset-password.mjs <username> <newpassword>
// DATA_DIR 经 .env/环境变量取（与 netease-api-server.js 同口径），默认 ./data。
// 顺便吊销该用户全部会话——密码重置的标准语义，防止旧会话继续存活。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// .env 与主服务同口径加载——DATA_DIR 不随脚本 cwd 漂移
require('dotenv').config({ path: join(ROOT, '.env') });

const [username, newPassword] = process.argv.slice(2);
if (!username || !newPassword) {
  console.error('用法: node scripts/reset-password.mjs <username> <newpassword>');
  process.exit(1);
}
// 与 /auth/setup 同一密码强度口径（shared/contracts.js authCredentialsBody）
if (newPassword.length < 8 || newPassword.length > 128) {
  console.error('密码须 8-128 位（与 /auth/setup 同口径）');
  process.exit(1);
}

const usersRepo = require('../src/server/repositories/users.js');
const sessionsRepo = require('../src/server/repositories/sessions.js');
const { hashPassword } = require('../src/server/lib/password.js');

const user = usersRepo.findByUsername(username);
if (!user) {
  console.error(`用户 '${username}' 不存在（users 表为空请走 /auth/setup 建号）`);
  process.exit(1);
}

const hash = await hashPassword(newPassword);
usersRepo.updatePasswordHash(user.id, hash);
sessionsRepo.deleteAllForUser(user.id);
console.log(`[reset-password] '${user.username}' 密码已重置（算法 ${hash.split('$')[0]}），既有会话已全部吊销`);
