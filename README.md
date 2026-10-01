# MeowSync

一个基于Vue 3构建的像素风格网易云音乐播放器，经典复古设计。

## 功能特性

- **歌单搜索与管理** - 搜索网易云音乐歌单，支持ID/URL直接添加
- **URL参数加载** - 通过URL参数直接加载指定歌单，支持单个或多个歌单
- **完整音乐播放** - 播放、暂停、上一首、下一首、随机播放
- **实时歌词显示** - 同步显示歌词和翻译，支持滚动定位
- **像素风主题** - 绿色荧光配色，像素风格
- **响应式设计** - 桌面端和移动端适配
- **音量与进度控制** - 可调节音量和播放进度
- **大列表渐进渲染** - 千曲歌单/待播队列/任务列表按需扩窗，滚动加载
- **VIP歌曲过滤** - 可选择隐藏VIP歌曲
- **歌单收藏** - 本地保存喜爱的歌单
- **下载管理** - 歌单/单曲下载到服务端（音频+歌词+封面），队列管理与进度跟踪，详见 [DOWNLOAD_GUIDE.md](DOWNLOAD_GUIDE.md)

## 技术栈

- **前端框架**: Vue 3 (Composition API)
- **构建工具**: Vite
- **样式框架**: TailwindCSS
- **音频播放**: Howler.js
- **HTTP客户端**: Axios
- **后端API**: 自研 NetEase 客户端（weapi/eapi 加密通道）+ Hono（单进程托管前端静态资源）
- **实时通信**: WebSocket（远程遥控 host/controller）
- **字体**: Fusion Pixel

## 快速开始

### 环境要求
- Node.js `^20.19.0 || >=22.12.0`（与 package.json engines 一致；CJS 里 `require` ESM 共享模块需要此下限，推荐 Dockerfile 同款 24.x）
- npm 包管理器

### 安装依赖
```bash
npm install
```

### 配置环境变量
```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件，根据需要修改配置
# 开发环境通常使用默认配置即可
```

### 启动开发服务器

#### 方式一：一键启动（推荐）
```bash
# 同时启动前端和后端服务
npm start
```

#### 方式二：分别启动
```bash
# 启动前端开发服务器 (端口: 3100)
npm run dev

# 启动网易云音乐API服务器 (端口: 3101)
npm run start:api
```

### 构建生产版本
```bash
# 开发环境构建
npm run build

# 生产环境构建
npm run build:prod
```

### 预览生产版本
```bash
npm run preview
```

## 项目结构

```
meowsync/
├── src/
│   ├── api/
│   │   └── music.js              # 音乐API接口封装
│   ├── components/               # Vue组件
│   ├── composables/              # 组合式函数
│   ├── lib/                      # 共享工具（含服务端补丁/初始化逻辑）
│   ├── server/                   # 服务端路由与 WebSocket（routes/、ws/）
│   ├── fonts/                    # Fusion Pixel字体文件
│   ├── App.vue                   # 主应用组件
│   ├── main.js                   # 应用入口
│   └── style.css                 # 全局样式
├── netease-api-server.js         # 单进程服务入口（API + WebSocket + 静态托管）
├── start.js                      # 开发环境一键启动脚本
├── Dockerfile                    # 三阶段构建（前端构建 → 生产依赖 → 运行时）
├── docker-compose.yml            # Compose 编排（可选 with-nginx 反代 profile）
├── nginx.conf                    # Nginx 反代完整主配置（含 WS Upgrade 头）
├── package.json                  # 项目配置和依赖
├── vite.config.js                # Vite构建配置
├── tailwind.config.js            # TailwindCSS配置
├── postcss.config.js             # PostCSS配置
└── README.md                     # 项目说明文档
```

## 使用说明

### 基本操作
1. **添加歌单**: 点击"发现歌单"标签，搜索或直接输入歌单ID/URL
2. **浏览歌单**: 在"我的歌单"中查看已添加的歌单
3. **播放音乐**: 点击歌单进入歌曲列表，点击歌曲开始播放
4. **查看歌词**: 播放时右侧自动显示同步歌词
5. **播放控制**: 使用底部播放器控制音乐播放

### URL参数功能
- **直接加载歌单**: 通过URL参数直接加载指定歌单，无需手动搜索添加
- **单个歌单**: `http://localhost:3100/?playlist=歌单ID`
- **多个歌单**: `http://localhost:3100/?playlists=歌单ID1,歌单ID2,歌单ID3`
- **支持格式**: 支持逗号(`,`)或竖线(`|`)分隔多个歌单ID
- **智能加载**: URL参数优先级高于默认设置，确保指定歌单正确加载
- **防重复**: 自动过滤重复的歌单ID，避免重复添加

#### URL参数示例
```
# 加载单个歌单
http://localhost:3100/?playlist=2829883282

# 加载多个歌单（逗号分隔）
http://localhost:3100/?playlists=2829883282,6725496800,123456789

# 加载多个歌单（竖线分隔）
http://localhost:3100/?playlists=2829883282|6725496800|123456789
```

