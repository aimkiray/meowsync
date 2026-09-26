# MeowSync 下载功能使用指南

## 功能概述

已成功实现歌单下载管理功能，支持：
- ✅ 音频文件下载（MP3，支持多码率）
- ✅ 歌词文件下载（LRC 格式）
- ✅ 封面图片下载（JPG/PNG）
- ✅ VIP 歌曲自动解锁（使用 ytdlp 和 kuwo 源）
- ✅ 下载队列管理（并发控制、暂停/恢复）
- ✅ 进度跟踪和错误重试

## 快速开始

### 1. 启动服务

```bash
# 启动后端 API 服务器（端口 3101）
node netease-api-server.js

# 启动前端开发服务器（端口 3100）
npm run dev
```

### 2. 访问管理页面

在浏览器中打开 `http://localhost:3100`，点击顶部导航栏右侧的 **⚙️ 管理** 按钮切换到下载管理视图。

### 3. 使用流程

**整个歌单下载**：
1. 在左侧歌单列表中，点击歌单右侧的菜单按钮（⋮）
2. 选择 **📥 下载歌单**——自动创建队列并开始后台下载（音频 320k + 歌词 + 封面，并发 3）
3. 切到管理视图查看队列进度，支持暂停/恢复/重试/删除

**单曲下载**：
1. 在歌曲列表中点击歌曲右侧的下载图标
2. 选择 **💾 下载到服务器**（存到服务端 `data/downloads/`）或 **📄 获取源文件**（浏览器直接下载）
3. 已下载的歌曲会显示 **🗑️ 删除已下载文件** 选项

## API 使用示例

### 创建下载队列

```bash
curl -X POST http://localhost:3101/downloads/queues \
  -H "Content-Type: application/json" \
  -d '{
    "playlistId": 1,
    "bitrate": 320000,
    "downloadAudio": true,
    "downloadLyrics": true,
    "downloadCover": true,
    "concurrentLimit": 3
  }'
```

### 启动队列

```bash
curl -X POST http://localhost:3101/downloads/queues/{queueId}/start
```

### 查看进度

```bash
curl http://localhost:3101/downloads/queues/{queueId}
```

### 查看任务列表

```bash
curl 'http://localhost:3101/downloads/tasks?queueId={queueId}'
# 或按歌单/状态过滤：?playlistId=1 / ?status=completed
```

### 暂停 / 恢复 / 取消 / 重试队列

```bash
curl -X POST http://localhost:3101/downloads/queues/{queueId}/pause
curl -X POST http://localhost:3101/downloads/queues/{queueId}/resume
curl -X POST http://localhost:3101/downloads/queues/{queueId}/cancel    # 中止在途下载，任务复位 pending
curl -X POST http://localhost:3101/downloads/queues/{queueId}/retry    # 重置失败任务并重跑
```

### 删除队列 / 任务 / 歌曲文件

```bash
curl -X DELETE http://localhost:3101/downloads/queues/{queueId}        # 中止队列并连带删除已落盘文件
curl -X DELETE http://localhost:3101/downloads/tasks/{taskId}
curl -X DELETE 'http://localhost:3101/downloads/songs/{songId}?playlistId=1'
curl -X DELETE http://localhost:3101/downloads/playlists/1/files       # 清空歌单全部已下载文件
```

### 单曲下载与状态查询

```bash
curl -X POST http://localhost:3101/downloads/songs/{songId} \
  -H "Content-Type: application/json" \
  -d '{"playlistId":1,"bitrate":320000,"downloadLyrics":true,"downloadCover":true}'

curl 'http://localhost:3101/downloads/songs/{songId}/status?playlistId=1'
```

### 一键创建并启动歌单下载

```bash
curl -X POST http://localhost:3101/downloads/playlists/{playlistId}/quick
```

错误统一返回 `{ "code": <http状态>, "message": "<原因>" }`。

## 文件存储结构

下载的文件保存在 `data/downloads/` 目录下：

```
data/downloads/
└── {playlist_id}/
    ├── audio/
    │   └── {艺术家} - {歌名}.mp3
    ├── lyrics/
    │   └── {艺术家} - {歌名}.lrc
    └── covers/
        └── {song_id}.jpg
```

## 数据库表结构

### download_queues（下载队列）
- id：队列 ID
- playlist_id：歌单 ID
- name：队列名称
- status：状态（pending/running/paused/completed/failed/cancelled）
- total_tasks：总任务数
- completed_tasks：已完成任务数
- failed_tasks：失败任务数
- bitrate：音频码率
- concurrent_limit：并发数

### download_tasks（下载任务）
- id：任务 ID
- playlist_id：歌单 ID
- song_id：歌曲 ID
- song_name：歌曲名称
- artist：艺术家
- status：状态（pending/downloading/completed/failed）
- progress：进度（0-100）
- retry_count：重试次数
- audio_path：音频文件路径
- lyrics_path：歌词文件路径
- cover_path：封面文件路径

## VIP 歌曲解锁

系统会自动检测 VIP 歌曲并使用解锁服务：
- 下载场景优先 kuwo 源（直连源站，不经 audio-proxy），备用 ytdlp
- 播放场景优先 ytdlp 源（经服务端 /audio-proxy 中转），备用 kuwo
- 自动验证时长匹配（kuwo 下载链接除外，其元数据不可靠）
- 失败自动重试（最多 3 次）

## 测试结果

✅ 数据库表创建成功
✅ API 端点正常工作
✅ 队列创建和启动成功
✅ 文件下载成功（音频、歌词、封面）
✅ VIP 解锁功能正常
✅ 进度跟踪实时更新

## 已知限制

- 下载速度取决于网络和源服务器
- 部分歌曲可能无法解锁（源不可用）
- 并发数过高可能导致 IP 限制

## 故障排查

### 下载失败
1. 检查网络连接
2. 查看服务器日志：开发模式看 `npm start`/`npm run start:api` 的终端输出；Docker 用 `docker compose logs -f meowsync`
3. 确认歌曲 ID 有效
4. 尝试降低并发数

### 前端无法访问
1. 确认后端服务器运行端口：开发默认 3101，Docker 容器内 3002（宿主映射默认 3101）
2. 检查 CORS 配置
3. 清除浏览器缓存

### 数据库错误
1. 检查 `data/` 目录权限
2. 删除 `data/meowsync.sqlite` 重新初始化
3. 查看错误日志

## 技术栈

- **后端**：Node.js + Hono (@hono/node-server) + SQLite (better-sqlite3)
- **前端**：Vue 3 + Vite + Tailwind CSS
- **音乐 API**：NeteaseCloudMusicApi
- **VIP 解锁**：@unblockneteasemusic/server
- **下载**：axios (流式下载)

## 开发者信息

- 数据库客户端：`src/server/db/client.js`
- 数据访问层：`src/server/repositories/`
- 业务逻辑层：`src/server/services/`
- API 路由：`src/server/routes/downloads.js`
- 前端组件：`src/components/AdminPanel.vue`
