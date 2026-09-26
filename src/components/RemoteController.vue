<template>
  <div class="remote-controller">
    <div v-if="!connected || hostDisconnected" class="rc-connecting">
      <div v-if="!gaveUp" class="rc-spinner"></div>
      <p>{{ gaveUp ? '无法连接主机，请检查服务后刷新重试' : (hostDisconnected ? '主机已断开，等待重连...' : '正在连接主机...') }}</p>
    </div>

    <template v-else>
      <!-- 封面 + 歌曲信息 -->
      <div class="rc-cover-wrap">
        <img
          v-if="state.currentSong?.al?.picUrl || state.currentSong?.album?.picUrl"
          :src="state.currentSong?.al?.picUrl || state.currentSong?.album?.picUrl"
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
          :value="state.currentTime"
          :max="state.duration || 1"
          step="1"
          @input="onSeekInput"
          @change="onSeek"
          @pointerdown="seekDragging = true"
          @pointerup="seekDragging = false"
          @pointercancel="seekDragging = false"
        />
        <span class="rc-time">{{ formatTime(state.duration) }}</span>
      </div>

      <!-- 控制按钮 -->
      <div class="rc-controls">
        <button class="rc-btn" @click="send('prev')" title="上一首">⏮</button>
        <button class="rc-btn rc-btn-main" @click="send(state.isPlaying ? 'pause' : 'play')" :title="state.isPlaying ? '暂停' : '播放'">
          {{ state.isPlaying ? '⏸' : '▶' }}
        </button>
        <button class="rc-btn" @click="send('next')" title="下一首">⏭</button>
      </div>

      <!-- 音量 -->
      <div class="rc-volume-wrap">
        <span class="rc-vol-icon">🔈</span>
        <input
          type="range"
          class="rc-slider"
          :value="state.volume"
          min="0"
          max="100"
          step="1"
          @input="onVolumeInput"
          @change="onVolume"
          @pointerdown="volumeDragging = true"
          @pointerup="volumeDragging = false"
          @pointercancel="volumeDragging = false"
        />
        <span class="rc-vol-icon">🔊</span>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { formatTime } from '../lib/format'

const props = defineProps({
  // 完整 WS URL，须已包含 ?role=controller 及可选 &token=（由 App.vue 构建）
  wsUrl: { type: String, required: true }
})

const connected = ref(false)
const hostDisconnected = ref(false)
// 重连超限后给出可读的终态提示，而不是永远停在“正在连接”
const gaveUp = ref(false)
// 拖动滑块期间屏蔽本地推进/远端推送回写，防止 thumb 被拽回旧值
const seekDragging = ref(false)
const volumeDragging = ref(false)
const state = ref({
  isPlaying: false,
  currentSong: null,
  currentTime: 0,
  duration: 0,
  volume: 80
})

let ws = null
let reconnectTimer = null
let progressTickTimer = null
let destroyed = false
let retries = 0

function connect() {
  if (destroyed) return
  ws = new WebSocket(props.wsUrl)

  ws.onopen = () => {
    retries = 0
    connected.value = true
    hostDisconnected.value = false
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
        state.value = { ...state.value, ...payload }
      } else if (msg.type === 'host_disconnected') {
        hostDisconnected.value = true
      }
    } catch {}
  }

  ws.onclose = () => {
    connected.value = false
    ws = null
    if (destroyed) return
    // 重连上限：握手被 401/403 拒绝时避免无限重试
    if (++retries > 5) {
      console.warn('[remote] controller 重连次数超限，停止重连')
      gaveUp.value = true
      return
    }
    reconnectTimer = setTimeout(connect, 3000)
  }

  ws.onerror = () => {
    ws?.close()
  }
}

function send(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }))
  }
}

// 拖动中仅本地预览（不发包），松手 @change 时一次性提交并发送
function onSeekInput(e) {
  state.value.currentTime = Number(e.target.value)
}

function onSeek(e) {
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
  volumeDragging.value = false
  const v = Number(e.target.value)
  state.value.volume = v
  send('volume', v)
}

const artistName = computed(() => {
  const song = state.value.currentSong
  if (!song) return ''
  return (song.ar || song.artists || []).map(a => a.name).join(' / ')
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
})
onUnmounted(() => {
  destroyed = true
  clearTimeout(reconnectTimer)
  clearInterval(progressTickTimer)
  if (ws) {
    ws.onclose = null // 阻止卸载后异步 close 触发重连
    ws.close()
    ws = null
  }
})
</script>

<style scoped>
.remote-controller {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100dvh;
  padding: 24px 20px;
  background: #0f0f0f;
  color: #fff;
  gap: 20px;
  box-sizing: border-box;
}

.rc-connecting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  color: #888;
}

.rc-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #333;
  border-top-color: #e74c3c;
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
  background: #222;
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
  color: #888;
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
  color: #888;
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
  background: #333;
  outline: none;
  cursor: pointer;
}

.rc-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #e74c3c;
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
  color: #fff;
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

.rc-btn-main {
  font-size: 40px;
  background: #e74c3c;
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.rc-btn-main:active {
  background: #c0392b;
}
</style>
