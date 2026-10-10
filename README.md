# MeowSync

自托管多源音乐播放器：聚合网易云音乐、QQ 音乐、YouTube、Bilibili 的歌单与单曲，支持本地上传、外源歌词管线与 AI 辅助，像素复古 UI。单进程交付——一个 Node.js 进程同时托管前端页面、API 与 WebSocket 遥控。

## 功能特性

### 音乐源与导入
- **四源聚合** - 网易云/QQ/YouTube/Bilibili 歌单、单曲、B 站收藏夹统一进歌单库
- **统一搜索框** - 关键词、数字 ID、各源分享链接同一入口自动分流（见「导入与搜索」）
- **URL 参数导入** - 分享链参数直接加载歌单/单曲/外部源内容（见「URL 参数」）
- **本地上传** - 音频/视频/封面/歌词四类资产上传为 `file_` 本地曲

### 播放与歌词
- **watch 沉浸页** - YTM 式三 tab（待播/歌词/相关）；B 站/YouTube 曲支持音画切换
- **歌词管线** - 词源自动匹配 + 外源兜底 + AI 核验/翻译 + 手动校准（见「歌词管线」）
- **全屏歌词层** - 字号调节与 ±0.5s 时间校准（服务端持久化）
- **历史与队列** - 播放历史、歌单历史；待播队列可存为歌单
- **渐进渲染** - 千曲歌单/队列虚拟列表按需扩窗，滚动加载

### 下载与缓存
- **服务端下载** - 歌单/单曲下载音频+歌词+封面（可选视频），队列管控/收养/级联清理
- **媒体缓存** - 音频字节缓存命中直喂盘文件；封面经 img-proxy 同源代取
- **零源站外联** - `img-src`/`media-src` 收敛到 `'self'`，页面不直连源站取媒体

### 多端与遥控
- **多端同步** - localStorage 文档级 LWW 同步引擎（`/sync`），失败退避重试不阻塞本地
- **WebSocket 遥控** - `?mode=host|controller` 用手机遥控播放（`REMOTE_TOKEN` 鉴权）
- **登录系统** - `/auth/setup` 首启建号；空用户表 = 未启用登录，全放行

### 界面主题
- **双主题** - retro（默认）/ glitch（glitch-restoration），GlitchText 字符腐蚀特效
- **像素复古风** - Fusion Pixel 像素字族自托管，响应式适配桌面与移动端

## 技术栈

- **前端**: Vue 3 (Composition API) + Vite + TailwindCSS + Howler.js
- **服务端**: Hono 4 单进程（API + WebSocket `/remote` + 静态托管 + SPA fallback）+ better-sqlite3 + ws
- **音乐数据**: 自研 NetEase 客户端（weapi/eapi 加密通道）+ Bilibili/YouTube/QQ 各源解析层
- **共享层**: `src/shared/` 前后端同一份谓词/协议/契约（服务端 `require` ESM 复用）
- **测试**: node:test（服务端/共享层）+ Vitest + @vue/test-utils（组件）+ `tsc --noEmit` 类型检查

## 快速开始

### 环境要求
- Node.js `^20.19.0 || >=22.12.0`（CJS 里 `require` ESM 共享模块需要此下限，推荐 24.x）
- npm

### 安装与启动
```bash
git clone https://github.com/aimkiray/meowsync.git
cd meowsync
npm install
cp .env.example .env   # 可选：默认值即可开发
npm start              # 一键同启前端(3100) + API(3101)
```

也可分别启动：
```bash
npm run dev        # 前端开发服务器（端口 3100）
npm run start:api  # API 服务器（端口 3101）
```

### 构建与验证
```bash
npm run build      # 生产构建 → dist/
npm run preview    # 预览构建产物

npm test             # 服务端与共享层测试（node --test tests/）
npm run test:ui      # 组件测试（vitest run）
npm run typecheck    # 类型检查（tsc --noEmit）
```

## 使用说明

### 导入与搜索

顶栏搜索框统一接受以下形态，回车自动分流：

| 输入形态 | 示例 | 去向 |
|---|---|---|
| 关键词 | 曲名/艺人/专辑（带输入建议） | 搜索结果页 |
| 纯数字 id / `?id=`、`?playlist=` 链接 | `2829883282` | 网易云歌单 |
| 含 song 的链接 | `music.163.com/song?id=N`、本站 `?song=N` | 网易云单曲 |
| BV 号 / av 号 / B 站链接 | `BV1xx...`、`av170001`、`b23.tv/...` | B 站视频 |
| B 站收藏夹 | `favlist?fid=N`、`medialist/play/mlN`、裸 `mlN` | 收藏夹整单导入 |
| YouTube 视频链 | `watch?v=`、`youtu.be/`、`shorts/` | YouTube 视频 |
| YouTube 歌单链 | `/playlist?list=`、`PL`/`UU`/`RD` 前缀裸 listId | YouTube 歌单 |
| QQ 链接 | `y.qq.com`、`c.y.qq.com`、`qqmusic://`、`songmid=` | QQ 单曲 |
| QQ 歌单链 | `/playlist/N`、`taoge.html?id=N`、`disstid` | QQ 歌单 |
| `qq:` 前缀 | `qq:关键词`、`qq:<链接或 mid>` | QQ 曲库搜索 / 直解 |

