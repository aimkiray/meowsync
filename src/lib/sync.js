// 多端同步引擎——localStorage 是本机权威缓存，同步是叠加层：
// 任何同步失败只退避重试，绝不阻塞本地写，也不让本地功能退化。
//
// 服务端契约（key 命名空间）：
//   playlist:<id>  — 歌单库按单炸开，一项一单（LWW 粒度=歌单）
//   doc:<lsKey>    — 其它白名单键整文档（value 承载 LS 原始串）
//   lib:index      — 库级元数据 doc（歌单顺序 + removedDefaultPlaylists）
// LWW：updatedAt(ms) 高者赢；服务端平局留旧并回 conflicts，客户端采纳回包值。
// 交付水位线：pull 的 since 是服务端单调 seq 域（每条 item 带 seq 下发），
// 与时钟域互不兼任；serverTime 仅诊断不回喂；conflicts 回包 {key,item}，
// item 内层 key/seq 是冗余可缺字段——采纳一律以外层 key 为准。
import { LS_KEYS, readJSON, writeJSON, setWriteHook } from './storage.js'
import { syncApi } from '../api/sync.js'
// 远端回填依赖方向：引擎 → 叶模块。叶模块（theme.js/prefs.js）不许反向
// import 本文件——会把 api/http 的 import.meta.env 链拖进 node:test 裸跑面
import { applyRemoteTheme } from './theme.js'
import { applyRemoteVideoPref, applyRemoteLyricFs } from './prefs.js'
// 播放上下文壳（single_song_/saved_queue_）过滤推送面——共享谓词层是纯
// ESM 零 IO，叶模块同一定位（不引入新依赖方向）
import { isEphemeralPlaylistId } from '../shared/predicates.js'

const SINCE_KEY = LS_KEYS.SYNC_SINCE
const META_KEY = LS_KEYS.SYNC_META
const LIB_INDEX = 'lib:index'
const PLAYLIST_PREFIX = 'playlist:'
const DOC_PREFIX = 'doc:'

// 同步白名单：这些 LS 键的写自动进脏集（writeJSON 钩 + notifyStorageWrite 两口收口）。
// PLAYLISTS/REMOVED_DEFAULT_PLAYLISTS 折叠进 playlist:*/lib:index 形态出行，
// 不直接成 doc
const SYNC_LS_KEYS = new Set([
  LS_KEYS.PLAYLISTS,
  LS_KEYS.REMOVED_DEFAULT_PLAYLISTS,
  LS_KEYS.PLAYER_STATE,
  LS_KEYS.PLAY_HISTORY,
  LS_KEYS.PLAYLIST_HISTORY,
  LS_KEYS.THEME,
  LS_KEYS.VIDEO_MODE,
  LS_KEYS.LYRIC_FONT_SIZE,
  LS_KEYS.WATCH_TAB,
  LS_KEYS.SETUP_DISMISSED,
])
// doc:* 命名空间只收整文档键
const DOC_LS_KEYS = new Set([...SYNC_LS_KEYS].filter(k =>
  k !== LS_KEYS.PLAYLISTS && k !== LS_KEYS.REMOVED_DEFAULT_PLAYLISTS))

const DEBOUNCE_MS = 1500   // 写后聚合窗口——连续写合并成一趟推送
const MAX_WAIT_MS = 15000  // 防抖截尾：首脏起算必发上限——播放中 PLAYER_STATE
                           // ~1/s 连续写会无限重排 1.5s 窗口（防抖饿死），
                           // 超窗必 flush，播放期不零推送
const RETRY_BASE_MS = 2000 // 失败退避底数（指数倍增）
const RETRY_MAX_MS = 60000 // 退避封顶
const PULL_RETRY_MS = 60000 // pull 失败/回前台补拉的节流窗——轻量排程不引长轮询
// 未版本化数据的 LWW 播种戳：firstSync 存量 doc/无 updatedAt 存量歌单的
// 出门戳。盖 1 而非「现在」——远端只要有真实戳就赢（pull LWW 判优或
// push conflicts 回包采纳），陈旧本地值不得以启动刻压死远端编辑；
// 远端无值则本机传播。随后真实本地写在脏标记时盖 now 不受影响
const SEED_TS = 1
// 与服务端 routes/sync.js 同源口径：changes>500 / 单条 value>256KB /
// 整批 value 总字节>4MB 都是整批 400 的硬顶——客户端提前分块/剔除，
// 必败批次不进退避死循环
const PUSH_CHUNK_SIZE = 500
const PUSH_MAX_VALUE_BYTES = 256 * 1024
// 整批字节预算的客户端切块阈：服务端硬顶 MAX_BATCH_VALUE_BYTES=4MB，
// 这里留 0.5MB 余量兜条目外壳（key/updatedAt/deleted 的 JSON 开销）与
// 两侧序列化口径微差——只按条数切块时首同步 ~16 个 256KB 歌单即顶穿
const PUSH_BATCH_BUDGET_BYTES = 3.5 * 1024 * 1024
// 远端 updatedAt 未来戳宽容窗——与服务端 routes/sync.js 的
// FUTURE_TOLERANCE_MS 同源口径（5min 钟漂容差）
const FUTURE_TS_SKEW_MS = 5 * 60 * 1000
const byteLen = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length)

let inited = false
const dirty = new Set()           // 待推 LS 键
const pendingWrites = new Set()   // initSync 前的白名单写——键级排程（集有界
                                  // ≤白名单键数），initSync 完成时统一回放记脏
