# 部署配置指南

本文档详细说明如何配置和部署 MeowSync 音乐播放器项目。

## 架构说明

MeowSync 采用**单进程全栈架构**：

- 前端：Vue 3 SPA，Vite 构建为 `dist/`
- 后端：Hono（`netease-api-server.js`），同端口提供 API、WebSocket 遥控（`/remote`）、音频代理（`/audio-proxy`）以及前端静态资源与 SPA fallback
- 生产环境只需运行 **一个 Node.js 进程**，对外暴露 **一个端口（默认 3101）**
- 下载管理功能使用 SQLite（`better-sqlite3`）持久化队列/任务，音频/歌词/封面写入 `DATA_DIR`（默认 `./data`）下的 `downloads/`

## 环境变量配置

### 1. 创建环境变量文件

```bash
cp .env.example .env
```

### 2. 前端变量（构建期生效，`VITE_` 前缀）

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| VITE_API_BASE_URL | - | API 地址；生产单进程部署**留空**即自动同源 |
| VITE_API_TIMEOUT | 10000 | API 请求超时（毫秒） |
| VITE_API_PORT | 3101 | 开发模式下的后端端口 |
| VITE_BASE_PATH | / | 应用基础路径（子目录部署；服务端会剥离前缀，compose 自动透传——裸机部署需同时设运行时 `BASE_PATH`） |
| VITE_REMOTE_TOKEN | - | 与后端 `REMOTE_TOKEN` 配对的遥控令牌 |
| VITE_DOWNLOAD_TOKEN | - | 与后端 `DOWNLOAD_TOKEN` 配对的前端内嵌令牌——构建期烘进 bundle = 对全体页面访客可见。**启用登录的部署不要设**；仅无登录 LAN 部署需要浏览器写权限时才显式配置（compose build arg 不自动回落 `DOWNLOAD_TOKEN`） |
| VITE_PORT | 3100 | 开发服务器端口 |
| VITE_OPEN_BROWSER | true（Linux 下恒不打开） | 启动时自动打开浏览器，设为 `false` 关闭 |
| VITE_ALLOWED_HOSTS | - | dev 服务器允许的 Host 列表 |

### 3. 后端变量（运行期生效）

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| API_PORT | 3101 | 服务监听端口 |
| DATA_DIR | `./data`（容器内 `/app/data`） | SQLite 与下载文件根目录 |
| DOWNLOAD_DIR | `<DATA_DIR>/downloads` | 下载文件存放目录 |
| PORT | - | `API_PORT` 的备用变量（Heroku/Railway 等 PaaS 自动注入；`API_PORT` 优先） |
| HOST | 0.0.0.0 | 绑定地址 |
| CORS_ORIGINS | localhost 开发源 | 逗号分隔的允许来源；同源请求始终放行 |
| REMOTE_TOKEN | - | 可选：设置后 `/remote` WebSocket 须带令牌（子协议 `remote.<token>` 优先，`?token=` 兼容兜底）。公网/共享网络部署务必配置——未设且未启用登录时任何可达客户端都能接管主机端（启用登录后由会话 cookie 鉴权兜底） |
| DOWNLOAD_TOKEN | - | 可选：非 GET 的 `/downloads`、`/playlists`、`/song-meta`、`/ai`、`/uploads`、`/settings` 请求须带 `x-download-token`（脚本/服务对服务旁路凭据）。**启用登录后浏览器不再需要它**——会话 cookie 等效放行；`VITE_DOWNLOAD_TOKEN` 仅保留给无登录老部署 |
| TRUST_PROXY | - | 可信反代跳数：`1`/`true` = 单层反代；多级链（CDN→nginx→应用）填实际跳数。采信 `X-Forwarded-Proto/Host`，并按跳数从 XFF 右起取真实客户端 IP 做限流分桶 |
| AI_BASE_URL | - | 可选：OpenAI 兼容接口根地址（如本地 CLIProxyAPI `http://127.0.0.1:8317/v1`）。与 `AI_API_KEY`、`AI_MODEL` 三项全配才启用 AI 辅助 |
| AI_API_KEY | - | 可选：OpenAI 兼容接口的 Bearer key |
| AI_MODEL | - | 可选：模型名（如 `deepseek-v4.1-flash`）。启用后：解锁检索元数据规整、B 站/YouTube 匹配复核与兜底、外部曲歌词归属核验、无译文歌词自动中文翻译 |
| AI_TIMEOUT_MS | 30000 | AI 单次请求超时（毫秒） |
| BILI_COOKIE | - | 可选：B 站登录 Cookie（`SESSDATA=…; bili_jct=…`）。杜比/Hi-Res 音轨只对登录账号下发（Hi-Res 通常需大会员）；不配则 B 站下载回落最高码率 AAC |
| QQ_COOKIE | - | 可选：QQ 音乐登录 Cookie（`uin=…; qm_keyst=…`）。无损/Hi-Res 与 VIP 档只对登录账号下发，不配则匿名态仅常规档。同时充当网易云灰曲的解锁兜底源（cookie 带 refresh_token（QQ 态常为 `psrf_qqrefresh_token`）时临期自动续期，新凭据写运行时变量 `NEW_QQ_COOKIE`，重启后回落 `QQ_COOKIE`——长期运行建议落回 .env）。**务必用小号**（账号风控有先例）；QQ 源对服务器 IP 有地域风控，海外机房部署基本不可用 |
| YT_COOKIE | - | 可选：YouTube 登录 Cookie（浏览器导出整串，形如 `SID=…; SAPISID=…; __Secure-3PAPISID=…`）。匿名 Innertube 全形态会被反机器人墙拦（「请登录，以便我们确认你不是聊天机器人」→ /stream 502），配上后取流/搜索/歌单导入的 youtubei 请求改带登录态 WEB 档绕行；串里需含 `SAPISID`/`__Secure-1PAPISID`/`__Secure-3PAPISID` 之一才会附 `SAPISID*HASH` 签名头，否则只发裸 Cookie。仅用于 youtubei 请求头，不出进程。**强烈建议用小号**——cookie 即完整登录凭据 |
| NODE_ENV | development | 环境标识（服务代码不直读，但 **Vite 构建期会读 `.env` 里的它**——`development` 会把生产 bundle 烘成开发态，故 `.env` 不要放此变量；镜像与 compose 已内置 `production`） |