> 裸 11 位 YouTube videoId 与裸 QQ songmid 和搜索词天然歧义，按关键词处理——要直解请贴完整链接或用 `?yt=`/`?qq=` 分享形态。

### URL 参数

| 参数 | 取值 | 说明 |
|---|---|---|
| `playlist` / `playlists` | 数字 id；多个用 `,` 或 `|` 分隔 | 网易云歌单（自动去重） |
| `song` | 数字 id | 网易云单曲 |
| `bili`（伴生 `p`） | BV 号 / av 号 / 收藏夹 URL / `mlN`；`p=N` 选分 P | B 站视频或收藏夹 |
| `yt` | 11 位 videoId 或歌单链接 | YouTube 视频/歌单 |
| `qq` | songmid | QQ 单曲 |
| `qqpl` | disstid 数字 | QQ 歌单 |
| `mix` | `名字~id1,id2,...` | 本地歌单内容分享链 |
| `view` / `pl` | `view` ∈ `home`/`songs`/`search`/`watch`/`downloads`/`settings` | 导航持久态（`pl`：songs 记歌单、downloads 记预选） |
| `mode` / `token` | `mode=host`/`controller`（`remote` 为 controller 别名） | WebSocket 遥控与令牌兜底 |

分享族参数（前 7 行）为一次性消费：进导入链后自动从地址栏摘除，刷新不重复劫持；`view`/`pl`/`mode` 持久保留在 URL，可分享/收藏。

```
http://localhost:3100/?playlists=2829883282,6725496800
http://localhost:3100/?bili=BV1xx411c7mD&p=3
http://localhost:3100/?view=downloads&pl=12345
http://<主机>:3101/?mode=controller        # 手机遥控端
```

### 歌词管线

- 曲库曲自动匹配词源并持久绑定；外部曲（`yt_`/`bv_`/`qq_`）先尝试回绑曲库词源
- 无词源时走外源级联：`yt_` 先 YouTube Music 本家，再 LRCLIB，最后酷狗兜底
- AI 辅助（可选）：整池消歧 + 词文归属核验拦截同题异曲，另提供歌词翻译——OpenAI 兼容接口，`AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL` 三项全配才启用
- 错配纠正走「重配」：否决名单持久入库，被否条目跨会话不再复活
- 歌词工具条支持手动重新获取；纯文本词可按已下载音频 AI 打轴生成滚动词
- 时间校准 ±0.5s 按词源入库持久化

### 下载与上传

- 歌单/单曲可下载到服务端：音频 + 歌词 + 封面，B 站/YouTube 曲可选视频
- 下载队列支持并发管控、暂停/恢复、失败重试与进度跟踪；任务 SQLite 持久化，重启自动收养
- VIP/灰曲走自研解锁层（pyncmd/YouTube 源）兜底，仍可能失败
- 删除歌单级联清理任务与文件；孤儿文件自动收割
- 「上传」把本地音频/视频/封面/歌词登记为 `file_` 曲，归入内置上传歌单
- 细节见 [DOWNLOAD_GUIDE.md](DOWNLOAD_GUIDE.md)

## 部署指南

### 本地部署

开发环境见「快速开始」。生产单进程：

```bash
npm run build
NODE_ENV=production node server.js
```

前端产物 `dist/` 由同进程托管，应用与 API 均在 `API_PORT`（默认 **3101**）提供服务。

### Docker 部署

```bash
# Compose（推荐）：对外默认 3101
docker compose up -d --build

# 可选：附带 nginx 反代（80 端口，使用仓库内 nginx.conf）
docker compose --profile with-nginx up -d --build

# 手动 docker run
docker build -t meowsync .
docker run -d -p 3101:3002 -v meowsync-data:/app/data meowsync
```

> **容器端口是 3002 不是 3101**：镜像内置 `API_PORT=3002` + `EXPOSE 3002`，`-p` 右段必须写 3002；用 `-e API_PORT=` 覆盖端口时映射右段须同步改。容器以 uid 1001 运行，推荐命名卷；bind mount 需先 `chown -R 1001:1001 ./data`。

> **公网暴露前必读**：`/auth/setup` 在空用户表时对任何可达者开放——
> 直接公网发布会被先到者建号接管。先绑 `127.0.0.1`（或内网）完成
> 管理员初始化再放开端口；完整流程与 TLS/反代配置见
> `DEPLOYMENT.md`「公网部署与登录系统」。局域网自用不受影响
> （空表 = 未启用登录，全放行）。

> **注意**：本项目依赖服务端代理播放与 WebSocket 遥控，需 Node.js 运行时，不适用于纯静态托管平台（Vercel/Netlify）。请使用 Docker 或 VPS 部署。