const applyHandlers = new Map()   // lsKey → Set<fn>（远端应用订阅表）
const knownContent = new Map()    // lsKey → 最近同步态原始串（回声判据：远端应用/推送成功时更新）
const remoteDeleted = new Set()   // lsKey：远端墓碑刚落地的键——订阅者 removeItem
                                  // 回声按此抑制：不二次盖戳（盖 now() 会压过远端真实
                                  // 墓碑戳）、不产回推墓碑；本地真写值进来时清除
const pushedPlStamps = new Map()  // playlistId → 上次已推 updatedAt（炸开 diff 基线；
                                  // 会话内有效——首脏全推幂等无害，服务端 LWW 自判）
let docMeta = null                // doc:* 与 lib:index 的 LWW 写戳表（LS 持久化，懒加载）；
                                  // 内嵌 plTomb 子表——歌单持久墓碑（见下）
let flushTimer = null
let retryTimer = null
let pullRetryTimer = null         // pull 失败的轻量补拉排程
let pullLastTry = 0               // 上次 pull 发起刻（回前台补拉的节流判据）
let firstDirtyAt = 0              // 本轮脏集首脏刻——防抖 maxWait 截尾判据
let libWriteAt = 0                // 歌单库最近一次本地写刻——删除型墓碑的
                                  // LWW 戳取「删除发生的那次写」的时刻；
                                  // 推迟到 buildChanges 盖戳会让重试/延迟
                                  // flush 把墓碑戳漂晚（漂晚=删除理由变新，
                                  // 语义虚增），与 doc 写戳打在脏标记同口径
let failStreak = 0
let flushing = false
let pulling = null                // 在途 pull Promise——推送让行，防盖写刚到位的远端值

const safeGetLs = (k) => { try { return localStorage.getItem(k) } catch { return null } }
// 返回成败：远端值落盘失败（配额满等）时调用方不得登记 knownContent——
// 把没落成的远端值记成「已知同步态」，下次本地写回旧值会被判成变更推回去
const safeSetLs = (k, v) => { try { localStorage.setItem(k, v); return true } catch { return false } }
const safeRmLs = (k) => { try { localStorage.removeItem(k) } catch { /* 同上 */ } }

// 叶模块回填 handler 表——initSync 里统一挂订阅（稳定引用，重入/测试
// 复位重建都幂等）。引擎已把远端值写进 LS，handler 只灌内存 ref/DOM
// 不做存储回写：远端值可能是本版不认识的形态（新主题 id/超界字号），
// 归一回写会被记脏推回去，等于本机拿新戳把远端新版数据降级
const LEAF_APPLY_HANDLERS = [
  [LS_KEYS.THEME, applyRemoteTheme],
  [LS_KEYS.VIDEO_MODE, applyRemoteVideoPref],
  [LS_KEYS.LYRIC_FONT_SIZE, applyRemoteLyricFs],
]

// ── doc 级 LWW 写戳表（LS 持久化——跨会话判据）──
const loadMeta = () => {
  if (docMeta && typeof docMeta === 'object') return docMeta
  const m = readJSON(META_KEY)
  docMeta = m && typeof m === 'object' && !Array.isArray(m) ? m : {}
  return docMeta
}
const metaTs = (k) => Number(loadMeta()[k]) || 0
// remoteApplied：簿记自身不是同步内容——防 meta 落盘被误记脏
//（META_KEY 本就不在白名单，双保险）
const saveMeta = () => writeJSON(META_KEY, loadMeta(), { remoteApplied: true })
const stampMeta = (k, ts) => {
  const m = loadMeta()
  m[k] = ts
  saveMeta()
}

// ── 歌单持久墓碑表（SYNC_META.plTomb：playlistId → 删除戳）──
// pushedPlStamps 只是会话内 diff 基线：本会话删单+推送失败+重启后基线
// 归零，buildChanges 产不出墓碑，服务端僵尸行会随下次 pull「本端缺席
// 直接收」把已删单复活。plTomb 是跨会话删除知识：产墓碑即落表。
// 语义口径（想清楚了的取舍）：
//   · 本端缺席的远端项，plTomb[id] > remoteTs → 拒收并标脏回推墓碑
//    （以墓碑赢回删除）；远端值戳 ≥ 墓碑 → 远端在删除后真改过，复活
//     合法（与 doc 同一条 LWW 口径），表项作废
//   · 表项在本地重现该 id（删后重建）时清——它的 put 以自己的新戳出门
//   · 推送成功后表项仍保留：服务端行可能滞后回旧值，持久墓碑是 merge
//     侧拒收复活的唯一凭据；续发墓碑幂等无害。表有界（PL_TOMB_CAP，
//     超帽挤掉最旧戳——删除越久服务端残留旧值的概率越低）不涨死
const PL_TOMB_KEY = 'plTomb'
const PL_TOMB_CAP = 512
const plTombMap = () => {
  const m = loadMeta()
  const t = m[PL_TOMB_KEY]
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    m[PL_TOMB_KEY] = {}
    return m[PL_TOMB_KEY]
  }
  return t
}
const tombTs = (id) => Number(plTombMap()[id]) || 0
const stampPlTomb = (id, ts) => {
  const t = plTombMap()
  if (t[id] === ts) return
  t[id] = ts
  // 表有界：超帽挤掉最旧戳——删除越久，服务端残留旧值的概率越低，
  // 先挤的牺牲最小
  const keys = Object.keys(t)
  if (keys.length > PL_TOMB_CAP) {
    keys.sort((a, b) => (Number(t[a]) || 0) - (Number(t[b]) || 0))
    for (const k of keys.slice(0, keys.length - PL_TOMB_CAP)) delete t[k]
  }
  saveMeta()
}
const dropPlTomb = (id) => {
  const t = plTombMap()
  if (t[id] == null) return
  delete t[id]
  saveMeta()
}

