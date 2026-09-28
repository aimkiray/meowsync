<template>
  <div class="remote-controller">
    <div v-if="!connected || hostDisconnected" class="rc-connecting">
      <div v-if="!gaveUp" class="rc-spinner"></div>
      <p>{{ gaveUp ? '无法连接主机' : (hostDisconnected ? '主机已断开，等待重连...' : '正在连接主机...') }}</p>
      <button v-if="gaveUp" class="rc-btn rc-retry" @click="retry">重新连接</button>
    </div>

    <template v-else>
      <!-- 封面 + 歌曲信息 -->
      <div class="rc-cover-wrap">
        <img
          v-if="state.currentSong?.al?.picUrl || state.currentSong?.album?.picUrl"
          :src="httpsCover(state.currentSong?.al?.picUrl || state.currentSong?.album?.picUrl)"
          :alt="state.currentSong?.name || '专辑封面'"
          class="rc-cover"
          :class="{ spinning: state.isPlaying }"
        />
        <div v-else class="rc-cover rc-cover-placeholder">🎵</div>
      </div>

      <div class="rc-song-info">
        <div class="rc-song-name">{{ state.currentSong?.name || '未在播放' }}</div>
        <div class="rc-artist">{{ artistName }}</div>
      </div>

      <!-- 进度条 -->
      <div class="rc-progress-wrap">
        <span class="rc-time">{{ formatTime(state.currentTime) }}</span>
        <input
          type="range"
          class="rc-slider"
          aria-label="播放进度"
          :value="state.currentTime"
          :max="state.duration || 1"
          step="1"
          @input="onSeekInput"
          @change="onSeek"
          @pointerdown="onSeekPointerDown"
          @pointerup="onDragPointerEnd"
          @pointercancel="onDragPointerEnd"
          @lostpointercapture="onDragPointerEnd"
        />
        <span class="rc-time">{{ formatTime(state.duration) }}</span>
      </div>

      <!-- 控制按钮 -->
      <div class="rc-controls">
        <button class="rc-btn" @click="send('prev')" title="上一首" aria-label="上一首">⏮</button>
        <button class="rc-btn rc-btn-main" @click="send(state.isPlaying ? 'pause' : 'play')" :title="state.isPlaying ? '暂停' : '播放'" :aria-label="state.isPlaying ? '暂停' : '播放'">
          {{ state.isPlaying ? '⏸' : '▶' }}
        </button>
        <button class="rc-btn" @click="send('next')" title="下一首" aria-label="下一首">⏭</button>
      </div>

      <!-- 音量 -->
      <div class="rc-volume-wrap">
        <span class="rc-vol-icon">🔈</span>
        <input
          type="range"
          class="rc-slider"
          aria-label="音量"
          :value="state.volume"
          min="0"
          max="100"
          step="1"
          @input="onVolumeInput"
          @change="onVolume"
          @pointerdown="onVolumePointerDown"
          @pointerup="onDragPointerEnd"
          @pointercancel="onDragPointerEnd"
          @lostpointercapture="onDragPointerEnd"
        />
        <span class="rc-vol-icon">🔊</span>
      </div>

      <!-- 待播队列：host 广播的播放快照，点选跳转 -->
      <div v-if="queueItems.length" class="rc-queue">
        <div class="rc-queue-title">待播队列</div>
        <div class="rc-queue-list">
          <button
            v-for="(s, i) in queueItems"
            :key="`${s.id}-${i}`"
            class="rc-queue-row"
            :class="{ 'rc-queue-row--current': i === state.queueIndex }"
            @click="send('play_song', s.id)"
          >
            <span class="rc-queue-idx">{{ i === state.queueIndex ? '▶' : i + 1 }}</span>
            <span class="rc-queue-name">{{ s.name }}</span>
            <span class="rc-queue-artist">{{ queueArtist(s) }}</span>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { formatTime } from '../lib/format'
import { httpsCover } from '../lib/url'

const props = defineProps({
  // 完整 WS URL，须已包含 ?role=controller（由 App.vue 构建）
  wsUrl: { type: String, required: true },
  // token 经 Sec-WebSocket-Protocol 携带（不落 URL 日志）；空/undefined 即无凭据
  wsProtocols: { type: Array, default: undefined }
})

const connected = ref(false)
const hostDisconnected = ref(false)
// 重连超限后给出可读的终态提示，而不是永远停在“正在连接”
const gaveUp = ref(false)
// 拖动滑块期间屏蔽本地推进/远端推送回写，防止 thumb 被拽回旧值
const seekDragging = ref(false)
const volumeDragging = ref(false)
// 记录发起拖动的 pointerId：window 级 pointerup/pointercancel 只在同一指针时
// 释放标志位，避免双指分别拖进度/音量两个滑块时互相误清
let seekPointerId = null
let volumePointerId = null
const state = ref({
  isPlaying: false,
  currentSong: null,
  currentTime: 0,
  duration: 0,
  volume: 80,
  queue: [],
  queueIndex: -1
})

