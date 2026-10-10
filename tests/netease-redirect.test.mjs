// netease/request.js redirect:'manual' 钉板：固定域名上游无合法重定向
// 语义——真 3xx 不得被静默跟随，必须落到错误路径 reject(answer)；
// 且 body 层 {code:302} 不得经 SPECIAL_BODY_CODES 洗白成 200
//（request.js 内 res.status 复核段的存在理由）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { request } = require('../src/server/services/netease/request.js');

// stub 只换一跳：request 内部 AbortSignal/加密/组装全走真路径
const withFetch = async (res, fn) => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => res;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
};

test('request：HTTP 302 → reject(answer) 且 status===302（不被跟随/洗白）', async () => {
  await withFetch(new Response(null, { status: 302 }), async () => {
    await assert.rejects(
      request('/api/song/detail', {}),
      (err) => {
        // 非 Error 的 answer 对象形态——消费方靠 status 识别
        assert.equal(err.status, 302);
        return true;
      },
    );
  });
});

test('request：HTTP 302 + body{code:302} → status 仍 302，不经 SPECIAL_BODY_CODES 洗成 200', async () => {
  await withFetch(
    new Response(JSON.stringify({ code: 302 }), {
      status: 302,
      headers: { 'content-type': 'application/json' },
    }),
    async () => {
      await assert.rejects(
        request('/api/song/detail', {}),
        (err) => {
          assert.equal(err.status, 302);
          return true;
        },
      );
    },
  );
});
