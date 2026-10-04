# 审查结论复核报告（第二轮：对 CODE_REVIEW.md 的独立审计）

- 复核日期：2026-10-04
- 对象：[CODE_REVIEW.md](CODE_REVIEW.md) 的全部 96 条结论
- 方法：**21 个子代理** —— 4 批复查 16 条 critical/high、1 个专职代理压力测试 12 条修复建议、12 批对抗性复核 88 条从未验证的 medium/low、4 个代理审计报告本身（遗漏面 / 事实计数 / 严重度校准 / 修复建议）
- 全部复核者被要求证伪优先：实际打开代码、追踪调用方、在 /tmp 做最小复现；仓库文件零改动

## 一、复核裁决总览

| 裁决 | 数量 |
|---|---|
| confirmed | 69 |
| partially-confirmed | 36 |
| uncertain | 3（含 1 条占位回执） |
| refuted | 2 |
| **合计** | **109** |

> 109 = 16 critical/high 复查 + 12 修复建议压力测试 + 33 medium + 47 low + 1 占位回执。

**严重度变化：15 条**（14 条下调、1 条上调）；**2 条被完全推翻**；**12 条修复建议中 4 通过 / 7 需补强 / 1 推翻**；**新增 8 条发现**；**20 条正文勘误**。

## 二、被推翻的结论（2 条，不应修复）

### ❌ `src/components/WatchView.vue:457-466, 334`｜相关栏滚动还位挂在 display:none 的元素上，永远还不上（并空转 2.5s 轮询定时器）

- 原级别：low
- 推翻理由：第二轮独立复核推翻：隐藏元素 scrollTop 恒为 0，scroll-mem.js:28 对 top=0 短路，故 2.5s 轮询根本不会启动；「永远还不上」的前提不成立。残留的极小事实（离开非 related tab 时该栏位置不跨页保留）与原文描述的机制不同。**该条不成立。**

```
三条反证：(1) 浏览器实测隐藏元素 scrollTop 读数 0（隐藏期间无法保存非 0 记忆）；(2) scroll-mem.js:28 对 top=0 短路，2.5s interval 不可能启动；(3) tab 单源持久化使『隐藏挂载 + 非 0 记忆』这一组合不可达。另：建议的『切 tab 时惰性还位』读到的仍是 0，治不了它声称的场景——真要保留需在隐藏/切 tab 前写记忆，而非改还位时机。残留的极小事实只是『离开非 related tab 时该栏位置不跨页保留』，而这与 finding 描述的机制和修复都不同。
```

### ❌ `src/composables/usePlayer.js:123-134, 166-168, 1341, 1350; src/App.vue:156, 370, 1002`｜restoreUiState 先落 isFullscreenPlayerOpen 而恢复失败不回滚：无歌曲时底栏整条消失且应用内无法复位

- 原级别：medium
- 推翻理由：第二轮独立复核推翻：restoreUiState(usePlayer.js:123-134) 根本不读 isFullscreenPlayerOpen，写入它的是 restorePlaybackState:166-168，位于全部失败出口之后且 currentSong 在 playSong:516 同步赋值；全仓不存在 currentSong.value = null，故「flag=true ∧ currentSong=null」不可构造。建议的「把 flag 恢复挪到 playSong 之后」还会回退 commit 0706f74 修掉的白拉流问题。**该条不成立，不应修复。**

```
三点反证：(1) usePlayer.js:123-134 的 restoreUiState 只恢复 volume/playMode/shuffleOn/showVipSongs/autoplayOn/fullscreenLyricMode/fullscreenInteractionMode，完全不碰 isFullscreenPlayerOpen；(2) 全仓唯一从存档写该 flag 的位置是 restorePlaybackState 内的 166-168，它在四个失败出口（144、147、153、157-160）之后，紧接 172 的 await playSong(...)，而 playSong 在 445-516 之间没有任何 await，516 行同步执行 currentSong.value = song，且全仓不存在 `currentSong.value = null`（grep 零命中）——因此 flag=true ∧ currentSong=null 不可构造，BottomPlayer 不会被误隐藏；(3) 复查意见自己列的『位置』含 166-168，恰好说明 flag 的写入在失败出口之后。恢复失败时 App.vue:1112 跳过落盘只是让存档里留旧的 true，内存态仍为 false，刷新后再失败亦然；恢复失败时 flag 根本不会被置 true，也就没有『此后点歌突然盖住 watch 页』（那是成功恢复路径的预期行为）。关键行：usePlayer.js:123-134、136-160、164-172、516；App.vue:1078、1107、156、370。
```

## 三、严重度调整（15 条）

| # | 位置 | 结论 | 原级 | 复核后 |
|---|---|---|---|---|
| 12 | `src/composables/usePlaylistLibrary.js` | 未入库预览单的「从歌单移除」写进快照并报成功，重开即复活（与 applyTrackEdit  | medium | **low** |
| 41 | `tests/helpers.mjs` | matchWithBudget/matchTracksPool 真身零覆盖，且路由测试用的替 | medium | **low** |
| 42 | `tests/deletion-locks.test.mjs` | deletion-locks 测试从不验证墓碑 TTL 到期——模块核心语义无断言 | medium | **low** |
| 43 | `tests/stream-vault.test.mjs` | stream-vault 测试头声称覆盖 LRU，但容量淘汰、LRU touch、24h 绝 | medium | **low** |
| 44 | `tests/settings.test.mjs` | settings.test.mjs 注释声称"写面限流 全链钉住"，实际无任何 429/限流 | medium | **low** |
| 45 | `tests/settings.test.mjs` | settings.test.mjs 用例间通过 process.env 隐式传递前置状态，无 | medium | **low** |
| 46 | `tests/netease-match.test.mjs` | "不触发 AI"用 aiScript.length===0 断言，是恒真的空断言 | medium | **low** |
| 51 | `src/server/lib/password.js` | argon2id 哈希在 engines 允许的 Node 20/22 上无法校验：登录成功 | medium | **low** |
| 53 | `start.js` | start.js 的 SIGKILL 升级永不生效：child.killed 让强制终止变成 | medium | **low** |
| 57 | `src/server/db/client.js` | download_tasks.queue_id 声明的 ON DELETE CASCADE  | medium | **low** |
| 63 | `src/server/services/netease-api.js` | 解锁缓存命中绕过代理白名单预筛：download 键被「有代理」与「无代理」两类调用共享 | medium | **low** |
| 65 | `src/server/routes/bilibili.js` | bilibili 视频流：durl 合流兜底被 dashBestH<1080 门挡住，无 a | low | **medium** |
| 71 | `src/server/routes/downloads.js` | quick 下载把 startQueue 的所有 409 都吞成成功，停机/删除窗口下返回  | medium | **low** |
| 92 | `src/server/ws/remote.js` | role=host 绕过 MAX_CONTROLLERS，且顶替只做优雅 close：被顶替 | medium | **low** |
| 93 | `src/server/ws/remote.js` | WS 升级路径完全脱离限流：未认证请求每发一次即打一次 SQLite | medium | **low** |

