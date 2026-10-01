// 测试脚手架收口——此前 seed/getJson/tmpdir 在四个测试文件里逐字节重复。
//
// seed：CJS 模块 stub 注入。被测文件 require 前先预播种 require.cache——
// 命中缓存跳过真实加载，实现「不碰生产代码的依赖替换」。必须在 require
// 被测文件之前调用。
// getJson：驱动 Hono app 的最小探测（不走网络，app.request 直发）。
// tmpDataDir：DATA_DIR 临时目录，process exit 兜底清（防 mkdtemp 泄漏）。
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export const seed = (path, exports) => {
  const p = require.resolve(path);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// app.request + {status, body} 归一；body 解析失败回 null（500 兜底响应
// 非 JSON 时用例仍能断言状态码）
export const getJson = async (app, path) => {
  const res = await app.request(`http://t${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

export const tmpDataDir = (prefix = 'meowsync-test-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清扫尽力而为 */ } });
  return dir;
};
