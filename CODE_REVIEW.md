# MeowSync 全量代码深度审查报告

> **本文档已并入第二轮独立复核结果（2026-10-04）。** 第二轮用 21 个子代理复核了本文档的全部 96 条结论：
> **69 条确认 / 36 条部分确认 / 3 条不确定 / 2 条被推翻**，15 条严重度调整，12 条修复建议被压力测试（4 通过 / 7 需补强 / 1 推翻），并新增 8 条发现与 20 条正文勘误。
> 完整第二轮记录见 [CODE_REVIEW_AUDIT.md](CODE_REVIEW_AUDIT.md)；下文每条带 ⚠️ 的段落即该轮修正后的表述。

- 审查日期：2026-10-04
- 代码基线：`77b223f`（工作区干净）
- 方法：第一轮 14 个领域子代理逐文件精读；第二轮 21 个子代理（4 批复查 critical/high + 1 个修复压力测试 + 12 批复核从未验证的 medium/low + 4 个报告审计）
- 基线状态：`npm test` **318/318 通过**（第二轮实测复核）、`npx tsc --noEmit` 无错误，但 `tsc --listFiles` 显示该检查**实际只覆盖 `src/shared/types.ts` 一个文件**（checkJs:false + include 仅 ts），对 101 个 .js 与 22 个 .vue 无约束

## 一、结论速览（第二轮复核后）

| 级别 | 复核前 | 复核后 | 含义 |
|---|---|---|---|
| 🔴 Critical | 1 | 1 | 未授权访问 / 鉴权体系失效 |
| 🟠 High | 7 | 7 | 明确功能错误、资源耗尽、构建失败 |
| 🟡 Medium | 41 | 27 | 边界错误、错误处理缺失、测试盲区 |
| 🔵 Low | 47 | 59 | 健壮性 / 可维护性问题 |
| **合计** | 96 | **94** | 另有 2 条被第二轮**推翻**（见审计文档） |
| ➕ 新增发现 | — | 8 | 第二轮审计代理新找出 |

最需要立刻处理的三件事（第二轮复核后仍然成立）：

1. **前端 bundle 内置 `DOWNLOAD_TOKEN`，登录体系可被匿名访客绕过**（Critical；第二轮实测 `docker compose config` 确认回落生效、并用桩化 Hono 端到端复现了 401→200 的旁路）。
2. **`docker compose build` 当前必然失败**——Dockerfile 前端阶段漏拷 `scripts/`（第二轮在隔离目录复现 EXIT=1）。
3. **`.env.example` 的 `NODE_ENV=development` 让生产构建退化为开发构建**（第二轮确认 Vite 链路；⚠️ 原文「现有 dist 是随包产物」措辞有误——`dist/` 被 gitignore，是**本机残留产物**，新 clone 无法复现该佐证，但主证据链 `.env.example:88` 受版本控制）。

**第二轮指出的三处结构性问题（已影响可判读性，建议按此回修）：**

- **同一根因被拆成三条并重复计数**：Critical #1 / High #5 / Medium #14 指向同一条链（bundle 内嵌令牌 → `x-download-token` 全量旁路），导致「Critical 1」这一头条数字失去可判读性。建议合并为一条，或在文中显式写明拆分口径与统一判据。
- **同类问题定级不一致**：authGate 测试缺口评 High，而同类的「模块从未被测试加载」条目全部为 Medium，且「结论速览」自称这些盲区「复核后均为 Medium」，前后矛盾。
- **级别倒挂**：默认部署下「任何网络可达者都能抢先自封 admin」被评为 Medium，而需要额外配置的旁路（#1/#5/#14）却是 Critical/High。若按「未授权访问 = critical 类」的判据，前者至少应同为 High。

## 二、审查范围与覆盖率

14 个审查单元均自报 `coverageComplete = true`。第二轮对该自报做了独立核验：14 个单元的 `filesRead` 并集覆盖 `src/` 下 **126/132** 个文件，未覆盖的 6 个全部是 `src/fonts/` 下的字体与许可资产，**代码层面确无漏审**。

| 单元 | 自报已读文件数 | findings | 覆盖率 |
|---|---|---|---|
| A. 下载管理器核心 | 18 | 4 | 自报完整 |
| B. 下载 IO/文件系统/路由 | 18 | 5 | 自报完整 |
| C. 服务端核心与安全边界 | 35 | 7 | 自报完整 |
| D. 音乐 provider 与解析 | 40 | 7 | 自报完整 |
| E. 解锁/歌词/AI/上传 | 30 | 9 | 自报完整 |
| F. 数据层与歌单路由 | 11 | 5 | 自报完整 |
| G. WebSocket 遥控 | 18 | 7 | 自报完整 |
| H. 播放器核心 | 17 | 6 | 自报完整 |
| I. Watch 页与 TextAlive 歌词 | 13 | 4 | 自报完整 |
| J. 列表与库/导入 | 29 | 8 | 自报完整 |
| K. 下载 UI | 23 | 5 | 自报完整 |
| L. 前端基础设施与通用 UI | 50 | 7 | 自报完整 |
| M. 测试与覆盖率 | 36 | 14 | 自报完整 |
| N. 契约/构建/部署/文档 | 41 | 8 | 自报完整 |

> ⚠️ 勘误：「自报已读文件数」列按各单元自报条目计，未去重（J 单元 `PlaylistGrid.vue` 重复出现，去重后 28）。原文「文件清单见下表」不存在，已删。

### 关键测试盲区

- `src/server/routes/*` 有 **6/12 个文件从未被任何测试加载**：`ai.js`、`qq.js`、`playlists.js`、`proxy.js`、`songmeta.js`、`auth.js`（第二轮用 CJS `Module._load` 钩子实跑 + 静态闭包双重确认）。
- `src/server/lib/auth-gate.js` 的**中间件本体**零调用（401 路径、token 旁路、公开前缀、`no-store`、CSRF 接线）——测试只覆盖其辅助导出。⚠️ 第二轮指出：本条与其它「模块零加载」类缺口应同级（Medium），评 High 属口径不一致。
- `src/server/ws/remote.js`（403 行）零加载。⚠️ 勘误：原文「protocol.test.mjs 只钉常量」不实——`tests/protocol.test.mjs:11-21` 对 `CONTROL_PAYLOAD_GUARDS` 做了真实行为断言；无网的是 remote.js 对这些守卫的接线及 Origin/容量/鉴权级联。
- 前端结构性零覆盖：`usePlayer.js`（1492 行）+ 21 个 `.vue` + **8 个** composable 从未被加载（10 个中 2 个已被纯逻辑测试覆盖）。⚠️ 勘误：原文正文写「9 个」。
- `src/api/*` 七个客户端（988 行）零覆盖——前后端字段/错误码契约无对拍。

## 三、第二轮新增发现

### N1. 同一根因（bundle 内嵌 DOWNLOAD_TOKEN → x-download-token 全量旁路）被拆成 Critical/High/Medium 三条并重复计数

- **级别**：high（复核置信度 high）｜**来源**：audit-severity
- **位置**：`CODE_REVIEW.md:57-80, 171-194, 353-367（另见 22 行速览）`

**证据**：三条指向同一条链：#1（idx 28，Critical）证据=compose:14 回落 + http.js:9,28-30 + auth-gate.js:59-61 + /assets 免登录；#5（idx 0，High）证据逐字包含同一组行号（含 docker-compose.yml:14 与 auth-gate.js:59-61）；#14（idx 52，Medium）影响明确写「老部署按 .env.example:40/DEPLOYMENT.md:118 注入 VITE_DOWNLOAD_TOKEN 进 bundle」后「无需登录即可 GET /settings、读取全部已下载媒体与歌单/任务数据、并写任何接口」。报告 22 行自己写「两个单元独立发现并互相印证」，等于承认 #1 与 #5 是同一发现；三条的修复建议也重叠（删 VITE_DOWNLOAD_TOKEN/compose 回落、收窄 token 作用域）。

**影响**：头条计数（Critical 1 / High 7 / Medium 41 / 合计 96）把同一缺陷计入三个级别：既虚增条目数，又让「登录体系被绕过」的真实级别无法判读——按 #1 是 Critical、按 #5 是 High、按 #14 是 Medium。

**建议**：合并为一条（或至少交叉引用并写明拆分口径），用同一判据定级：若认可 #5 验证者理由（默认局域网/空 users 本已全放行，危害需「启用登录 + 设 DOWNLOAD_TOKEN」组合），三条统一为 High 并把 Critical 计数改为 0；若坚持 Critical，则 #5、#14 必须同样升为 Critical。

### N2. #6「authGate 本体零调用」评 High，与同类「模块从未被测试加载」条目 #39/#40/#41/#42 的 Medium 不一致，且与「结论速览」自述冲突

- **级别**：medium（复核置信度 high）｜**来源**：audit-severity
- **位置**：`CODE_REVIEW.md:47-53, 196-219`

**证据**：47 行小节标题写「关键测试盲区（复核后均为 Medium，但值得单独强调）」，紧随的 50 行条目正是「auth-gate 中间件本体零调用」；但正文 #6（198 行）级别写 🟠 High。#39/#40/#41/#42 是同类的「测试闭包从未加载该文件」缺口，全部为 Medium（且都经复核下调）。#6 的验证块（215-217 行）自己也承认「其调用的纯函数均已被测」（isApiPath、csrfOriginOk、sessionFromCookieHeader、token-eq），剩余无覆盖的只是中间件编排接线。

**影响**：同为「安全关键模块无执行覆盖」的测试缺口，authGate 被单列 High，使 High 段的 7 条里有 1 条实际是测试缺口而非已存在缺陷；不同段落的定级口径不可比。

**建议**：把 #6 与 #39-#42 归为同级（Medium），或在方法学中写明「安全关键中间件编排层缺口 = High」的判据并回填其它条目；同时修正 47 行「均为 Medium」的表述。

### N3. #13（默认配置下任意可达者自封 admin，Medium）与 #1/#5/#14（需额外配置的鉴权旁路，Critical/High）级别倒挂

- **级别**：medium（复核置信度 medium）｜**来源**：audit-severity
- **位置**：`CODE_REVIEW.md:337-352（对比 57-80、171-194、353-367）`

**证据**：#13 触发面是默认部署：HOST 默认 0.0.0.0（netease-api-server.js:30）+ 空 users 表；/auth/setup 仅需 csrfOriginOk + 5/min 限流，users>0 后恒 409（auth.js:62-73、78-80），建号即登录并成为唯一 admin，合法所有者此后无法再 setup（全仓无 password reset 路由/脚本，grep 确认）。#1/#5/#14 都需要「启用登录 + 设 DOWNLOAD_TOKEN（并用 compose 构建）」这一额外组合，且 #1 自述在默认模型下无害（反证段）。

**影响**：同属「未授权取得全站控制」，报告给默认配置即可达者 Medium、给需额外配置的旁路 Critical/High，读者会低估前者；也影响「公网部署先 127.0.0.1 完成 setup」这条唯一缓解是否应作为 High 级待办排出。

**建议**：统一判据：若按 rubric「未授权访问=critical 类」定级，#13 至少 High（与 #1/#5/#14 同档）；若因默认空 users 本就全开放而压低，则 #1/#5/#14 也不应高于 Medium。

### N4. #11（Medium）与 #10（Low）同属「返回成功/已提交但无消费者」，级别不同；且 #11 的「无重试入口」与前端实现相反

- **级别**：low（复核置信度 medium）｜**来源**：audit-severity
- **位置**：`CODE_REVIEW.md:289-319`

**证据**：#11：quick 路由在 startQueue 抛任意 409 时仍回 200（downloads.js:407-418），队列停在 pending；#10：终态写失败使任务行停在 downloading、队列被判 completed（download-manager.js:822-833、598-608）。两者都产出「无任何消费者」的 pending 行。但 #11 影响里的「无重试入口」不成立：队列仍是 pending，前端 DownloadQueueList.vue:110 对 ['pending','cancelled'] 渲染「启动」按钮，停机窗口后仍可直接恢复；真正不可恢复的是 #10 那种行（队列 completed + 行 pending，recoverStaleStates:2250-2264 只把行翻成 pending，队列仍终态，startQueue:361-363 与 retryQueue:2014-2018 双拒）。

**影响**：#11 的核心（成功提示与实际不符）成立，但「无重试入口/永久搁浅」被用来支撑其与 #10 的级别差，而实际永久性在 #10 一侧，两条的严重度取向被写反（#10 另错称重启可恢复，见 reportErrors E5）。

**建议**：删掉 #11 的「无重试入口」表述；若保留级别差，改用「用户被误导为已开始」这一维度说明，并把 #10 的永久性写实后重评为 Medium。

### N5. #70（Medium）与 #81（Low）是同一类「不做长度/范围对账 → 截断工件被登记为 completed」，级别不一

- **级别**：low（复核置信度 medium）｜**来源**：audit-severity
- **位置**：`CODE_REVIEW.md:321-335（#70，download-io）与 Low 段 uploads 条目（#81）`

**证据**：#70：download-io.js:277,321-326 只对 content-length 对账、不解析 Content-Range，206 局部窗会被当完整工件 rename 就位；#81：uploads.js:80-84 只用声明的 content-length 做 413/507 预检，落盘后 171-181 直接 renameSync，从不把 total 与 declared 对账（同一仓库 download-io.js:318-326 有这道对账，uploads 没有）。两者产物都是「静默截断却标记 completed」。

**影响**：同类数据一致性缺陷（截断工件入库）分列 Medium/Low，口径不一致，读者无法判断哪一类应优先修。

**建议**：统一口径：若按「静默产出损坏工件」计，uploads 的对账缺失应同为 Medium；或两者都列 Low 并说明 206 场景在真实上游更常见。

### N6. /tmp/findings.json 的 severity 字段对 16 条已复核项仍是复核前级别，与报告表格口径不一致

- **级别**：low（复核置信度 high）｜**来源**：audit-facts
- **位置**：`/tmp/findings.json:索引 0,19,23,28,29,30,36,37,38,39,40,50,69,89,90,91 的 verification.correctedSeverity`

