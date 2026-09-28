<template>
  <!-- YTM /watch 播放页：左栏 封面+信息+操作+走带+进度，右栏 待播/歌词/相关 tab -->
  <div class="watch-view">
    <header class="watch-header">
      <button class="pixel-button watch-header-btn" @click="$emit('back')" title="返回上一页">← 返回</button>
      <button class="pixel-button watch-header-btn" @click="$emit('open-fullscreen')" title="全屏歌词模式">⛶ 沉浸</button>
    </header>

    <div class="watch-layout">
      <!-- ══ 左栏 ══ -->
      <div class="watch-main">
        <div class="watch-cover-wrap">
          <img
            v-if="coverUrl"
            :src="httpsCover(coverUrl)"
            :alt="currentSong?.name"
            class="watch-cover"
            :class="{ 'playing-animation': isPlaying }"
          />
          <div v-else class="watch-cover watch-cover--fallback">♪</div>
        </div>

        <h2 class="watch-title">{{ currentSong?.name || '未播放' }}</h2>
        <p class="watch-meta">
          {{ artistText }}<template v-if="albumText"> · {{ albumText }}</template>
          <template v-if="duration"> · {{ formatTime(duration) }}</template>
        </p>

        <div class="watch-actions">
          <button class="pixel-button watch-action" @click="shareSong" :disabled="!currentSong">🔗 分享歌曲</button>
        </div>

        <!-- 走带：YTM 顺序 随机/上一首/播放/下一首/循环 + 时间 + 音量 -->
        <div class="watch-transport">
          <button
            class="watch-transport-btn"
            :class="{ 'watch-transport-btn--active': shuffleOn }"
            @click="$emit('toggle-shuffle')"
            :title="shuffleOn ? '关闭随机播放' : '随机播放'"
          >🔀</button>
          <button class="watch-transport-btn" @click="$emit('previous-song')" title="上一首">◀◀</button>
          <button
            class="watch-transport-btn watch-transport-btn--primary"
            @click="$emit('toggle-play')"
            :disabled="songSwitching"
            :class="{ 'opacity-50 cursor-not-allowed': songSwitching }"
          >{{ songSwitching ? '⏳' : (isPlaying ? '⏸' : '▶') }}</button>
          <button class="watch-transport-btn" @click="$emit('next-song')" title="下一首">▶▶</button>
          <button
            class="watch-transport-btn"
            :class="{ 'watch-transport-btn--active': playMode !== 'list' }"
            @click="$emit('toggle-repeat')"
            :title="`循环：${playModeText}`"
          >{{ playMode === 'single' ? '↻1' : (playMode === 'loop' ? '↻' : '→') }}</button>

          <span class="watch-time">{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>

          <div class="watch-volume">
            <button
              class="watch-transport-btn"
              @click="$emit('toggle-mute')"
              :title="volume === 0 ? '取消静音' : '静音'"
            >{{ volume === 0 ? '🔇' : '🔊' }}</button>
            <input
              :value="Number(volume)"
              type="range"
              min="0"
              max="100"
              step="1"
              class="jirai-slider watch-volume-slider"
              @input="$emit('update-volume', Number($event.target.value))"
            />
          </div>
        </div>

        <div
          ref="progressBar"
          class="player-progress-bar watch-progress"
          :class="{ 'player-progress-bar--dragging': seeking }"
          @pointerdown="onSeekStart"
        >
          <div class="player-progress-fill" :style="{ width: progressPercentage + '%' }"></div>
          <div class="player-progress-thumb" :style="{ left: progressPercentage + '%' }"></div>
        </div>
      </div>

      <!-- ══ 右栏：待播 / 歌词 / 相关 ══ -->
      <aside class="watch-side">
        <div class="panel-tabs watch-tabs" role="tablist">
          <button
            class="panel-tab"
            :class="{ 'panel-tab--active': tab === 'queue' }"
            role="tab"
            aria-controls="watch-panel-queue"
            :aria-selected="tab === 'queue'"
            @click="setTab('queue')"
          >待播</button>
          <button
            class="panel-tab"
            :class="{ 'panel-tab--active': tab === 'lyrics' }"
            role="tab"
            aria-controls="watch-panel-lyrics"
            :aria-selected="tab === 'lyrics'"
            @click="setTab('lyrics')"
          >歌词</button>
          <button
            class="panel-tab"
            :class="{ 'panel-tab--active': tab === 'related' }"
            role="tab"
            aria-controls="watch-panel-related"
            :aria-selected="tab === 'related'"
            @click="setTab('related')"
          >相关</button>
        </div>

        <!-- 待播队列 -->
        <div
          id="watch-panel-queue"
          role="tabpanel"
          v-show="tab === 'queue'"
          class="watch-side-body"
          ref="queueContainer"
        >
          <p class="queue-source">正在播放：{{ queueTitle }}</p>
          <div v-if="queue.length === 0" class="watch-empty">队列为空喵~</div>
          <template v-else>
            <div
              v-for="(song, index) in queue"
              :key="`${song.id}-${index}`"
              class="queue-row"
              :class="{ 'queue-row--current': String(song.id) === String(currentSong?.id), 'queue-row--dragging': dragIndex === index }"
              @click="jumpTo(index)"
              @keydown.enter="jumpTo(index)"
              tabindex="0"
              role="button"
            >
              <span
                class="watch-grip"
                title="拖拽排序"
                @pointerdown.stop="startDrag(index, $event)"
                @click.stop
              >⠿</span>
              <span class="queue-row-index">
                <template v-if="String(song.id) === String(currentSong?.id)">▶</template>
                <template v-else>{{ index + 1 }}</template>
              </span>
              <img
                v-if="song.al?.picUrl || song.album?.picUrl"
                :src="httpsCover(song.al?.picUrl || song.album?.picUrl)"
                :alt="song.name"
                class="watch-queue-thumb"
              />
              <div v-else class="watch-queue-thumb watch-queue-thumb--fallback">♪</div>
              <div class="queue-row-info">
                <p class="queue-row-title">{{ song.name }}</p>
                <p class="queue-row-artist">{{ songArtist(song) }}</p>
              </div>
              <span class="queue-row-duration">{{ formatDuration(song) }}</span>
              <button
                v-if="String(song.id) !== String(currentSong?.id)"
                class="queue-row-remove"
                title="从队列移除"
                aria-label="从队列移除"
                @click.stop="$emit('queue-remove', index)"
              >✕</button>
            </div>
          </template>

          <div class="watch-queue-foot" v-if="queue.length">
            <button class="watch-foot-btn" @click="$emit('save-queue')" title="把当前队列存成新歌单">💾 存为歌单</button>
            <button
              class="watch-foot-btn"
              :disabled="queue.length < 2"
              @click="$emit('clear-queue')"
              title="清空队列（保留当前播放）"
            >🧹 清空</button>
          </div>

          <!-- YTM UP NEXT 底部：自动播放开关 -->
          <label class="watch-autoplay">
            <input
              type="checkbox"
              :checked="autoplay"
              @change="$emit('update:autoplay', $event.target.checked)"
            />
            <span>自动播放（队列播完接续相关歌曲）</span>
          </label>
        </div>

        <!-- 歌词 -->
        <div
          id="watch-panel-lyrics"
          role="tabpanel"
          v-show="tab === 'lyrics'"
          class="watch-side-body"
          ref="lyricContainer"
        >
          <div v-if="!currentSong" class="watch-empty">选择一首歌开始播放喵~</div>
          <template v-else>
            <div v-if="durationWarning" class="watch-banner watch-banner--warn">⚠️ {{ durationWarning }}</div>
            <div v-if="playbackError" class="watch-banner watch-banner--error">❌ {{ playbackError }}</div>

            <div v-if="songSwitching" class="watch-empty">
              <div class="pixel-loading mx-auto mb-4"></div>
              <p>正在切换歌曲喵...</p>
            </div>
            <div v-else-if="loadingLyrics" class="watch-empty">
              <div class="pixel-loading mx-auto mb-4"></div>
              <p>加载歌词中喵...</p>
            </div>
            <div v-else-if="!lyrics.length" class="watch-empty">暂无歌词</div>
            <div v-else class="watch-lyric-list">
              <div
                v-for="(lyric, index) in lyrics"
                :key="index"
                :data-lyric-index="index"
                class="watch-lyric-line"
                :class="{ 'watch-lyric-line--current': index === currentLyricIndex }"
              >
                <p>{{ lyric.text }}</p>
                <p v-if="lyric.translation" class="watch-lyric-translation">{{ lyric.translation }}</p>
              </div>
            </div>
          </template>
        </div>

        <!-- 相关（按当前艺人拉取，点击即播） -->
        <div
          id="watch-panel-related"
          role="tabpanel"
          v-show="tab === 'related'"
          class="watch-side-body"
        >
          <div v-if="relatedLoading" class="watch-empty">
            <div class="pixel-loading mx-auto mb-4"></div>
            <p>加载相关歌曲喵...</p>
          </div>
          <div v-else-if="!relatedSongs.length" class="watch-empty">暂无相关推荐</div>
          <div
            v-else
            v-for="song in relatedSongs"
            :key="song.id"
            class="queue-row watch-related-row"
            @click="$emit('play-song', song)"
            @keydown.enter="$emit('play-song', song)"
            tabindex="0"
            role="button"
            :title="`播放 ${song.name}`"
          >
            <img
              v-if="song.al?.picUrl || song.album?.picUrl"
              :src="httpsCover(song.al?.picUrl || song.album?.picUrl)"
              :alt="song.name"
              class="watch-queue-thumb"
            />
            <div v-else class="watch-queue-thumb watch-queue-thumb--fallback">♪</div>
            <div class="queue-row-info">
              <p class="queue-row-title">{{ song.name }}</p>
              <p class="queue-row-artist">{{ songArtist(song) }}</p>
            </div>
            <span class="queue-row-duration">{{ formatDuration(song) }}</span>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script>
import { ref, computed, watch, nextTick } from 'vue'
import { musicApi } from '../api/music'
import { shareOrCopy } from '../lib/share'
import { formatTime } from '../lib/format'
import { httpsCover } from '../lib/url'

export default {
  name: 'WatchView',
  props: {
    currentSong: { type: Object, default: null },
    isPlaying: { type: Boolean, default: false },
    currentTime: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    volume: { type: Number, default: 80 },
    songSwitching: { type: Boolean, default: false },
    queue: { type: Array, default: () => [] },
    queueTitle: { type: String, default: '' },
    lyrics: { type: Array, default: () => [] },
    currentLyricIndex: { type: Number, default: -1 },
    loadingLyrics: { type: Boolean, default: false },
    playbackError: { type: String, default: '' },
    durationWarning: { type: String, default: '' },
    tab: { type: String, default: 'queue' },
    playMode: { type: String, default: 'list' },
    playModeText: { type: String, default: '顺序' },
    shuffleOn: { type: Boolean, default: false },
    autoplay: { type: Boolean, default: false }
  },
  emits: [
    'back', 'open-fullscreen',
    'toggle-play', 'previous-song', 'next-song', 'seek-to',
    'update-volume', 'toggle-mute', 'toggle-shuffle', 'toggle-repeat',
    'update:tab', 'update:autoplay',
    'queue-jump', 'queue-remove', 'queue-move', 'save-queue', 'clear-queue',
    'play-song'
  ],
  setup(props, { emit }) {
    const progressBar = ref(null)
    const seeking = ref(false)
    const queueContainer = ref(null)
    const lyricContainer = ref(null)
    const dragIndex = ref(-1)

    const coverUrl = computed(() =>
      props.currentSong?.al?.picUrl || props.currentSong?.album?.picUrl || ''
    )
    const artistText = computed(() =>
      (props.currentSong?.ar || props.currentSong?.artists || [])
        .map(a => a?.name).filter(Boolean).join(', ') || '未知艺术家'
    )
    const albumText = computed(() =>
      props.currentSong?.al?.name || props.currentSong?.album?.name || ''
    )

    const progressPercentage = computed(() =>
      props.duration > 0
        ? Math.max(0, Math.min(100, (props.currentTime / props.duration) * 100))
        : 0
    )

    const songArtist = (song) =>
      (song.ar || song.artists || []).map(a => a?.name).filter(Boolean).join('/') || '未知艺人'

    const formatDuration = (song) => formatTime((song.dt || song.duration || 0) / 1000)

    const setTab = (t) => emit('update:tab', t)
    const jumpTo = (index) => emit('queue-jump', index)

    // ── 进度条拖拽（与 BottomPlayer 同款的加固实现）──
    const ratioFromEvent = (event) => {
      const rect = progressBar.value?.getBoundingClientRect()
      if (!rect || rect.width === 0) return null
      return (event.clientX - rect.left) / rect.width
    }

    const onSeekStart = (event) => {
      if (event.button !== undefined && event.button !== 0) return
      const bar = progressBar.value
      if (!bar) return
      const pid = event.pointerId
      seeking.value = true
      const ratio = ratioFromEvent(event)
      if (ratio !== null) emit('seek-to', ratio)
      bar.setPointerCapture?.(pid)

      const onMove = (e) => {
        if (e.pointerId !== pid) return
        const r = ratioFromEvent(e)
        if (r !== null) emit('seek-to', r)
      }
      const onEnd = (e) => {
        if (e?.pointerId !== undefined && e.pointerId !== pid) return
        seeking.value = false
        bar.removeEventListener('pointermove', onMove)
        bar.removeEventListener('pointerup', onEnd)
        bar.removeEventListener('pointercancel', onEnd)
        bar.removeEventListener('lostpointercapture', onEnd)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
        window.removeEventListener('blur', onEnd)
        document.removeEventListener('visibilitychange', onVisibility)
      }
      const onVisibility = () => { if (document.hidden) onEnd() }
      bar.addEventListener('pointermove', onMove)
      bar.addEventListener('pointerup', onEnd)
      bar.addEventListener('pointercancel', onEnd)
      bar.addEventListener('lostpointercapture', onEnd)
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
      window.addEventListener('blur', onEnd)
      document.addEventListener('visibilitychange', onVisibility)
    }

    // ── 队列拖拽排序（YTM UP NEXT：握把按下后拖动实时换位）──
    const startDrag = (index, event) => {
      event.preventDefault()
      const container = queueContainer.value
      if (!container) return
      const pid = event.pointerId
      dragIndex.value = index

      const onMove = (e) => {
        if (e.pointerId !== pid || dragIndex.value === -1) return
        const rows = container.querySelectorAll('.queue-row')
        let target = rows.length - 1
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i].getBoundingClientRect()
          if (e.clientY < r.top + r.height / 2) { target = i; break }
        }
        if (target !== dragIndex.value) {
          emit('queue-move', { from: dragIndex.value, to: target })
          dragIndex.value = target
        }
      }
      const onEnd = () => {
        dragIndex.value = -1
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
        window.removeEventListener('blur', onEnd)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
      window.addEventListener('blur', onEnd)
    }

    // ── 相关歌曲：按当前曲艺人拉取，切歌后重载（懒加载+序号防乱序）──
    const relatedSongs = ref([])
    const relatedLoading = ref(false)
    let relatedFor = null // 已按哪首歌加载过
    let relatedSeq = 0

    const loadRelated = async () => {
      const artist = (props.currentSong?.ar || props.currentSong?.artists || [])[0]?.name
      const songId = props.currentSong?.id
      if (!artist || songId == null) { relatedSongs.value = []; return }
      relatedFor = songId
      const seq = ++relatedSeq
      relatedLoading.value = true
      try {
        const list = await musicApi.searchSongs(artist, 15)
        if (seq !== relatedSeq) return
        relatedSongs.value = (list || [])
          .filter(s => s?.id != null && String(s.id) !== String(songId))
      } catch {
        if (seq === relatedSeq) relatedSongs.value = []
      } finally {
        if (seq === relatedSeq) relatedLoading.value = false
      }
    }

    watch(() => props.tab, (t) => {
      if (t === 'related' && relatedFor !== props.currentSong?.id) loadRelated()
      // 切到队列/歌词时把当前行滚进视野（与原抽屉一致）
      if (t === 'queue' || t === 'lyrics') nextTick(centerCurrentRow)
    })
    watch(() => props.currentSong?.id, () => {
      if (props.tab === 'related') loadRelated()
    })

    // ── 歌词/队列定位滚动 ──
    const centerCurrentRow = () => {
      if (props.tab === 'lyrics') {
        const el = lyricContainer.value?.querySelector(`[data-lyric-index="${props.currentLyricIndex}"]`)
        el?.scrollIntoView({ block: 'center' })
      } else {
        const el = queueContainer.value?.querySelector('.queue-row--current')
        el?.scrollIntoView({ block: 'center' })
      }
    }

    watch(() => props.currentLyricIndex, async (i) => {
      if (props.tab !== 'lyrics' || i < 0) return
      await nextTick()
      const container = lyricContainer.value
      const el = container?.querySelector(`[data-lyric-index="${i}"]`)
      if (!container || !el) return
      const containerRect = container.getBoundingClientRect()
      const lyricRect = el.getBoundingClientRect()
      const scrollOffset = (lyricRect.top - containerRect.top + lyricRect.height / 2) - containerRect.height / 2
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      container.scrollTo({ top: container.scrollTop + scrollOffset, behavior: smooth ? 'smooth' : 'auto' })
    })

    const shareSong = async () => {
      const song = props.currentSong
      if (!song) return
      const shareUrl = `${window.location.origin}/?song=${song.id}&view=watch`
      const result = await shareOrCopy({
        title: `🎵 ${song.name} - ${artistText.value}`,
        text: `来听听这首歌：${song.name} - ${artistText.value}`,
        url: shareUrl
      })
      if (result === 'copied') alert('分享链接已复制到剪贴板！')
      else if (result === 'failed') alert('分享失败，请手动复制链接')
    }

    return {
      progressBar,
      seeking,
      queueContainer,
      lyricContainer,
      dragIndex,
      coverUrl,
      artistText,
      albumText,
      progressPercentage,
      songArtist,
      formatDuration,
      formatTime,
      httpsCover,
      setTab,
      jumpTo,
      onSeekStart,
      startDrag,
      relatedSongs,
      relatedLoading,
      shareSong
    }
  }
}
</script>

