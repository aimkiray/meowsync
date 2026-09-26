# syntax=docker/dockerfile:1

# ---------- 阶段 1：前端构建 ----------
FROM node:22-alpine AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js postcss.config.js tailwind.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---------- 阶段 2：生产依赖 ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
# NeteaseCloudMusicApi / unblockneteasemusic 为运行时 CJS 依赖，不打包
RUN npm ci --omit=dev && npm cache clean --force

# ---------- 阶段 3：单进程运行时 ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=frontend /app/dist ./dist
COPY package.json netease-api-server.js ./
COPY src/server ./src/server
COPY src/lib ./src/lib

# 非 root 运行
RUN addgroup -g 1001 -S nodejs \
  && adduser -S meowsync -u 1001 \
  && chown -R meowsync:nodejs /app
USER meowsync

# 单端口：API + WS + 静态站点同端口托管
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/healthz || exit 1

CMD ["node", "netease-api-server.js"]