**证据**：原始 severity 分布 = critical 1 / high 15 / medium 33 / low 47；把 16 条 verification.correctedSeverity 覆盖后 = 1/7/41/47，恰等于 CODE_REVIEW.md:10-14 速览表。例：索引 39（前端 UI 层零覆盖）severity="high" 而 verification.correctedSeverity="medium"；索引 19、23、36、38、40、89、90 同样 high→medium。

**影响**：任何直接读取 severity 字段的下游（含本轮按索引取元素的核对脚本）会得到与报告不一致的分级计数，容易误判这 8 条结论未被下调或认为报告计数造假。

**建议**：把 severity 归一为复核后级别，或将复核前级别改名为 originalSeverity 并在数据说明中写明 correctedSeverity 优先级。

### N7. 报告 High #7 的 dist 佐证依赖被 gitignore 的未跟踪产物，无法从基线 commit 复现

- **级别**：low（复核置信度 high）｜**来源**：audit-facts
- **位置**：`CODE_REVIEW.md:24, 231（对应 /tmp/findings.json 索引 30）`

**证据**：.gitignore 含 dist/ 与 .env，`git ls-files dist .env` 为 0；基线 77b223f 工作区干净，dist/ 与 .env 都不进仓。我实测当前本机 dist/assets/index-ebf02ad4.js 确有 MODE:"production",DEV:!0,PROD:!1 与 VITE_USER_NODE_ENV:"development"（证实坑存在），但它只是本机残留产物；报告已正确把主锚点放在受版本控制的 .env.example:88（我核对该行确为 NODE_ENV=development）。

**影响**：换机器/新 clone 的复核者无法用仓库内容复现该条佐证；不影响该 High 的主证据链（.env.example:88 + Vite 4.5.14 行为 + 隔离构建），故不改级别。

**建议**：佐证改为可复现步骤（cp .env.example .env && npm run build:prod 后检查产物 PROD/警告串）或给出产物哈希，避免引用 .gitignore 的机器本地文件。

### N8. VITE_BASE_PATH 在 Hono 单进程托管下不生效：子目录构建的 /<base>/assets/* 一律 404，只有前缀剥离型反代能用

- **级别**：medium（复核置信度 high）｜**来源**：audit-fixes
- **位置**：`netease-api-server.js:99-123, 183-186`

**证据**：serveStatic 的 root 固定为 distDir、无 base 前缀处理（netease-api-server.js:99-100），路由与 SPA 兜底也都按根路径挂载（:178-192）；而兜底对带扩展名的路径显式返回 JSON 404：`if (isApiPath(p) || p.toLowerCase().startsWith('/assets/') || /\.[a-z0-9]+$/i.test(p)) return c.json({ code: 404 ... })`（:183-186）。vite.config.js:15 `base: env.VITE_BASE_PATH || '/'`，Dockerfile:17-21 与 docker-compose.yml:10 都把它当构建变量传入，.env.example:27-28 写明「用于子目录部署」。以 VITE_BASE_PATH=/music/ 构建后，index.html 的 script src 是 /music/assets/index-xxx.js：请求先经 serveStatic 查 dist/music/assets/... 落空，再进 SPA 兜底被 .js 扩展名判定为 404；我在本仓 dist 上确认当前产物是 src="/assets/index-ebf02ad4.js"（默认 base），服务器代码里 grep 不到任何 BASE/BASE_PATH 处理。

**影响**：按 .env.example/compose 配置 VITE_BASE_PATH 后，Docker 单进程（同端口托管 API+静态）部署的页面壳能返回，但全部 JS/CSS/字体 404，应用白屏/无法启动——文档声称支持的子目录部署在本项目主推的部署模型下完全不可用；只有外部 nginx 用 `proxy_pass http://app/`（带尾斜杠剥前缀）才偶然可用，而那种拓扑正是 finding idx 1 里分享链指向根路径失效的场景，两个问题互相叠加。

**建议**：二选一并同步文档：(a) 让服务器感知 base——按 VITE_BASE_PATH 挂载静态与 SPA 兜底（或在进入路由前剥离前缀），并加一条 base!='/' 的集成断言（请求 /music/assets/x.js 返回 JS 而非 404）；(b) 若不打算实现，就从 Dockerfile/compose/.env.example 移除 VITE_BASE_PATH 并明确写「必须在根路径部署或由外部反代剥前缀」。

---

## 四、Critical（立即修复）

### 1. compose 把 DOWNLOAD_TOKEN 烧进前端产物：登录体系可被匿名访客用 bundle 里的令牌旁路

- **级别**：🔴 Critical
- **⚠️ 口径注记（第二轮 N1）**：本条与 High #5、Medium #14 为**同一根因**（bundle 内嵌令牌 → `x-download-token` 全量旁路），拆列三条仅因三个审查单元独立发现；定级按「默认局域网/空 users 本就全放行，危害需『启用登录+设 DOWNLOAD_TOKEN+compose 构建』组合」计，严格口径下三条应为同一 High 级条目。修复验收以本条为准，#5/#14 随附验证。
- **位置**：`docker-compose.yml:11-14`
- **类别**：安全（认证/授权）｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
compose:14 `VITE_DOWNLOAD_TOKEN: ${VITE_DOWNLOAD_TOKEN:-${DOWNLOAD_TOKEN:-}}` 在未显式设 VITE_DOWNLOAD_TOKEN 时自动把服务端 DOWNLOAD_TOKEN 当构建 arg 注入；src/api/http.js:9,28-30 把它编译成字面量并在每个请求头带 `x-download-token`；src/server/lib/auth-gate.js:59-61 `if (tokenMatches(c.req.header('x-download-token'), process.env.DOWNLOAD_TOKEN)) { return next(); }` —— 登录启用后该头仍是全量旁路凭据（GET/POST/PUT/DELETE 一律放行），且 netease-api-server.js:135-150 的 protectedWrite 也接受它。auth-gate.js:56-57 自己的注释写着『bundle 内嵌等于向全体访客发口令』，而 .env.example:38-39 与 DEPLOYMENT.md:31 恰好教用户这么做。
```

**影响**：按文档部署（DEPLOYMENT.md:125-128 建议公网 + BILI_COOKIE/QQ_COOKIE 时设 DOWNLOAD_TOKEN，:135-140 推荐 compose）并启用登录后，任何匿名访客都能公开 GET /assets/index-*.js（api-path.js 不把 /assets 当 API，auth-gate.js:26 放行），从 bundle 抠出令牌，再带 `x-download-token` 调用 /downloads、/playlists、/song-meta、/ai、/settings、/uploads 的全部读写接口，完全绕过 /auth 登录——首启建号建立的认证体系被作废。

**建议**：删除 `${DOWNLOAD_TOKEN}` 回落（只保留显式 opt-in 的 VITE_DOWNLOAD_TOKEN），并同步修正 .env.example:38-39、DEPLOYMENT.md:31/117-121 的引导：DOWNLOAD_TOKEN 是服务端/脚本旁路凭据，绝不进 bundle。

> 🧪 **修复压力测试**：方向正确但需补强 —— 方向正确，按建议实施并把配套做全：(1) docker-compose.yml:14 改为 `VITE_DOWNLOAD_TOKEN: ${VITE_DOWNLOAD_TOKEN:-}`；(2) 同步改 .env.example:38-40、DEPLOYMENT.md:31、117-121、307-308、README 前端变量表，统一口径为『DOWNLOAD_TOKEN 只做服务端/脚本旁路，启用登录的部署绝不注入 VITE_DOWNLOAD_TOKEN』；(3) 显式写明无登录 LAN 部署的两条合法出路——要么完成 /auth/setup（推荐），要么显式设 VITE_DOWNLOAD_TOKEN 并接受它对页面访客可见；(4) 若要纵深，可在 auth-gate.js:59 把 token 旁路收窄到 `!authEnabled()`，但这会改变『脚本可旁路登录』的既有契约，需同步改 DEPLOYMENT:244-250，不建议与本次修复捆绑。

## 五、High

### 2. HEAD 请求 /downloads/songs/:songId/file 每次泄漏一个文件描述符（可达 EMFILE 全服务不可用）

- **级别**：🟠 High
- **位置**：`src/server/routes/downloads.js:269, 360, 365`
- **类别**：资源泄漏/HTTP｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
路由先开裸 fd 再把 fd 交给 stream：`fd = fs.openSync(filePath, 'r');`（269）→ `stream = fs.createReadStream(filePath, { fd, start, end, autoClose: true });`（360）→ `return c.body(stream, status, headers);`（365），依赖 autoClose 在流被消费/销毁时才关 fd。但 HEAD 不消费 body：Hono 对 HEAD 的特殊分支是 `if (method === "HEAD") return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();`（node_modules/hono/dist/hono-base.js:280-282）——GET 处理器照常执行（fd 已开、stream 已建），随后 new Response(null, res) 丢弃 body，既不读也不 cancel 原 body ⇒ 流永不 close ⇒ autoClose 不触发、fd 永久打开。用本仓库版本做了最小复现：HEAD /f 后 `fs.fstatSync(fd)` 仍成功（fd 未关），同一路由的 GET 后 fstatSync 抛 EBADF（已关）。服务端装配正是同一条路径：netease-api-server.js:242-246 `serve({ fetch: app.fetch, ... })`。影响：可反复 HEAD 累加 fd 到 EMFILE，之后 DB/静态文件/下载流全部打不开；被泄漏的 fd 还钉住 inode，删除文件也不释放磁盘空间。默认局域网部署（users 表空、未配 DOWNLOAD_TOKEN）下任意可达主机或恶意页面即可触发（authGate lib/auth-gate.js:43 未启用登录全放行；DOWNLOAD_TOKEN 中间件只覆盖非 GET：netease-api-server.js:141）。
```

**影响**：未授权/低权限客户端用 HEAD 请求即可耗尽进程 fd（Linux 默认 1024、macOS 更低），造成整个服务不可用；同时被删文件的空间无法回收直到重启。

**建议**：在路由内显式处理 HEAD：完成 stat/etag/Range 判定后 `closeFd(); return c.body(null, status, headers);`；或在 stream 建立后按 `c.req.method === 'HEAD'` 主动 `stream.destroy()`；更彻底的做法是不预先 openSync 而是把路径+Range 交给 createReadStream，并保证未被消费的响应体会被销毁。

> ⚠️ **第二轮复核修正**：第二轮修正影响措辞：EMFILE 只让「需要新开 fd」的路径失败（静态资源、媒体读写、上传、下载落盘 → Web UI 实际打不开），而 SQLite 连接在启动时已持有 fd，/healthz、/playlists、/settings、/ai、/song-meta 等纯 JSON 端点仍可响应。**「整个服务不可用」应改为「静态与媒体/上传/下载链路不可用」。**

> 🧪 **修复压力测试**：建议可直接落地 —— 在 downloads.js:353-358 的空文件分支之后、:360 createReadStream 之前插入：`if (c.req.method === 'HEAD') { closeFd(); return c.body(null, status, headers); }`。等价可选写法是先建 stream 再 `if (HEAD) stream.destroy()`，但显式 closeFd 更直观。必须保留 fd 预开以维持 inode 锁语义。

### 3. 静态中间件对所有 GET/HEAD 全局删除 Range 头——已实现的 206/If-Range 与音频 seek 全成死代码

- **级别**：🟠 High
- **位置**：`netease-api-server.js:115-123`
- **类别**：正确性/功能回归｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
app.use('/*', (c, next) => { if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next(); c.req.raw.headers.delete('range'); return staticMiddleware(c, next); }); —— 删除发生在**所有** GET/HEAD（不止静态文件），而 c.req.raw.headers 正是下游 c.req.header('range') 读的同一对象。用本仓库的 @hono/node-server 2.1.1 + serveStatic 起真实服务实测：GET /downloads/songs/1/file 带 Range: bytes=0-99 → 路由内 c.req.header('range') === null。注释 116-118 写「前端本就不对静态资源发 Range」，但实际连 API 请求一起剥了；proxy.js:27-41、86-91 与 downloads.js:311-336（含 If-Range/206/ETag 混血段防护）都依赖该头。
```

**影响**：本地已下载媒体（songFileUrl → Howler html5 <audio>）与 /audio-proxy（googlevideo/QQ/B站流）的 seek 永远拿不到 206：每次拖动进度条要么被 200 全量从头重下、要么停在未缓冲处，长音频/长视频带宽与体验显著劣化；同时 downloads.js 里为防「换源后 206 拼新旧文件混血」而写的 Range/If-Range 分支成为不可达死代码，注释声称的保护实际不存在。

**建议**：只对非 API 路径剥 Range（先 isApiPath(c.req.path) 判定），或给静态中间件单独克隆一个去掉 Range 的 Request（c.req.raw.clone() 后改头），让 /downloads/... 与 /audio-proxy 保留 Range/If-Range 语义。

> ⚠️ **第二轮复核修正**：第二轮补充边界条件：剥 Range 的中间件整体位于 netease-api-server.js:98 的 `if (hasDist)` 内，**纯源码 clone / `npm run dev`（无构建产物）时不受影响**；「永远拿不到 206」应限定为 hasDist=true（Docker/已构建部署，即生产默认）。

> 🧪 **修复压力测试**：建议可直接落地 —— 取第一个方案：`app.use('/*', (c,next)=>{ if (c.req.method!=='GET'&&c.req.method!=='HEAD') return next(); if (!isApiPath(c.req.path)) c.req.raw.headers.delete('range'); return staticMiddleware(c,next) })`。API 路径永远不会命中 dist 实体文件（serveStatic 直接 next()），故保留 Range 不会把压缩档切段的坑带回来；顺手把 116-118 注释改成『仅静态档剥』。不要采用 clone 备选。

### 4. send() 无背压控制：不读取的 controller 使服务端无界缓存广播数据

- **级别**：🟠 High
- **位置**：`src/server/ws/remote.js:20-34 (335, 259)`
- **类别**：资源泄漏/性能｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
`function send(ws, msg) { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(msg)); } catch {} } }`——只判 readyState，从不看 ws.bufferedAmount；broadcastToControllers（30-34）对每个 controller 各做一次 JSON 序列化后盲发。上游速率：host 桶 200 msg/s（14、335），单帧上限 64KB（10，REMOTE_LIMITS.MAX_PAYLOAD_BYTES），controller 上限 32（11）。实测（/tmp 探针，host 推 2000 帧共 84MB 后让一个 controller 暂停读 socket 20s）：进程 rss 从 49MB 涨到 250MB、external 124MB 并保持不降（host.bufferedAmount 已回 0，说明滞留的是服务端发往暂停 controller 的队列）。
```