> 上表 `AI_*`/`BILI_COOKIE`/`QQ_COOKIE`/`YT_COOKIE` 均可在前端「顶部 ⋯ → 设置」运行时覆盖：
> `app_settings` 表存覆盖值，DB 优先于 env，留空回落 env，改动即刻生效无需重启。
> 密钥类字段只回显存在性与尾标；env 的 `AI_API_KEY` 只发往 `AI_BASE_URL` 同源
> 地址——改 Base URL 需同时填覆盖 Key。

## 部署步骤

### 本地开发

```bash
npm install
cp .env.example .env
npm start          # 同时启动 Vite(3100) 与后端(3101)
```

### 生产部署（Node.js）

```bash
npm run build:prod
NODE_ENV=production node netease-api-server.js
# 访问 http://localhost:3101
```

### PM2

```javascript
// ecosystem.config.js —— 仅需一个进程
module.exports = {
  apps: [{
    name: 'meowsync',
    script: 'netease-api-server.js',
    env: {
      NODE_ENV: 'production',
      API_PORT: 3101,
      HOST: '0.0.0.0',
      CORS_ORIGINS: 'https://your-domain.com'
    }
  }]
}
```

```bash
pm2 start ecosystem.config.js && pm2 save
```

### Docker（推荐）

仓库内 `Dockerfile` 为三阶段构建：前端构建 → 生产依赖 → 非 root 运行时。
镜像内只有一个 Node 进程，健康检查走 `/healthz`（Node 内置 fetch 探测）。

```bash
docker build -t meowsync .
docker run -d -p 3101:3002 -v meowsync-data:/app/data --name meowsync meowsync
# -v 挂载 /app/data：SQLite 数据库与下载文件持久化（不挂载则随容器删除）。
# 推荐命名卷：容器以 uid 1001 运行，bind mount 宿主机目录属主不匹配会导致 SQLITE_CANTOPEN。
# 若坚持用宿主机目录，先 `mkdir -p ./data && chown -R 1001:1001 ./data` 再 `-v ./data:/app/data`
```