// 队列渲染：白名单已保证数组形状，这里只需对元素个体防御
const queueItems = computed(() =>
  Array.isArray(state.value.queue) ? state.value.queue.filter(s => s && s.id != null) : []
)

const queueArtist = (s) => {
  const list = s?.ar || s?.artists
  if (!Array.isArray(list)) return ''
  return list.map(a => a?.name ?? '').filter(Boolean).join(' / ')
}

let ws = null
let reconnectTimer = null
let progressTickTimer = null
let destroyed = false
let retries = 0

function connect() {
  if (destroyed) return
  ws = new WebSocket(props.wsUrl, props.wsProtocols)

  ws.onopen = () => {
    retries = 0
    connected.value = true
    hostDisconnected.value = false
    gaveUp.value = false // 防御性复位：未来若出现重连路径可自动恢复
  }

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'state_update') {
        hostDisconnected.value = false
        const payload = msg.payload || {}
        // 拖动中不回写对应字段，避免 thumb 被远端旧值拽回
        if (seekDragging.value) delete payload.currentTime
        if (volumeDragging.value) delete payload.volume
        // sanitize 后 queue 可能整个键缺席（非数组被丢）——不补默认值会留着旧队列
        if (!Array.isArray(payload.queue)) payload.queue = []
        state.value = { ...state.value, ...payload }
      } else if (msg.type === 'host_disconnected' || msg.type === 'host_absent') {
        // 断开与"从未有 host"共用空态 UI
        hostDisconnected.value = true
        // v-if 会摘除滑块元素，悬挂的拖动标志（pointerup 可能不再派发）必须复位
        resetDragState()
      } else if (msg.type === 'host_joined') {
        // host 就位（含顶替旧 host 后新主接管）：等它的 state_update，先摘掉空态遮罩
        hostDisconnected.value = false
      }
    } catch {}
  }

  ws.onclose = () => {
    connected.value = false
    ws = null
    resetDragState() // 同上：滑块随 connected=false 被摘除，不能留下悬挂标志
    if (destroyed) return
    // 重连上限：握手被 401/403 拒绝时避免无限重试
    if (++retries > 5) {
      console.warn('[remote] controller 重连次数超限，停止重连')
      gaveUp.value = true
      return
    }
    reconnectTimer = setTimeout(connect, 3000)
  }

  // 用闭包局部 sock 而非共享 ws——与未来多 socket 场景对齐 App.vue 的纪律
  const sock = ws
  ws.onerror = () => {
    sock.close()
  }
}

// 重连超限后的手动重试：复位计数重新走 connect
function retry() {
  retries = 0
  gaveUp.value = false
  connect()
}

function send(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }))
  }
}

function onSeekPointerDown(e) {
  seekPointerId = e.pointerId
  seekDragging.value = true
}

function onVolumePointerDown(e) {
  volumePointerId = e.pointerId
  volumeDragging.value = true
}

// pointerup/pointercancel/lostpointercapture 共用释放逻辑（按 pointerId 匹配）。
// 同时挂到 window 兜底：鼠标没有隐式捕获，在滑块外松开时 pointerup 不会派发到
// 滑块元素上；此时若值恰好未变，@change 也不会触发，元素级监听不足以复位标志
function onDragPointerEnd(e) {
  if (e.pointerId === seekPointerId) {
    seekPointerId = null
    seekDragging.value = false
  }
  if (e.pointerId === volumePointerId) {
    volumePointerId = null
    volumeDragging.value = false
  }
}

function resetDragState() {
  seekPointerId = null
  volumePointerId = null
  seekDragging.value = false
  volumeDragging.value = false
}

// 拖动中仅本地预览（不发包），松手 @change 时一次性提交并发送
function onSeekInput(e) {
  state.value.currentTime = Number(e.target.value)
}

function onSeek(e) {
  seekPointerId = null
  seekDragging.value = false
  const t = Number(e.target.value)
  // 本地立即提交：host 每 2s 才推送一次，不回写会闪回旧进度
  state.value.currentTime = t
  send('seek', t)
}

function onVolumeInput(e) {
  state.value.volume = Number(e.target.value)
}

function onVolume(e) {
  volumePointerId = null
  volumeDragging.value = false
  const v = Number(e.target.value)
  state.value.volume = v
  send('volume', v)
}

