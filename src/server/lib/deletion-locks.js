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
// 复活防护按网易云 id 记墓碑：导入的 upsert 以 netease_playlist_id 为冲突键，
// 行被删后重建会拿到"新"本地 id——deletingPlaylists（按本地 id）查不到，
// 在途导入就把刚删的歌单复活。删除方在级联开始时登记 netease id，
// 导入方在写事务内（上游往返之后）复查。
//
// Map<neteaseId, expiresAt>：级联进行中记 Infinity；级联结束后保留一段 TTL
// 而非立刻清除——级联本体毫秒级完成而导入的上游抓取可达分钟级，立即释放
// 会让"删除先于在途 fetch 返回"的导入照样复活行
const NETEASE_TOMBSTONE_TTL_MS = 130_000;
const deletingNeteasePlaylists = new Map();

// Map<neteaseId, number>：在途导入计数——墓碑时长不能只按固定 TTL 赌上游总时长：
// 多腿串行抓取（playlist_detail 120s + 每 500 曲一腿 song_detail 各 120s）
// 千曲歌单轻松超过 130s，TTL 先到期 → 复查放行 → 已删行被复活。
// 计数归零才允许 Infinity 墓碑降级为 TTL；归零前的删除登记维持 Infinity
const inflightNeteaseImports = new Map();

function isNeteasePlaylistDeleting(neteaseId) {
  const expiresAt = deletingNeteasePlaylists.get(String(neteaseId));
  if (expiresAt === undefined) return false;
  if (expiresAt === Infinity || expiresAt > Date.now()) return true;
  deletingNeteasePlaylists.delete(String(neteaseId));
  return false;
}

function beginNeteasePlaylistImport(neteaseId) {
  const key = String(neteaseId);
  inflightNeteaseImports.set(key, (inflightNeteaseImports.get(key) || 0) + 1);
}

function endNeteasePlaylistImport(neteaseId) {
  const key = String(neteaseId);
  const remaining = (inflightNeteaseImports.get(key) || 0) - 1;
  if (remaining > 0) {
    inflightNeteaseImports.set(key, remaining);
    return;
  }
  inflightNeteaseImports.delete(key);
  // 删除发生在导入在途期间（墓碑被续命为 Infinity）——最后一腿结束的此刻
  // 起算 TTL：导入方的事务内复查已被 Infinity 拦死，TTL 只兜后续新请求
  if (deletingNeteasePlaylists.get(key) === Infinity) {
    deletingNeteasePlaylists.set(key, Date.now() + NETEASE_TOMBSTONE_TTL_MS);
  }
}

function markNeteasePlaylistDeleted(neteaseId) {
  const key = String(neteaseId);
  // 在途导入未归零维持 Infinity——固定 TTL 盖不住多腿抓取的总时长；
  // 计数清空由 endNeteasePlaylistImport 转 TTL（该导入本腿会撞墓碑 409）
  if ((inflightNeteaseImports.get(key) || 0) > 0) {
    deletingNeteasePlaylists.set(key, Infinity);
    return;
  }
  deletingNeteasePlaylists.set(key, Date.now() + NETEASE_TOMBSTONE_TTL_MS);
}

module.exports = {
  deletingPlaylists,
  deletingQueues,
  deletingNeteasePlaylists,
  isNeteasePlaylistDeleting,
  markNeteasePlaylistDeleted,
  beginNeteasePlaylistImport,
  endNeteasePlaylistImport
};