<style scoped>
/* 主区页内视图（非覆盖层）——不占 fixed 位，随 .main-view 滚动容器排版 */
.watch-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.watch-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  flex-shrink: 0;
}

.watch-header-btn {
  font-size: 12px;
  padding: 4px 12px;
}

.watch-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) min(400px, 38vw);
  gap: 24px;
  padding: 0 20px 20px;
}

/* ── 左栏 ── */
.watch-main {
  min-width: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 8px 24px;
  text-align: center;
}

.watch-cover {
  width: min(46vh, 420px, 100%);
  aspect-ratio: 1;
  object-fit: cover;
  border: 4px solid rgba(255, 255, 255, 0.9);
  image-rendering: pixelated;
  box-shadow: 0 12px 32px rgba(80, 40, 60, 0.25);
}

.watch-cover--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 64px;
  color: var(--pixel-text-dim);
  background: var(--pixel-card-bg);
}

.watch-title {
  margin-top: 20px;
  font-size: clamp(22px, 2.6vw, 36px);
  font-weight: bold;
  line-height: 1.15;
  color: var(--pixel-text);
  max-width: 34ch;
  overflow-wrap: anywhere;
}

.watch-meta {
  margin-top: 8px;
  font-size: 13px;
  color: var(--pixel-text-dim);
}