const artistName = computed(() => {
  const song = state.value.currentSong
  if (!song) return ''
  // host 上游不可信：服务端虽已白名单序列化，渲染端仍守卫类型
  const list = song.ar || song.artists
  if (!Array.isArray(list)) return ''
  return list.map(a => a?.name ?? '').filter(Boolean).join(' / ')
})

onMounted(() => {
  connect()
  // host 每 2s 才推送一次进度；期间本地按秒推进让进度条平滑，下一次推送会校准漂移
  progressTickTimer = setInterval(() => {
    const s = state.value
    if (s.isPlaying && !seekDragging.value && s.duration > 0 && s.currentTime < s.duration) {
      s.currentTime = Math.min(s.currentTime + 1, s.duration)
    }
  }, 1000)
  window.addEventListener('pointerup', onDragPointerEnd)
  window.addEventListener('pointercancel', onDragPointerEnd)
  // 指针在窗口外松开时 pointerup/cancel 都不派发——blur/隐藏兜底清拖动标志
  window.addEventListener('blur', resetDragState)
  document.addEventListener('visibilitychange', resetDragState)
})
onUnmounted(() => {
  destroyed = true
  clearTimeout(reconnectTimer)
  clearInterval(progressTickTimer)
  window.removeEventListener('pointerup', onDragPointerEnd)
  window.removeEventListener('pointercancel', onDragPointerEnd)
  window.removeEventListener('blur', resetDragState)
  document.removeEventListener('visibilitychange', resetDragState)
  if (ws) {
    ws.onclose = null // 阻止卸载后异步 close 触发重连
    ws.close()
    ws = null
  }
})
</script>

<style scoped>
.remote-controller {
  --rc-bg: #0f0f0f;
  --rc-surface: #222;
  --rc-line: #333;
  --rc-text: #fff;
  --rc-text-2: #ddd;
  --rc-dim: #888;
  --rc-dim-2: #aaa;
  --rc-accent: #e74c3c;
  --rc-accent-dark: #c0392b;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 24px 20px;
  background: var(--rc-bg);
  color: var(--rc-text);
  gap: 20px;
  box-sizing: border-box;
}

.rc-connecting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  color: var(--rc-dim);
}

.rc-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--rc-line);
  border-top-color: var(--rc-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.rc-cover-wrap {
  width: 220px;
  height: 220px;
}

.rc-cover {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}

.rc-cover.spinning {
  animation: rotate 8s linear infinite;
}

@keyframes rotate { to { transform: rotate(360deg); } }

.rc-cover-placeholder {
  background: var(--rc-surface);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 64px;
}

.rc-song-info {
  text-align: center;
}

.rc-song-name {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 6px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-artist {
  font-size: 14px;
  color: var(--rc-dim);
}

.rc-progress-wrap,
.rc-volume-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 320px;
}

.rc-time {
  font-size: 12px;
  color: var(--rc-dim);
  min-width: 36px;
  text-align: center;
}

.rc-vol-icon {
  font-size: 16px;
}

.rc-slider {
  flex: 1;
  -webkit-appearance: none;
  height: 4px;
  border-radius: 2px;
  background: var(--rc-line);
  outline: none;
  cursor: pointer;
}

.rc-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--rc-accent);
  cursor: pointer;
}

.rc-controls {
  display: flex;
  align-items: center;
  gap: 24px;
}

.rc-btn {
  background: none;
  border: none;
  color: var(--rc-text);
  font-size: 28px;
  cursor: pointer;
  padding: 8px;
  border-radius: 50%;
  transition: background 0.15s;
  line-height: 1;
}

.rc-btn:active {
  background: rgba(255,255,255,0.1);
}

.rc-retry {
  font-size: 15px;
  padding: 10px 24px;
  background: var(--rc-accent);
  border-radius: 20px;
}

.rc-btn-main {
  font-size: 40px;
  background: var(--rc-accent);
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.rc-btn-main:active {
  background: var(--rc-accent-dark);
}

/* 待播队列 */
.rc-queue {
  width: 100%;
  max-width: 360px;
}

.rc-queue-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--rc-dim-2);
  margin-bottom: 8px;
}

.rc-queue-list {
  max-height: 240px;
  overflow-y: auto;
}

.rc-queue-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 8px;
  background: none;
  border: none;
  border-left: 3px solid transparent;
  color: var(--rc-text-2);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.rc-queue-row:active {
  background: rgba(255, 255, 255, 0.08);
}

.rc-queue-row--current {
  border-left-color: var(--rc-accent);
  color: var(--rc-text);
}

.rc-queue-idx {
  width: 18px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--rc-dim);
  text-align: center;
}

.rc-queue-row--current .rc-queue-idx {
  color: var(--rc-accent);
}

.rc-queue-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-queue-artist {
  flex-shrink: 0;
  max-width: 40%;
  font-size: 11px;
  color: var(--rc-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