// 歌单 LWW 戳：updatedAt 字段优先；存量歌单无字段时按创建链兜底——
// 自建 id 内嵌毫秒戳（local_pl_<ts>/saved_queue_<ts>）＞ 网易云单自带的
// createTime/updateTime/trackNumberUpdateTime ＞ 未版本化小戳 SEED_TS。
// 兜底盖小戳而非启动时刻：bootTs「以启动刻冒充」会让远端更旧的**真实**
// 戳被本地陈旧数据压死（pull 判优本地赢+回推陈旧值）；小戳则远端只要有
// 值就赢（pull LWW / push conflicts 采纳收敛），远端无值本机照常传播——
// 与 firstSync doc 播种同口径
const PL_ID_TS_RE = /^(?:local_pl_|saved_queue_)(\d{10,})$/
const playlistTs = (p) => {
  const u = Number(p?.updatedAt)
  if (Number.isFinite(u) && u > 0) return u
  const m = String(p?.id ?? '').match(PL_ID_TS_RE)
  if (m) return Number(m[1])
  const legacy = Number(p?.createTime ?? p?.updateTime ?? p?.trackNumberUpdateTime)
  return Number.isFinite(legacy) && legacy > 0 ? legacy : SEED_TS
}

// 远端 updatedAt 进本机视野的统一闸：纵深防御（服务端 push 已拒超窗
// 未来戳，此道只防存量脏数据/旁路写入残留）。值照采纳——服务端是权威；
// 但簿记用戳钳到当前刻：一个偏移的未来戳不该在 LWW 判优里压制本地
// 写很多年。钳到 now 而非窗顶——本地写戳恒 <= now，钳后远端仍赢当次
// 判优（doc 要 metaTs>remoteTs 才本地赢、playlist 要 remoteTs>=localTs
// 才远端赢，now 对二者都足够）
let futureTsWarned = false // 告警限频：整页脏戳不刷屏
const clampRemoteTs = (ts) => {
  const t = Number(ts) || 0
  if (t > Date.now() + FUTURE_TS_SKEW_MS) {
    if (!futureTsWarned) {
      futureTsWarned = true
      console.warn('[sync] 远端 updatedAt 超未来戳窗，簿记戳按当前刻钳制:', t)
    }
    return Date.now()
  }
  return t
}

// ── 远端应用订阅：composable 注册「远端值进 LS 后重建内存态」回调 ──
export function onRemoteApply(lsKey, handler) {
  let set = applyHandlers.get(lsKey)
  if (!set) { set = new Set(); applyHandlers.set(lsKey, set) }
  set.add(handler)
  return () => set.delete(handler)
}
const dispatchApply = (lsKey) => {
  for (const h of applyHandlers.get(lsKey) || []) {
    try { h() } catch (e) { console.warn('[sync] 远端应用回调异常:', e?.message || e) }
  }
}

// ── 脏标记（writeJSON 钩 + notifyStorageWrite 共用此口）──
// 回声抑制：写内容与最近同步态一致 → 不动（远端落盘被订阅者同值重写、
// 以及本地无净变化的重写都不产生推送）
const onStorageWrite = (lsKey) => {
  if (!SYNC_LS_KEYS.has(lsKey)) return
  // 引擎未 init（initSync 前的恢复/导入写、未登录/遥控端）：钩内只进
  // pending 集不推送——initSync 完成时统一回放记脏。此前这些写被闸
  // 静默丢掉：loadDefaultPlaylists/分享导入都抢在 onMounted 尾的
  // initSync 之前，老用户非首同步不补种 → 写全丢
  if (!inited) { pendingWrites.add(lsKey); return }
  const raw = safeGetLs(lsKey)
  if (raw === null) {
    // 远端墓碑落盘回声（订阅者 removeItem 同态重写）——不是本地删除，
    // 已知同步态即墓碑本身，无需传播任何东西
    if (remoteDeleted.has(lsKey)) return
    // 删除一个从未同步过的键没有可传播物——既无已知内容也无历史写戳
    if (!knownContent.has(lsKey) && !metaTs(lsKey)) return
    knownContent.delete(lsKey)
    // 删除也是一次本地写——盖戳记 LWW 依据，推送时产出 deleted 墓碑
    if (DOC_LS_KEYS.has(lsKey)) stampMeta(lsKey, Date.now())
  } else {
    remoteDeleted.delete(lsKey) // 真值落盘即脱离墓碑态
    if (knownContent.get(lsKey) === raw) return // 回声/同值重写
    knownContent.set(lsKey, raw)
    // doc 键写戳即本地 LWW 依据——打点在脏标记时而非推送时：
    // 写时刻才是争夺远程值的真正论据
    if (DOC_LS_KEYS.has(lsKey)) stampMeta(lsKey, Date.now())
  }
  // 歌单库写刻同口径打在脏标记——buildChanges 给「推送过又消失」的 id
  // 盖墓碑戳时取它（=删除发生的那次写），比构建时刻更接近真实删除刻
  if (lsKey === LS_KEYS.PLAYLISTS || lsKey === LS_KEYS.REMOVED_DEFAULT_PLAYLISTS) {
    libWriteAt = Date.now()
  }
  dirty.add(lsKey)
  scheduleFlush()
}