**影响**：慢/挂起客户端（手机休眠、后台冻结标签页、或恶意 client）把广播内容全量堆在服务端内存；按 200×64KB×32 的理论上限可达数百 MB/s 的堆积，OOM 风险，且心跳只清死连接、对“TCP 存活但不读”的对端无效。

**建议**：发送前检查 ws.bufferedAmount，超阈值（如 1MB）时丢弃该 state_update 或直接 close(1013)；给 controller 侧设发送预算，避免为慢消费者做全量快照序列化。

> ⚠️ **第二轮复核修正**：第二轮修正正文措辞：心跳（remote.js:274-284）在首 tick 置 isAlive=false、次 tick（≤~60-90s）即 terminate，暂停读的对端不回 pong 故堆积在时间上被封顶，「无界缓存」「心跳对不读对端无效」不准确。正确表述：**心跳前 ≤60s 窗口内可堆积数百 MB**（实测 3s/单 controller 24.5MB）。级别维持 high（时间封顶不足以压到安全区）。

> 🧪 **修复压力测试**：建议可直接落地 —— 把预算只加在 broadcastToControllers：循环前 `const str = JSON.stringify(msg)` 一次序列化，循环内对每个 controller 先查 `ctrl.bufferedAmount`，超过阈值（1MB 左右）就跳过该帧（state_update 是全量快照，安全）；只有连续多帧仍超限时才 close(1013) 且仅限 controller，绝不作用于 hostSocket 与 384 行的控制指令。这样同时拿到『不为慢消费者做全量快照序列化』的性能收益。

### 5. 构建期注入的 DOWNLOAD_TOKEN 被打进前端 bundle，而该令牌在服务端等价于完整会话旁路（登录启用后仍全放行）

- **级别**：🟠 High
- **位置**：`src/api/http.js:9, 28-30`
- **类别**：安全/密钥泄露·未授权访问｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
`const DOWNLOAD_TOKEN = import.meta.env.VITE_DOWNLOAD_TOKEN || ''`；请求拦截器把它加在**所有**请求上：`if (DOWNLOAD_TOKEN && config.url && !/^https?:/i.test(config.url)) config.headers['x-download-token'] = DOWNLOAD_TOKEN`。同口径还有 src/api/uploads.js:14-15,27（裸 XHR）与 src/api/music.js:510-514（裸 fetch）。而服务端 src/server/lib/auth-gate.js:59-61 在校验 cookie 失败后：`if (tokenMatches(c.req.header('x-download-token'), process.env.DOWNLOAD_TOKEN)) return next();` —— 该分支绕过会话，也不吃 46-49 行的 CSRF Origin 检查（只作用于 session 分支），且 authEnabled()（43 行）为真时依然生效。docker-compose.yml:14 `VITE_DOWNLOAD_TOKEN: ${VITE_DOWNLOAD_TOKEN:-${DOWNLOAD_TOKEN:-}}` 会自动把 DOWNLOAD_TOKEN 烘进 bundle（同文件 30-31 行称该变量「公网/局域网暴露时必需」），DEPLOYMENT.md:307-308 的排障条目更直接要求补上它；而 auth-gate.js:57 自己写着「构建期注入 VITE_DOWNLOAD_TOKEN（bundle 内嵌等于向全体访客发口令）」，DEPLOYMENT.md:247-248 也承认「不建议再往前端 bundle 注入」。由于 non-API 的 GET 一律公开（auth-gate.js:26），/assets/*.js 无需登录即可下载，令牌由此可被任何访客读出。
```

**影响**：按官方 compose/部署文档配置（启用登录 + 设 DOWNLOAD_TOKEN）的实例，任何人只要 GET 一次前端 JS 就能拿到令牌，之后可无凭据调用全部 API：改运行时配置 PUT /settings（可覆写 AI_BASE_URL/AI_API_KEY、BILI_COOKIE/QQ_COOKIE，把上游凭据引到攻击者网关）、删上传资产 DELETE /uploads/:id、触发 /ai 计费调用等——登录门形同不存在。

**建议**：不要把写鉴权令牌当作前端构建变量：删除 VITE_DOWNLOAD_TOKEN 注入路径（http.js:9/28-30、uploads.js:14-15/27、music.js:510-514），并去掉 compose 的 `VITE_DOWNLOAD_TOKEN: ${DOWNLOAD_TOKEN:-}` 自动回落；若必须保留脚本旁路，请为浏览器另发一个只读/受限令牌，且在 auth-gate 中让 cookie 存在或 users 非空时不再接受 x-download-token。同时修正 DEPLOYMENT.md:307-308 的排障指引。

### 6. 认证中间件 authGate 本体零调用——401/旁路/公开前缀/no-store 全无测试

- **级别**：🟡 Medium（第二轮由 High 下调：与 #39-#42 同类「测试闭包未加载」缺口同级；其调用的纯函数均已被测，剩余仅是中间件编排接线）
- **位置**：`src/server/lib/auth-gate.js:41-66`
- **类别**：认证授权测试缺口｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
tests/auth.test.mjs 只调用 sessionFromCookieHeader（:133-137）与 csrfOriginOk（:161-289）；authGate 函数本体（auth-gate.js:41）和 authEnabled（:99）在全部 tests/ 中零调用（grep 'authGate\.authGate\|authEnabled' tests/ 无命中）。而该中间件决定：未登录 401（:65）、x-download-token 旁路（:59）、PUBLIC_PREFIXES/PUBLIC_GET_PREFIXES 放行（:18-28）、登录态响应禁缓存（:53）、CSRF 仅对写请求生效（:46-49）。
```

**影响**：任何让未授权请求被放行的回归——isPublic 前缀判断放宽、token 比对退化成 ==、忘记设置 X-Ms-Auth/no-store、CSRF 检查被挪出中间件——现有 318 个用例都不会报警。CSRF 判定被单测，但"写请求是否真的调用它"这一环没有断言。

**建议**：用 Hono app 挂 authGate 做端到端：users 表非空时无 cookie POST → 401 且带 X-Ms-Auth；带有效 cookie 但异源 Origin 的 POST → 403；x-download-token 正确/错误两态；/auth/* 与静态 GET 放行；登录态响应含 Cache-Control: no-store。

> 🧪 **修复压力测试**：方向正确但需补强 —— 新增 tests/auth-gate.test.mjs：DATA_DIR 隔离，先断言 users 空表时 API GET 放行（默认部署不回归），再 createUser+createSession，用 `app.request(url,{headers:{cookie, host:'localhost', origin:...}})` 显式带 host 头；断言矩阵＝无 cookie GET/POST→401 且 X-Ms-Auth:required、Cache-Control:no-store；同源 POST→200（这条是 403 断言有意义的前提）；Origin:http://evil.com POST→403；正确/错误 x-download-token→200/401；/auth/status 与 /assets/*→200；登录态 API GET→no-store。不改生产代码。

### 7. .env.example 的 NODE_ENV=development 会让生产构建烘焙 import.meta.env.PROD=false，API 同源推断被 DCE 掉

- **级别**：🟠 High
- **位置**：`.env.example:87-88`
- **类别**：构建配置/部署契约｜**原始置信度**：high
- **第二轮复核**：⚠️ 部分确认（正文有需修正处）

**证据**

```
.env.example:88 `NODE_ENV=development`（README:43-44 与 DEPLOYMENT:18-19 都要求 `cp .env.example .env`）。Vite 4.5 把 .env 的 NODE_ENV 提到 `process.env.VITE_USER_NODE_ENV`（node_modules/vite/dist/node/chunks/dep-827b23df.js:37258-37259），再用 `const isProduction = process.env.NODE_ENV === 'production'`（同文件 66190）烘焙 DEV/PROD（66316-66317）。隔离复现：.env 含该行时 `vite build` 产出 `import.meta.env.PROD===false`，移除后为 true。仓库现有 dist/assets/index-ebf02ad4.js 烘焙 `{MODE:"production",DEV:!0,PROD:!1}`，api-base 函数以 `const s=!1;return r()` 收尾且无『检测到 vite preview』串；按 Dockerfile 文件集（无 .env）构建的产物是 `DEV:!1` 且告警串存在。
```

**影响**：src/lib/api-base.js:104 `if (pageIsHttp && !isVitePreview && import.meta.env?.PROD) return window.location.origin` 在按文档构建的产物里成了死代码，resolveApiBaseUrl 恒回落 `协议//页面主机:3101`。于是 API_PORT 改成非 3101、或按 DEPLOYMENT:204-238『公网部署步骤』只开放 TLS 反代端口（应用 3101 仅 loopback）时，前端全部 API/WS 请求打到错误 origin（https 页面还会去请求 https://域名:3101），页面功能全挂；同一源码在 Docker（PROD true，同源正常）与裸机构建（PROD false）产出行为不同的 bundle。DEPLOYMENT.md:55 称『NODE_ENV 服务代码不直接读取』属实，但漏了 Vite 构建会读它。

**建议**：从 .env.example 删掉 NODE_ENV（服务端不读；Docker/compose 各自已内置 production），或在 vite.config.js 显式 define import.meta.env.PROD/DEV；同时修正 README:68-74 的『build=开发构建 / build:prod=生产构建』——两者 mode 都是 production。

> 🧪 **修复压力测试**：方向正确但需补强 —— 推荐组合：(1) 主修——.env.example 删 NODE_ENV 行并同步 DEPLOYMENT.md:55 措辞（说明 Vite 构建期会读它）与 README:68-74；(2) 代码兜底——vite.config.js 顶部只对 build 生效：`...(command==='build' ? { define: { 'import.meta.env.PROD':'true','import.meta.env.DEV':'false' } } : {})`（实测产出 PROD:!0 且不影响 dev）；(3) 重新 `npm run build:prod` 刷新仓库 dist。不要用『无条件 define』或在 config 里仅 delete VITE_USER_NODE_ENV。

<details><summary>第二轮复核的反证/边界</summary>

最强反证是『现有 dist 是开发构建』这一断言的措辞而非事实：事实无误——仓库 dist/assets/index-ebf02ad4.js 确为 `MODE:"production",DEV:!0,PROD:!1` 且不含 preview 告警串，我按相同文件集重建得到完全同型产物（首建 index-50c65c27.js），且该 dist 的 vendor 是开发态 Vue（140305B，含 __VUE_DEVTOOLS 4 处），而无 NODE_ENV 构建的 vendor 是 109706B、零开发态字符串，两者互为判别证据，机制可靠。但 dist/ 被 .gitignore:5 忽略、git ls-files dist 计数为 0，所以它是本地产物而非『随包/随仓库分发』的构建，『随包的构建产物就是踩了该陷阱产出的』这一措辞不准确（新 clone 无 dist）。其余减轻条件：shell 显式导出 NODE_ENV=production 时 .env 行被忽略（已复现 PROD:!0）；Docker 路径不受影响；默认端口裸机路径 devFallback 恰等于页面 origin。测试侧 318 项无一覆盖该烘焙链路，属真实盲区。此外 #29 使 Docker 构建当前本就失败，所以受影响面更偏向裸机路径。

</details>

### 8. Dockerfile 前端阶段未 COPY scripts/：npm run build 的 postbuild 必然 MODULE_NOT_FOUND，镜像构建失败

- **级别**：🟠 High
- **位置**：`Dockerfile:10-12,25`
- **类别**：构建/部署｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
package.json:12 `"postbuild": "node scripts/compress-dist.mjs"` 会被 `npm run build` 自动触发（npm 的 post<name> 生命周期）；Dockerfile:10-12 只 COPY index.html、vite.config.js、postcss.config.js、tailwind.config.js、public、src，`scripts/` 从未进镜像，:25 `RUN npm run build` 必失败。用与 Dockerfile frontend 阶段完全相同的文件集复现（/tmp，仓库未改）：vite build 成功产出 dist 后 postbuild 报 `Error: Cannot find module '.../scripts/compress-dist.mjs'`，退出码 1。
```

**影响**：`docker build -t meowsync .` 与 `docker compose up -d --build`（README:176、DEPLOYMENT:108/137 的首选部署路径）在 frontend 阶段直接失败，镜像构建不出来；br/gz 预压缩特性在 Docker 下永远无法生效。commit 3c3cbf2 加入该脚本（2026-10-04）后 Dockerfile 未同步更新（最后改动 2026-10-01）。

**建议**：在 :25 前加 `COPY scripts ./scripts`（或把脚本挪进 src/ 并同步改 package.json 路径）；让 postbuild 容忍缺失只是掩盖问题。

> 🧪 **修复压力测试**：建议可直接落地 —— 按建议在 Dockerfile:25 之前加 `COPY scripts ./scripts` 即正确（实测通过）。把脚本挪进 src/ 需同步改 package.json:12 的 postbuild 路径，收益不大；让 postbuild 容忍缺失才不可取（会静默丢掉预压缩特性）。

## 六、Medium

### 9. failed 且 failed_tasks=0 的队列没有任何重启入口，残留 pending 任务被永久搁浅

- **级别**：🟡 Medium
- **位置**：`src/server/services/download-manager.js:361-363, 386-388, 1922-1927, 2013-2018`
- **类别**：状态机 / 错误处理 / 契约漂移｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
startQueue 只允许非终态起跑：`if (queue.status === 'failed' || queue.status === 'completed') throw httpError(409, '队列已完结，请使用重试接口');`（361-363）。崩溃兜底无条件写 failed 且只看 cancelled：`if (row && row.status !== 'cancelled') { downloadQueuesRepo.updateQueue(queueId, { status: 'failed' }); }`（386-388），完全不检查库里是否还有 pending 行。重试入口要求至少一条 failed 行：`const failedTasks = tasks.filter(task => task.status === 'failed'); if (failedTasks.length === 0) throw httpError(400, '没有可重试的失败任务');`（2014-2018）。单任务路线也堵死：`const orphanedPending = task.status === 'pending' && (!task.queueId || !downloadQueuesRepo.findQueueById(task.queueId)); const retriable = (task.status === 'failed' || orphanedPending) && ...`（1922-1925）——队列行还在，pending 任务不算 orphan。前端同口径：DownloadQueueList.vue:110 启动键仅 ['pending','cancelled']，canRetry 为 `queue.failedTasks > 0 && status !== 'running' && status !== 'paused'`（254-256），只剩「详情/删除」。
```

**影响**：两种可达形态：(1) 崩溃路径——processQueue 循环内任何未被内层 try 包住的 DB 失败（listTasksByQueue、expireDeferred 的 findTaskById:443、终态事务里 recount 抛错导致回滚后走到 catch）都会把队列直接判 failed；此时队列可能仍有整批 pending 任务且 failed_tasks=0，用户既不能启动也不能重试，任务行在 UI 里连删除入口都没有（DownloadTaskRow.vue:59 对 pending/downloading 隐藏删除），只能对歌单重新发起下载（走 createDownloadQueue 复活分支）或删除整个歌单足迹。(2) 无需任何异常：对 failed 队列执行 DELETE /downloads/playlists/:id/files 或逐条删除失败任务，downloadedTasks 收 completed|failed（1696），recount 后 failed_tasks=0 而队列状态仍是 failed，留下零任务、只能靠「删除」（=级联删歌单+全部文件）清理的死壳。

**建议**：让终态与任务集合自洽：崩溃兜底改为「仍有 pending 行 → 回 pending，无 pending 且 failedTasks>0 → failed」；startQueue 放行「failed 但存在 pending 行」的队列；retryQueue 在 failed_tasks=0 但有 pending 行时退化为 startQueue；deletePlaylistDownloadedFiles/deleteTask/retry* 之后若终态队列已无失败任务且无 pending 行，把状态收回 pending 或收掉空壳。

### 10. 每一步 DB 写失败被静默吞掉，任务行可永久停在 downloading，而队列仍被判 completed

- **级别**：🟡 Medium
- **位置**：`src/server/services/download-manager.js:822-833, 866-890, 484-497`
- **类别**：数据一致性 / 错误处理｜**原始置信度**：medium
- **第二轮复核**：✅ 确认

**证据**

```
完成写失败被无声吞掉且直接 return：`try { const done = downloadTasksRepo.updateTask(task.id, { status: 'completed', ... }); if (!done) return; ... } catch { return; }`（822-833）；失败/重试两条写也各自 `} catch { /* 行已删 */ }`（866-882、885-890）。此时行状态停在 processTask 开头写入的 downloading（668-672），而队列收尾只统计 pending 行：`const pendingRows = downloadTasksRepo.listTasksByQueue(queueId).filter(t => t.status === 'pending'); if (pendingRows.length === 0) break;`（495-497），随后 failedCount 只数 failed 行（598-599）→ `status: failedCount > 0 ? 'failed' : 'completed'`（608）。
```

