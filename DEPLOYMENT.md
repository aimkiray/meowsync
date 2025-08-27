# 部署配置指南

本文档详细说明如何配置和部署 MeowSync 音乐播放器项目。

## 环境变量配置

### 1. 创建环境变量文件

复制 `.env.example` 文件并重命名为 `.env`：

```bash
cp .env.example .env
```

### 2. 配置环境变量

根据你的部署环境修改 `.env` 文件中的配置：

#### 前端配置
```env
# 前端服务端口
VITE_PORT=3000

# API服务器地址（重要：部署时需要修改为实际域名）
VITE_API_BASE_URL=https://your-domain.com:3002

# 备用API地址
VITE_BACKUP_API_URL=https://163api.qijieya.cn

# API超时时间（毫秒）
VITE_API_TIMEOUT=10000

# 基础路径（如果部署在子目录）
VITE_BASE_PATH=/
```

#### 后端配置
```env
# API服务器端口
API_PORT=3002

# 服务器主机地址
HOST=0.0.0.0

# CORS允许的来源（重要：部署时需要添加实际域名）
CORS_ORIGINS=https://your-domain.com,http://localhost:3000

# 是否启用请求日志
ENABLE_REQUEST_LOG=true

# 日志级别
LOG_LEVEL=info

# API超时时间
API_TIMEOUT=30000
```

## 部署步骤

### 本地开发

1. **安装依赖**
   ```bash
   npm install
   ```

2. **配置环境变量**
   ```bash
   cp .env.example .env
   # 编辑 .env 文件
   ```

3. **启动开发服务器**
   ```bash
   # 启动前端开发服务器
   npm run dev
   
   # 启动后端API服务器（新终端）
   node netease-api-server.js
   ```

### 生产环境部署

#### 方式一：传统部署

1. **构建前端**
   ```bash
   npm run build
   ```

2. **配置生产环境变量**
   ```env
   # .env.production
   VITE_API_BASE_URL=https://qaq.tat.mom:3002
   CORS_ORIGINS=https://qaq.tat.mom
   HOST=0.0.0.0
   API_PORT=3002
   ENABLE_REQUEST_LOG=false
   ```

3. **启动服务**
   ```bash
   # 启动API服务器
   NODE_ENV=production node netease-api-server.js
   
   # 使用静态文件服务器托管前端（如nginx、apache等）
   # 或使用Node.js静态服务器
   npx serve dist -p 3000
   ```

#### 方式二：使用PM2（推荐）

1. **安装PM2**
   ```bash
   npm install -g pm2
   ```

2. **创建PM2配置文件**
   ```javascript
   // ecosystem.config.js
   module.exports = {
     apps: [
       {
         name: 'meowsync-api',
         script: 'netease-api-server.js',
         env: {
           NODE_ENV: 'production',
           API_PORT: 3002,
           HOST: '0.0.0.0',
           CORS_ORIGINS: 'https://qaq.tat.mom',
           ENABLE_REQUEST_LOG: false
         }
       },
       {
         name: 'meowsync-frontend',
         script: 'npx',
         args: 'serve dist -p 3000',
         env: {
           NODE_ENV: 'production'
         }
       }
     ]
   }
   ```

3. **启动服务**
   ```bash
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup
   ```

#### 方式三：Docker部署

1. **创建Dockerfile**
   ```dockerfile
   FROM node:18-alpine
   
   WORKDIR /app
   
   # 复制package文件
   COPY package*.json ./
   RUN npm ci --only=production
   
   # 复制源代码
   COPY . .
   
   # 构建前端
   RUN npm run build
   
   # 暴露端口
   EXPOSE 3000 3002
   
   # 启动脚本
   CMD ["npm", "run", "start"]
   ```

2. **添加启动脚本到package.json**
   ```json
   {
     "scripts": {
       "start": "node netease-api-server.js & npx serve dist -p 3000"
     }
   }
   ```

## Nginx配置示例

```nginx
server {
    listen 80;
    server_name qaq.tat.mom;
    
    # 前端静态文件
    location / {
        root /path/to/your/dist;
        try_files $uri $uri/ /index.html;
    }
    
    # API代理
    location /api/ {
        proxy_pass http://localhost:3002/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 环境变量说明

### 前端环境变量（VITE_前缀）

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| VITE_PORT | 3000 | 前端开发服务器端口 |
| VITE_API_BASE_URL | http://localhost:3002 | API服务器地址 |
| VITE_BACKUP_API_URL | https://163api.qijieya.cn | 备用API地址 |
| VITE_API_TIMEOUT | 10000 | API请求超时时间（毫秒） |
| VITE_BASE_PATH | / | 应用基础路径 |

### 后端环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| API_PORT | 3002 | API服务器端口 |
| HOST | localhost | 服务器绑定地址 |
| CORS_ORIGINS | http://localhost:3000 | CORS允许的来源 |
| ENABLE_REQUEST_LOG | true | 是否启用请求日志 |
| LOG_LEVEL | info | 日志级别 |
| API_TIMEOUT | 30000 | API超时时间（毫秒） |

## 注意事项

1. **CORS配置**：确保 `CORS_ORIGINS` 包含你的前端域名
2. **API地址**：生产环境中 `VITE_API_BASE_URL` 必须指向正确的API服务器地址
3. **端口配置**：确保服务器防火墙开放相应端口
4. **SSL证书**：生产环境建议配置HTTPS
5. **版权合规**：请遵守相关音乐版权法律法规
6. **性能优化**：可以配置CDN、缓存等优化策略

## 故障排除

### 常见问题

1. **API连接失败**
   - 检查 `VITE_API_BASE_URL` 配置
   - 确认API服务器正在运行
   - 检查CORS配置

2. **环境变量不生效**
   - 确认 `.env` 文件位置正确
   - 重启开发服务器
   - 检查变量名前缀（前端需要 `VITE_` 前缀）

3. **构建失败**
   - 检查Node.js版本（推荐16+）
   - 清除缓存：`npm run build -- --force`
   - 检查依赖版本兼容性

### 日志查看

```bash
# PM2日志
pm2 logs

# 直接运行时的日志
node netease-api-server.js
```

## 更新部署

1. **拉取最新代码**
   ```bash
   git pull origin main
   ```

2. **更新依赖**
   ```bash
   npm install
   ```

3. **重新构建**
   ```bash
   npm run build
   ```

4. **重启服务**
   ```bash
   pm2 restart all
   ```

---

如有问题，请查看项目README或提交Issue。