// 显式脏标记口（供不走 writeJSON 的写点调用；白名单内生效）
export function markDirty(keys) {
  for (const k of [].concat(keys)) onStorageWrite(k)
}

// 写钩尽早挂（App.vue setup 顶调用；initSync 内重挂幂等）。与 initSync
// 分离的理由：恢复/导入写发生在 onMounted 前段，等 initSync 才挂钩——
// 那之前的白名单写只能被 !inited 闸接住，靠 pending 集才不丢
export function attachWriteHook() { setWriteHook(onStorageWrite) }

// ── 远端值应用 ──
const applyRemoteDoc = (lsKey, item) => {
  if (!DOC_LS_KEYS.has(lsKey)) return // 不认识的 doc 键不落本机
  const remoteTs = clampRemoteTs(item?.updatedAt)
  // LWW 本地赢：本地写戳更高则远端值丢弃——本地项留在脏集里随后推回去
  if (metaTs(lsKey) > remoteTs) { dirty.add(lsKey); return }
  if (item.deleted) {
    safeRmLs(lsKey)
    knownContent.delete(lsKey)
    remoteDeleted.add(lsKey) // 标记墓碑态——订阅者 removeItem 回声不二次盖戳
  } else {
    // doc 值传输形态=LS 原始串；非串值（兼容服务端将来发对象）序列化落
    const raw = typeof item.value === 'string' ? item.value : JSON.stringify(item.value ?? null)
    // 落盘失败不登记 knownContent——没写成的远端值记作已知态会让随后
    // 本地写回旧值被判成「变更」推回去（回声判据反向咬人）
    if (safeSetLs(lsKey, raw)) knownContent.set(lsKey, raw)
    remoteDeleted.delete(lsKey)
  }
  if (remoteTs > 0) stampMeta(lsKey, remoteTs)
  dispatchApply(lsKey)
}

// 歌单库合并：per-playlist LWW——远端赢替换/插入，本地赢留存并标记回推；
// deleted 墓碑同按 ts 判优。lib:index 的 order/removedDefaultPlaylists 最后应用
const mergeRemoteLibrary = (items, libIndex) => {
  const saved = readJSON(LS_KEYS.PLAYLISTS, [])
  const arr = Array.isArray(saved) ? saved.filter(p => p && p.id != null) : []
  let touched = false
  let localWon = false
  for (const item of items) {
    const id = item.key.slice(PLAYLIST_PREFIX.length)
    const remoteTs = clampRemoteTs(item.updatedAt)
    const idx = arr.findIndex(p => String(p.id) === String(id))
    const localTs = idx === -1 ? 0 : playlistTs(arr[idx])
    if (item.deleted) {
      // 墓碑赢本地才删——本地单更晚动过则留存（它的新版随后推回去复活）
      if (idx !== -1 && remoteTs >= localTs) {
        arr.splice(idx, 1)
        pushedPlStamps.delete(String(id)) // 服务端已有墓碑——本侧基线同步擦掉
        touched = true
      } else if (idx !== -1) {
        localWon = true
      }
      // 远端墓碑与本端持久墓碑撞车：远端戳不落后即吞并本端记录（服务端
      // 已持同等删除知识）；本端更鲜则留表续推——服务端行戳还能再抬
      if (remoteTs >= tombTs(id)) dropPlTomb(id)
      continue
    }
    const val = item.value
    if (!val || typeof val !== 'object' || val.id == null) continue
    // 本端持久墓碑比远端值新（本端删过它——跨会话删除知识，见 plTomb 表注释）：
    //   本端缺席 → 拒收+标脏回推墓碑（以墓碑赢回删除，防僵尸行复活）
    //   本端仍在 → 删后已重建，墓碑知识作废，随正常 LWW 判优
    // 远端值戳盖过墓碑 → 远端在删除后真改过，复活合法，表项作废
    const tTs = tombTs(id)
    if (tTs > remoteTs) {
      if (idx === -1) { localWon = true; continue }
      dropPlTomb(id)
    } else if (tTs > 0) {
      dropPlTomb(id)
    }
    if (idx === -1) {
      // 本端缺席直接收（deleted 之外的远端项一律视为更新知识——上面
      // 持久墓碑检查先于它，本端删过的不算「更新知识」）。入参就地写
      // updatedAt 会污染 pull 回包对象，改防御性拷贝
      const next = { ...val, updatedAt: remoteTs || val.updatedAt || Date.now() }
      arr.push(next)
      pushedPlStamps.set(String(id), next.updatedAt)
      touched = true
    } else if (remoteTs >= localTs) {
      // 远端赢（含平局——平局远端赢，与 doc 的「metaTs>remoteTs 才算本地
      // 赢」同口径，也与服务端平局留旧+conflicts 采纳同向收敛；墓碑分支
      // 的 >= 亦同此口径）：整单替换（字段级合并不做——服务端 LWW 判优
      // 即真理）
      const next = { ...val, updatedAt: remoteTs }
      arr[idx] = next
      pushedPlStamps.set(String(id), remoteTs) // 服务端真相同步进基线，防回声推
      touched = true
    } else {
      // 本地赢（严格大于才算赢）——留存；标脏让它的新版推上去收敛
      localWon = true
    }
  }

  // lib:index：顺序与移除名单的 LWW 以其自身写戳判（与歌单项同批一致性出行）
  if (libIndex) {
    const idxTs = clampRemoteTs(libIndex.updatedAt)
    if (idxTs > 0 && idxTs >= metaTs(LIB_INDEX)) {
      stampMeta(LIB_INDEX, idxTs)
      if (libIndex.deleted) {
        // 远端把库级元数据墓碑化：移除名单清空（顺序无解信息可重排——
        // 歌单项本身不由 lib:index 管死活），本地版本随后推回去复活
        const raw = '[]'
        if (safeSetLs(LS_KEYS.REMOVED_DEFAULT_PLAYLISTS, raw)) {
          knownContent.set(LS_KEYS.REMOVED_DEFAULT_PLAYLISTS, raw)
        }
        dispatchApply(LS_KEYS.REMOVED_DEFAULT_PLAYLISTS)
      } else {
        const v = libIndex.value && typeof libIndex.value === 'object' ? libIndex.value : {}
        if (Array.isArray(v.removedDefaultPlaylists)) {
          const raw = JSON.stringify(v.removedDefaultPlaylists)
          if (safeSetLs(LS_KEYS.REMOVED_DEFAULT_PLAYLISTS, raw)) {
            knownContent.set(LS_KEYS.REMOVED_DEFAULT_PLAYLISTS, raw)
          }
          dispatchApply(LS_KEYS.REMOVED_DEFAULT_PLAYLISTS)
        }
        if (Array.isArray(v.order)) {
          // 按远端顺序重排；未登记 id（本端新增未上行）保持相对位序坠尾
          const pos = new Map(v.order.map((pid, i) => [String(pid), i]))
          const decorated = arr.map((p, i) => [p, pos.get(String(p.id)) ?? v.order.length + i])
          decorated.sort((a, b) => a[1] - b[1])
          const reordered = decorated.map(d => d[0])
          if (reordered.some((p, i) => p !== arr[i])) {
            arr.length = 0
            arr.push(...reordered)
            touched = true
          }
        }
      }
    } else if (metaTs(LIB_INDEX) > idxTs) {
      // 本地 lib:index 更新——远端旧值留在服务端会漂着，标脏回推收敛
      localWon = true
    }
  }

  if (touched) {
    // 远端值回写跳过脏标记的是「写钩口径」，这里裸 setItem + 手动登记
    // 已知同步态——与 writeJSON(remoteApplied) 同效但路径更短。
    // 落盘失败不登记：没写成的远端值记作已知态会让本地旧值反被当变更推回
    const raw = JSON.stringify(arr)
    if (safeSetLs(LS_KEYS.PLAYLISTS, raw)) knownContent.set(LS_KEYS.PLAYLISTS, raw)
    dispatchApply(LS_KEYS.PLAYLISTS)
  }
  // 本地赢项回推收敛（远端旧值/墓碑留在服务端会漂着）
  if (localWon) dirty.add(LS_KEYS.PLAYLISTS)
}