**影响**：行被钉在 downloading 且没有任何在途 promise，runningTasks 为空 → 队列被判 completed，而该曲在 /downloads/songs/:id/status 仍是 downloaded:false；前端队列进度 total > completed+failed、永远不到 100%，任务行永远显示「下载中」；与代码自身注释冲突（864 行：'每步 DB 写独立兜底……局部失败不得把行卡在 downloading'）。触发条件是这一步写抛错（SQLITE_FULL/SQLITE_IOERR、外部进程持写锁致 busy_timeout 超时等），恢复只能靠重启（recoverStaleStates:2256-2263）或用户对该曲重下。

**建议**：写失败时不要只吞：对状态迁移类写做一次有限重试或兜底 updateTask(status:'failed')；队列收尾前增加「无在途 promise 的 downloading 行 → 复位 pending/failed」的收敛步骤，使终态判定不依赖单一 pending 过滤。

> ⚠️ **第二轮复核修正**：第二轮修正恢复路径：**「靠重启恢复」不成立**——该行 queueId 对应的队列此时已是 completed，重启后 recoverStaleStates 只把行翻成 pending，而 startQueue 对 completed 抛 409、retryQueue 要求存在 failed 行、前端启动键只认 pending/cancelled，重启后仍是同一死态。真正的恢复入口只有 createDownloadQueue 的复活分支或删队列（后者对带 playlistId 的队列会连歌单与文件一起删）。

### 11. 206 响应只对账 content-length，从不校验 Content-Range：任何「局部窗口」响应都会被当成完整工件登记

- **级别**：🟡 Medium
- **位置**：`src/server/services/download-io.js:277, 311, 318-326`
- **类别**：数据一致性/Range 断点续传｜**原始置信度**：medium
- **第二轮复核**：⚠️ 部分确认（正文有需修正处）

**证据**

```
落盘对账唯一依据是 content-length 与实际字节数：`const totalLength = parseInt(response.headers['content-length'], 10);`（277），`if (totalLength > maxBytes) ...`（279-282），pipeline（311）后 `if (totalLength > 0 && stats.size > totalLength) throw fatalError(...)` / `if (totalLength > 0 && stats.size !== totalLength) throw new Error('下载不完整...')`（321-326）。全程没有解析 content-range，也不检查 response.status（全仓 grep content-range 只命中 proxy.js 与 routes/downloads.js）。而下载链大量以 Range 发起：file-downloader.js:49 `RANGE_ALL = { Range: 'bytes=0-' }` 用于 external 音频/视频与网易云音频（file-downloader.js:64/389/702），调用方只做 `if (resp.status !== 200 && resp.status !== 206)` 放行（130/176/427/646/703）。若上游对 `bytes=0-` 回 206 且只给首段窗（file-downloader.js:51-53 注释自述「自适应流的 Range 只放首段窗」），content-length 与该窗口字节数一致 ⇒ 三重校验全部通过，截断文件被 rename 就位并登记为 completed；且 totalLength 是窗口长度，maxBytes 上限对 Content-Range 声明的总长度形同虚设。external 源（bv_/yt_）还叠加豁免：download-manager.js:727-731 对 isExternalSongId 跳过 durationLooksTruncated，截断没有任何后续兜底。
```

**影响**：上游/CDN 返回局部 206 时静默产出截断音频/视频并写入 audioPath/videoPath，前端播到半截或损坏内容且状态显示「已下载」；512MiB/8GiB 体积闸对声明总量失效。

**建议**：status 为 206 时解析 content-range：要求 `bytes 0-.../total` 形式（start=0），用 total 而非 content-length 做 maxBytes 判定，并在 pipeline 后校验 `stats.size === total`；解析不到合法 Content-Range 的 206 按确定性违规处理（或改回无 Range 的全量 GET）。

> ⚠️ **第二轮复核修正**：第二轮修正建议：**不要把「206 但缺/畸形 Content-Range」判为 fatal**——streamToFile 是音频/封面/解锁链共用的落盘骨架，fatal 会让当前能用的非严格上游从「静默可用」变成「硬失败且不重试」；括号里的「改回全量 GET」也与 file-downloader.js:47-48 实测（googlevideo 全量 GET 回 403）冲突。应降级为**可重试错误**并保留 Range 通道。

<details><summary>第二轮复核的反证/边界</summary>

1) 『maxBytes 上限对 Content-Range 声明的总长度形同虚设』夸大：即便窗口很小，data 监听里的 downloadedLength>maxBytes 仍会 destroy 流（292-295），无 content-length 时同样生效，落盘字节永远不会超过 maxBytes；失效的只是『用声明总量做前置拒绝』这一条，不构成磁盘风险。2) 断言『从不校验 response.status』不准确——调用方在 130/176/703 都校验了 200/206，只是不校验 206 的区间语义。3) netease 音频链有 durationLooksTruncated 兜底，并非全链无对账。

</details>

### 12. 默认 HOST=0.0.0.0 + 空 users 表：首启任何网络可达者都能自封管理员，硬闸缺失仅靠控制台警告

- **级别**：🟡 Medium
- **位置**：`netease-api-server.js:30, 269-279`
- **类别**：安全/认证｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
const HOST = process.env.HOST || '0.0.0.0'; 与 if (!authReady && onAllInterfaces) console.warn('[auth] 登录体系未初始化：对外监听时任何人都能执行 /auth/setup 建号。请先完成初始化再开放端口')。对应的 POST /auth/setup（src/server/routes/auth.js:62-95）在 usersRepo.countUsers() === 0 时公开可达（auth-gate.js:13 PUBLIC_PREFIXES 含 '/auth'），csrfOriginOk 对无 Origin 的非浏览器客户端放行，建号即登录。
```

**影响**：首次部署（或 users 表被清空后）只要端口可达，先到者即可拿到 admin：随后可读写 /settings（写入上游 cookie/密钥覆盖）、触发下载、读取全部媒体与歌单数据。缓解只有启动警告和 DEPLOYMENT.md:206 的部署顺序要求，没有任何技术闸门。

**建议**：让 setup 需要一次性 SETUP_TOKEN（或仅允许 loopback/带可信 XFF 的本机请求），或默认 HOST=127.0.0.1 并在完成 setup 后才允许绑定全网卡。

### 13. x-download-token 定位是「写接口守卫」，实现却是登录体系的全量旁路凭据

- **级别**：🟡 Medium
- **⚠️ 定级口径注记（第二轮 N3）**：本条与 #1/#5/#14 是同一凭据链；与 #12（默认部署任意可达者自封 admin）同属「未授权取得全站控制」，原文定级倒挂（前者 Medium 后者反而更低配前提）。按统一判据 #12 应同为 High；维持 Medium 时本段以「文档措辞与作用域不符」为主要修复面（用户决策保留全量旁路契约，仅修正口径表述）。
- **位置**：`src/server/lib/auth-gate.js:41-66（关键 56-61）`
- **类别**：安全/授权范围｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
authGate 中 if (tokenMatches(c.req.header('x-download-token'), process.env.DOWNLOAD_TOKEN)) { return next(); } 位于 session 分支之后、401 之前，对**任意方法、任意 API 路径**生效（不区分 GET/写面）。而 netease-api-server.js:133-152 只用它守非 GET 的 /downloads、/playlists、/ai、/settings、/song-meta、/uploads，DEPLOYMENT.md:47 也把它描述为「非 GET 的 /downloads… 须带 x-download-token（脚本/服务对服务旁路凭据）」。附注：auth-gate.js:58 声明「懒读 env 而非启动快照」，但 netease-api-server.js:129 的 const downloadToken = process.env.DOWNLOAD_TOKEN || '' 是启动快照，同一凭据两处取值时机不一致。
```

**影响**：令牌一旦泄漏（老部署按 .env.example:40/DEPLOYMENT.md:118 注入 VITE_DOWNLOAD_TOKEN 进 bundle、共享脚本、日志），持有者无需登录即可 GET /settings（拿到密钥存在性与尾标）、读取全部已下载媒体与歌单/任务数据、并写任何接口；令牌不过期、不能按面收敛、启用登录后依然有效，等于把整套认证体系降级为一个静态口令。

**建议**：把令牌旁路限制在原本要守的写面（或引入最小权限作用域），启用登录后默认不再把 DOWNLOAD_TOKEN 当全量凭据；统一 env 读取口径（authGate 与写守卫都用同一份懒读或同一份快照）。

### 14. bilibili 视频流：durl 合流兜底被 dashBestH<1080 门挡住，无 avc1 稿件仍 404

- **级别**：🟡 Medium（第二轮复核由 low 调整为 medium）
- **位置**：`src/server/routes/bilibili.js:291-293, 317-323（配合 src/server/lib/bilibili.js:198-202）`
- **类别**：正确性/边界｜**原始置信度**：medium
- **第二轮复核**：✅ 确认

**证据**

```
lib/bilibili.js:198-202：`const avc = all.filter(v => (v?.codecs||'').startsWith('avc1')); return (avc.length ? avc : all).slice().sort(...)`——无 avc1 时返回的是**全编码**列表。routes/bilibili.js:291 `const dashBestH = streams[0]?.height || 0;` 取的就是这个列表首项（可能是 2160p hev1/av01），293 `if (kind === 'video' && dashBestH < 1080)` 才去打 durl（fnval=1&qn=80）。于是当稿件 dash 无任何 avc1 且最优档 ≥1080p 时，durl 那一跳根本不发，usable 为空后落到 321-322 `if (kind === 'video' && !streams.some(s => (s?.codecs||'').startsWith('avc1'))) return c.json({ code: 404, message: 'no playable (avc1) video stream' }, 404)`——正是 286-289 行注释声称会被 durl「救活」的那类稿件。
```

**影响**：对纯 hev1/av01 自适应档且最高档 ≥1080p 的稿件，/bilibili/stream?kind=video 返回 404，而 durl 合流档（恒 avc1 的完整 mp4、实测可到 720p）本可播放。前端 WatchView.vue:1003 用 providerData.hasVideo（无 avc1 时为 false）门控，使新导入场景不可达，但存量 providerData.hasVideo=true 而上游撤掉 avc1 轨、或直接调用该公开 API 时会命中。

**建议**：把 durl 探测门改为「无 avc1 或 最优可播档 <1080p」：例如 `const avcBestH = streams.find(s => (s?.codecs||'').startsWith('avc1'))?.height || 0; if (kind === 'video' && (avcBestH < 1080 || !avcBestH))`，让无 avc1 稿件的兜底跳不被非 avc1 档高度屏蔽。

### 15. 网易云代理路由全家族无速率限制，song_url 解锁扇出可被无限放大

