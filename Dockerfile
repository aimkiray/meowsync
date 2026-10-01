# syntax=docker/dockerfile:1

# ---------- 阶段 1：前端构建 ----------
FROM node:22-alpine AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js postcss.config.js tailwind.config.js ./
COPY public ./public
COPY src ./src

# 构建期变量（VITE_* 会打包进前端产物）：
# 通过 docker build --build-arg 或 compose build.args 注入；留空走同源自动推断
ARG VITE_API_BASE_URL=""
ARG VITE_BASE_PATH="/"
ARG VITE_REMOTE_TOKEN=""
ARG VITE_DOWNLOAD_TOKEN=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_BASE_PATH=$VITE_BASE_PATH \
    VITE_REMOTE_TOKEN=$VITE_REMOTE_TOKEN \
    VITE_DOWNLOAD_TOKEN=$VITE_DOWNLOAD_TOKEN

RUN npm run build

# ---------- 阶段 2：生产依赖 ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
# better-sqlite3 是原生模块：musl 有预编译产物则直接用，没有则回退 node-gyp 编译，
# 工具链只装在本阶段（不带入最终镜像）
RUN apk add --no-cache python3 make g++
# NeteaseCloudMusicApi / unblockneteasemusic 为运行时 CJS 依赖，不打包
RUN npm ci --omit=dev && npm cache clean --force

# ---------- 阶段 3：单进程运行时 ----------
FROM node:22-alpine
WORKDIR /app
# API_PORT 必须显式设：镜像未设时服务回落到开发默认 3101，
# 而 EXPOSE/compose 映射的都是 3002——裸 `docker run -p` 会暴露错误端口
ENV NODE_ENV=production \
    API_PORT=3002

# yt-dlp 是播放解锁的第一优先级源（缺装时静默退化到 kuwo）
RUN apk add --no-cache yt-dlp

COPY --from=deps /app/node_modules ./node_modules
COPY --from=frontend /app/dist ./dist
COPY package.json netease-api-server.js ./
COPY src/server ./src/server
COPY src/shared ./src/shared

# 非 root 运行；/app/data 存放 SQLite 与下载文件（compose 挂载 ./data 持久化）
RUN addgroup -g 1001 -S nodejs \
  && adduser -S meowsync -u 1001 \
  && mkdir -p /app/data \
  && chown -R meowsync:nodejs /app
USER meowsync

# 单端口：API + WS + 静态站点同端口托管
EXPOSE 3002

# 注意：node:22-alpine 的 wget 是 busybox 精简版，不支持 --no-verbose/--tries
# （会报 unrecognized option 恒失败），改用 Node 内置 fetch 探活
# 端口解析与服务端一致（API_PORT || PORT || 3002），docker run -e API_PORT=... 覆盖端口时探活仍正确
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.API_PORT||process.env.PORT||3002)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "netease-api-server.js"]