const applyRemoteItems = (items) => {
  if (!Array.isArray(items) || !items.length) return
  const plItems = []
  let libIndex = null
  for (const item of items) {
    if (!item || typeof item.key !== 'string') continue
    if (item.key === LIB_INDEX) { libIndex = item; continue }
    if (item.key.startsWith(PLAYLIST_PREFIX)) { plItems.push(item); continue }
    if (item.key.startsWith(DOC_PREFIX)) applyRemoteDoc(item.key.slice(DOC_PREFIX.length), item)
  }
  if (plItems.length || libIndex) mergeRemoteLibrary(plItems, libIndex)
  // 远端应用可能带出本地赢回推——统一排在应用之后（写盘先于推送）
  if (dirty.size) scheduleFlush()
}

// ── 增量拉取 ──
// since=交付水位线，服务端单调 seq 域（非时钟域——serverTime 仅诊断不回喂）。
// 翻页天然 keyset：每页消化后 since=本页最大 seq 续拉（seq>since 严格大于，
// 同 seq 项已在同页全送达——不漏不重，无需独立游标）。
// 水位线不变量：只有「已应用」的 seq 许进 SINCE_KEY——收集 loop 只推进内存
// since 不落盘：拉到未应用的页若先落盘，apply 失败/中断后的重拉会按新
// 水位线永久跳过这批项。applyRemoteItems 成功才把 max(seq) 一次性写盘。
// 不逐页 apply 的理由：lib:index 的顺序重排要在全量歌单项齐了才正确——
// 分页应用会让晚到页的单按「未登记 id 坠尾」规则误排
export async function pullFromServer() {
  if (!inited || pulling) return pulling
  pullLastTry = Date.now()
  pulling = (async () => {
    try {
      const storedSince = Math.max(0, Number(readJSON(SINCE_KEY, 0)) || 0)
      let since = storedSince
      const items = []
      let guard = 0
      for (;;) {
        const resp = await syncApi.pull(since)
        if (!resp || resp.code !== 200) break
        // 本页最大 seq=续拉游标；缺 seq 域的项不进水位线——契约外数据
        // 若把游标推过去，这批项就再也拉不回了
        let pageMax = since
        if (Array.isArray(resp.items)) {
          items.push(...resp.items)
          for (const it of resp.items) {
            const s = Number(it?.seq)
            if (Number.isFinite(s) && s > pageMax) pageMax = s
          }
        }
        const progressed = pageMax > since
        since = pageMax
        // 本页零进展（空页/全缺 seq）即契约违背——续拉只会原地重发，
        // 断开防空转；guard 兜页数上限
        if (!resp.hasMore || !progressed || ++guard >= 100) break
      }
      applyRemoteItems(items)
      // 应用成功水位线才落盘（拉到≠消化）；零推进（空拉/异常页）不写
      if (since > storedSince) {
        writeJSON(SINCE_KEY, since, { remoteApplied: true })
      }
    } catch {
      // 离线/未登录 401/404/网络错一律静默——本机缓存仍是权威。
      // 首拉失败不能等下次启动：留一趟轻量排程重试，回前台/回网事件
      // 也经 onSyncForeground 低频补拉（同一节流窗，不引长轮询）
      schedulePullRetry()
    } finally {
      pulling = null
    }
  })()
  return pulling
}