.watch-actions {
  margin-top: 14px;
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
}

.watch-action {
  font-size: 12px;
  padding: 5px 14px;
}

.watch-transport {
  margin-top: auto;
  padding-top: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}

.watch-transport-btn {
  width: 42px;
  height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  color: var(--pixel-text);
  background: var(--pixel-card-bg);
  border: 2px solid var(--pixel-border, rgba(240, 179, 192, 0.6));
  cursor: pointer;
  transition: background 0.12s, transform 0.1s;
}

.watch-transport-btn:hover {
  background: rgba(236, 72, 153, 0.15);
}

.watch-transport-btn:active {
  transform: translate(1px, 1px);
}

.watch-transport-btn--primary {
  width: 52px;
  height: 52px;
  font-size: 22px;
  background: var(--pixel-accent-fg, #f472b6);
  color: #fff;
}

.watch-transport-btn--active {
  background: rgba(236, 72, 153, 0.25);
  border-color: var(--pixel-accent-fg, #f472b6);
}

.watch-time {
  font-size: 12px;
  color: var(--pixel-text-dim);
  white-space: nowrap;
}

.watch-volume {
  display: flex;
  align-items: center;
  gap: 6px;
}

.watch-volume .watch-transport-btn {
  width: 34px;
  height: 34px;
  font-size: 14px;
}

.watch-volume-slider {
  width: 90px;
}

.watch-progress {
  position: relative;
  width: 100%;
  max-width: 720px;
  height: 14px;
  margin-top: 12px;
  display: flex;
  align-items: center;
}

.watch-progress .player-progress-fill {
  position: relative;
}

.watch-progress .player-progress-thumb {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  transform: translate(-50%, -50%);
  background: var(--pixel-accent-fg, #f472b6);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s;
}

.watch-progress:hover .player-progress-thumb,
.watch-progress.player-progress-bar--dragging .player-progress-thumb {
  opacity: 1;
}

/* ── 右栏 ── */
.watch-side {
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 2px solid rgba(240, 179, 192, 0.25);
  padding-left: 16px;
}

.watch-tabs {
  flex-shrink: 0;
  padding-bottom: 6px;
}

.watch-side-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-top: 8px;
  scrollbar-gutter: stable;
}

.watch-empty {
  text-align: center;
  padding: 32px 8px;
  font-size: 12px;
  color: var(--pixel-text-dim);
}

.watch-grip {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--pixel-text-dim);
  cursor: grab;
  touch-action: none;
  opacity: 0.6;
}

.queue-row:hover .watch-grip {
  opacity: 1;
}

.queue-row--dragging {
  outline: 2px dashed var(--pixel-accent-fg, #f472b6);
  background: rgba(236, 72, 153, 0.08);
}

.watch-queue-thumb {
  width: 30px;
  height: 30px;
  object-fit: cover;
  flex-shrink: 0;
  border: 1px solid rgba(240, 179, 192, 0.6);
  image-rendering: pixelated;
}

.watch-queue-thumb--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--pixel-text-dim);
}

