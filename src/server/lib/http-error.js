// 共享 HTTP 错误约定：业务错误必须显式标 exposed 才会把 message 透传给客户端。
// 不能只看 err.status——axios 的 AxiosError 自带 .status（上游响应码），透传其
// message 会把上游错误细节当业务消息漏给客户端；未标记的异常一律 500。

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.exposed = true;
  return err;
}

function fail(c, status, message) {
  return c.json({ code: status, message }, status);
}

function handleError(c, error, tag) {
  const marked = error && error.exposed === true
    && Number.isInteger(error.status) && error.status >= 400 && error.status < 600;
  if (marked) {
    if (error.status >= 500) console.error(`${tag}:`, error);
    return fail(c, error.status, error.message || '请求失败');
  }
  console.error(`${tag}:`, error);
  return fail(c, 500, '服务器错误');
}

module.exports = { httpError, fail, handleError };
