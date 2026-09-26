// 错误消息透出前的路径剥离：上游/本地 fs 错误（ENOENT open '/app/data/...'、
// tmpdir 读失败）会把服务器文件系统布局透给未认证调用方
// 覆盖 POSIX 绝对路径与 Windows 盘符路径；要求至少两段路径分量，
// "a/b" 这类普通分隔文本不误伤（"a/b/c" 会命中——上游 msg 以中文为主，
// 误伤面可接受，换不透路径是底线）
const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[\w.@%~+-]*(?:[\\/][\w.@%~+-]+)+/g;

function stripAbsolutePaths(text) {
  return String(text ?? '').replace(ABSOLUTE_PATH_RE, '<path>');
}

module.exports = { stripAbsolutePaths, ABSOLUTE_PATH_RE };