- **级别**：🟡 Medium
- **位置**：`src/server/routes/music.js:142-239, 209-221`
- **类别**：限流与滥用｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
routes/music.js 未引入 rate-limit（顶部 1-6 行仅 require hono/netease-api/http-body/sanitize/env），`app.all('/:apiName')` 直接执行上游调用。而 209-221 行对 song_url/song_url_v1 触发解锁后处理：`result.body.data.filter(needsUnlock)` 最多 20 项，每项串行试 pyncmd/youtube 两源（单源 60s 预算、每次 provider 内 fetch 真出站）、并对每首未命中缓存的曲目发 AI 规整调用（UNLOCK_INFO 正缓存 30min、负缓存仅 2min，换 id 即绕过）。对照：同项目其它外部音源端点全部限流（routes/qq.js:50/92/124/141/159、routes/bilibili.js:40/141/248、routes/youtube.js:78/155/254），audio-proxy 也限流（routes/proxy.js:222/234）。authGate 在 users 表为空时全放行（auth-gate.js:43），且 authEnabled 时登录用户同样无请求速率约束。
```

**影响**：局域网/未启用登录的部署（以及启用登录后的任一账号）可用循环请求把服务端 IP 打进网易云与解锁源的风控、耗光运营者 AI 额度，并使上游配额与 socket/FD 被单机占满；代价约为 1 次入站请求 → 20 项 × (上游云搜/取流 + HEAD 探测 + AI 调用)。

**建议**：给 `/:apiName`（至少 song_url/song_url_v1/playlist_detail/search/cloudsearch/lyric）加 per-IP 滑动窗限流，与其它 provider 路由同规格；对解锁后处理另设更严的桶（fan-out 型端点）。

### 16. trackIds 过滤致空被当成「权威空歌单」，刷新时清空已导入曲目

- **级别**：🟡 Medium
- **位置**：`src/server/services/playlist-sync.js:52-59, 78-82, 140`
- **类别**：数据一致性｜**原始置信度**：medium
- **第二轮复核**：⚠️ 部分确认（正文有需修正处）

**证据**

```
`const trackIds = Array.isArray(playlist.trackIds) ? playlist.trackIds.map(t => t?.id).filter(id => Number.isInteger(id)) : null;` 之后紧接 `if (trackIds && trackIds.length === 0) { songs = []; }`——判空用的是**过滤后**数组。只要上游 trackIds 元素的 id 不是整数（如字符串 id）或元素畸形，全部被滤掉 → 走「空歌单」快路径返回 `{trackCount: 0, tracks: []}`，随后 line 140 `replaceTracksForPlaylist(row.id, remotePlaylist.tracks || [])` 删除该歌单全部 playlist_tracks 行。同文件 78-82 行专门写了防这条路的护栏（`if (songs.length === 0) throw httpError(502, '网易云曲目接口返回空列表（疑似上游故障）')`，注释明说「否则 refresh 会把整个歌单清成 0 行」），但护栏在 `else if (trackIds)` 分支内，过滤致空的场景绕过了它。
```

**影响**：上游契约漂移（id 变字符串/混入畸形元素）时，refresh/重导入会把本地歌单曲目静默清空并写 trackCount=0——用户可感知的数据丢失，且没有任何错误上报（对比：真正的空 trackIds 才是合法空歌单）。

**建议**：用原始长度区分两种语义：先取 `const rawTrackIds = Array.isArray(playlist.trackIds) ? playlist.trackIds : null` 与过滤后的 ids，仅当 `rawTrackIds.length === 0` 才走空歌单快路径；`rawTrackIds.length > 0 && ids.length === 0` 时按上游异常抛 502（与 78-82 行护栏同口径）。

<details><summary>第二轮复核的反证/边界</summary>

未发现能产生『过滤致空』的真实上游形态；该路径只在 id 类型漂移或元素整体畸形时可达。另外建议本身把 rawTrackIds.length===0 继续当合法空歌单，因此 raw 空数组引发的同类清空风险原样保留——建议不能关闭这一类数据丢失。

</details>

### 17. lib/ai.js：200+error 且 choices/content 有效时仍强制裸重试，重试失败会丢掉这份有效答案

- **级别**：🟡 Medium
- **位置**：`src/server/lib/ai.js:133-150`
- **类别**：错误处理/契约漂移｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
`let data = await res.json(); if ((data?.error || !Array.isArray(data?.choices)) && !bare) { res = await retryBare(); if (!res.ok) { console.warn('[ai] chat 重试失败 HTTP ' + res.status); await res.arrayBuffer().catch(() => {}); return null; } data = await res.json(); }`——重试条件只看 data.error/choices 形状，不看 content；而下方注释明说'error 与有效 choices 共存的网关回包以内容为准——只在拿不到内容时才算失败'（146-147），代码却在此时把首次响应整体丢弃。
```

**影响**：网关同时回 {error:...} 与有效 choices（代码注释自认该形态存在）时：①每次调用多打一次上游（配额/延迟翻倍）；②裸重试若网络失败或仍非 2xx，函数返回 null，尽管首次响应里已有合法 JSON 答案——AI 增强路径被无谓降级为「AI 不可用（哑火）」。

**建议**：把重试判据改成'拿不到内容才重试'：先取 content，仅当 content 为空/null 且 !bare 时 retryBare；或在重试失败时回退使用首次的 data（保留首份响应对象）。

### 18. lyric-translate 无整体时间闸：注释声称的 300s 包线本身算错（275+30>300），实际可远超并被客户端超时整份丢弃

- **级别**：🟡 Medium
- **位置**：`src/server/routes/ai.js:154-156, 183, 196-212, 226-229`
- **类别**：性能/超时契约与错误处理｜**原始置信度**：medium
- **第二轮复核**：✅ 确认

**证据**

```
注释：'最坏时长收进客户端 axios 300s 包线内：块数封顶 5（=200 个去重文本）× 55s 块超时 = 275s + 上游 lyric ≈30s < 300s'——275+30=305 已越线；且循环只有 signal 检查，没有任何累计时长判断：`for (let off = 0; off < Math.min(jobs.length, TRANSLATE_CHUNK * 5); off += TRANSLATE_CHUNK) { if (signal?.aborted) return c.body(null, 499); ... }`。单块 `timeoutMs: 55000`（183 行），而 askAiJson→postChat 对同一次调用最多发两次请求（lib/ai.js:116-127 的 response_format 裸重试、136-144 的 200+error 重试），单块实际可达 110s；split 补救（196-202）在 150s 闸前启动还会再叠 2×55s。
```

**影响**：客户端 api/ai.js translateLyric 固定 timeout:300000，超时即断链→服务端 c.req.raw.signal 触发→循环内 499 或 catch 里 499（227 行），两条路径都在 upsertTranslation（224 行）之前返回：已完成的块全部作废、零落库。慢模型/长歌词时该曲每次重播都从零重跑 AI（8/min 限流挡不住重复），用户永远拿不到译文，AI 配额被反复消耗。

**建议**：在循环条件里加单调截止（如 `Date.now() - startedAt < 240000`），到点后不再开新块；并把已翻译结果按块增量落库（或至少在 abort/超时时把已得 translated 合并写盘），使下次重播能续跑而不是重跑。

> ⚠️ **第二轮复核修正**：第二轮修正建议：**不要「在 abort/超时时把已得译文合并写盘」**——缓存命中是整体返回、行上没有完成度标记，提前写盘会把截断译文固化成完整缓存永久下发（比现状更差）。本轮只保留时间闸；增量续译必须与 index 76 合并设计（先加完成度/块位图字段）。

### 19. lyric-translate 尾部行被 200 条上限静默丢弃，且这份不完整译文永久落库不再补译

- **级别**：🟡 Medium
- **位置**：`src/server/routes/ai.js:206, 216-224`
- **类别**：功能错误/数据一致性｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
`off < Math.min(jobs.length, TRANSLATE_CHUNK * 5)`（TRANSLATE_CHUNK=40 → 200 个去重文本封顶）；输出段对全部行回填原文：`for (const l of lines) { const t = translated.get(l.text); out.push(`${l.tag}${t || l.text}`); }`，随后 `lyricAiRepo.upsertTranslation(id, result, aiModel())` 把这份含未译占位的结果写库。而 repositories/lyricAi.js:8-13 的 `getCachedTranslation` 只对 `model LIKE 'skip:%'` 给 7 天 TTL，AI 行无 TTL，命中即返回。MAX_LYRIC_LINES=400 允许 jobs 达 200~400 条。
```

**影响**：source 行数 >200 的长歌词（且未被 400 行闸拒掉）第 201 行起永远显示原文：响应里 lines<total 已自证截断，但结果被当作完整译文永久缓存，后续重播只吃缓存、永不再补译；用户无任何手段触发重译（除手删 DB 行）。

**建议**：要么把上限提升到 MAX_LYRIC_LINES 覆盖的实际块数，要么在截断时不要写'完整'缓存（例如按块落库并标记未完成，命中后继续补译），至少把 lines/total 差异透出给调用方作为可重试信号。

### 20. 远端 play 未复刻 togglePlay 的加载窗闸门：howl.play() 与 onload autoplay 叠加成双音轨

- **级别**：🟡 Medium
- **位置**：`src/composables/useRemoteControl.js:77-87`
- **类别**：正确性/并发竞态｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
case 'play' 只写 `} else if (!isPlaying.value) { howl.play() }`（84-86）。usePlayer.js:1161-1165 的 togglePlay 在同一位置有注释级防线：`// 走 Howler 内部 _queue 排队，onload 的 autoplay 分支又补一次 play——两条 _inactiveSound 各起一个轨道叠加成双音轨` 后接 `if (howl.state?.() === 'loading') return`；playSong 在切歌开始即 `isPlaying.value = false`（usePlayer.js:512），加载窗内 songSwitching=true 而 howl 已非 null，走不到 `!howl` 分支。RemoteController.vue:50 在 `!state.isPlaying` 时渲染的正是 play 按钮，用户在切歌后的加载窗内点遥控播放即触发。Howler 源码佐证：`_state !== 'loaded'` 时 play 只把任务推入 `self._queue`（howler.js:789-800），加载完成时先同步 `parent._loadQueue()` 再 setTimeout 触发用户 onload（howler.js:2503-2505、2332-2335），随后 autoplay 的 `newHowl.play()` 因无 id 走 `_inactiveSound()` 起第二个轨道。
```

**影响**：用户可见的功能错误：遥控端在切歌加载窗内点“播放”会得到两路重叠音频（有相位差的双音轨），只能再暂停一次；本地播放按钮因同一 bug 已被修过。

**建议**：远端 play 复用 togglePlay（或在 useRemoteControl 分支里补 `howl.state?.() === 'loading'` 与 `currentPlayingId !== currentSong.value.id` 两道闸）。

### 21. onUpgrade 无异常兜底：握手路径任一抛错直达 uncaughtException，远端一次连接即可让进程退出

- **级别**：🟡 Medium
- **位置**：`src/server/ws/remote.js:202-267 (244, 249)`
- **类别**：错误处理/进程崩溃｜**原始置信度**：high
- **第二轮复核**：⚠️ 部分确认（正文有需修正处）

**证据**

```
整个 onUpgrade 无 try/catch；鉴权级联里 `const sess = sessionFromCookieHeader(req.headers.cookie || '');`（244）与 `: authEnabled()`（249）都直接读 SQLite：auth-gate.js:38 → sessionsRepo.resolveSession（sessions.js:39 起 prepare/get），auth-gate.js:99-101 → usersRepo.countUsers()（users.js:5-7 `getDb().prepare('SELECT COUNT(*) ...').get().n`，无缓存）。实测（/tmp 探针，DATA_DIR 指向不可创建目录模拟 DB 层抛错）：一个未认证的同源 WS 连接即触发 `UNCAUGHT-EXCEPTION: Error ENOTDIR ... mkdir '/dev/null/nope'`，进程退出；netease-api-server.js:312-315 的 uncaughtException 处理器会执行 process.exit(1)。对照：同一次 DB 错误走 HTTP 时被 Hono 捕获（hono-base.js:298/315 errorHandler → 500），只有 WS 升级路径没有这层兜底。
```

**影响**：DB 出现任何抛错态（磁盘满/IO 错误/权限或 DATA_DIR 不可写/SQLITE_BUSY 超时）时，任意可达客户端只要向 /remote 发一次握手就能终止整个服务进程（连带中断在途下载与播放服务），且默认配置（未配 REMOTE_TOKEN）下每次升级都会走这条 DB 读路径。

**建议**：把 onUpgrade 主体包进 try/catch，捕获后统一 rejectUpgrade(socket, 500/503) 并 socket.destroy()；鉴权级联外再套一层，绝不把异常抛回 http server 的 'upgrade' emit。

<details><summary>第二轮复核的反证/边界</summary>

反证：真实启动路径使'坏 DATA_DIR'场景在监听前就退出（netease-api-server.js:215-218），findings 的主推触发面无效；:244 无 cookie 时不触库。但 :249 每次升级必读库这条崩溃链无法证伪，我已独立复现。

</details>

### 22. 看门狗「等用户手势」分支把播放键变成死键：错误文案要求点播放，但 togglePlay 在 state()==='loading' 时吞掉点击

- **级别**：🟡 Medium
- **位置**：`src/composables/usePlayer.js:731-756, 1161-1165`
- **类别**：错误处理/加载失败恢复｜**原始置信度**：medium
- **第二轮复核**：✅ 确认

**证据**

```
看门狗超时后若 `navigator.userActivation && !navigator.userActivation.hasBeenActive`（738）走「等手势」分支：`songSwitching.value = false`、`playbackError.value = '点击播放键开始播放'`（742），然后 return——不 abort（736 注释）、不 unload、不重置 node，且 732 已 `howlWatchdog = null` 且不会重挂。此时 howl 仍是 load() 设的 `_state = 'loading'`（howler.js:715；只有 canplaythrough 的 _loadListener 才置 'loaded' 并发 'load'，howler.js:2334-2341）。而 togglePlay 在 1165 `if (howl.state?.() === 'loading') return` 把这次点击原样吞掉（1161-1164 注释：加载窗吞点击是为防双音轨）。
```

**影响**：看门狗存在的唯一理由就是 onload/onloaderror 都不来的挂死/CDN 黑洞（728-729 注释）。真挂死时用户按播放键（底栏 / MediaSession play / 远端 play 指令全经 togglePlay）一律无响应，文案却明确让用户点播放键；唯一出路是重新点歌重建 Howl。冷启动（刷新恢复、分享链、远端点歌）路径都没有用户手势，hasBeenActive 为 false，因此桌面端同样可达，不是纯移动端问题。

**建议**：该分支要么把实例置为可重试（例如标记 retryPending，令 togglePlay 在 state!=='loaded' 时改走 `playSong(currentSong, { preserveContext: true, seekTime: currentTime.value })` 重建），要么直接 unload+置空 howl 让 `!howl` 分支接管；无论哪种，都要让文案与实际可执行的动作一致。

> 🧪 **修复压力测试**：方向正确但需补强 —— 取建议的第二个（更简单更完整）方案：在手势分支 return 前加 `newHowl.unload(); if (howl === newHowl) howl = null;`，保持 songSwitching=false、isPlaying=false、文案不变。若坚持 retryPending 方案，必须同步让 useRemoteControl.js:80-86 的 play 分支也走该标记/playSong 重建，否则远端仍是死路径。

### 23. continueWithRelated 只改 playingSongs 不更新 queueOriginalOrder：关掉随机时会把续播追加的曲（含正在播放那首）从队列抹掉

- **级别**：🟡 Medium
- **位置**：`src/composables/usePlayer.js:419, 234-236, 202-204`
- **类别**：数据一致性/队列状态机｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
autoplay 续播追加走 419 `playingSongs.value = [...playingSongs.value, ...fresh]`——不动 queueOriginalOrder；而其它所有队列变更都同步维护该备份（queueRemove 254-257、playNextInQueue 274-279、addToQueueEnd 294-298、queueMove 360-367）。toggleShuffle 关随机时是 234-236 `} else if (queueOriginalOrder?.length) { playingSongs.value = queueOriginalOrder.slice() }`：用旧备份整体替换整个播放队列，且不像 setQueue（202-215）那样把 currentSong 锚回队首。
```

