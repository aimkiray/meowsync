// /auth/setup 的 SETUP_TOKEN 闸（opt-in）：设置后建号须携带匹配的
// x-setup-token 头——空 users 表「先到先得」接管窗口的上闸钉板；
// 未设置保持 LAN 友好默认。DATA_DIR 隔离 → 真 0 计数的空表。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-setup-token-');
const require = createRequire(import.meta.url);

let app, usersRepo;
before(() => {
  app = require('../src/server/routes/auth.js');
  usersRepo = require('../src/server/repositories/users.js');
});
after(() => { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const post = (body, headers = {}) => app.request('http://t/auth/setup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('setup-token：未设置时保持开放默认（LAN 兼容路径不回归）', async () => {
  delete process.env.SETUP_TOKEN;
  assert.equal(usersRepo.countUsers(), 0);
  const r = await post({ username: 'gateadmin', password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal(usersRepo.countUsers(), 1);
});

test('setup-token：设置后缺头/错头 403，匹配头放行建号', async () => {
  // 上个用例已建号会让本用例撞 409 而非到闸——清表恢复空表前提
  const { getDb } = require('../src/server/db/client.js');
  getDb().exec('DELETE FROM sessions; DELETE FROM users');
  assert.equal(usersRepo.countUsers(), 0);

  process.env.SETUP_TOKEN = 'setup-gate-token-0123456789abcdef';
  try {
    const noHeader = await post({ username: 'admin', password: 'password123' });
    assert.equal(noHeader.status, 403);
    const wrongHeader = await post({ username: 'admin', password: 'password123' },
      { 'x-setup-token': 'definitely-wrong' });
    assert.equal(wrongHeader.status, 403);
    // 两次 403 都未建号——闸在写库前
    assert.equal(usersRepo.countUsers(), 0);

    const ok = await post({ username: 'admin', password: 'password123' },
      { 'x-setup-token': 'setup-gate-token-0123456789abcdef' });
    assert.equal(ok.status, 200);
    assert.equal(usersRepo.countUsers(), 1);
  } finally {
    delete process.env.SETUP_TOKEN;
  }
});
