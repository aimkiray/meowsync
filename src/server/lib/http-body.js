// 共享 HTTP body 读取：Content-Length 只是声明值，chunked/无声明的请求
// 会绕过"先查头再读"的限长检查——这里手动读流按累计字节硬截断

function bodyTooLarge() {
  const err = new Error('Payload Too Large');
  err.status = 413;
  return err;
}

// 读取原始 body 文本，超过 maxBytes 抛 413
async function readBodyText(c, maxBytes) {
  const declared = Number(c.req.header('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw bodyTooLarge();
  }

  const body = c.req.raw.body;
  if (!body || typeof body.getReader !== 'function') {
    return '';
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* 忽略 */ }
        throw bodyTooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

// JSON body：畸形 JSON 按空对象处理（与旧行为一致——缺参由路由各自 400）
async function readJsonBody(c, maxBytes = 1024 * 1024) {
  const text = await readBodyText(c, maxBytes);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    // 仅对象形态可展开为参数；数组/原始值展开只会产生数字键垃圾参数
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

// music.js 需要兼容表单提交：按 content-type 分派 json/urlencoded
async function readParamsBody(c, maxBytes = 1024 * 1024) {
  const text = await readBodyText(c, maxBytes);
  if (!text) return {};
  const contentType = c.req.header('content-type') || '';
  try {
    if (contentType.includes('json')) {
      const parsed = JSON.parse(text);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    }
    if (contentType.includes('urlencoded')) {
      return Object.fromEntries(new URLSearchParams(text));
    }
  } catch {
    return {};
  }
  return {};
}

module.exports = { readBodyText, readJsonBody, readParamsBody };