.watch-queue-foot {
  display: flex;
  gap: 8px;
  padding: 12px 4px 4px;
}

.watch-foot-btn {
  font-size: 11px;
  padding: 4px 10px;
  color: var(--pixel-text);
  background: var(--pixel-card-bg);
  border: 1px solid rgba(240, 179, 192, 0.6);
  cursor: pointer;
}

.watch-foot-btn:hover:not(:disabled) {
  background: rgba(236, 72, 153, 0.15);
}

.watch-foot-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.watch-autoplay {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 4px 4px;
  font-size: 12px;
  color: var(--pixel-text);
  cursor: pointer;
  border-top: 1px solid rgba(240, 179, 192, 0.2);
  margin-top: 4px;
}

.watch-banner {
  margin-bottom: 10px;
  padding: 6px 8px;
  font-size: 11px;
  border: 2px solid;
}

.watch-banner--warn {
  background: rgba(254, 240, 138, 0.25);
  border-color: #eab308;
  color: #a16207;
}

.watch-banner--error {
  background: rgba(254, 202, 202, 0.25);
  border-color: #ef4444;
  color: #b91c1c;
}

.watch-lyric-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 0;
}

.watch-lyric-line {
  text-align: center;
  padding: 3px 4px;
  font-size: 13px;
  color: var(--pixel-text-dim);
  transition: color 0.25s;
}

.watch-lyric-line--current {
  color: var(--pixel-accent-fg, #f472b6);
  font-weight: bold;
}

.watch-lyric-translation {
  margin-top: 2px;
  font-size: 11px;
  opacity: 0.75;
}

/* 窄屏：单列——YTM 移动端同样是 封面→信息→控制 在上、tab 区在下 */
@media (max-width: 900px) {
  .watch-view {
    overflow-y: auto;
  }

  .watch-layout {
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow: visible;
  }

  .watch-main {
    overflow: visible;
  }

  .watch-cover {
    width: min(64vw, 320px);
  }

  .watch-side {
    border-left: none;
    border-top: 2px solid rgba(240, 179, 192, 0.25);
    padding-left: 0;
    padding-top: 10px;
  }

  .watch-side-body {
    max-height: 60vh;
  }

  .watch-transport {
    margin-top: 18px;
  }
}
</style>