**影响**：「随机开着 → 队列播尽 → autoplay 拉相关曲续播（播放的是 fresh[0]）→ 用户关掉随机」这条链上，追加的 15 首和当前正在播放的那首都不在旧备份里，于是集体从播放队列消失：currentPlayingIndex()（1175-1179）返回 -1，WatchView 的 currentQueueIndex 也为 -1（当前行高亮/已播勾/「接下来」分节线全部失据），此后点「下一首」会因 cur<0 → newIndex=0（1235）跳回恢复后列表第 0 首。autoplayOn 可随存档持久化，故非一次性场景。

**建议**：continueWithRelated 同步把 fresh 追加进 queueOriginalOrder（或抽统一的 pushTail 帮助函数同时维护两表），并让 toggleShuffle 关随机时把 currentSong 锚回（不在备份里就插入），与 setQueue 的锚定语义对齐。

### 24. 恢复播放时 currentTime 先归零并落盘、seek 要等 onload 才生效 → 存档续播点可能被 0 覆盖

- **级别**：🟡 Medium
- **位置**：`src/composables/usePlayer.js:513, 610-614, 703, 721, 765; src/App.vue:1110-1114`
- **类别**：数据一致性/持久化｜**原始置信度**：medium
- **第二轮复核**：✅ 确认

**证据**

```
playSong 在 513 无条件 `currentTime.value = 0`，而恢复用的 seekTime 只在 onload 里写回（610-614 `const safeSeekTime = …; newHowl.seek(safeSeekTime); currentTime.value = safeSeekTime`）；这中间 playSong 自己会落盘：765 `savePlayerStateToStorage()` 位于 `await loadLyrics(song, abortSignal)` 之后（音频通常还没 canplaythrough），错误出口 703/721 也各落一次盘，而 savePlayerStateToStorage（87-106）写的正是 `currentTime: currentTime.value`。App.vue:1110-1114 的注释「恢复路径失败…不落盘：否则会拿全空状态覆盖掉存档里仍可用的续播点」说明这个续播点是有意保护的数据。
```

**影响**：刷新恢复时只要歌词请求（两次小往返）先于 canplaythrough 返回——常见——存档里的 currentTime 已被改写为 0；若用户此时关页/切后台被回收，或该曲随后加载失败（看门狗/onloaderror 路径再写一次 0），续播位置永久丢失，下次从 0:00 开始；同一会话内进度条也会先回 0:00 再跳到续播点。

**建议**：seekTime 落地前不要用 0 覆盖存档位置：restore 场景把「曲 id + 待 seek 位置」一起写入并只在 onload seek 之后再更新 currentTime 的持久化，或让 savePlaybackTimeIfNeeded 在 songSwitching 期间跳过写 currentTime（只更新其它字段）。

### 25. 相关歌曲加载失败被当成「已加载」缓存，一次网络抖动后该曲相关栏永久为空

- **级别**：🟡 Medium
- **位置**：`src/components/WatchView.vue:634-651, 659`
- **类别**：错误处理｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
`relatedFor = songId` 在发起请求之前就落地（638 行），失败分支只清列表、不撤回标记也不提示用户：
```js
relatedFor = songId            // 请求前先锚定
const seq = ++relatedSeq
relatedLoading.value = true
try { const list = await musicApi.searchSongs(artist, 15) ... }
catch { if (seq === relatedSeq) relatedSongs.value = [] }   // 静默清空
finally { if (seq === relatedSeq) relatedLoading.value = false }
```
而唯一的重载入口是切 tab 或换曲：
```js
watch(() => props.tab, (t) => { if (t === 'related' && relatedFor !== props.currentSong?.id) loadRelated() }, ...)
watch(() => props.currentSong?.id, () => { if (props.tab === 'related') loadRelated() })
```
`relatedFor` 已等于当前曲 id，所以再次进入「相关」不会再请求；换曲前该面板恒显示 363 行的「暂无相关推荐」。搜索本身走 withRetry（api/music.js:83-89），上游 5xx/超时耗尽重试后仍会走到这个 catch。
```

**影响**：一次瞬时网络/上游故障后，当前曲的「相关」tab 永久空白且无重试路径，用户只能换歌再回来；与仓内其它错误面（toast(...,'error')）相比属静默吞错。

**建议**：只在成功时置 `relatedFor = songId`（失败时置回 null 以便重进 tab 重试），并在 catch 里给出一次 toast/重试入口；如需保持静默，至少在 catch 中 `relatedFor = null`。

### 26. 过期歌词不退场仍霸占格位，导致该显的歌词缺块/整行不渲染（并放大 6 倍落位开销）

- **级别**：🟡 Medium
- **位置**：`src/lib/textalive-local/canvas-manager.js:370-377, 584-586, 415`
- **类别**：正确性/资源与性能｜**原始置信度**：high
- **第二轮复核**：⚠️ 部分确认（正文有需修正处）

**证据**

```
预填占位对所有 isDraw 的窗内块无差别认领，没有可见性判断：
```js
for (let i = start; i < end; i += 1) {
  const l = this._lyrics[i]
  if (l.isDraw && l.slotKeys?.length) {          // ← 无 isVisible 判断
    for (const key of l.slotKeys) if (!slotOwner.has(key)) slotOwner.set(key, i)
  }
}
```
而同帧的绘制分支却按可见性跳过：
```js
const isVisible = position <= lyric.endTime + LYRIC_PERSIST_MS
if (lyric.isDraw && isVisible) { ... 仅此处绘制并在 622 行重新登记 ... }
```
且过期块永远不会被清 isDraw（全文只有 596 重建失败 / 616 被偷占 / 656 未开始三处 `isDraw = false`，加上 resetLayout 的 110 行），窗范围 [start,end) 的 start 只按 `LINE_LOOKBACK_MS = 14000` 回溯（311 行）——于是「已过期但 startTime 在近 14s 内」的块在窗口内持续霸占格位却一个像素都不画，`tryPlaceWord` 在 415 行 `if (slotOwner.has(key)) return null` 直接拒绝这些格。我用桩化 DOM 直接 import 该模块复现：1440x900、每 2.5s 一句 7 字（space=160 → 视口内可用格仅 ~24 个）时，窗内被不可见块独占的格稳定 ~20 个；整首 240 个词块只有 202 个曾经落位，任一时刻平均 1.6 个（峰值 9 个）「应显未显」；小画布/密歌词更差：1440x600 时 240 块只落位 122、40 句里有 3 句一个块都没渲染；手机 390x844（touch，space=80）180 块只落位 164。把「过期即清 isDraw/slotKeys/glyphPositions」作为对照跑同一输入：240/240 落位、miss 恒为 0。同一份桩化基准里纯落位数学耗时 0.0998ms/帧 → 0.0155ms/帧（6.4x），说明大量块落位失败后反复跑 40 环螺旋（534 行）与兜底候选。
```

**影响**：用户可见的功能错误：沉浸歌词页上该出现的歌词缺 1~2 个词块（整行留洞），密度高/画布小时整句甚至连续多句完全不渲染；同时每帧被不可见块逼进螺旋/兜底路径，落位数学 CPU 抬升约 6 倍（低端机上更明显）。

**建议**：预填时排除已过 persist 窗的块，例如 `if (l.isDraw && l.slotKeys?.length && position <= l.endTime + LYRIC_PERSIST_MS)`；或在块过期时清掉 isDraw/slotKeys/glyphPositions（我已在桩化环境验证：不破坏回退 seek 的补放——过期块本就在 462 行的 `position <= endTime + LYRIC_PERSIST_MS` 闸外，回退 seek 后走 `!lyric.isDraw` 生成路径重排）。

> ⚠️ **第二轮复核修正**：第二轮修正正文数据：原文的「240 块仅 202 落位 / 1440x600 仅 122 / 整句不渲染 / CPU 抬升 6 倍」来自 performance.now() 几乎不动的紧循环桩（相机漂移失效）。真实 60fps 下默认 auto 模式为**约 1-11% 词块迟到、0-4% 永久缺块、整行全灭 0 行**；「整行不渲染」只出现在非默认的 pointer 鼠标模式；性能差实测 <0.7% 帧预算，**不应计入严重度**。机制与修复建议仍然正确。

<details><summary>第二轮复核的反证/边界</summary>

反证一：finding 的紧凑循环桩使 performance.now() 不动→dt≈0，等价冻结相机；我以同法冻结（pointer 模式）得 203.8/240，与其 202/240 吻合，证明其数字来自冻结相机而非真实默认路径；恢复真实时钟后 auto 1440x900 回到 240/240。反证二：整行留洞不成立——5 种子下四个场景的 blankLines 全为 0。反证三：补丁对照（预填加 position <= l.endTime + LYRIC_PERSIST_MS）在所有场景均 240/240。

</details>

### 27. 搜索失败被吞成「没有找到相关内容」空态（allSettled 不查 rejected / QQ 分支无 catch）

- **级别**：🟡 Medium
- **位置**：`src/composables/useSearchNav.js:307-319, 363-369`
- **类别**：错误处理/吞错｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
handlePlaylistSearch 用 `const [plRes, songRes] = await Promise.allSettled([musicApi.searchPlaylists(query), musicApi.searchSongsPage(query, {limit:20})])` 后仅按 status 取值：`searchResults.value = plRes.status === 'fulfilled' ? ... : []`，失败腿被静默映射成空数组、无任何 toast；handleQQSongSearch 只有 try/finally（`try { const list = await musicApi.searchQQSongs(kw) ... } finally {...}`），没有 catch。而 api/http.js 的响应拦截器只处理 401，withRetry 失败最终 throw（api/music.js:17-27），musicApi 层不会把失败变成空结果。
```

**影响**：上游 502/超时/断网时 PlaylistGrid 渲染 `results.length===0 && songs.length===0` 分支，用户看到「没有找到相关内容喵~」——与「真的零结果」不可区分，正是 unwrapBody 注释（api/music.js:42-43「反代把 API 错指到静态服时会返回 HTML 200……会静默吞成空态，必须抛错」）要避免的假空态；QQ 路径还会因未捕获的 rejection 产生 unhandled promise rejection。

**建议**：按本文件既有口径补错误通道：handlePlaylistSearch 检查 plRes/songRes.status === 'rejected' 时 toast(apiErrorMessage(...))（至少在两腿全败时），handleQQSongSearch 外套 try/catch + toast，与 loadMoreSearchSongs(343-346)、previewPlaylistById(398-401) 一致。

### 28. 面板首载期间卸载会永久泄漏 2s 轮询 interval、visibilitychange 监听与跨页副作用

- **级别**：🟡 Medium
- **位置**：`src/components/DownloadsPanel.vue:615-629, 631-639 (startPolling 580-589)`
- **类别**：资源泄漏 / 生命周期竞态｜**原始置信度**：high
- **第二轮复核**：⚠️ 部分确认（正文有需修正处）

**证据**

```
onMounted 内先 `await loadQueues()`（621），成功后才 `startPolling()`（627）与 `document.addEventListener('visibilitychange', handleVisibilityChange)`（628）；清理只挂在 onUnmounted（631-633 `stopPolling()` / `removeEventListener`）。组件在 await 窗口内被卸载时（App.vue:145-150 是 `v-if/v-else-if` 链，切 centerView 即整卸），onUnmounted 已先跑完（pollInterval 仍为 null、监听器尚未注册），随后 await 的续体仍会执行 627-628：`pollInterval = setInterval(pollTick, 2000)` 在已卸载实例上创建且再无清理点。且 onUnmounted 的 `queuesGate.claim()`（636）挡不住它：每轮 pollTick 内的 `loadQueues` 会重新 `queuesGate.claim()`（289）拿到“当前”令牌，`isCurrent` 为真，于是继续发请求并写已死组件的 ref 树。窗口长度 = listQueues 的请求时长（http.js:16 默认 10s 超时），真实可命中。
```

