// 删除窗口的进程内锁（下载管理器与歌单同步共用——download-manager 依赖
// playlist-sync，反向引用会成环，所以锁放独立模块）：
//
// deletingPlaylists：歌单级联删除（排空+清文件+删行）进行中。窗口内必须拒绝：
//   - 新建下载/启动队列（排空竞态产孤儿文件）
//   - 歌单刷新/重导入（upsert 会在 delete 后把行复活）
// deletingQueues：队列排空+删行进行中。窗口内拒绝 startQueue/retryTask——
//   行删后新协程仍在写盘，成为永久失联的孤儿协程
const deletingPlaylists = new Set();
const deletingQueues = new Set();

module.exports = { deletingPlaylists, deletingQueues };
