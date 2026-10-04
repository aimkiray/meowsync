// 错误消息透出前的路径剥离：上游/本地 fs 错误（ENOENT open '/app/data/...'、
// tmpdir 读失败）会把服务器文件系统布局透给未认证调用方
// 主模式覆盖 POSIX/Windows 绝对路径：起头是 / 或 X:\，段内字符允许
// 非分隔符/引号的一切（含中文——\w 只覆盖 ASCII 会让含中文目录名整串漏剥）。
// 至少两段分量，"a/b" 这类普通分隔文本不误伤；空格路径用引号包裹模式
// 兜底——fs 错误消息恒以单引号包裹路径（open '/路径'、mkdir '/路径'）。
// 两个分支共用的 lookbehind 排除三类前置字符：':'（scheme:// 的首个 /）、
// '/'（// 续段）、\w（URL 中段分隔符，如 https://host/a/b 里 host/a；
// 也挡住 drive 分支把 https: 的 's:/' 误当盘符）——URL 因此整体不剥；
// 副作用是 "path:/x" 这类紧贴冒号的裸路径也不再剥（错误消息里路径几乎
// 总以空格/引号分隔，可接受），相对路径片段 "dir/sub/file" 不再被误剥
// 也更贴近「只剥绝对路径」的本意
const ABSOLUTE_PATH_RE = /(?<![:/\w])(?:[A-Za-z]:[\\/]|\/)[^\s\\/:'"<>|]*(?:[\\/][^\s\\/:'"<>|]+)+/g;
// 引号内的 https?: URL 同样不剥——其中的 / 不是文件系统路径分隔符
const QUOTED_PATH_RE = /'(?!https?:)[^'\n]*[/\\][^'\n]*'/g;

function stripAbsolutePaths(text) {
  return String(text ?? '')
    .replace(QUOTED_PATH_RE, "'<path>'")
    .replace(ABSOLUTE_PATH_RE, '<path>');
}

// 只导出函数：/g 正则实例跨调用方 .test()/.exec() 会踩 lastIndex 坑
module.exports = { stripAbsolutePaths };
