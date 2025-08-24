# MeowSync

一个基于Vue 3构建的像素风格网易云音乐播放器，经典复古设计。

## 功能特性

- **歌单搜索与管理** - 搜索网易云音乐歌单，支持ID/URL直接添加
- **完整音乐播放** - 播放、暂停、上一首、下一首、随机播放
- **实时歌词显示** - 同步显示歌词和翻译，支持滚动定位
- **像素风主题** - 绿色荧光配色，像素风格
- **响应式设计** - 桌面端和移动端适配
- **音量与进度控制** - 可调节音量和播放进度
- **分页浏览** - 大歌单分页显示，优化性能
- **VIP歌曲过滤** - 可选择隐藏VIP歌曲
- **歌单收藏** - 本地保存喜爱的歌单

## 技术栈

- **前端框架**: Vue 3 (Composition API)
- **构建工具**: Vite
- **样式框架**: TailwindCSS
- **音频播放**: Howler.js
- **HTTP客户端**: Axios
- **工具库**: @vueuse/core
- **后端API**: NeteaseCloudMusicApi + Express.js
- **字体**: Fusion Pixel

## 快速开始

### 环境要求

- Node.js >= 16.0.0
- npm >= 8.0.0

### 安装依赖

```bash
npm install
```

### 启动开发服务器

```bash
# 启动前端开发服务器
npm run dev

# 在另一个终端启动API服务器
node netease-api-server.js
```

服务地址：
- 前端应用: http://localhost:3000
- API服务器: http://localhost:3002

### 构建生产版本

```bash
npm run build
```

### 预览构建结果

```bash
npm run preview
```

## 项目结构

```
meowsync/
├── src/
│   ├── api/
│   │   └── music.js              # 音乐API接口封装
│   ├── fonts/                    # Fusion Pixel字体文件
│   ├── App.vue                   # 主应用组件
│   ├── main.js                   # 应用入口
│   └── style.css                 # 全局样式
├── netease-api-server.js         # 网易云音乐API服务器
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

### 高级功能
- **分页浏览**: 大歌单自动分页，使用底部分页按钮导航
- **VIP过滤**: 点击"隐藏VIP"按钮过滤付费歌曲
- **随机播放**: 启用随机模式体验不同的音乐
- **歌单管理**: 长按歌单可以删除不需要的歌单

## 配置说明

### API配置
项目使用NeteaseCloudMusicApi提供音乐数据，支持：
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

## 已知问题

- 某些VIP歌曲可能无法正常播放
- 网络不稳定时可能出现加载延迟
- 移动端浏览器可能存在音频播放限制

## 开源协议

MIT License - 详见 [LICENSE](LICENSE) 文件

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