// pull 失败的轻量补拉：60s 节流，已有排程不叠加——失败常态下不放大请求
const schedulePullRetry = () => {
  if (pullRetryTimer || !inited) return
  pullRetryTimer = setTimeout(() => {
    pullRetryTimer = null
    void pullFromServer()
  }, PULL_RETRY_MS)
}
// online / visibilitychange→visible 的低频补拉口：与排程重试同一节流
// 窗（距上次发起 ≥PULL_RETRY_MS 才再拉），事件风暴不刷请求
const onSyncForeground = () => {
  if (inited && Date.now() - pullLastTry >= PULL_RETRY_MS) void pullFromServer()
}

// ── 推送 ──
// 把脏集炸成 sync 形态：doc 键整文档，PLAYLISTS 按单 diff，lib:index 恒随歌单写
const buildChanges = (keys) => {
  const changes = []
  const docRaws = new Map()   // lsKey → 本趟发送的 raw（成功后刷 knownContent）
  const plPuts = new Map()    // playlistId → 本趟发送的 updatedAt
  const plTombstones = []     // 本趟发送的墓碑 id
  let libIndexTs = 0
  let libTouched = false
  for (const lsKey of keys) {
    if (lsKey === LS_KEYS.PLAYLISTS || lsKey === LS_KEYS.REMOVED_DEFAULT_PLAYLISTS) {
      libTouched = true
      continue
    }
    if (!DOC_LS_KEYS.has(lsKey)) continue
    const raw = safeGetLs(lsKey)
    const ts = metaTs(lsKey) || Date.now()
    docRaws.set(lsKey, raw)
    changes.push(raw === null
      ? { key: `${DOC_PREFIX}${lsKey}`, value: null, updatedAt: ts, deleted: true }
      : { key: `${DOC_PREFIX}${lsKey}`, value: raw, updatedAt: ts, deleted: false })
  }
  if (libTouched) {
    const saved = readJSON(LS_KEYS.PLAYLISTS, [])
    const list = Array.isArray(saved) ? saved.filter(p => p && p.id != null) : []
    const seen = new Set()
    for (const p of list) {
      const id = String(p.id)
      // 播放上下文产物（single_song_ 分享壳 / saved_queue_ 队列快照）不主动
      // 推：一次性壳随库广播会把他端库塞满临时单。也不进 seen——曾推过的
      // 壳按「本地缺席」口径在下方产墓碑，把服务端上的壳善终掉。收不收由
      // 合并侧定（远端若推来 merge 照旧受理），本侧只管住不推；正常单的
      // 「首脏全推」兜底不受影响
      if (isEphemeralPlaylistId(id)) continue
      seen.add(id)
      const ts = playlistTs(p)
      // 与上次推送快照 diff：新增/updatedAt 变动 → put；未变跳过
      if (pushedPlStamps.get(id) !== ts) {
        changes.push({ key: `${PLAYLIST_PREFIX}${id}`, value: p, updatedAt: ts, deleted: false })
        plPuts.set(id, ts)
      }
    }
    // 消失的 id → deleted 墓碑，两层来源统一到持久表（plTomb）：
    //   1) pushedPlStamps 会话内 diff 检出本趟删除——现记现发。已表内的
    //      保原戳：墓碑戳=真实删除时刻，退避重试/跨会话续发都不漂
    //   2) plTomb 缺席即续发——跨会话删除知识：本会话删单+推送失败+重启
    //      后 pushedPlStamps 归零也照发墓碑（防服务端僵尸行复活）
    for (const id of pushedPlStamps.keys()) {
      // 墓碑戳=本次歌单库写刻（libWriteAt 打在脏标记刻，重试/延迟 flush 不漂）；
      // 兜底 Date.now() 兜的是无写刻可考的非常规缺席（合并肩等）
      if (!seen.has(id) && tombTs(id) === 0) stampPlTomb(id, libWriteAt || Date.now())
    }
    for (const [id, ts] of Object.entries(plTombMap())) {
      if (seen.has(id)) { dropPlTomb(id); continue } // 本地重现——删除知识作废
      changes.push({
        key: `${PLAYLIST_PREFIX}${id}`, value: null,
        updatedAt: Number(ts) > 0 ? ts : Date.now(), deleted: true,
      })
      plTombstones.push(id)
    }
    // lib:index 恒随歌单写更新——顺序+移除名单与歌单项同批出行保持一致
    const removed = readJSON(LS_KEYS.REMOVED_DEFAULT_PLAYLISTS, [])
    libIndexTs = Date.now()
    changes.push({
      key: LIB_INDEX,
      value: {
        order: list.map(p => p.id),
        removedDefaultPlaylists: Array.isArray(removed) ? removed : [],
      },
      updatedAt: libIndexTs,
      deleted: false,
    })
  }
  return { changes, docRaws, plPuts, plTombstones, libIndexTs }
}