构建期前端变量（打包进 bundle，运行时不可改）可用 `--build-arg` 注入，
如启用遥控令牌：`docker build --build-arg VITE_REMOTE_TOKEN=xxx -t meowsync .`；
`VITE_DOWNLOAD_TOKEN` 同理需 build arg + 运行时 `DOWNLOAD_TOKEN` 双管齐下，
但它会烘进 bundle 对全体页面访客可见——**启用登录的部署不要设**
（浏览器走会话 cookie），仅无登录 LAN 部署需要浏览器写权限时才用。
Compose 构建时会自动从根目录 `.env` 读取 `VITE_API_BASE_URL`/`VITE_BASE_PATH`/
`VITE_REMOTE_TOKEN`/`VITE_DOWNLOAD_TOKEN`（显式 opt-in，不回落
`DOWNLOAD_TOKEN`），并从同一 `.env` 读取 `CORS_ORIGINS`/
`REMOTE_TOKEN`/`DOWNLOAD_TOKEN`/`TRUST_PROXY`/`AI_*`/`BILI_COOKIE`/`QQ_COOKIE`/`YT_COOKIE` 注入容器运行环境。

> `BILI_COOKIE`/`QQ_COOKIE` + 公网暴露 = 任何访客都能用你的大会员/VIP 轨
> （`prefer=best`）。配置了 Cookie 且开启公网访问时，务必同时设
> `DOWNLOAD_TOKEN`——`/bilibili/stream?prefer=best` 与 `/qq/stream?prefer=best`
> 在该组合下要求 `x-download-token` 才放行高规格轨，匿名访客自动回落常规档
> （播放链不受影响）。上游签名链（QQ purl uin、B 站 mid/uipk、googlevideo
> ip=）一律经 `/audio-proxy/t/<token>` opaque 令牌回源，不出服务端进程——
> 反向代理侧建议对 `/audio-proxy` 关闭 access_log 或剥离 query 落盘。
> `YT_COOKIE` 风险面不同且无令牌闸：公网部署下全体访客的取流/搜索/歌单
> 导入都借用管理员登录态，滥用与高频风控直接记在该账号信誉上——公网
> 部署务必配专用小号而非主号。
注意：改了令牌变量后要 `docker compose up -d --build` 重建镜像——旧 bundle
没有令牌会在写接口上全部 401。

### Docker Compose

```bash
docker compose up -d                    # 单容器，宿主暴露 3101（容器内 3002）
docker compose --profile with-nginx up -d   # 附带 nginx 反代（80 端口）
```

compose 中的 `with-nginx` profile 使用仓库根目录的 `nginx.conf`，
已配置 WebSocket `Upgrade`/`Connection` 头转发，遥控功能可穿透反代。

## Nginx 反向代理（独立部署时）

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 2g;                            # 对齐 /uploads 上限（audio 512MB / video 2GB / cover·lyrics 32MB）

    location / {
        proxy_pass http://localhost:3101;  # 宿主机部署的监听端口（容器内才是 3002）
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;        # WebSocket 必需
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # TRUST_PROXY 限流分桶的生命线——漏配会让全站客户端共享反代出口 IP 挤一个限流桶
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;                        # 音频流长连接
    }
}
```

> 注意：`proxy_read_timeout` 决定反代能容忍的最长单请求时长。下载类接口
> 已是"提交即返回 + 状态轮询"的异步语义（单曲下载、任务重试都不阻塞），
> 剩余长耗时请求是音频流代理与歌单首次导入（上游往返两次），300s 足够。

> 使用反向代理时在 `.env` 设置 `TRUST_PROXY=1`，使 `/song_url` 解锁
> 下发的 `/audio-proxy` 地址使用正确的 `https://` 对外地址——同时它也是
> IP 级限流的正确分桶前提：未设 TRUST_PROXY 时所有客户端共享反代出口 IP，
> `with-nginx` profile 已回传 `X-Forwarded-For`，两个配置须成对出现，
> 否则 `/ai/*`、`/downloads/*` 等按 IP 限流的接口会退化成全局单桶互相饿死。

## 公网部署与登录系统

自托管公网暴露的核心矛盾是「cookie 认证 ↔ `<audio>` 无法带 Authorization 头」。
本项目用 **SQLite 不透明会话 + HttpOnly cookie** 解决——媒体请求同源自动携带，
浏览器无需任何令牌。

### 认证模型

- `users` 表为空 = **登录未启用**：全部放行（局域网自用兼容路径，与
  `DOWNLOAD_TOKEN`「未配即开放」同口径）