**影响**：用户进入下载页后立刻切走（侧栏点歌单/设置/首页）即触发：一个 setInterval + 一个 document 级 visibilitychange 监听永久存活，每 2s 发起 listQueues + getQueue + listTasks 三跳请求直到页面刷新；被泄漏实例通过闭包持有 queues/tasks 数组。更严重的是 applyPreselect（337）仍会在已离开的页面上跑，命中落空时 `emit('preselect-expired')` 改父级 downloadsPl 并 replaceState 改地址栏、或弹 toast —— 这正是 634-635 注释声称“卸载后落地的响应不该再跑 applyPreselect”所要禁止的行为。

**建议**：在 onBeforeUnmount 置 `disposed = true`，并在 `await loadQueues()` 之后、startPolling/addEventListener 之前 `if (disposed) return`；或把 setInterval/addEventListener 移到 onMounted 的同步段（首个 await 之前），使 onUnmounted 的清理必然与之配对。可参考 useServerDownloads.js:20-21 的 viewDisposed 模式。

<details><summary>第二轮复核的反证/边界</summary>

部分影响被框架挡掉：@vue/runtime-core 3.5.20 runtime-core.cjs.js:6325 `if (instance.isUnmounted) return;`（instance.emit 在 :7806 绑定到该 emit），首次泄漏 tick 距卸载 ≥2s，emit('preselect-expired') 恒为 no-op，故 App.vue:149 的 clearDownloadsPl 与 useSearchNav.js:219 的 replaceState 不会触发，父级 downloadsPl/地址栏不受影响。App.vue:145-150 为 v-else 分支且全仓无 KeepAlive/Suspense（grep 仅注释提及）。核心泄漏经我复现仍成立。

</details>

### 29. withRetry 把「超时」当可重试错误，配合 90s/120s 端点超时把单次失败放大成十几分钟的假死并重复制造服务端僵尸上游链路

- **级别**：🟡 Medium
- **位置**：`src/api/music.js:4-27, 123-125, 156-163`
- **类别**：性能/错误处理｜**原始置信度**：medium
- **第二轮复核**：✅ 确认

**证据**

```
`const RETRY_COUNT = 3` + `function isRetryable(error) { const status = error?.response?.status; return !(status >= 400 && status < 500) }`——没有 response 的失败（超时/断网）恒判为可重试；而 isAbortError（7-9 行）只认 AbortError/CanceledError/ERR_CANCELED，axios 超时错误码是 ECONNABORTED，因此**超时会被重试**。被包裹的端点超时给得很长：getPlaylistDetail 两个串行请求各 120000ms（124、138 行）、getSongUrl 每个码率 90000ms（162 行，且外层还按 [320000,192000] 两个码率各跑一轮）。
```

**影响**：上游慢/半死时，打开一个歌单最坏要等 2×(3×120s+0.5s+1s) ≈ 12 分钟才报错（单曲取流最坏 6×90s≈9 分钟），期间界面只转圈；每次超时后重试都会让服务端继续跑一条完整上游链（121-123 行注释的意图恰是「客户端先断会让服务端继续跑僵尸上游请求」，重试把这条代价乘以 3），在限流桶里也白烧配额。

**建议**：在 isRetryable 中显式排除超时（`error?.code === 'ECONNABORTED'` 或 `error?.message?.includes('timeout')`），或给这类长超时端点关闭重试/加总预算（同一逻辑调用总耗时上限），只对「快速失败」（连接被拒、5xx）重试。

### 30. 分享链接把 URL 硬编码为站点根路径，VITE_BASE_PATH 子目录部署下分享出去就是死链

- **级别**：🟡 Medium
- **位置**：`src/lib/share.js:37-43, 69-82`
- **类别**：正确性/契约不符｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
所有分享链都以 `${origin}/?...` 拼接：`return `${origin}/?bili=${song.bilibili.bvid}...&view=watch``（39 行）、`${origin}/?song=${song?.id}&view=watch`（43 行）、`${origin}/?playlist=${playlist.id}&view=songs&pl=${playlist.id}`（72 行）、以及 76/79/81/82 行的 ?yt=/?bili=/?qqpl=/?mix= 形态。但 SPA 支持子目录部署：vite.config.js:15 `base: env.VITE_BASE_PATH || '/'`，.env.example:27-28「应用基础路径（用于子目录部署）」，Dockerfile:17-21 与 docker-compose.yml:10 都在传递它。同仓的另一处运行时 URL 构造刻意保留了路径——src/components/TopNavigation.vue:194 `window.location.origin + window.location.pathname + '?mode=controller'`。
```

**影响**：设置 VITE_BASE_PATH=/music/ 后，应用在 https://host/music/，而复制/分享出去的链接指向 https://host/?song=...；接收端落到根路径（404 或另一个应用，反代 301 通常还会丢掉 query），分享功能在子目录部署下整体失效。

**建议**：用 `import.meta.env.BASE_URL`（或 `location.pathname` 去掉文件名）拼分享链，与 TopNavigation 的 controllerUrl 同口径，例如 `${origin}${base}?playlist=...`。

> ⚠️ **第二轮复核修正**：第二轮补充：修复方向正确（用 import.meta.env.BASE_URL），无回归。但需注意与本轮新增发现联动——**Hono 单进程静态托管根本不支持 base 前缀**（serveStatic 不做前缀剥离、SPA 兜底对带扩展名路径直接 JSON 404），故子目录部署本身只在外置反代剥前缀的拓扑下可用。

### 31. src/api/* 七个客户端（988 行）零覆盖——前后端字段/错误码契约无对拍

- **级别**：🟡 Medium
- **位置**：`src/api/http.js:1-68`
- **类别**：契约不符测试缺口｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
grep -rn 'src/api' tests/ 无命中；src/api/{http.js 68, music.js 597, downloads.js 195, uploads.js 69, ai.js 34, settings.js 15, auth.js 10} 全部从未加载。服务端响应形状只在 queue-delete-cascade.test.mjs:317-323 对 /downloads/songs/:id/status 一处钉了 {code,data:{downloaded,task}} 嵌套；其余端点（队列列表、任务列表、上传、AI 状态/翻译）的前端消费字段与错误码无任何断言。
```

**影响**：前后端契约漂移（字段改名、错误码从 code 改成 status、分页字段缺失）是该项目历史上反复出现的问题类型（mirror-provider-data.test.mjs:1-3 记录过投影丢 title/author 导致歌词核验成死代码）。当前没有任何机制能在单测阶段发现这类漂移。

