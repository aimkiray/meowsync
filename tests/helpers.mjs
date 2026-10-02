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

// netease-match 模块的完整 stub 面：路由消费 matchWithBudget/matchTracksPool/
// toMatchedJson——三者都委托回 matchNeteaseSong 录制桩，调用记录与 per-call
// impl 语义保持可观测。getImpl 惰性取实现（测试用例内重赋 matchImpl 生效）
export const seedMatchModule = (matchCalls, getImpl) => {
  const call = (...args) => { matchCalls.push(args); return getImpl()(...args); };
  seed('../src/server/services/netease-match.js', {
    matchNeteaseSong: call,
    matchWithBudget: ({ candidates, durationSec, tag, sourceInfo }) =>
      call(candidates, durationSec, tag, null, sourceInfo),
    matchTracksPool: async (tracks, o) => {
      let n = 0;
      for (const t of tracks) {
        const r = await call(o.candidatesOf(t), o.durationOf(t), o.tag, null, o.infoOf(t))
          .catch(() => ({ song: null }));
        if (r?.song) {
          t.matched = { id: r.song.id, name: r.song.name, ar: r.song.ar || r.song.artists || [], al: r.song.al || r.song.album || {} };
          t.matchedBy = r.query;
          n++;
        }
      }
      return n;
    },
    toMatchedJson: (song) => song ? {
      id: song.id, name: song.name,
      ar: song.ar || song.artists || [], al: song.al || song.album || {},
    } : null,
  });
};
