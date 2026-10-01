// 契约入口：readJsonBody + zod safeParse 合一。
// 返回 {data} 或 {error: Response}——调用点 `if (error) return error` 一行收编。
// 413 在此就地应答（ai.js 等路由的 body 段没有外层 catch，冒泡会变 500）；
// 畸形 JSON 由 readJsonBody 按 {} 兜底，schema 失败统一 400 {code,message}。
const { readJsonBody } = require('./http-body');
const { fail } = require('./http-error');

async function parseJsonBody(c, schema, maxBytes) {
  let body;
  try {
    body = await readJsonBody(c, maxBytes);
  } catch (e) {
    if (e?.exposed === true && e?.status === 413) {
      return { error: fail(c, 413, 'Payload Too Large') };
    }
    throw e;
  }
  const result = schema.safeParse(body);
  if (result.success) return { data: result.data };
  const issue = result.error.issues[0];
  const path = (issue.path || []).join('.');
  return { error: fail(c, 400, `参数错误：${path ? `${path} ` : ''}${issue.message}`) };
}

module.exports = { parseJsonBody };
