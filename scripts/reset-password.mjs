// 管理员密码重置：脱困通道——argon2 不可用的运行时（Node <24.7）里 a2id 哈希
// 无法登录、/auth/setup 在 users 非空时又已关闭，只能直接改库。
// 用法：node scripts/reset-password.mjs <username> [newpassword]
//   密码省略时交互读入（关 echo）——argv 里的明文会落 shell 历史、ps cmdline、
//   CI 日志，脱困场景下恰恰最不可能清理；argv 兼容保留但打 stderr 警告。
// DATA_DIR 经 .env/环境变量取（与 server.js 同口径），默认 ./data。
// 顺便吊销该用户全部会话——密码重置的标准语义，防止旧会话继续存活。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// .env 与主服务同口径加载——DATA_DIR 不随脚本 cwd 漂移
require('dotenv').config({ path: join(ROOT, '.env') });

const [username, argvPassword] = process.argv.slice(2);
if (!username) {
  console.error('用法: node scripts/reset-password.mjs <username> [newpassword]');
  process.exit(1);
}
if (argvPassword !== undefined) {
  console.error('[reset-password] 警告：argv 密码会留在 shell 历史/进程列表里，建议省略后交互输入');
}

// 交互读密码：/dev/tty 输出端 mute 输入，不经 stdin 缓冲回显
function promptPassword() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const origWrite = rl._writeToOutput;
    rl._writeToOutput = function (s) { if (rl.stdoutMuted) rl.output.write('*'); else origWrite.call(rl, s); };
    rl.stdoutMuted = true;
    rl.question('新密码: ', (answer) => {
      rl.stdoutMuted = false;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const newPassword = argvPassword ?? await promptPassword();
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