- 首个管理员经 **`POST /auth/setup`** 创建（页面打开即自动进建号页）——
  一次性，`users` 非空后该端点恒 409
- 登录得 `HttpOnly` + `SameSite=Lax` cookie（HTTPS 下自动加 `Secure`）；
  服务端只存 token 的 SHA-256——数据库泄露不等于会话泄露
- 会话 = 14 天空闲滑动过期 + 90 天绝对上限；过期行每小时清扫
- 密码 KDF：Node ≥24.7 用内置 `crypto.argon2`（Argon2id），旧版回落 `scrypt`；
  PHC 自描述串，参数升档后登录时透明重哈希
- 登录端点双键限流（per-IP 20 次/10min + per-account 8 次/10min），
  用户不存在也跑完整 KDF——「用户不存在」与「密码错误」时序不可区分
- 写请求带 `Origin` 头时强制同源/`CORS_ORIGINS` 白名单（cookie 会话的 CSRF 纵深）

### 公网部署步骤（推荐顺序）

**接管窗口警告**：`/auth/setup` 在空 `users` 表时对任何可达者开放——
直接把服务绑上公网再去开浏览器，窗口期内扫描器/先到者一条
`curl -X POST /auth/setup` 即接管实例。务必**先建号，再暴露**：

```bash
# 第一步：容器只绑 loopback，公网不可达
docker run -d --name meowsync -p 127.0.0.1:3101:3002 \
  -v meowsync-data:/app/data meowsync

# 第二步：经 SSH 隧道或本机直接完成建号（浏览器开 http://localhost:3101 进建号页）
ssh -L 3101:127.0.0.1:3101 user@your-vps    # 远程 VPS 场景

# 第三步：确认 users 非空后，再换公网映射/挂反代重建容器
docker rm -f meowsync && docker run -d --name meowsync -p 3101:3002 \
  -v meowsync-data:/app/data meowsync    # 或交给反代独占对外
```

compose 用户等价做法：先把 `ports` 改成 `"127.0.0.1:3101:3002"` 起服务
完成建号，再改回公网映射 `docker compose up -d --force-recreate`。

建号完成后继续：

1. TLS 反代在前（nginx/Caddy/Traefik），**只有反代端口对外开放**；
   应用端口只绑内网/loopback，或 docker 网络内不 publish
2. `.env` 设 `TRUST_PROXY=1`（cookie `Secure` 判定、限流分桶、解锁回链的
   `https://` 前缀全部依赖真实外部协议）——**反代必须回传
   `X-Forwarded-For`**（上面的 nginx 示例已含；漏配会让全站客户端
   挤进同一个限流桶，任一用户锁死所有人的登录额度）
3. `CORS_ORIGINS=https://your-domain.com` 显式收紧（默认同源已够，跨域部署才需要）
4. compose `volumes:` 挂载 `/app/data`（users/sessions 与下载文件同卷持久化）

> 服务监听 `0.0.0.0` 且 `users` 为空时启动日志会打 `[auth]` 接管窗口警告；
> 看到它就该意识到「现在暴露 = 谁先建号归谁」。

> 分享出去的 `/audio-proxy/t/<token>` 播放链对未登录者仍有效（vault 令牌
> 本身即能力凭证——这是设计意图，mint 入口已全部在门内）；但
> `/audio-proxy?url=` 开放中转在启用登录后不再裸露。

### 会话/API 客户端

- 浏览器：`fetch`/axios `withCredentials` 已内置，媒体元素同源自动带 cookie
- 脚本/CLI：继续可用 `x-download-token`（`DOWNLOAD_TOKEN` 未失效，降级为
  服务对服务凭据）；启用登录的部署不要往前端 bundle 注入 `VITE_DOWNLOAD_TOKEN`
- `/remote` WebSocket：浏览器握手自动带 cookie；非浏览器客户端仍可用
  `REMOTE_TOKEN` 子协议。登录启用后两者皆无的连接一律 401

### 忘记密码/锁死恢复

清掉两张表即回到「未启用」态（下次访问重新进建号页）。宿主机有 sqlite3：

```bash
sqlite3 <DATA_DIR>/meowsync.sqlite "DELETE FROM sessions; DELETE FROM users;"
```