const flushPush = async () => {
  if (flushing || !dirty.size) return
  flushing = true
  const batch = [...dirty]
  dirty.clear()
  try {
    // 在途拉取先落地——否则推送会把刚拉到的远端值当本地变更回顶
    if (pulling) await pulling
    const built = buildChanges(batch)
    // 单条 value>256KB 会让服务端整批 400——剔出超限项保批次；
    // 其基线不推进（本就不是可同步物，下趟照样被剔，告警可追）。
    // 字节口径与服务端 valueJsonOf 同源：墓碑恒 'null'、undefined 归一
    // null——按真实落库串形计量，不算请求侧脏形态
    const sendable = []
    for (const c of built.changes) {
      const valueBytes = byteLen(c.deleted
        ? 'null'
        : JSON.stringify(c.value === undefined ? null : c.value))
      if (valueBytes > PUSH_MAX_VALUE_BYTES) {
        console.warn('[sync] 单条 value 超 256KB 上限，跳过推送:', c.key)
        built.docRaws.delete(c.key.startsWith(DOC_PREFIX) ? c.key.slice(DOC_PREFIX.length) : c.key)
        if (c.key.startsWith(PLAYLIST_PREFIX)) built.plPuts.delete(c.key.slice(PLAYLIST_PREFIX.length))
        continue
      }
      sendable.push({ ch: c, valueBytes })
    }
    if (sendable.length) {
      const conflicts = []
      const rejected = []
      // 条数+字节双闸切块，谁先到顶谁开新块——只按 500 条切时首同步
      // ~16 个 256KB 歌单即撞服务端 4MB 整批闸（必败批次进退避死循环）。
      // 块首行豁免字节闸（与服务端 pull 页首行同口径）：单项已过 256KB
      // 闸天然装得进预算，豁免只兜「单项超阈永远发不出」的死路
      let chunk = []
      let chunkBytes = 0
      const sendChunk = async () => {
        const resp = await syncApi.push(chunk)
        if (!resp || resp.code !== 200) throw new Error(`sync push code=${resp?.code}`)
        if (Array.isArray(resp.conflicts)) conflicts.push(...resp.conflicts)
        if (Array.isArray(resp.rejected)) rejected.push(...resp.rejected)
        chunk = []
        chunkBytes = 0
      }
      for (const s of sendable) {
        if (chunk.length >= PUSH_CHUNK_SIZE
          || (chunk.length > 0 && chunkBytes + s.valueBytes > PUSH_BATCH_BUDGET_BYTES)) {
          await sendChunk()
        }
        chunk.push(s.ch)
        chunkBytes += s.valueBytes
      }
      if (chunk.length) await sendChunk()
      // 成功才推进基线：失败重试要靠旧基线 diff 出同一批变更
      for (const [k, raw] of built.docRaws) {
        if (raw === null) knownContent.delete(k)
        else knownContent.set(k, raw)
      }
      for (const [id, ts] of built.plPuts) pushedPlStamps.set(id, ts)
      for (const id of built.plTombstones) pushedPlStamps.delete(id)
      if (built.libIndexTs) stampMeta(LIB_INDEX, built.libIndexTs)
      failStreak = 0
      // 服务端平局/本地落后留旧的项回包在 conflicts——采纳远端值落 LS。
      // 回包形 {key,item:{key?,value,updatedAt,deleted,seq}}：item 内层 key
      // 只是冗余可缺字段，一律以外层 c.key 为准铺平——直接喂 c.item 时
      // 无 key 的项会被 applyRemoteItems 形状闸丢光，LWW 负方永久分叉
      //（基线已推进、脏集已清，本地旧值永远等不到重判）
      const adopted = []
      for (const c of conflicts) {
        if (!c || typeof c.key !== 'string') continue
        const it = c.item
        if (!it || typeof it !== 'object' || Array.isArray(it)) continue
        adopted.push({ ...it, key: c.key })
      }
      applyRemoteItems(adopted)
      if (rejected.length) {
        // 硬拒项的基线已随本批推进、脏集已清——服务端硬拒（形状/大小闸）
        // 重发必败，不再重试是刻意（告警留痕可追）
        console.warn('[sync] 部分变更被服务端拒绝:',
          rejected.map(r => r?.key ?? r).join(', '))
      }
    }
  } catch {
    // 离线/401/404/网络错：脏集回收 + 指数退避；下次 markDirty 也会再试。
    // 本地写已落 LS——同步只是叠加层，失败不回滚本地
    for (const k of batch) dirty.add(k)
    failStreak++
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failStreak - 1))
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => { retryTimer = null; void flushPush() }, delay)
  } finally {
    flushing = false
    // 在途互踩窗收口：本趟在途期间新脏排到的防抖定时器触发时撞 flushing
    // 闸早退——定时器已耗散，只复位不重排会把这批脏键停摆到下一写事件。
    // retryTimer 在跑说明失败退避链已接管（catch 排了 retry），不抢；
    // flushTimer 还在则说明在途期的写已自排下一趟，也不重复排
    if (dirty.size && !flushTimer && !retryTimer) scheduleFlush()
  }
}

