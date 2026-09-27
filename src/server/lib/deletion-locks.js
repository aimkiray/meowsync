// 删除窗口的进程内锁（下载管理器与歌单同步共用——download-manager 依赖
// playlist-sync，反向引用会成环，所以锁放独立模块）：
//
// deletingPlaylists：歌单级联删除（排空+清文件+删行）进行中。窗口内必须拒绝：
//   - 新建下载/启动队列/单曲接管/重试（排空竞态产孤儿文件）
//   - 歌单刷新/重导入（upsert 会在 delete 后把行复活）
//   - deleteTask/deleteSongFiles/deletePlaylistDownloadedFiles（排空期间控制器
//     已移出 Map，"在跑"判定失效——删行后协程继续写盘成孤儿）
// deletingQueues：队列排空+删行进行中。窗口内拒绝 startQueue/retryTask/
// retryQueue/cancelQueue/downloadSingleSong 接管——
//   行删后新协程仍在写盘，成为永久失联的孤儿协程
const deletingPlaylists = new Set();
const deletingQueues = new Set();

module.exports = { deletingPlaylists, deletingQueues };