### 高级功能
- **渐进渲染**: 大歌单按需扩窗渲染，滚到底自动加载下一批
- **搜索深挖**: 单曲搜索结果可点「加载更多歌曲」翻页（cloudsearch 服务端分页）
- **VIP过滤**: 点击"隐藏VIP"按钮过滤付费歌曲
- **随机播放**: 启用随机模式体验不同的音乐
- **歌单管理**: 长按歌单可以删除不需要的歌单

## 部署指南

### 本地部署

#### 开发环境部署
```bash
# 克隆项目
git clone https://github.com/aimkiray/meowsync.git
cd meowsync

# 安装依赖
npm install

# 启动开发服务器
npm start
```

#### 生产环境部署（单进程）
```bash
# 构建生产版本
npm run build:prod

# 启动后端（自动托管 dist 静态资源 + SPA fallback）
NODE_ENV=production node netease-api-server.js
```
应用与 API 均在 **3101** 端口提供访问（`API_PORT` 可覆盖）。

### Docker部署

#### 使用Docker Compose（推荐）
```bash
# 仓库已含 docker-compose.yml，直接构建并启动
docker compose up -d --build

# 可选：附带 nginx 反代（80 端口，使用仓库内 nginx.conf）
docker compose --profile with-nginx up -d --build
```

#### 手动Docker部署
```bash
# 构建镜像
docker build -t meowsync .

# 运行容器（单端口，前端+API+WebSocket 同进程）
# -v 挂载数据目录，持久化 SQLite 数据库与下载文件。
# 容器以 uid 1001 运行，推荐命名卷；bind mount 需先 chown -R 1001:1001 ./data
docker run -d -p 3101:3002 -v meowsync-data:/app/data meowsync
```

> **公网暴露前必读**：`/auth/setup` 在空用户表时对任何可达者开放——
> 直接公网发布会被先到者建号接管。先绑 `127.0.0.1:3101`（或内网）完成
> 管理员初始化再放开端口；完整流程与 TLS/反代配置见
> `DEPLOYMENT.md`「公网部署与登录系统」。局域网自用不受影响
> （空表 = 未启用登录，全放行）。

> **注意**：本项目依赖服务端代理播放与 WebSocket 遥控，需 Node.js 运行时，不适用于纯静态托管平台（Vercel/Netlify）。请使用 Docker 或 VPS 部署。

### 环境变量配置

#### 前端环境变量（构建期）
```bash
# VITE_API_BASE_URL=                      # 可选：默认留空自动推断（dev=主机:3101，prod=同源）
VITE_API_TIMEOUT=10000
VITE_BASE_PATH=/
VITE_REMOTE_TOKEN=                        # 与后端 REMOTE_TOKEN 配对（可选）
```

#### 后端环境变量（运行期）
```bash
API_PORT=3101
# PORT=                                   # 备用端口变量（仅 API_PORT 未设时生效，PaaS 常用）
HOST=0.0.0.0
CORS_ORIGINS=http://localhost:3101        # 逗号分隔多个来源；留空 = 同源
REMOTE_TOKEN=                             # 可选：/remote WebSocket 访问令牌
TRUST_PROXY=                              # 可选：设为 1 时采信 X-Forwarded-* 头
# DATA_DIR=                               # 可选：SQLite/下载文件根目录（默认 ./data，容器内 /app/data）
# DOWNLOAD_DIR=                           # 可选：下载文件目录（默认 <DATA_DIR>/downloads）
```

## 配置说明

### API配置
项目内置自研 NetEase 客户端提供音乐数据（网易云 weapi/eapi 双通道，替代原 NeteaseCloudMusicApi 依赖），支持：
- 歌单搜索和详情获取
- 歌曲URL获取和播放
- 歌词获取和显示
- 多种音质支持

### 样式自定义
可以在以下文件中自定义样式：
- `src/style.css` - 像素主题样式
- `tailwind.config.js` - TailwindCSS配置
- CSS变量定义在`:root`中，可轻松修改配色方案

## 开发指南

### 核心组件
- **播放器核心**: 基于Howler.js的音频播放管理
- **歌词同步**: 实时歌词解析和滚动定位
- **状态管理**: Vue 3 Composition API响应式状态
- **本地存储**: 歌单收藏和播放历史本地保存

## 注意事项

- 本项目仅供学习和个人使用
- 音乐资源来自网易云音乐，请遵守相关版权规定
- 部分歌曲可能因版权限制无法播放
- 建议在良好的网络环境下使用以获得最佳体验

## 详细部署文档

如需了解更详细的部署配置信息，请查看 [DEPLOYMENT.md](./DEPLOYMENT.md) 文档，其中包含：
- 完整的环境变量配置说明
- 多种部署方式的详细步骤
- Nginx配置示例
- Docker部署配置
- 故障排除指南
- 性能优化建议

## 已知问题

- 某些VIP歌曲可能无法正常播放
- 网络不稳定时可能出现加载延迟
- 移动端浏览器可能存在音频播放限制

## 开源协议

MIT License

## 贡献指南

欢迎提交Issue和Pull Request！

### 贡献方式
1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 联系方式

如有问题或建议，欢迎通过以下方式联系：
- 提交 [GitHub Issue](https://github.com/aimkiray/meowsync/issues)
- 发送邮件至项目维护者