主要规律：**「测试零覆盖 / 注释与实现不符 / 迁移静默无效」这一类被系统性下调**（13 条 medium→low），第二轮的判断是——这些是「诚实性 / 防回归」收益，而非用户可见缺陷；唯一上调的是 `#65`（B 站视频流 durl 兜底被门挡住导致 404，属用户可见功能错误，low→medium）。

## 四、修复建议压力测试（12 条）

| # | 结论 | 裁决 | 关键修正 |
|---|---|---|---|
| 28 | compose 把 DOWNLOAD_TOKEN 烧进前端产物：登录 | ⚠️ 需补强 | 方向正确，按建议实施并把配套做全：(1) docker-compose.yml:14 改为 `VITE_DOWNLOAD_TOKEN: ${VITE_DOWNLOAD_TOKEN:-}`；(2) 同步改 .env.example:38-40、DEPLOYMENT.md:31、117-121、307-308、README 前端变量表，统一口径为『DOWNLOAD_TOKEN 只做服务端/脚本旁路，启用登录的部署绝不注入 VITE_DOWN |
| 29 | Dockerfile 前端阶段未 COPY scripts/：npm | ✅ 可落地 | 按建议在 Dockerfile:25 之前加 `COPY scripts ./scripts` 即正确（实测通过）。把脚本挪进 src/ 需同步改 package.json:12 的 postbuild 路径，收益不大；让 postbuild 容忍缺失才不可取（会静默丢掉预压缩特性）。 |
| 30 | .env.example 的 NODE_ENV=developmen | ⚠️ 需补强 | 推荐组合：(1) 主修——.env.example 删 NODE_ENV 行并同步 DEPLOYMENT.md:55 措辞（说明 Vite 构建期会读它）与 README:68-74；(2) 代码兜底——vite.config.js 顶部只对 build 生效：`...(command==='build' ? { define: { 'import.meta.env.PROD':'true','import.meta.env.DEV': |
| 50 | 静态中间件对所有 GET/HEAD 全局删除 Range 头——已实 | ✅ 可落地 | 取第一个方案：`app.use('/*', (c,next)=>{ if (c.req.method!=='GET'&&c.req.method!=='HEAD') return next(); if (!isApiPath(c.req.path)) c.req.raw.headers.delete('range'); return staticMiddleware(c,next) })`。API 路径永远不会命中 dist 实体文件（ |
| 69 | HEAD 请求 /downloads/songs/:songId/f | ✅ 可落地 | 在 downloads.js:353-358 的空文件分支之后、:360 createReadStream 之前插入：`if (c.req.method === 'HEAD') { closeFd(); return c.body(null, status, headers); }`。等价可选写法是先建 stream 再 `if (HEAD) stream.destroy()`，但显式 closeFd 更直观。必须保留 fd 预开以维持 |
| 91 | send() 无背压控制：不读取的 controller 使服务端无 | ✅ 可落地 | 把预算只加在 broadcastToControllers：循环前 `const str = JSON.stringify(msg)` 一次序列化，循环内对每个 controller 先查 `ctrl.bufferedAmount`，超过阈值（1MB 左右）就跳过该帧（state_update 是全量快照，安全）；只有连续多帧仍超限时才 close(1013) 且仅限 controller，绝不作用于 hostSocket 与 384  |
| 37 | 认证中间件 authGate 本体零调用——401/旁路/公开前缀/ | ⚠️ 需补强 | 新增 tests/auth-gate.test.mjs：DATA_DIR 隔离，先断言 users 空表时 API GET 放行（默认部署不回归），再 createUser+createSession，用 `app.request(url,{headers:{cookie, host:'localhost', origin:...}})` 显式带 host 头；断言矩阵＝无 cookie GET/POST→401 且 X-Ms-Auth |
| 51 | argon2id 哈希在 engines 允许的 Node 20/2 | ⚠️ 需补强 | 从 password.js 导出 `argon2Available`；登录路由在查到 user 后若 `user.passwordHash.startsWith('a2id$') && !argon2Available` 返回可区分 503（同时照常跑 dummy verify，避免枚举时序/状态差异；或更简单——运行时缺 argon2 且库内存在 a2id 行时对所有登录统一 503）。另加 scripts/reset-passwor |
| 57 | download_tasks.queue_id 声明的 ON DEL | ⚠️ 需补强 | 更简单且不失能力的组合：保留字典里的 REFERENCES（缺列库仍能装 FK），把 59-60 与 DOWNLOAD_GUIDE 的措辞改成『已存在但无 REFERENCES 的旧列无法补 FK，删除路径一律显式清任务行』，并在启动时加一条幂等自愈（`DELETE FROM download_tasks WHERE queue_id IS NOT NULL AND queue_id NOT IN (SELECT id FROM dow |
| 63 | 解锁缓存命中绕过代理白名单预筛：download 键被「有代理」与「 | ⚠️ 需补强 | 取键分裂方案：`unlockCacheGet/Set` 键改 `${purpose}/${proxyOrigin ? 'px' : 'direct'}/${id}`（或缓存未过滤集、在 421-423 算出 useProxy 后再按需过 isProxyAllowedHost），使带 proxyOrigin 的读取永不消费直连写入的集合；保留 364-366 的 checked 重对齐与 345-351 注释同步更新。若选无条件过滤，需明 |
| 83 | 看门狗「等用户手势」分支把播放键变成死键：错误文案要求点播放，但 t | ⚠️ 需补强 | 取建议的第二个（更简单更完整）方案：在手势分支 return 前加 `newHowl.unload(); if (howl === newHowl) howl = null;`，保持 songSwitching=false、isPlaying=false、文案不变。若坚持 retryPending 方案，必须同步让 useRemoteControl.js:80-86 的 play 分支也走该标记/playSong 重建，否则远端仍是死路 |
| 85 | restoreUiState 先落 isFullscreenPlay | ❌ 有误 | 无需修复该『缺陷』。若只想要防御网：可在 App.vue 恢复流程收尾加 `if (!currentSong.value) isFullscreenPlayerOpen.value = false`（无害空操作），并把 f 键/Back 的关层语义限定为『只置 false、绝不在无歌曲时置 true』，openFullscreenPlayer 的 `if (!currentSong.value) return` 守卫保持不变。切勿把 f |

### 审计代理另外抽查出 8 条有实质缺陷的建议

- **idx 4：把 aiTimeout 加入 SettingsPanel 的 watch，使改了超时后旧的「连接成功」横幅失效**（`src/components/SettingsPanel.vue:299`）
  - 问题：该建议的前提不成立：/settings/ai-test 完全不消费超时输入——前端只送 {baseUrl, apiKey, model}（src/api/settings.js:13-14），服务端探测用硬编码 AbortSignal.timeout(10000)（src/server/routes/settings.js:92），从不读 aiTimeout/AI_TIMEOUT_MS，且草稿超时也不会被送进探测。因此改超时不可能让「连接成功」这个可达性/鉴权结论变旧；当前 watch 列表 [aiBase, aiKey, aiModelName] 恰好就是被探测输入的全集，按建议加入 aiTimeout 只会无依据地清掉仍然有效的成功横幅，反而与该注释「避免结论挂在已改配置下误导」的语义不符（被改的超时不属于被探测配置），并给后续维护者留下「超时参与探测」的错误暗示。
  - 正解：不改 watch；如需消歧，只在「超时 (ms)」输入旁注明该值不参与连通性探测（探测固定 10s 上限），或把注释里的「输入」明确限定为 base/key/model。
- **idx 7：让下载队列终态与任务集合自洽——崩溃兜底回 pending、startQueue 放行「failed 但有 pending 行」、retryQueue 退化为 star**（`src/server/services/download-manager.js:361-363, 1922-1927, 2013-2018`）
  - 问题：建议只改服务端状态机，遗漏了所有暴露入口的前端口径，照做后用户可见症状仍在：DownloadQueueList.vue:110 的启动键条件是 `['pending','cancelled'].includes(queue.status)`（failed 不显示启动），:254-256 的 canRetry 要求 `queue.failedTasks > 0`；DownloadTaskRow.vue:58-59 对 status 为 pending/downloading 的行隐藏删除。于是「failed 且仍有 pending 行」（startQueue 新放行的对象）与「failed、failed_tasks=0」两类队列在 UI 上依旧只有「详情/删除」，新加的服务端入口不可达；retryQueue 的 pending 退化分支同样因 canRetry 的 failedTasks 闸而被前端藏住。
  - 正解：服务端改动与前端同步：启动键条件改为「pending/cancelled 或 (failed 且存在 pending 行)」，canRetry 增加「failed_tasks=0 但 total>completed+failed」分支，DownloadTaskRow 对无在途协程的 pending 行放行删除；更稳妥的是由服务端在队列 DTO 上直接下发 canStart/canRetry 能力位，避免前后端两套状态判定再次漂移；并补一条「failed 队列仍有 pending 行」的服务端用例。
- **idx 43：用 ttlMs:MAX_TTL_MS+ 或伪造 notAfter 来断言 stream-vault 的 24h 绝对上限生效**（`src/server/lib/stream-vault.js:44, 65`）
  - 问题：该断言按字面无法成立：mint(url, { ttlMs: 25h }) 只把 expiresAt 推到 25h，notAfter 仍是 now+24h，立即 resolve 时两个时间都大于 now，仍返回条目——不推进时钟就断言不出任何东西（写「ttlMs>MAX_TTL_MS 应 resolve 为 null」会直接失败）；而 stream-vault.js:65 只导出 { mint, resolve }，vault 与 MAX_TTL_MS 都不可见，条目只能经 resolve 获得且不返回 notAfter，「伪造 notAfter」也无从下手。同一建议里的「断言 vault.size 不增长」同样没有可读的 vault。
  - 正解：用 node:test 的 mock.timers（apis:['Date']）把 Date 前进 >24h 后再 resolve 断言 null（engines ≥20.19 已支持），或导出 MAX_TTL_MS/内部 vault（或注一个测试专用 size/peek 口）再断言；不要用「ttlMs > MAX_TTL_MS 立即断言」这种写法。
- **idx 44：连发 21 次 PUT 断言第 21 次 429，「且成功写不计数/失败路径 refund 行为符合预期」**（`src/server/routes/settings.js:36`）
  - 问题：后半句把 rateLimitByKey 的 refund 语义张冠李戴：settings-write 用的是 IP 桶 rateLimit（src/server/lib/rate-limit.js:19-33），只加不减；全仓唯一的退还是登录用的 refundByKey（:57-61）。而且该 rateLimit 调用位于 parseJsonBody 与 entries 过滤之后、逐键校验之前（settings.js:33-42）——「有合法键但值非法」的请求照样计数（随后 400），「无 entries/解析失败」的请求则不计数。按建议去断言「成功写不计数」「失败路径 refund」会写出与实现相反的用例。
  - 正解：只钉 IP 桶真实语义：21 次「有合法键」的 PUT，第 21 次 429；另加一例断言「无可写配置项（entries 为空）的请求不消耗桶」（它到不了 rateLimit）；删掉 refund 相关断言，refund 只属于登录链的 rateLimitByKey。
- **idx 79：把 model 纳入译文缓存判定——命中行 model 与当前 aiModel() 不符即视为未命中并重译**（`src/server/repositories/lyricAi.js:8-13, 23-29`）
  - 问题：直接按「model = 当前模型」收紧 getCachedTranslation 会把 skip 哨兵一起判为未命中：哨兵行的 model 是 'skip:already-zh'/'skip:no-lyric'/'skip:too-long' 等（:23-28 markTranslationSkip 写入 `skip:${reason}`），永远不等于 aiModel()。后果正是 :5-7 注释要避免的——already-zh/无词曲/超长的歌每次重播都重打上游 lyric 并重跑启发式判定，放大上游请求与限流压力；官方译文行 model 是 'netease'/'qq'（src/server/routes/ai.js:113-114），也会被无谓判失效而重译。
  - 正解：命中判据写成 `(model LIKE 'skip:%' AND updated_at >= datetime('now','-7 days')) OR model = :currentModel`，保留哨兵 7 天 TTL；更清晰的做法是拆列（sentinel_reason 与 ai_model 分开），只对 AI 译文行做模型比对，并对官方译文行按 srcModel 特判。
- **idx 93：在 onUpgrade 开头按 clientIp(env.js:24-34) 做与 HTTP 同源的滑动窗限流，超限直接 rejectUpgrade(429)**（`src/server/ws/remote.js:202-268`）
  - 问题：缺少必需的配套重构，按字面实现会抛错：rateLimit(c,...) 与 clientIp(c) 都是 Hono 上下文签名（rate-limit.js:20 `clientIp(c)`；env.js:25-34 读 `c.req.header('x-forwarded-for')` 与 `c.env?.incoming?.socket?.remoteAddress`），而 WS 走原生 server.on('upgrade')，onUpgrade 拿到的是 Node req/socket，没有 c.req/c.env——直接把 req 传进去就是 TypeError。更危险的是 onUpgrade 全程无 try/catch（这正是报告里 high 级的 finding idx 89），'upgrade' 事件的抛错会直达 uncaughtException → process.exit，等于把「加限流」变成「每次 WS 连
  - 正解：先把 env.js 的 IP 解析与 Hono 解耦：抽出 `clientIpFromHeaders(headers, remoteAddress)`，原 clientIp 改为薄包装；rate-limit 暴露接受 (key, ip, limit) 的核心函数。onUpgrade 用 req.headers/req.socket.remoteAddress 调用它，并将整个限流+鉴权段包进 try/catch + rejectUpgrade(socket, 500)（同时收敛 idx 89）。
- **idx 74：lyric-translate 加单调截止，并把已翻译结果按块增量落库（或至少在 abort/超时时把已得 translated 合并写盘）**（`src/server/routes/ai.js:80-86, 224-226`）
  - 问题：「在 abort/超时时把已得 translated 合并写盘」这条捷径与既有缓存语义直接冲突：缓存命中即整体返回（:80-86 rowOf→直接 return，行上没有完成度/块位图），所以提前写盘会把一份截断译文当成完整缓存永久下发，下次重播不再补译——正是 idx 76 要修的问题，比现状（超时丢弃、下次重跑）更差；「按块增量落库」若不配套完成度标记与续译入口同样会固化成永久残缺译文。
  - 正解：本轮的正面改动只保留时间闸（到点不再开新块、不再追加 55s 块），不要写部分结果到 song_lyric_translation。若要增量续跑，必须与 idx 76 合并设计：先加完成度/已译块位图字段，再把缓存命中路径改为「完整才直回，未完成则续译并合并」，并为「超时后重放能续译」补用例。
- **idx 70：206 一律解析 Content-Range、解析不到合法 Content-Range 就按确定性违规处理（或改回无 Range 的全量 GET）**（`src/server/services/download-io.js:318-326; src/server/services/file-d`）
  - 问题：两个备选都带回归面：(a) 把任何拿不到合法 Content-Range 的 206 直接 fatal，会把当前能正常落盘的上游（非严格实现/CDN 缺该头但仍回全量字节）从「静默可用」变成「硬失败且不重试（fatalError 语义）」——而 streamToFile 是音频/封面/解锁链共用的落盘骨架，影响面远超 Range 路径；(b) 括号里的「改回无 Range 全量 GET」与 file-downloader.js:47-48 自己记录的实测事实冲突（googlevideo 对全量 GET 回 403，`bytes=0-` 才通），照做会让 YouTube 外部音频直接拿不到流。
  - 正解：保留正面改动：解析 Content-Range 并要求 `bytes 0-.../total`、用 total 做 maxBytes 与最终字节对账；但把「206 缺头/畸形」降级为可重试错误（而不是 fatal），保留 Range 通道；删除或明确限定「改回全量 GET」这一选项（仅适用于 B 站等不限全量的源），并加一条 206 窗口被识破的用例。

## 五、报告正文勘误（20 条）

按主题归并如下；每条都是「正文与自己的复核块互相打脸」或与代码事实不符。

### [audit-severity｜影响 medium] 标题「send() 无背压控制：不读取的 controller 使服务端无界缓存广播数据」及影响「全量堆在服务端内存…OOM 风险，且心跳只清死连接、对『TCP 存活但不读』的对端无效」

- 位置：CODE_REVIEW.md:146-161（#4），对照同条验证块 167 行；src/server/ws/remote.js:274-284
- 问题：正文与本条验证块自相矛盾：remote.js:274-284 的心跳每 30s ping、isAlive 首 tick 置 false、次 tick（≤~60s）即 terminate，暂停读的对端不回 pong 故堆积在时间上被封顶；验证块 167 行明确写「这句不准确…堆积在时间上是被封顶的而非无界」。正文标题/影响仍保留「无界」「无效」，未作更正标注，却被速览计入「全部属实」。
- 修正：标题与影响改为「背压缺失 + 心跳前 ≤~60s 窗口内可堆积数百 MB（12.8MB/s 量级）」，删除或改写「心跳对不读对端无效」一句。

### [audit-severity｜影响 medium] （#33）证据中的量化数字（240 块仅 202 落位、1440x600 仅 122、390x844 180 块仅 164）与影响「整句甚至连续多句完全不渲染」「落位数学 CPU 抬升约 6 倍」

- 位置：CODE_REVIEW.md:689-716（#33），对照验证块 720-728
- 问题：验证块已推翻这些量化：原数字来自 performance.now() 几乎不动的 tight-loop 桩（相机漂移与弹簧牵引失效）；真实 60fps 下 1440x900 为 195.6/200（对照 197/200）、390x844(touch) 为 192.4/200 且空洞与对照持平（原文称 180 块仅 164，方向相反）、整行全灭只出现在非默认 pointer 模式；性能差实为 0.002-0.11ms/帧（<0.7% 帧预算），验证者明说「不应计入严重度」。正文只把级别改成 Medium，标题仍带「放大 6 倍落位开销」，证据与影响未同步。
- 修正：按验证块重写证据/影响：默认 auto 模式为 1-11% 词块迟到、0-4% 永久缺块；整行空白限定在 pointer 模式；删除「CPU 抬升 6 倍」作为影响项并注明绝对量 <0.7% 帧预算。

### [audit-severity｜影响 medium] （#3）「本地已下载媒体（songFileUrl → Howler html5 <audio>）与 /audio-proxy 的 seek 永远拿不到 206」

- 位置：CODE_REVIEW.md:122（#3），对照 netease-api-server.js:98-124 与验证块 142 行
- 问题：删 Range 的中间件（119-123 行）整体位于 `if (hasDist)`（dist/index.html 存在，98 行）之内；纯源码 clone / `npm run dev`（无构建产物）时该中间件根本不注册，Range 通路与 downloads.js 的 206/If-Range 分支正常。本条验证块 142 行已实测并写明该例外（hasDist=false 时返回 400 unsupported range），正文影响句用「永远」把例外抹掉。
- 修正：限定为「hasDist=true（Docker/已构建部署，也是生产默认）时」，并注明 dev/无 dist 场景不受影响。

### [audit-severity｜影响 low] 「未授权/低权限客户端用 HEAD 请求即可耗尽进程 fd…造成整个服务不可用」/ 标题「（可达 EMFILE 全服务不可用）」

- 位置：CODE_REVIEW.md:84, 97（#2；同措辞见 findings.json idx 69）
- 问题：EMFILE 只让「需要新开 fd」的路径失败（serveStatic 静态资源、downloads.js:269 的 openSync、uploads.js:105 与 download-io.js:311 的写流），而 SQLite 连接在启动时已持有 fd、/healthz 与 /playlists、/settings、/ai、/song-meta 等 JSON 端点逐请求不开文件，仍可持续服务（src/server/routes 内逐请求 openSync/createReadStream/createWriteStream 仅 downloads.js 7 处、uploads.js 1 处与 download-io.js 2 处）。「整个服务不可用」把部分功能瘫痪写成全站瘫痪（尽管代码注释 downloads.js:275 也用了「全服务崩」的说法）。
- 修正：改为「静态资源与全部媒体/上传/下载读写不可用（Web UI 实际打不开），已持 fd 的 SQLite JSON 端点仍可响应」。

### [audit-severity｜影响 medium] （#10）「恢复只能靠重启（recoverStaleStates:2256-2263）或用户对该曲重下」

- 位置：CODE_REVIEW.md:301（#10），对照 download-manager.js:2250-2274、598-608、361-363、2014-2018 与 DownloadQueueList.vue:110
- 问题：重启并不能恢复：任务行 downloading 且带 queueId，重启时被 recoverStaleStates:2256-2263 翻成 pending，但该队列此时已是 completed（598-608），startQueue 对 failed/completed 抛 409（361-363）、retryQueue 要求 failed 行非空（2014-2018），前端启动键只认 pending/cancelled（DownloadQueueList.vue:110）。重启后仍是同一死态，行只能删队列或走 createDownloadQueue 复活分支。
- 修正：删除「靠重启恢复」，写明该行在队列终态下无任何入口（与 #7 同态），恢复需靠 createDownloadQueue 复活分支或删队列。

### [audit-severity｜影响 low] （#40）「前端 UI 层结构性零覆盖：usePlayer.js 1492 行 + 21 个 .vue + 9 个 composable 从未被加载」

- 位置：CODE_REVIEW.md:851, 861（#40），对照 52 行速览与验证块 870 行
- 问题：src/composables 共 10 个，被测试加载的是 usePagedList、useVirtualList 两个（tests/paged-list.test.mjs、tests/virtual-list.test.mjs），未覆盖为 8 个；同一报告 52 行速览也写「8 个 composable」。验证块 870 行已指出计数错误（「未被测的是 8 个而非 9 个」），标题与证据未改。
- 修正：标题与证据统一改为 8 个 composable（10 个中 2 个已被纯逻辑测试覆盖）。

### [audit-severity｜影响 low] （#39）「当前没有任何机制能在单测阶段发现这类漂移」

- 位置：CODE_REVIEW.md:839（#39），对照验证块 845 行
- 问题：本条验证块明确判此句「偏绝对」：被测试路由的响应形状在 route 测试中被大量断言（uploads 74 处、settings 94 处、bilibili 50 处、youtube 60 处、queue-delete 多处），服务端改字段名多数会先在路由测试炸掉；真正无覆盖的是前端解析侧与未被断言的服务端字段。正文影响句未按复核结论收敛。
- 修正：改为「前端消费字段/错误码映射与未被断言的列表端点无对拍；服务端已测端点的形状变更通常会被 route 测试捕获」。

### [audit-severity｜影响 low] （#15）标题「argon2id 哈希在 engines 允许的 Node 20/22 上无法校验：登录成功即把用户锁在门外且无重置路径」

- 位置：CODE_REVIEW.md:369-381（#15），对照 src/server/lib/password.js:50-55、87-99 与 package.json engines
- 问题：机制属实（本机 node v26.8.2 的 crypto.argon2 为 function；Node 20.19/22.12 无该 API，verifyPassword 直接 return false；needsRehash 在 argon2 可用时把 scrypt 升为 a2id；engines ^20.19.0||>=22.12.0 允许低版本；全仓无 password reset 路由/脚本）。但「登录成功即把用户锁在门外」因果写反：是先在 ≥24.7 运行时（含 Docker node:24）登录成功、哈希被静默升级，之后把同一 DATA_DIR 放到 20/22 上运行才锁死，属跨运行时迁移陷阱，而非默认登录路径即中招。
- 修正：标题/影响改为「在 ≥24.7（含 Docker node:24）登录过的库迁到 Node 20/22 后无法登录」，写明触发条件为运行时降级/迁移；Medium 可保留但不应暗示默认路径必中。

### [audit-facts｜影响 low] 「14 个审查单元全部自报『分配文件已完整读完』（coverageComplete = true），文件清单见下表」

- 位置：CODE_REVIEW.md:28-46（第二节覆盖率表）
- 问题：表内只有每单元的『分配文件』数字，没有任何文件清单，所谓『见下表』的清单不存在；且该数字恒等于原始审计输出 /tmp/recovered.json 中该单元自报 filesRead 数组的长度（14/14 单元比对完全一致：A18/B18/C35/D40/E30/F11/G18/H17/I13/J29/K23/L50/M36/N41），因此『读过文件 ✅ 全部』是自证，不是对独立分配清单的核验。
- 修正：删除『文件清单见下表』或补上逐单元清单；把『分配文件』改称『单元自报已读文件数』并注明完整读毕来自 coverageComplete 自报；可补一句独立核验结果：14 单元 filesRead 并集覆盖 src 下 126/132 个文件，未覆盖的 6 个均为字体/许可资产（src/fonts/*），故代码层面确无漏审。

### [audit-facts｜影响 none] finding #40 标题与证据称『9 个 composable 从未被加载』

- 位置：CODE_REVIEW.md:851,861（对应 /tmp/findings.json 索引 39）
- 问题：计数错误。src/composables 共 10 个 .js；tests 实际加载 usePagedList.js 与 useVirtualList.js（静态闭包确认），未被加载的是 8 个；证据括号内也只列了 8 个名字（usePlayer/useSearchNav/useRemoteControl/useServerDownloads/usePlaylistLibrary/useAddToPlaylist/useExternalImport/useHomeFeed），且同条 <details> 验证意见与第二节摘要 CODE_REVIEW.md:52 都写 8。
- 修正：标题与证据中的『9 个 composable』改为『8 个 composable』。

### [audit-facts｜影响 none] 摘要关键盲区称『protocol.test.mjs 只钉常量』

- 位置：CODE_REVIEW.md:51
- 问题：与事实不符。tests/protocol.test.mjs:11-21 对 CONTROL_PAYLOAD_GUARDS 做了行为断言（play/seek/play_song 的类型、NaN、128 长度边界），:23-27 才钉 MSG_TYPES/REMOTE_LIMITS 常量；同一报告 finding #42 的验证意见已明确写『protocol.test.mjs 并非「只做字面量断言」』。
- 修正：改为『protocol.test.mjs 覆盖了常量与 payload 守卫逻辑本身；无网的是 remote.js 对这些守卫的接线，以及 Origin/控制器容量/升级鉴权级联』。

### [audit-facts｜影响 low] 覆盖率表 J 行『分配文件 29』

- 位置：CODE_REVIEW.md:41
- 问题：原始审计输出中 J 单元 filesRead 有 29 个条目，但 src/components/PlaylistGrid.vue 出现两次（第 3 项与第 23 项），去重后为 28；表格把条目数当文件数，虚增 1。
- 修正：J 行的『分配文件』应为 28（或在表注中说明该列按自报条目数、未去重）。

### [audit-fixes｜影响 low] idx 4：把 aiTimeout 加入 SettingsPanel 的 watch，使改了超时后旧的「连接成功」横幅失效

- 位置：src/components/SettingsPanel.vue:299
- 问题：该建议的前提不成立：/settings/ai-test 完全不消费超时输入——前端只送 {baseUrl, apiKey, model}（src/api/settings.js:13-14），服务端探测用硬编码 AbortSignal.timeout(10000)（src/server/routes/settings.js:92），从不读 aiTimeout/AI_TIMEOUT_MS，且草稿超时也不会被送进探测。因此改超时不可能让「连接成功」这个可达性/鉴权结论变旧；当前 watch 列表 [aiBase, aiKey, aiModelName] 恰好就是被探测输入的全集，按建议加入 aiTimeout 只会无依据地清掉仍然有效的成功横幅，反而与该注释「避免结论挂在已改配置下误导」的语义不符（被改的超时不属于被探测配置），并给后续维护者留下「超时参与探测」的错误暗示。
- 修正：不改 watch；如需消歧，只在「超时 (ms)」输入旁注明该值不参与连通性探测（探测固定 10s 上限），或把注释里的「输入」明确限定为 base/key/model。

### [audit-fixes｜影响 medium] idx 7：让下载队列终态与任务集合自洽——崩溃兜底回 pending、startQueue 放行「failed 但有 pending 行」、retryQueue 退化为 startQueue、终态后收空壳

- 位置：src/server/services/download-manager.js:361-363, 1922-1927, 2013-2018
- 问题：建议只改服务端状态机，遗漏了所有暴露入口的前端口径，照做后用户可见症状仍在：DownloadQueueList.vue:110 的启动键条件是 `['pending','cancelled'].includes(queue.status)`（failed 不显示启动），:254-256 的 canRetry 要求 `queue.failedTasks > 0`；DownloadTaskRow.vue:58-59 对 status 为 pending/downloading 的行隐藏删除。于是「failed 且仍有 pending 行」（startQueue 新放行的对象）与「failed、failed_tasks=0」两类队列在 UI 上依旧只有「详情/删除」，新加的服务端入口不可达；retryQueue 的 pending 退化分支同样因 canRetry 的 failedTasks 闸而被前端藏住。
- 修正：服务端改动与前端同步：启动键条件改为「pending/cancelled 或 (failed 且存在 pending 行)」，canRetry 增加「failed_tasks=0 但 total>completed+failed」分支，DownloadTaskRow 对无在途协程的 pending 行放行删除；更稳妥的是由服务端在队列 DTO 上直接下发 canStart/canRetry 能力位，避免前后端两套状态判定再次漂移；并补一条「failed 队列仍有 pending 行」的服务端用例。

### [audit-fixes｜影响 low] idx 43：用 ttlMs:MAX_TTL_MS+ 或伪造 notAfter 来断言 stream-vault 的 24h 绝对上限生效

- 位置：src/server/lib/stream-vault.js:44, 65
- 问题：该断言按字面无法成立：mint(url, { ttlMs: 25h }) 只把 expiresAt 推到 25h，notAfter 仍是 now+24h，立即 resolve 时两个时间都大于 now，仍返回条目——不推进时钟就断言不出任何东西（写「ttlMs>MAX_TTL_MS 应 resolve 为 null」会直接失败）；而 stream-vault.js:65 只导出 { mint, resolve }，vault 与 MAX_TTL_MS 都不可见，条目只能经 resolve 获得且不返回 notAfter，「伪造 notAfter」也无从下手。同一建议里的「断言 vault.size 不增长」同样没有可读的 vault。
- 修正：用 node:test 的 mock.timers（apis:['Date']）把 Date 前进 >24h 后再 resolve 断言 null（engines ≥20.19 已支持），或导出 MAX_TTL_MS/内部 vault（或注一个测试专用 size/peek 口）再断言；不要用「ttlMs > MAX_TTL_MS 立即断言」这种写法。

### [audit-fixes｜影响 low] idx 44：连发 21 次 PUT 断言第 21 次 429，「且成功写不计数/失败路径 refund 行为符合预期」

- 位置：src/server/routes/settings.js:36
- 问题：后半句把 rateLimitByKey 的 refund 语义张冠李戴：settings-write 用的是 IP 桶 rateLimit（src/server/lib/rate-limit.js:19-33），只加不减；全仓唯一的退还是登录用的 refundByKey（:57-61）。而且该 rateLimit 调用位于 parseJsonBody 与 entries 过滤之后、逐键校验之前（settings.js:33-42）——「有合法键但值非法」的请求照样计数（随后 400），「无 entries/解析失败」的请求则不计数。按建议去断言「成功写不计数」「失败路径 refund」会写出与实现相反的用例。
- 修正：只钉 IP 桶真实语义：21 次「有合法键」的 PUT，第 21 次 429；另加一例断言「无可写配置项（entries 为空）的请求不消耗桶」（它到不了 rateLimit）；删掉 refund 相关断言，refund 只属于登录链的 rateLimitByKey。

### [audit-fixes｜影响 medium] idx 79：把 model 纳入译文缓存判定——命中行 model 与当前 aiModel() 不符即视为未命中并重译

- 位置：src/server/repositories/lyricAi.js:8-13, 23-29
- 问题：直接按「model = 当前模型」收紧 getCachedTranslation 会把 skip 哨兵一起判为未命中：哨兵行的 model 是 'skip:already-zh'/'skip:no-lyric'/'skip:too-long' 等（:23-28 markTranslationSkip 写入 `skip:${reason}`），永远不等于 aiModel()。后果正是 :5-7 注释要避免的——already-zh/无词曲/超长的歌每次重播都重打上游 lyric 并重跑启发式判定，放大上游请求与限流压力；官方译文行 model 是 'netease'/'qq'（src/server/routes/ai.js:113-114），也会被无谓判失效而重译。
- 修正：命中判据写成 `(model LIKE 'skip:%' AND updated_at >= datetime('now','-7 days')) OR model = :currentModel`，保留哨兵 7 天 TTL；更清晰的做法是拆列（sentinel_reason 与 ai_model 分开），只对 AI 译文行做模型比对，并对官方译文行按 srcModel 特判。

### [audit-fixes｜影响 medium] idx 93：在 onUpgrade 开头按 clientIp(env.js:24-34) 做与 HTTP 同源的滑动窗限流，超限直接 rejectUpgrade(429)

- 位置：src/server/ws/remote.js:202-268
- 问题：缺少必需的配套重构，按字面实现会抛错：rateLimit(c,...) 与 clientIp(c) 都是 Hono 上下文签名（rate-limit.js:20 `clientIp(c)`；env.js:25-34 读 `c.req.header('x-forwarded-for')` 与 `c.env?.incoming?.socket?.remoteAddress`），而 WS 走原生 server.on('upgrade')，onUpgrade 拿到的是 Node req/socket，没有 c.req/c.env——直接把 req 传进去就是 TypeError。更危险的是 onUpgrade 全程无 try/catch（这正是报告里 high 级的 finding idx 89），'upgrade' 事件的抛错会直达 uncaughtException → process.exit，等于把「加限流」变成「每次 WS 连接尝试都能打挂进程」。建议也没交代 TRUST_PROXY 下 XFF 跳数语义要与 HTTP 侧复用同一份实现，否则两侧分桶口径漂移。
- 修正：先把 env.js 的 IP 解析与 Hono 解耦：抽出 `clientIpFromHeaders(headers, remoteAddress)`，原 clientIp 改为薄包装；rate-limit 暴露接受 (key, ip, limit) 的核心函数。onUpgrade 用 req.headers/req.socket.remoteAddress 调用它，并将整个限流+鉴权段包进 try/catch + rejectUpgrade(socket, 500)（同时收敛 idx 89）。

### [audit-fixes｜影响 medium] idx 74：lyric-translate 加单调截止，并把已翻译结果按块增量落库（或至少在 abort/超时时把已得 translated 合并写盘）

- 位置：src/server/routes/ai.js:80-86, 224-226
- 问题：「在 abort/超时时把已得 translated 合并写盘」这条捷径与既有缓存语义直接冲突：缓存命中即整体返回（:80-86 rowOf→直接 return，行上没有完成度/块位图），所以提前写盘会把一份截断译文当成完整缓存永久下发，下次重播不再补译——正是 idx 76 要修的问题，比现状（超时丢弃、下次重跑）更差；「按块增量落库」若不配套完成度标记与续译入口同样会固化成永久残缺译文。
- 修正：本轮的正面改动只保留时间闸（到点不再开新块、不再追加 55s 块），不要写部分结果到 song_lyric_translation。若要增量续跑，必须与 idx 76 合并设计：先加完成度/已译块位图字段，再把缓存命中路径改为「完整才直回，未完成则续译并合并」，并为「超时后重放能续译」补用例。

### [audit-fixes｜影响 low] idx 70：206 一律解析 Content-Range、解析不到合法 Content-Range 就按确定性违规处理（或改回无 Range 的全量 GET）

- 位置：src/server/services/download-io.js:318-326; src/server/services/file-downloader.js:47-53
- 问题：两个备选都带回归面：(a) 把任何拿不到合法 Content-Range 的 206 直接 fatal，会把当前能正常落盘的上游（非严格实现/CDN 缺该头但仍回全量字节）从「静默可用」变成「硬失败且不重试（fatalError 语义）」——而 streamToFile 是音频/封面/解锁链共用的落盘骨架，影响面远超 Range 路径；(b) 括号里的「改回无 Range 全量 GET」与 file-downloader.js:47-48 自己记录的实测事实冲突（googlevideo 对全量 GET 回 403，`bytes=0-` 才通），照做会让 YouTube 外部音频直接拿不到流。
- 修正：保留正面改动：解析 Content-Range 并要求 `bytes 0-.../total`、用 total 做 maxBytes 与最终字节对账；但把「206 缺头/畸形」降级为可重试错误（而不是 fatal），保留 Range 通道；删除或明确限定「改回全量 GET」这一选项（仅适用于 B 站等不限全量的源），并加一条 206 窗口被识破的用例。

## 六、第二轮新增发现

### N1. 同一根因（bundle 内嵌 DOWNLOAD_TOKEN → x-download-token 全量旁路）被拆成 Critical/High/Medium 三条并重复计数

- 级别：high｜置信度：high｜来源：audit-severity
- 位置：`CODE_REVIEW.md:57-80, 171-194, 353-367（另见 22 行速览）`

**证据**：三条指向同一条链：#1（idx 28，Critical）证据=compose:14 回落 + http.js:9,28-30 + auth-gate.js:59-61 + /assets 免登录；#5（idx 0，High）证据逐字包含同一组行号（含 docker-compose.yml:14 与 auth-gate.js:59-61）；#14（idx 52，Medium）影响明确写「老部署按 .env.example:40/DEPLOYMENT.md:118 注入 VITE_DOWNLOAD_TOKEN 进 bundle」后「无需登录即可 GET /settings、读取全部已下载媒体与歌单/任务数据、并写任何接口」。报告 22 行自己写「两个单元独立发现并互相印证」，等于承认 #1 与 #5 是同一发现；三条的修复建议也重叠（删 VITE_DOWNLOAD_TOKEN/compose 回落、收窄 token 作用域）。

**影响**：头条计数（Critical 1 / High 7 / Medium 41 / 合计 96）把同一缺陷计入三个级别：既虚增条目数，又让「登录体系被绕过」的真实级别无法判读——按 #1 是 Critical、按 #5 是 High、按 #14 是 Medium。

**建议**：合并为一条（或至少交叉引用并写明拆分口径），用同一判据定级：若认可 #5 验证者理由（默认局域网/空 users 本已全放行，危害需「启用登录 + 设 DOWNLOAD_TOKEN」组合），三条统一为 High 并把 Critical 计数改为 0；若坚持 Critical，则 #5、#14 必须同样升为 Critical。

### N2. #6「authGate 本体零调用」评 High，与同类「模块从未被测试加载」条目 #39/#40/#41/#42 的 Medium 不一致，且与「结论速览」自述冲突

- 级别：medium｜置信度：high｜来源：audit-severity
- 位置：`CODE_REVIEW.md:47-53, 196-219`

**证据**：47 行小节标题写「关键测试盲区（复核后均为 Medium，但值得单独强调）」，紧随的 50 行条目正是「auth-gate 中间件本体零调用」；但正文 #6（198 行）级别写 🟠 High。#39/#40/#41/#42 是同类的「测试闭包从未加载该文件」缺口，全部为 Medium（且都经复核下调）。#6 的验证块（215-217 行）自己也承认「其调用的纯函数均已被测」（isApiPath、csrfOriginOk、sessionFromCookieHeader、token-eq），剩余无覆盖的只是中间件编排接线。

**影响**：同为「安全关键模块无执行覆盖」的测试缺口，authGate 被单列 High，使 High 段的 7 条里有 1 条实际是测试缺口而非已存在缺陷；不同段落的定级口径不可比。

**建议**：把 #6 与 #39-#42 归为同级（Medium），或在方法学中写明「安全关键中间件编排层缺口 = High」的判据并回填其它条目；同时修正 47 行「均为 Medium」的表述。

### N3. #13（默认配置下任意可达者自封 admin，Medium）与 #1/#5/#14（需额外配置的鉴权旁路，Critical/High）级别倒挂

- 级别：medium｜置信度：medium｜来源：audit-severity
- 位置：`CODE_REVIEW.md:337-352（对比 57-80、171-194、353-367）`

**证据**：#13 触发面是默认部署：HOST 默认 0.0.0.0（netease-api-server.js:30）+ 空 users 表；/auth/setup 仅需 csrfOriginOk + 5/min 限流，users>0 后恒 409（auth.js:62-73、78-80），建号即登录并成为唯一 admin，合法所有者此后无法再 setup（全仓无 password reset 路由/脚本，grep 确认）。#1/#5/#14 都需要「启用登录 + 设 DOWNLOAD_TOKEN（并用 compose 构建）」这一额外组合，且 #1 自述在默认模型下无害（反证段）。

**影响**：同属「未授权取得全站控制」，报告给默认配置即可达者 Medium、给需额外配置的旁路 Critical/High，读者会低估前者；也影响「公网部署先 127.0.0.1 完成 setup」这条唯一缓解是否应作为 High 级待办排出。

**建议**：统一判据：若按 rubric「未授权访问=critical 类」定级，#13 至少 High（与 #1/#5/#14 同档）；若因默认空 users 本就全开放而压低，则 #1/#5/#14 也不应高于 Medium。

### N4. #11（Medium）与 #10（Low）同属「返回成功/已提交但无消费者」，级别不同；且 #11 的「无重试入口」与前端实现相反

- 级别：low｜置信度：medium｜来源：audit-severity
- 位置：`CODE_REVIEW.md:289-319`

**证据**：#11：quick 路由在 startQueue 抛任意 409 时仍回 200（downloads.js:407-418），队列停在 pending；#10：终态写失败使任务行停在 downloading、队列被判 completed（download-manager.js:822-833、598-608）。两者都产出「无任何消费者」的 pending 行。但 #11 影响里的「无重试入口」不成立：队列仍是 pending，前端 DownloadQueueList.vue:110 对 ['pending','cancelled'] 渲染「启动」按钮，停机窗口后仍可直接恢复；真正不可恢复的是 #10 那种行（队列 completed + 行 pending，recoverStaleStates:2250-2264 只把行翻成 pending，队列仍终态，startQueue:361-363 与 retryQueue:2014-2018 双拒）。

**影响**：#11 的核心（成功提示与实际不符）成立，但「无重试入口/永久搁浅」被用来支撑其与 #10 的级别差，而实际永久性在 #10 一侧，两条的严重度取向被写反（#10 另错称重启可恢复，见 reportErrors E5）。

**建议**：删掉 #11 的「无重试入口」表述；若保留级别差，改用「用户被误导为已开始」这一维度说明，并把 #10 的永久性写实后重评为 Medium。

### N5. #70（Medium）与 #81（Low）是同一类「不做长度/范围对账 → 截断工件被登记为 completed」，级别不一

- 级别：low｜置信度：medium｜来源：audit-severity
- 位置：`CODE_REVIEW.md:321-335（#70，download-io）与 Low 段 uploads 条目（#81）`

**证据**：#70：download-io.js:277,321-326 只对 content-length 对账、不解析 Content-Range，206 局部窗会被当完整工件 rename 就位；#81：uploads.js:80-84 只用声明的 content-length 做 413/507 预检，落盘后 171-181 直接 renameSync，从不把 total 与 declared 对账（同一仓库 download-io.js:318-326 有这道对账，uploads 没有）。两者产物都是「静默截断却标记 completed」。

**影响**：同类数据一致性缺陷（截断工件入库）分列 Medium/Low，口径不一致，读者无法判断哪一类应优先修。

**建议**：统一口径：若按「静默产出损坏工件」计，uploads 的对账缺失应同为 Medium；或两者都列 Low 并说明 206 场景在真实上游更常见。

### N6. /tmp/findings.json 的 severity 字段对 16 条已复核项仍是复核前级别，与报告表格口径不一致

- 级别：low｜置信度：high｜来源：audit-facts
- 位置：`/tmp/findings.json:索引 0,19,23,28,29,30,36,37,38,39,40,50,69,89,90,91 的 verification.correctedSeverity`

**证据**：原始 severity 分布 = critical 1 / high 15 / medium 33 / low 47；把 16 条 verification.correctedSeverity 覆盖后 = 1/7/41/47，恰等于 CODE_REVIEW.md:10-14 速览表。例：索引 39（前端 UI 层零覆盖）severity="high" 而 verification.correctedSeverity="medium"；索引 19、23、36、38、40、89、90 同样 high→medium。

**影响**：任何直接读取 severity 字段的下游（含本轮按索引取元素的核对脚本）会得到与报告不一致的分级计数，容易误判这 8 条结论未被下调或认为报告计数造假。

**建议**：把 severity 归一为复核后级别，或将复核前级别改名为 originalSeverity 并在数据说明中写明 correctedSeverity 优先级。

### N7. 报告 High #7 的 dist 佐证依赖被 gitignore 的未跟踪产物，无法从基线 commit 复现

- 级别：low｜置信度：high｜来源：audit-facts
- 位置：`CODE_REVIEW.md:24, 231（对应 /tmp/findings.json 索引 30）`

**证据**：.gitignore 含 dist/ 与 .env，`git ls-files dist .env` 为 0；基线 77b223f 工作区干净，dist/ 与 .env 都不进仓。我实测当前本机 dist/assets/index-ebf02ad4.js 确有 MODE:"production",DEV:!0,PROD:!1 与 VITE_USER_NODE_ENV:"development"（证实坑存在），但它只是本机残留产物；报告已正确把主锚点放在受版本控制的 .env.example:88（我核对该行确为 NODE_ENV=development）。

**影响**：换机器/新 clone 的复核者无法用仓库内容复现该条佐证；不影响该 High 的主证据链（.env.example:88 + Vite 4.5.14 行为 + 隔离构建），故不改级别。

**建议**：佐证改为可复现步骤（cp .env.example .env && npm run build:prod 后检查产物 PROD/警告串）或给出产物哈希，避免引用 .gitignore 的机器本地文件。

### N8. VITE_BASE_PATH 在 Hono 单进程托管下不生效：子目录构建的 /<base>/assets/* 一律 404，只有前缀剥离型反代能用

- 级别：medium｜置信度：high｜来源：audit-fixes
- 位置：`netease-api-server.js:99-123, 183-186`

**证据**：serveStatic 的 root 固定为 distDir、无 base 前缀处理（netease-api-server.js:99-100），路由与 SPA 兜底也都按根路径挂载（:178-192）；而兜底对带扩展名的路径显式返回 JSON 404：`if (isApiPath(p) || p.toLowerCase().startsWith('/assets/') || /\.[a-z0-9]+$/i.test(p)) return c.json({ code: 404 ... })`（:183-186）。vite.config.js:15 `base: env.VITE_BASE_PATH || '/'`，Dockerfile:17-21 与 docker-compose.yml:10 都把它当构建变量传入，.env.example:27-28 写明「用于子目录部署」。以 VITE_BASE_PATH=/music/ 构建后，index.html 的 script src 是 /music/assets/index-xxx.js：请求先经 serveStatic 查 dist/music/assets/... 落空，再进 SPA 兜底被 .js 扩展名判定为 404；我在本仓 dist 上确认当前产物是 src="/assets/index-ebf02ad4.js"（默认 base），服务器代码里 grep 不到任何 BASE/BASE_PATH 处理。

**影响**：按 .env.example/compose 配置 VITE_BASE_PATH 后，Docker 单进程（同端口托管 API+静态）部署的页面壳能返回，但全部 JS/CSS/字体 404，应用白屏/无法启动——文档声称支持的子目录部署在本项目主推的部署模型下完全不可用；只有外部 nginx 用 `proxy_pass http://app/`（带尾斜杠剥前缀）才偶然可用，而那种拓扑正是 finding idx 1 里分享链指向根路径失效的场景，两个问题互相叠加。

**建议**：二选一并同步文档：(a) 让服务器感知 base——按 VITE_BASE_PATH 挂载静态与 SPA 兜底（或在进入路由前剥离前缀），并加一条 base!='/' 的集成断言（请求 /music/assets/x.js 返回 JS 而非 404）；(b) 若不打算实现，就从 Dockerfile/compose/.env.example 移除 VITE_BASE_PATH 并明确写「必须在根路径部署或由外部反代剥前缀」。

## 七、复核本身的局限

1. **遗漏面审计未完成**：负责「找出报告盲区」的审计代理只返回了占位内容（`title: "probe"`），因此**「报告不存在大块盲区」这一结论并未被建立**。其余 3 个审计代理各自也顺带发现了 1-5 条报告未覆盖的问题，但覆盖面小于预期。
2. **无第三轮**：critical/high 只经过两轮（第二轮为复查，非独立第三方）。
3. **测试类结论的判定依赖静态闭包分析**，对「Node 原生模块 / 动态 require」的覆盖可能仍有遗漏。
4. **报告的结构性问题（同因重复计数、同类定级不一致、级别倒挂）在本文档被记录，但正文只加注未重排**；若要彻底解决，需按「同因合并、同判据定级」重写结论速览与分级。