**建议**：以 app.request 起真路由，把 src/api/* 客户端的请求/解析函数跑一遍，断言其解析出的领域对象字段；或在 contracts.test.mjs 中补"客户端期望字段集 ⊆ 服务端下发字段集"的静态对拍清单。

### 32. 前端 UI 层结构性零覆盖：usePlayer.js 1492 行 + 21 个 .vue + 9 个 composable 从未被加载，且测试栈无 DOM 能力

- **级别**：🟡 Medium
- **位置**：`src/composables/usePlayer.js:1-1492`
- **类别**：测试覆盖率｜**原始置信度**：high
- **第二轮复核**：⚠️ 部分确认（正文有需修正处）

**证据**

```
package.json:19 为 "test": "node --test tests/"，devDependencies（package.json:34-42）不含 jsdom/vitest/@vue/test-utils，即没有可渲染 Vue 组件或 DOM 的测试运行器。闭包分析：src/components 21 个文件、src/composables 10 个中的 9 个（含 usePlayer.js 1492 行、useSearchNav、useRemoteControl、useServerDownloads、usePlaylistLibrary、useAddToPlaylist、useExternalImport、useHomeFeed）、src/App.vue、src/main.js 全部从未被测试加载；现有前端测试只覆盖 usePagedList 与 useVirtualList 两个纯逻辑模块。
```

**影响**：播放器状态机、播放列表库、深链搜索导航、遥控宿主端、下载面板等用户可见逻辑完全没有回归网。song.test.mjs:12-15 的注释记录过"SongList 每行渲染都炸"的生产崩溃——那类问题目前只能靠人工发现。

**建议**：引入 vitest + @vue/test-utils + jsdom（或 happy-dom）作为前端测试通道；优先为 usePlayer.js（播放/切换/恢复/本地档回落）与 useSearchNav.js 建立行为测试，其次为 SongList/WatchView 的渲染冒烟。

> ⚠️ **第二轮复核修正**：第二轮修正计数与措辞：composables 共 10 个，**被测试覆盖 2 个、未覆盖 8 个（非 9 个）**；「没有任何机制能在单测阶段发现契约漂移」偏绝对——已测路由的响应形状在 route 测试中有大量断言，真正无对拍的是前端消费侧与少数未被断言列表端点。

<details><summary>第二轮复核的反证/边界</summary>

计数反证=composables 目录 10 文件、闭包可达 2（usePagedList/useVirtualList），未测 8 非 9。覆盖反证=grep tests/*.mjs 的 src/lib/ 得 8 个直接 import；song.test.mjs:14-15 明确称“导出全调一遍是唯一可靠钉法”。另无 DOM 栈只解释 .vue 不可测，composable 本身可在 Node 测（paged-list.test.mjs:3 仅 import vue 的 ref/computed）。

</details>

### 33. 6/12 服务端路由文件从未被任何测试加载——ai/qq/playlists/proxy/songmeta/auth 的 HTTP 语义零覆盖

- **级别**：🟡 Medium
- **位置**：`src/server/routes/ai.js:29-299`
- **类别**：测试覆盖率｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
对全部 tests/*.mjs 做 require/import 闭包分析：src/server/routes 下只有 bilibili/downloads/music/settings/uploads/youtube 被加载；ai.js(299 行)/qq.js(179)/playlists.js(137)/proxy.js(242)/songmeta.js(42)/auth.js(162) 在 tests/ 中零引用（grep -rn 'src/api\|routes/ai\|routes/proxy' tests/ 无命中）。这些文件承载真实写接口：/ai/lyric-translate(ai.js:71)、/ai/lyric-verify(:241)、/playlists/import(playlists.js:48)、PUT /song-meta/:id(songmeta.js:25)、/audio-proxy/t/:token(proxy.js:233)、/auth/setup+login+logout(auth.js:62/97/135)。
```

**影响**：路由层的入参校验、错误码映射（httpError→handleError 透传）、状态码语义（400/404/409/429）、流地址 vault 失效 404、镜像 idx 轮换的装配面全部无回归网。lib 层单测覆盖了 stream-vault 原语，但"路由是否按契约使用它"无人验证。

**建议**：按 queue-delete-cascade.test.mjs 的"真路由真库"模式，为这 6 个路由各加最小 HTTP 冒烟：成功形状 + 至少一个 400/404/409/429 分支，重点补 proxy 的 token 失效与 playlists/import 的墓碑 409。

### 34. WS 遥控执行边界 src/server/ws/remote.js（403 行）从未被加载，protocol 测试只钉常量

- **级别**：🟡 Medium
- **位置**：`src/server/ws/remote.js:186-260`
- **类别**：测试覆盖率｜**原始置信度**：high
- **第二轮复核**：⚠️ 部分确认（正文有需修正处）

**证据**

```
闭包分析显示 src/server/ws/remote.js 从未被任何测试加载。tests/protocol.test.mjs:23-27 只做字面量断言（MSG_TYPES、REMOTE_LIMITS.MAX_PAYLOAD_BYTES===65536、MAX_CONTROLLERS===32），即只验证常量声明，不验证常量被执行。真实边界在 remote.js：maxPayload（:189）、Origin 校验与"白名单为空退化为同源"（:220-235）、控制器数上限判断（:259），以及 :381-382 的 CONTROL_TYPES + CONTROL_PAYLOAD_GUARDS 双层校验。
```

**影响**：遥控是未登录外部客户端可直达的入口（PUBLIC 前缀 /remote，auth.test.mjs:104 确认其被判 API 路径）。Origin 校验被误改（例如按注释警告加回 allowedOrigins.length>0 跳过门）、控制器上限失效、payload 上限失效，都不会被测试发现。

**建议**：新增 ws 层测试：用 ws 客户端连 attachRemoteControl 起的服务器，验证跨站 Origin 被拒、第 33 个 controller 被拒、超 64KB 帧被断开、畸形 payload 被丢弃，以及 state_update 的 sanitize 白名单投影。

<details><summary>第二轮复核的反证/边界</summary>

protocol.test.mjs:11-21 已覆盖守卫逻辑本体→“不验证常量被执行”被反证；auth.test.mjs:104 的 isApiPath('/remote')=true 被 finding 当成 PUBLIC 前缀，方向相反；remote.js:244-253 对启用登录的部署强制 session/token 否则 401，“未登录外部客户端可直达”仅指设计开放的默认局域网模型。remote.js 接线/Origin/容量/鉴权级联未覆盖属实。

</details>

### 35. nginx client_max_body_size 10m 与应用上传上限（音频 512MB/视频 2GB/封面 32MB）冲突

- **级别**：🟡 Medium
- **位置**：`nginx.conf:18`
- **类别**：部署配置/契约不符｜**原始置信度**：high
- **第二轮复核**：✅ 确认

**证据**

```
nginx.conf:18 `client_max_body_size 10m;`；src/server/routes/uploads.js:38-40 `audio maxBytes: 512*1024*1024`、`video: 2*1024*1024*1024`、`cover: 32*1024*1024`。compose 的 with-nginx profile 由 nginx.conf:58-72 全量反代 /uploads 到 meowsync:3002。
```

**影响**：通过仓库自带 nginx 反代（DEPLOYMENT:137-143 推荐组合）上传任何 >10MB 文件（一首无损音轨、一张 >10MB 封面）都会被 nginx 直接 413 拒绝，应用侧 512MB/2GB 上限与友好错误永远到不了用户；DEPLOYMENT.md:157 的独立反代示例同样写 10m 并注释为『镜像导入/封面 blob 上传』，与实现不符。

**建议**：按应用上限放宽（如 client_max_body_size 2g，或为 /uploads 单独放宽），并同步修正 DEPLOYMENT.md 的示例。

## 七、Low

低优先级问题，按位置列出。

- **A. 下载管理器核心**｜`src/server/services/download-manager.js`｜deferred 与退避并存时退化为 400ms 忙轮询，每轮两次整队列扫描，最长可持续到 15 分钟硬顶
- **A. 下载管理器核心**｜`src/server/services/download-manager.js`｜downloadSingleSong 缺少 await 之后的停机复查，可在停机窗口落一条永不被消费的 pending 单曲行
- **B. 下载 IO/文件系统/路由**｜`src/server/lib/deletion-locks.js`｜netease 墓碑表只增不删（仅在过期后被读取时才清），长期运行实例内存无界增长
- **B. 下载 IO/文件系统/路由**｜`src/server/routes/downloads.js`｜quick 下载把 startQueue 的所有 409 都吞成成功，停机/删除窗口下返回 200 但没有任何协程在跑 ⚠️（见审计文档修正）
- **B. 下载 IO/文件系统/路由**｜`src/server/services/file-downloader.js`｜音频扩展名白名单可被 Content-Type 绕过：image/* 响应会把音频工件落成 .png/.jpg/.webp
- **C. 服务端核心与安全边界**｜`src/server/lib/env.js`｜corsOrigins() 每次调用重新解析并逐项 console.warn，跨源写请求可无限刷日志
- **C. 服务端核心与安全边界**｜`src/server/lib/password.js`｜argon2id 哈希在 engines 允许的 Node 20/22 上无法校验：登录成功即把用户锁在门外且无重置路径 ⚠️（见审计文档修正）
- **C. 服务端核心与安全边界**｜`src/server/lib/sanitize.js`｜stripAbsolutePaths 的绝对路径正则把 URL 也当路径剥掉，用户可见错误消息被改坏
- **C. 服务端核心与安全边界**｜`start.js`｜start.js 的 SIGKILL 升级永不生效：child.killed 让强制终止变成空操作，留下孤儿进程
- **D. 音乐 provider 与解析**｜`src/server/routes/qq.js`｜QQ 歌单超上限静默截断，且缺 bili/yt 同款的 truncated 契约字段
- **D. 音乐 provider 与解析**｜`src/server/services/netease-api.js`｜解锁缓存命中绕过代理白名单预筛：download 键被「有代理」与「无代理」两类调用共享 ⚠️（见审计文档修正）
- **D. 音乐 provider 与解析**｜`src/server/services/netease/endpoints.js`｜端点表的 crypto 声明是死元数据：运行时通道只由 handler 是否显式传 'weapi' 决定
- **D. 音乐 provider 与解析**｜`src/server/services/playlist-sync.js`｜上游 200 + 非 JSON 错误页被误判为「歌单不存在」404 而非上游故障 502
- **E. 解锁/歌词/AI/上传**｜`src/server/repositories/lyricAi.js`｜译文缓存键不含模型：换模型后旧译文永不失效（与 verdict 键含模型、注释声明的原则相反） ⚠️（见审计文档修正）
- **E. 解锁/歌词/AI/上传**｜`src/server/routes/ai.js`｜lyric-verify：HTTP 链缺省 sourceAuthor 时 verdict 键写入字面量 'undefined'，与下载链的空串签名不一致，缓存判定互不共享
- **E. 解锁/歌词/AI/上传**｜`src/server/routes/ai.js`｜lyric-translate 把 aiEnabled 闸放在缓存查询之前：AI 关闭时已落库译文（含官方译文）不可用，而下载链仍会合并它
- **E. 解锁/歌词/AI/上传**｜`src/server/routes/uploads.js`｜uploads：KIND_DEFS[kind] 走原型链查表，?kind=constructor/toString/__proto__ 触发 TypeError → 500（应 400）
- **E. 解锁/歌词/AI/上传**｜`src/server/routes/uploads.js`｜uploads 落盘不做 content-length 对账（与 streamToFile 不对称），截断请求体会被登记为 completed 完整工件（与 #11 同类「静默截断却标记完整」，量级同级）
- **E. 解锁/歌词/AI/上传**｜`src/server/services/unlock/match.js`｜unlock/match.js 的 JSDoc 与实现不符：声称'放行原序首条'，代码返回前 3 条
- **F. 数据层与歌单路由**｜`src/server/db/client.js`｜download_tasks.queue_id 声明的 ON DELETE CASCADE 在既有库上永远装不上（迁移静默无效），注释与文档却声称有级联 ⚠️（见审计文档修正）
- **F. 数据层与歌单路由**｜`src/server/repositories/downloadTasks.js`｜createTask 对未传入的 download_* 标志写 0，覆盖了建表默认值 1——契约漂移，未来调用方会静默建出「什么都不下」的任务
- **F. 数据层与歌单路由**｜`src/server/repositories/playlists.js`｜deletePlaylist 只显式删 playlist_tracks，把 download_queues/download_tasks 押在 FK 级联上——与自身注释的理由自相矛盾
- **F. 数据层与歌单路由**｜`src/server/repositories/playlistTracks.js`｜findTrackBySongId 的查询计划按 playlist_id 扫全单，song_id 索引完全用不上
- **F. 数据层与歌单路由**｜`src/server/repositories/sessions.js`｜sessions.createSession 的驱逐 DELETE 与 INSERT 未包事务——INSERT 失败会白丢一条既有会话
- **G. WebSocket 遥控**｜`src/composables/useRemoteControl.js`｜host 指令分派用裸字面量，与 protocol.js「三端同源唯一真相源」的声明不符
- **G. WebSocket 遥控**｜`src/server/ws/remote.js`｜role=host 绕过 MAX_CONTROLLERS，且顶替只做优雅 close：被顶替 host 可把连接堆到上限之外
- **G. WebSocket 遥控**｜`src/server/ws/remote.js`｜WS 升级路径完全脱离限流：未认证请求每发一次即打一次 SQLite ⚠️（见审计文档修正）
- **G. WebSocket 遥控**｜`src/server/ws/remote.js`｜协议里 info(controllers) 服务端发、前端无消费端：契约面存在死消息
- **H. 播放器核心**｜`src/App.vue`｜空格/k 缺 e.repeat 闸：长按以 repeat 速率反复 toggle，且 Howler _playLock 期间 isPlaying 滞后可能叠出第二音轨
- **H. 播放器核心**｜`src/App.vue`｜App 每帧重渲染 + 模板内调用 currentPlayingIndex() 对整条队列做线性扫描
- **I. Watch 页与 TextAlive 歌词**｜`src/lib/textalive-local/lyric.js`｜适配器的 grapheme 级切分被 Lyric 按码点二次劈开，keycap/ZWJ emoji 仍会渲染成空白格与豆腐块
- **J. 列表与库/导入**｜`src/components/PlaylistGrid.vue`｜PlaylistGrid 为读一批 id 深监听整个歌单库（含所有 tracks），与 PlaylistPanel 的 id 串监听口径不一致
- **J. 列表与库/导入**｜`src/components/SongList.vue`｜退出排序态的焦点归还是死代码：入口键在排序态被 v-if 卸载，sortBtn 恒为 null
- **J. 列表与库/导入**｜`src/components/SongList.vue`｜歌单行滚动还位只在挂载时试一次；挂载期落在 loading/空态分支时 rowsEl 为 null，还位被永久丢弃
- **J. 列表与库/导入**｜`src/composables/useAddToPlaylist.js`｜点歌台「正在解析…」30s 长驻 toast 从不回收，成功提示与其并存
- **J. 列表与库/导入**｜`src/composables/useAddToPlaylist.js`｜QQ 分支把「主动中止」也当 resolve 失败回落，关窗后仍发起新的上游搜索请求
- **J. 列表与库/导入**｜`src/composables/useHomeFeed.js`｜最近播放历史写盘失败被静默吞掉（配额满时首页货架刷新即空）
- **J. 列表与库/导入**｜`src/composables/usePlaylistLibrary.js`｜未入库预览单的「从歌单移除」写进快照并报成功，重开即复活（与 applyTrackEdit 的入库闸口径不一致）
- **K. 下载 UI**｜`src/components/DownloadQueueList.vue`｜队列列表空态不区分“过滤后无匹配”与“真的没有队列”
- **K. 下载 UI**｜`src/components/DownloadsPanel.vue`｜深链预选消费账本随实例销毁，重挂载后重放已结算意图并清掉 pageMem 保留的过滤器
- **K. 下载 UI**｜`src/components/DownloadTaskList.vue`｜队列任务首载失败的错误态在有 standalone 任务时被吞掉
- **K. 下载 UI**｜`src/composables/useServerDownloads.js`｜切走歌单再切回丢失“下载中”在途标记，重复下载入口导致假“下载失败”toast
- **L. 前端基础设施与通用 UI**｜`src/components/SettingsPanel.vue`｜设置页「输入一改旧结果即失效」的看漏了超时输入框，改了超时仍显示旧的「连接成功」 ⚠️（见审计文档修正）
- **L. 前端基础设施与通用 UI**｜`src/components/SongFormDialog.vue`｜SongFormDialog 声明 aria-modal="true" 却没有焦点陷阱，Tab 可逃到遮罩后的页面
- **L. 前端基础设施与通用 UI**｜`src/lib/external-songs.js`｜buildQQSong 缺少兄弟构造器都有的 http(s) 协议闸，非 URL 封面串会被写进 al.picUrl
- **L. 前端基础设施与通用 UI**｜`src/lib/scroll-mem.js`｜restoreScrollTop 的超时兜底定时器没有随取消函数清理，卸载后仍持有已卸载元素最多 2.5s
- **M. 测试与覆盖率**｜`tests/bilibili-favlist.test.mjs`｜bilibili-favlist 的 lib/bilibili 桩缺 flatUrls，桩面小于被测模块真实依赖面
- **M. 测试与覆盖率**｜`tests/contracts.test.mjs`｜contracts.test 声称测 tracks 体量封顶，实际未测 5000 上限；settingsBody/aiTestBody 契约无用例
- **M. 测试与覆盖率**｜`tests/deletion-locks.test.mjs`｜deletion-locks 测试从不验证墓碑 TTL 到期——模块核心语义无断言
- **M. 测试与覆盖率**｜`tests/helpers.mjs`｜matchWithBudget/matchTracksPool 真身零覆盖，且路由测试用的替身丢弃了 budget/abort/并发语义
- **M. 测试与覆盖率**｜`tests/netease-layer.test.mjs`｜QQ 续期用例用固定 50ms 睡眠等待 fire-and-forget 外呼，负载下会假阴性
- **M. 测试与覆盖率**｜`tests/netease-match.test.mjs`｜"不触发 AI"用 aiScript.length===0 断言，是恒真的空断言
- **M. 测试与覆盖率**｜`tests/settings.test.mjs`｜settings.test.mjs 注释声称"写面限流 全链钉住"，实际无任何 429/限流断言 ⚠️（见审计文档修正）
- **M. 测试与覆盖率**｜`tests/settings.test.mjs`｜settings.test.mjs 用例间通过 process.env 隐式传递前置状态，无法单跑或重排
- **M. 测试与覆盖率**｜`tests/stream-vault.test.mjs`｜stream-vault 测试头声称覆盖 LRU，但容量淘汰、LRU touch、24h 绝对上限全部无断言 ⚠️（见审计文档修正）
- **N. 契约/构建/部署/文档**｜`.env.example`｜DOWNLOAD_TOKEN 文档的受保护端点清单漏了 /settings
- **N. 契约/构建/部署/文档**｜`src/server/lib/qq.js`｜qq.js 手写第二份 songmid 正则，违背 predicates『唯一真相源』的既有收口
- **N. 契约/构建/部署/文档**｜`src/shared/predicates.js`｜extractYouTubePlaylistId 的 URL 分支接受 2 位短 list id，绕开路由『短 token 不浪费一跳』的 ≥13 位闸
- **N. 契约/构建/部署/文档**｜`src/shared/types.ts`｜types.ts 声称被 JSDoc 消费但全仓无人引用，typecheck 实际只检查这一个文件

## 八、被第二轮推翻的结论（不应修复）

- **`src/components/WatchView.vue:457-466, 334`｜相关栏滚动还位挂在 display:none 的元素上，永远还不上（并空转 2.5s 轮询定时器）**
  - 第二轮独立复核推翻：隐藏元素 scrollTop 恒为 0，scroll-mem.js:28 对 top=0 短路，故 2.5s 轮询根本不会启动；「永远还不上」的前提不成立。残留的极小事实（离开非 related tab 时该栏位置不跨页保留）与原文描述的机制不同。**该条不成立。**
- **`src/composables/usePlayer.js:123-134, 166-168, 1341, 1350; src/App.vue:156, 370, 1002`｜restoreUiState 先落 isFullscreenPlayerOpen 而恢复失败不回滚：无歌曲时底栏整条消失且应用内无法复位**
  - 第二轮独立复核推翻：restoreUiState(usePlayer.js:123-134) 根本不读 isFullscreenPlayerOpen，写入它的是 restorePlaybackState:166-168，位于全部失败出口之后且 currentSong 在 playSong:516 同步赋值；全仓不存在 currentSong.value = null，故「flag=true ∧ currentSong=null」不可构造。建议的「把 flag 恢复挪到 playSong 之后」还会回退 commit 0706f74 修掉的白拉流问题。**该条不成立，不应修复。**

## 九、方法学与局限

- 第一轮：14 个单元被要求完整阅读其分配文件并交叉引用调用方；全部 critical/high 交由独立验证代理证伪。
- 第二轮：21 个子代理复核**全部 96 条结论**（含第一轮未验证的 88 条 medium/low），另有 4 个专职代理审计报告本身的遗漏面、事实计数、严重度校准与修复建议质量。
- **局限**：4 个审计代理中「遗漏面审计」只返回了占位内容（`probe`），因此**「报告没有大块盲区」这一结论并未被真正建立**；新增发现集中在「严重度校准/修复建议」两个审计代理所覆盖的范围内。第二轮也**没有**对 critical/high 做第三轮交叉复核。
- 第二轮所有验证者被要求实际打开代码、追踪调用方，并可在 /tmp 下做最小复现；仓库文件零改动。
