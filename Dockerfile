# 使用Node.js 18 Alpine镜像作为基础镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 安装必要的系统依赖
RUN apk add --no-cache git

# 复制package文件
COPY package*.json ./

# 安装依赖（包括开发依赖，用于构建）
RUN npm ci

# 复制源代码
COPY . .

# 构建前端应用
RUN npm run build

# 清理开发依赖，只保留生产依赖
RUN npm ci --only=production && npm cache clean --force

# 创建非root用户
RUN addgroup -g 1001 -S nodejs
RUN adduser -S meowsync -u 1001

# 更改文件所有权
RUN chown -R meowsync:nodejs /app
USER meowsync

# 暴露端口
EXPOSE 3000 3002

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/ping || exit 1

# 启动命令
CMD ["sh", "-c", "node netease-api-server.js & npx serve dist -s -l 3000"]