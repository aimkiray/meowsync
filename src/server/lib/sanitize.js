// 错误消息透出前的路径剥离：上游/本地 fs 错误（ENOENT open '/app/data/...'、
// tmpdir 读失败）会把服务器文件系统布局透给未认证调用方
// 主模式覆盖 POSIX/Windows 绝对路径：起头是 / 或 X:\，段内字符允许
// 非分隔符/引号的一切（含中文——\w 只覆盖 ASCII 会让含中文目录名整串漏剥）。
// 至少两段分量，"a/b" 这类普通分隔文本不误伤；空格路径用引号包裹模式
// 兜底——fs 错误消息恒以单引号包裹路径（open '/路径'、mkdir '/路径'）
const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s\\/:'"<>|]*(?:[\\/][^\s\\/:'"<>|]+)+/g;
const QUOTED_PATH_RE = /'[^'\n]*[/\\][^'\n]*'/g;

function stripAbsolutePaths(text) {
  return String(text ?? '')
    .replace(QUOTED_PATH_RE, "'<path>'")
    .replace(ABSOLUTE_PATH_RE, '<path>');
}

// 只导出函数：/g 正则实例跨调用方 .test()/.exec() 会踩 lastIndex 坑
module.exports = { stripAbsolutePaths };