容器内没有 sqlite3 CLI——用容器自带的 Node + better-sqlite3。
按你的启动方式二选一（compose 服务名与容器名无关，第二种最稳）：

```bash
docker exec meowsync node -e "const D=require('better-sqlite3');new D('/app/data/meowsync.sqlite').exec('DELETE FROM sessions; DELETE FROM users')"
# compose 部署的容器名是 meowsync-app——用服务名执行不受容器名影响：
docker compose exec meowsync node -e "const D=require('better-sqlite3');new D('/app/data/meowsync.sqlite').exec('DELETE FROM sessions; DELETE FROM users')"
```

### 已知边界

- **`a2id$` 哈希仅 Node ≥24.7 可验**：库文件在 Docker（node:24）建号后
  拿到裸机 Node 20/22 跑会永远「密码错误」——换回来或按上节清表重建
- **跨「站点」部署不送 cookie**：`SameSite=Lax` 下异 eTLD+1（或 http↔https）
  的浏览器请求一律不带会话——前后端分离部署必须在同站（同 eTLD+1）；
  跨站遥控端改用 `REMOTE_TOKEN` 子协议
- **内容分享链需要账号**：启用登录后 `?mix=`/`?bili=`/`?yt=`/`?qq=` 链接
  的接收方必须登录；对未登录者有效的分享面只有 `/audio-proxy/t/` 播放链
- **单进程假设**：PM2/cluster 多实例会让限流桶与 stream-vault 各自为政——
  `instances` 恒为 1
- **无会话管理 API**：没有改密/「登出所有设备」端点；吊销一切会话 = 上节
  的清表恢复命令；已建立的 `/remote` WebSocket 连接在 logout 后不断线
  （鉴权只在握手时），需要强制踢线就重启服务
- **`?token=` 落 access_log**：REMOTE_TOKEN 走 URL 兜底形态会写进反代日志——
  token 用 RFC7230 字符集（字母数字+`!#$%&'*+-.^_`|~`）会优先走子协议不落 URL
- 本会话内已登录页继续播放不受踢门影响（流已下发）；门控只管 API/WS

## 远程遥控

- 主机端：`http://<host>:3101/?mode=host`
- 遥控端：扫描主机端二维码，或直接访问同一服务的 `/?mode=controller`
  （遥控页从当前页面推导 WS 地址，无需额外参数；跨域分离部署时靠 `VITE_API_BASE_URL` 指定 API 地址）
- 设置 `REMOTE_TOKEN`（后端）与 `VITE_REMOTE_TOKEN`（构建期）启用令牌校验；
  启用登录后浏览器遥控端经会话 cookie 鉴权，无需再配 VITE_REMOTE_TOKEN；
  两者皆无且未登录的连接一律 401
- WebSocket 校验 Origin：默认同源或 `CORS_ORIGINS` 白名单内来源；controller 连接数上限 32，逐连接消息限流

## 故障排除

1. **页面打开但 API 报错** — 检查 `VITE_API_BASE_URL` 是否误指向 localhost
   （生产构建应留空走同源）；查看 `CORS_ORIGINS`
2. **遥控连接失败** — 确认反代透传了 `Upgrade` 头；校验 token 配对
3. **容器一直 unhealthy** — `curl http://localhost:3101/healthz` 应返回 `{"ok":true}`；
   健康检查端口跟随 `API_PORT`/`PORT` 环境变量，改端口无需改探活配置
4. **with-nginx 反代突然 502** — nginx 仅在启动时解析一次 `meowsync` 服务名；
   单独重建后端容器后 IP 可能变化，执行 `docker compose restart nginx` 即可
5. **端口被占用** — `API_PORT` 修改监听端口；Windows 下确认无残留 node 进程
6. **下载/歌单写接口全 401** — 服务端设了 `DOWNLOAD_TOKEN` 但请求没带令牌。
   **启用登录的部署不要设 `VITE_DOWNLOAD_TOKEN`**（烘进 bundle = 对全体访客
   发口令；浏览器由会话 cookie 等效放行，401 说明是未登录而非缺令牌）。
   无登录部署确需浏览器写权限时才显式 `VITE_DOWNLOAD_TOKEN=xxx` 并
   `--build` 重建；或反之——只设前端变量没设后端变量等于没开鉴权

## 更新部署

```bash
git pull && npm install && npm run build
pm2 restart meowsync        # 或 docker compose up -d --build
```
