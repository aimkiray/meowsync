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
| VITE_BASE_PATH | / | 应用基础路径 |
| VITE_REMOTE_TOKEN | - | 与后端 `REMOTE_TOKEN` 配对的遥控令牌 |
| VITE_DOWNLOAD_TOKEN | - | 与后端 `DOWNLOAD_TOKEN` 配对的下载接口令牌（npm/vite 构建路径用；docker compose 只需设 `DOWNLOAD_TOKEN`，构建 arg 会自动取它） |
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
| REMOTE_TOKEN | - | 可选：设置后 `/remote` WebSocket 必须带 `?token=` |
| DOWNLOAD_TOKEN | - | 可选：设置后非 GET 的 `/downloads`、`/playlists` 请求须带 `x-download-token`；前端需同时设置 `VITE_DOWNLOAD_TOKEN` |
| TRUST_PROXY | - | 可选：设为 `1`/`true` 时采信 `X-Forwarded-Proto/Host` |
| NODE_ENV | development | 环境标识（约定变量，服务代码不直接读取；镜像与 compose 已内置 `production`） |

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
启用下载写鉴权时须双管齐下：
`docker build --build-arg VITE_DOWNLOAD_TOKEN=xxx -t meowsync .` +
`docker run -e DOWNLOAD_TOKEN=xxx`。
Compose 构建时会自动从根目录 `.env` 读取 `VITE_API_BASE_URL`/`VITE_BASE_PATH`/
`VITE_REMOTE_TOKEN`/`VITE_DOWNLOAD_TOKEN`（缺省回落到 `DOWNLOAD_TOKEN`，即
compose 下单设 `DOWNLOAD_TOKEN` 即可），并从同一 `.env` 读取 `CORS_ORIGINS`/
`REMOTE_TOKEN`/`DOWNLOAD_TOKEN`/`TRUST_PROXY` 注入容器运行环境。
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

    location / {
        proxy_pass http://localhost:3101;  # 宿主机部署的监听端口（容器内才是 3002）
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;        # WebSocket 必需
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;                        # 音频流长连接
    }
}
```

> 注意：`proxy_read_timeout` 决定反代能容忍的最长单请求时长。同步阻塞型下载
> （单曲下载/standalone 重试）理论尾部可超 30min——歌曲较多或解锁较慢时
> 反代会先切断响应，但服务端仍在后台跑完，前端应以任务状态轮询为准。
> 若单曲下载常超时，可上调到 `1800s` 以上，或后续改为"提交后轮询"的异步交互。

> 使用反向代理时在 `.env` 设置 `TRUST_PROXY=1`，使 `/song_url` 解锁
> 下发的 `/audio-proxy` 地址使用正确的 `https://` 对外地址。

## 远程遥控

- 主机端：`http://<host>:3101/?mode=host`
- 遥控端：扫描主机端二维码或访问 `/?mode=controller&host=<地址>`
- 设置 `REMOTE_TOKEN`（后端）与 `VITE_REMOTE_TOKEN`（构建期）启用令牌校验
- WebSocket 校验 Origin：默认同源或 `CORS_ORIGINS` 白名单内来源

## 故障排除

1. **页面打开但 API 报错** — 检查 `VITE_API_BASE_URL` 是否误指向 localhost
   （生产构建应留空走同源）；查看 `CORS_ORIGINS`
2. **遥控连接失败** — 确认反代透传了 `Upgrade` 头；校验 token 配对
3. **容器一直 unhealthy** — `curl http://localhost:3101/healthz` 应返回 `{"ok":true}`；
   健康检查端口跟随 `API_PORT`/`PORT` 环境变量，改端口无需改探活配置
4. **with-nginx 反代突然 502** — nginx 仅在启动时解析一次 `meowsync` 服务名；
   单独重建后端容器后 IP 可能变化，执行 `docker compose restart nginx` 即可
5. **端口被占用** — `API_PORT` 修改监听端口；Windows 下确认无残留 node 进程
6. **下载/歌单写接口全 401** — 服务端设了 `DOWNLOAD_TOKEN` 但前端 bundle 没带
   `VITE_DOWNLOAD_TOKEN`（compose 下只需设 `DOWNLOAD_TOKEN` 并用 `--build` 重建）；
   或反之——只设前端变量没设后端变量等于没开鉴权

## 更新部署

```bash
git pull && npm install && npm run build
pm2 restart meowsync        # 或 docker compose up -d --build
```
