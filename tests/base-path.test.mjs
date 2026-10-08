// lib/base-path.js 钉板：normalizeBasePath 各形态归一、withBasePath 根部署恒等/
// 子路径拼接/非法入参兜底。env 直接换值（basePath() 每次调用重读 env——
// 不 memoize 正是为了让这种用法免 require 缓存 reset），每用例后 restore。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeBasePath, basePath, withBasePath } = require('../src/server/lib/base-path.js');

// env 快照还原：两个变量都可能影响 basePath()，一并存取
const withEnv = (vars, fn) => {
  const saved = { BASE_PATH: process.env.BASE_PATH, VITE_BASE_PATH: process.env.VITE_BASE_PATH };
  for (const k of ['BASE_PATH', 'VITE_BASE_PATH']) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of ['BASE_PATH', 'VITE_BASE_PATH']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

test('normalizeBasePath：各形态归一到 /x（无尾斜杠，/ 表根）', () => {
  assert.equal(normalizeBasePath('/music/'), '/music');
  assert.equal(normalizeBasePath('music'), '/music');
  assert.equal(normalizeBasePath('music/'), '/music');
  assert.equal(normalizeBasePath('/music'), '/music');
  assert.equal(normalizeBasePath('/a/b/'), '/a/b');
  assert.equal(normalizeBasePath('/'), '/');
  assert.equal(normalizeBasePath(''), '/');
  assert.equal(normalizeBasePath(undefined), '/');
  assert.equal(normalizeBasePath(null), '/');
  assert.equal(normalizeBasePath('  /music//  '), '/music');
  // '///' 归一后是根而非 '//' 双斜杠前缀
  assert.equal(normalizeBasePath('///'), '/');
});

test('basePath：BASE_PATH 优先，VITE_BASE_PATH 兜底，未设 → /', () => {
  withEnv({ BASE_PATH: undefined, VITE_BASE_PATH: undefined }, () => {
    assert.equal(basePath(), '/');
  });
  withEnv({ BASE_PATH: '/music', VITE_BASE_PATH: '/other' }, () => {
    assert.equal(basePath(), '/music');
  });
  withEnv({ BASE_PATH: undefined, VITE_BASE_PATH: '/vite-base/' }, () => {
    assert.equal(basePath(), '/vite-base');
  });
  // BASE_PATH 显式 '/' 是真值——显式根部署覆盖 VITE_BASE_PATH 兜底值
  // （compose 恒透传 BASE_PATH=$VITE_BASE_PATH，裸机 .env 里显式 '/' 不翻盘）
  withEnv({ BASE_PATH: '/', VITE_BASE_PATH: '/music' }, () => {
    assert.equal(basePath(), '/');
  });
});

test('withBasePath：根部署恒等返回，子路径拼前缀', () => {
  withEnv({ BASE_PATH: undefined, VITE_BASE_PATH: undefined }, () => {
    assert.equal(withBasePath('/audio-proxy/t/abc'), '/audio-proxy/t/abc');
    assert.equal(withBasePath('/x'), '/x');
  });
  withEnv({ BASE_PATH: '/music', VITE_BASE_PATH: undefined }, () => {
    assert.equal(withBasePath('/audio-proxy/t/abc'), '/music/audio-proxy/t/abc');
  });
  // 带尾斜杠/不带前斜杠的 env 形态先归一再拼——与入口剥前缀同口径
  withEnv({ BASE_PATH: 'music/', VITE_BASE_PATH: undefined }, () => {
    assert.equal(withBasePath('/x'), '/music/x');
  });
});

test('withBasePath：非根相对入参告警并原样返回——防 /musicundefined 式拼串', () => {
  withEnv({ BASE_PATH: '/music', VITE_BASE_PATH: undefined }, () => {
    const warns = [];
    const origWarn = console.warn;
    console.warn = (m) => warns.push(m);
    try {
      for (const bad of ['', 'abc', undefined, null, 42]) {
        assert.equal(withBasePath(bad), bad);
      }
      assert.equal(warns.length, 5);
      // 绝对 URL 不是根相对路径——同样原样返回（本函数只给本站根相对链用）
      assert.equal(withBasePath('https://a/b'), 'https://a/b');
    } finally {
      console.warn = origWarn;
    }
  });
  // 根部署下恒等短路——非法入参不告警也不拼串（恒等在先是契约）
  withEnv({ BASE_PATH: undefined, VITE_BASE_PATH: undefined }, () => {
    assert.equal(withBasePath('abc'), 'abc');
  });
});