const scheduleFlush = () => {
  // trailing 防抖 + maxWait 截尾：连续写（播放中 PLAYER_STATE ~1/s 一档）
  // 会把 1.5s 窗口无限重排——首脏起算超 MAX_WAIT_MS 必发，播放期不零推送
  if (!firstDirtyAt) firstDirtyAt = Date.now()
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstDirtyAt + MAX_WAIT_MS - Date.now()))
  clearTimeout(flushTimer)
  flushTimer = setTimeout(() => { flushTimer = null; firstDirtyAt = 0; void flushPush() }, wait)
}

// 杀页/转后台兜底 flush：best-effort——脏集有货就把 push 发出去（axios
// 发出去即尽人事，绝不阻塞卸载；丢一趟也只是慢收敛，本地已落盘）
const flushNow = () => {
  if (!dirty.size) return
  clearTimeout(flushTimer)
  flushTimer = null
  firstDirtyAt = 0
  void flushPush()
}
const onSyncPageHide = () => flushNow()
const onSyncVisibility = () => {
  if (typeof document === 'undefined') return
  if (document.visibilityState === 'hidden') flushNow()
  else onSyncForeground()
}
const onSyncOnline = () => onSyncForeground()

// ── 引擎生命周期 ──
// App.vue onMounted 尾部调用：注册写钩 + 补记绕钩键。此后 pullFromServer 发首拉
export function initSync() {
  if (inited) return
  inited = true
  // firstSync 判定必须在 pendingWrites 回放之前捕获：回放对 doc 键会
  // stampMeta → META_KEY 落盘 → 回放后再读 safeGetLs(META_KEY) 恒非 null，
  // 存量播种永判假。生产链必踩：setup 顶挂写钩→init 前
  // savePlayerStateToStorage 几乎必跑→PLAYER_STATE 进 pendingWrites
  const firstSync = readJSON(SINCE_KEY) === null && safeGetLs(META_KEY) === null
  setWriteHook(onStorageWrite)
  // 叶模块（主题/偏好）远端回填订阅——它们的模块域不持引擎引用，
  // 订阅边全部挂在本侧
  for (const [k, h] of LEAF_APPLY_HANDLERS) onRemoteApply(k, h)
  // 卸载/前后台/回网钩子（同函数引用重挂幂等；resetSyncState 统一摘）：
  // 杀页兜底 flush、回前台低频补拉
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onSyncPageHide)
    window.addEventListener('online', onSyncOnline)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onSyncVisibility)
  }
  // init 前攒下的写统一回放——重走同一条记脏路径（读盘→回声判据→盖戳
  // 记脏），戳打在回放刻≈真实写刻。回放先于播种循环执行：pending 里的
  // 存量键按「刚写过」拿 now 戳（新写压远端是正当 LWW），播种小戳只兜
  // 从没被碰过的陈旧键——播种闸 metaTs(k)===0 天然跳过刚回放盖的 now 戳
  for (const k of pendingWrites) onStorageWrite(k)
  pendingWrites.clear()
  // 首同步（本机从未建立同步态——无游标无写戳表）：存量 LS 全量记脏一趟，
  // 否则本机老数据永远等不到「下一次本地写」才上行。远端已有更新值的键
  // 靠 push conflicts 回包采纳收敛；推送让行在途拉取（flushPush 内 await
  // pulling），拉到的远端值不会被当成本地变更回顶
  if (firstSync) {
    for (const k of SYNC_LS_KEYS) {
      if (safeGetLs(k) === null) continue
      // doc 键必须有 LWW 写戳才出得了门（服务端拒非正数 ts）——存量键
      // 盖极小戳 SEED_TS 而非「现在」：远端只要有真实戳就经 conflicts
      // 回包采纳，陈旧本地值不得以首同步刻压死远端新值
      if (DOC_LS_KEYS.has(k) && !metaTs(k)) stampMeta(k, SEED_TS)
      dirty.add(k)
    }
  }
  // SETUP_DISMISSED 是白名单里唯一绕过钩子的写点（auth-state.js 裸 setItem，
  // 不在前端同步文件域内）：除首同步播种外，每次 init 也兜底补记——
  // dismissSetup 抢在 initSync 前触发时 watcher 的 markDirty 会进 pending
  // 集回放，此处再补一层保险（双保险，metaTs 判重不重复盖戳）
  if (safeGetLs(LS_KEYS.SETUP_DISMISSED) !== null && !metaTs(LS_KEYS.SETUP_DISMISSED)) {
    stampMeta(LS_KEYS.SETUP_DISMISSED, Date.now())
    dirty.add(LS_KEYS.SETUP_DISMISSED)
  }
  if (dirty.size) scheduleFlush()
}

// 测试隔离/引擎复位：清脏集、订阅表、基线与计时器并摘掉写钩——
// 生产路径只进 initSync，本函数是给 spec 用的逃生口
export function resetSyncState() {
  inited = false
  dirty.clear()
  pendingWrites.clear()
  applyHandlers.clear()
  knownContent.clear()
  remoteDeleted.clear()
  pushedPlStamps.clear()
  docMeta = null
  futureTsWarned = false
  failStreak = 0
  flushing = false
  pulling = null
  firstDirtyAt = 0
  libWriteAt = 0
  pullLastTry = 0
  clearTimeout(flushTimer)
  clearTimeout(retryTimer)
  clearTimeout(pullRetryTimer)
  flushTimer = null
  retryTimer = null
  pullRetryTimer = null
  if (typeof window !== 'undefined') {
    window.removeEventListener('pagehide', onSyncPageHide)
    window.removeEventListener('online', onSyncOnline)
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onSyncVisibility)
  }
  setWriteHook(null)
}