### 环境变量速览

`.env.example` 是唯一权威全集（含 AI/各源 Cookie/出站代理/数据目录等可选项），此处只列关键变量：

| 变量 | 语境 | 说明 |
|---|---|---|
| `API_PORT` | 运行期 | 服务端口（开发默认 3101，容器内 3002）；`PORT` 仅在其未设时兜底 |
| `HOST` | 运行期 | 绑定地址；`0.0.0.0` 全接口，`127.0.0.1` 仅本机 |
| `CORS_ORIGINS` | 运行期 | 跨域 + WebSocket Origin 白名单，逗号分隔 |
| `REMOTE_TOKEN` | 运行期 | `/remote` 遥控令牌；公网部署务必配置（前端构建侧配 `VITE_REMOTE_TOKEN`） |
| `DOWNLOAD_TOKEN` | 运行期 | 下载/歌单/AI 等写接口令牌；启用登录后退化为服务间旁路 |
| `TRUST_PROXY` | 运行期 | 反代后设 `1`（或实际跳数），采信 `X-Forwarded-*` |
| `VITE_API_BASE_URL` | 构建期 | API 地址显式覆盖；默认留空自动推断，仅分离部署时需要 |

> 不要把 `NODE_ENV` 写进 `.env`——Vite 构建期会读它，`development`
> 值会把生产 bundle 烘成开发态；服务进程请用启动命令/PM2/Docker 注入。

## 项目结构

```
meowsync/
├── index.html                  # SPA 入口（含首帧前主题恢复内联脚本）
├── start.js                    # 开发一键启动（前端 + API 双进程）
├── server.js                   # 生产单进程入口（API + WS + 静态托管）
├── src/
│   ├── api/                    # 前端 API 客户端封装
│   ├── components/             # Vue 组件（TopNavigation/WatchView/SongList 等）
│   ├── composables/            # 组合式函数（usePlayer/useRemoteControl 等）
│   ├── lib/                    # 前端工具（share-params/navUrl/sync/theme 等）
│   ├── shared/                 # 前后端共享谓词/协议/契约
│   ├── server/
│   │   ├── routes/             # Hono 路由 17 枚（music/qq/youtube/bilibili/downloads 等）
│   │   ├── services/           # 业务服务（netease/unlock/lyric-*/download-*/media-cache）
│   │   ├── repositories/       # SQLite 仓储层
│   │   ├── lib/                # 服务端工具（auth-gate/net-guard/stream-vault 等）
│   │   ├── ws/                 # 遥控 WebSocket（remote.js）
│   │   └── db/                 # better-sqlite3 连接
│   └── fonts/                  # 自托管字族（Fusion Pixel 等 woff2）
├── scripts/                    # compress-dist / fetch-fonts / reset-password
├── tests/                      # node:test 服务端与共享层测试
├── public/ · dist/             # 静态资产与构建产物
├── Dockerfile                  # 三阶段构建（EXPOSE 3002，uid 1001）
├── docker-compose.yml          # Compose 编排（可选 with-nginx profile）
├── nginx.conf                  # Nginx 反代主配置（含 WS Upgrade 头）
├── vite/tailwind/postcss/tsconfig/vitest 配置文件
├── .env.example                # 环境变量权威全集
└── DEPLOYMENT.md · DOWNLOAD_GUIDE.md · PRODUCT.md
```

## 文档

- [DEPLOYMENT.md](DEPLOYMENT.md) - 完整部署指南（环境变量全集、公网部署与登录系统、Nginx/TLS、故障排除）
- [DOWNLOAD_GUIDE.md](DOWNLOAD_GUIDE.md) - 下载功能详解（队列机制、解锁层、文件布局）
- [PRODUCT.md](PRODUCT.md) - 产品定位与设计文档

## 注意事项与已知限制

- VIP/灰曲虽有自研解锁层兜底，解锁后仍可能失败；部分歌曲因版权限制无法播放
- 外源歌词（LRCLIB/酷狗/YouTube Music）可用性随上游波动
- 网络不稳定时可能出现加载延迟
- 移动端浏览器存在音频自动播放限制，首次播放可能需手动触发

## 开源协议

[MIT License](LICENSE)

## 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支（`git checkout -b feature/AmazingFeature`）
3. 提交更改（`git commit -m 'Add some AmazingFeature'`）
4. 推送到分支（`git push origin feature/AmazingFeature`）
5. 开启 Pull Request

提交前请跑通 `npm test`、`npm run test:ui` 与 `npm run typecheck`。

## 免责声明

- 本项目仅供个人学习与技术交流用途
- 音乐资源与各源站数据的版权归原平台及相应权利方所有，本项目不持有亦不主张任何权利
- 不得将本项目用于商业用途、大规模抓取或任何侵犯第三方权益的行为
- 使用者须遵守所在司法辖区的法律法规及各源站服务条款，因使用本项目产生的一切后果由使用者自行承担

## 联系方式

- 提交 [GitHub Issue](https://github.com/aimkiray/meowsync/issues)
