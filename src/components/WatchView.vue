<template>
  <!-- YTM /watch 播放页：左栏 封面+信息+分享，右栏 待播/歌词/相关 tab。
       走带/进度/音量不重复渲染——底部播放条已覆盖 -->
  <div class="watch-view">
    <!-- 浮层顶行：不占流——右栏待播区的顶部空间随之释放 -->
    <div class="watch-top">
      <button class="ink-btn ink-btn--ghost ink-btn--sm" @click="$emit('back')" title="返回上一页"><PixelIcon name="chev-l" :size="14" />返回</button>
    </div>

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
          <div v-else class="watch-cover watch-cover--fallback"><PixelIcon name="note" :size="40" /></div>
        </div>

        <h2 class="watch-title" data-nosnippet><GlitchText :text="currentSong?.name || '未播放'" /></h2>
        <p class="watch-meta">
          {{ artistText }}<template v-if="albumText"> · {{ albumText }}</template>
          <template v-if="duration"> · {{ formatTime(duration) }}</template>
        </p>

        <div class="watch-actions">
          <button class="ink-btn ink-btn--ghost watch-action" @click="$emit('open-fullscreen')" title="全屏歌词模式">
            <PixelIcon name="expand" :size="14" /> 沉浸
          </button>
          <button class="ink-btn ink-btn--ghost watch-action" @click="shareSong" :disabled="!currentSong">
            <PixelIcon name="share" :size="14" /> 分享歌曲
          </button>
        </div>

        <!-- 播放错误/警告在操作行下方——归属左栏信息区，不占右栏 tab 顶部 -->
        <div v-if="durationWarning" class="watch-banner" role="status"><span class="watch-banner-tag">warn:</span> {{ durationWarning }}</div>
        <div v-if="playbackError" class="watch-banner" role="alert"><span class="watch-banner-tag">error:</span> {{ playbackError }}</div>
      </div>

      <!-- ══ 右栏：待播 / 歌词 / 相关 ══ -->
      <aside class="watch-side" aria-label="待播与歌词">

        <div class="pg-tabs watch-tabs" role="tablist" aria-label="播放页侧栏面板">
          <button
            v-for="t in TABS"
            :key="t.key"
            :id="`watch-tab-${t.key}`"
            class="pg-tab"
            :class="{ 'pg-tab--active': tab === t.key }"
            role="tab"
            :aria-controls="`watch-panel-${t.key}`"
            :aria-selected="tab === t.key"
            :tabindex="tab === t.key ? 0 : -1"
            @click="setTab(t.key)"
            @keydown.left.prevent="moveTab(-1)"
            @keydown.right.prevent="moveTab(1)"
          >{{ t.label }}</button>
        </div>

        <!-- 待播队列 -->
        <div
          id="watch-panel-queue"
          role="tabpanel"
          aria-labelledby="watch-tab-queue"
          v-show="tab === 'queue'"
          class="watch-side-body"
          ref="queueContainer"
        >
          <!-- YTM「Playing from」：归属歌单在库时来源名可点回歌单页 -->
          <button
            v-if="queueOwner"
            class="queue-source queue-source--link"
            @click="$emit('open-source')"
            :title="`回到歌单 ${queueTitle}`"
          >正在播放：{{ queueTitle }}</button>
          <p v-else class="queue-source">正在播放：{{ queueTitle }}</p>
          <div v-if="queue.length === 0" class="watch-empty">队列为空喵~</div>
          <template v-else>
            <div
              v-for="(song, index) in queue"
              :key="queueKeyOf(song)"
              class="queue-row"
              :class="{ 'queue-row--current': String(song.id) === String(currentSong?.id), 'queue-row--played': index < currentQueueIndex, 'queue-row--dragging': dragIndex === index }"
            >
              <button
                type="button"
                class="watch-grip"
                title="拖拽排序 · ↑↓ 键移动"
                aria-label="调整队列顺序"
                @pointerdown.stop="startDrag(index, $event)"
                @keydown.up.prevent.stop="moveRow(index, -1)"
                @keydown.down.prevent.stop="moveRow(index, 1)"
                @click.stop
              ><PixelIcon name="grip" :size="13" /></button>
              <div
                class="queue-row-main"
                role="button"
                tabindex="0"
                @click="jumpTo(index)"
                @keydown.enter="jumpTo(index)"
                @keydown.space.prevent="jumpTo(index)"
              >
              <span class="queue-row-index">
                <template v-if="String(song.id) === String(currentSong?.id)"><PixelIcon name="play" :size="16" /></template>
                <template v-else>{{ index + 1 }}</template>
              </span>
              <img
                v-if="song.al?.picUrl || song.album?.picUrl"
                :src="httpsCover(song.al?.picUrl || song.album?.picUrl)"
                :alt="song.name"
                class="watch-queue-thumb"
              />
              <div v-else class="watch-queue-thumb watch-queue-thumb--fallback"><PixelIcon name="note" :size="16" /></div>
              <div class="queue-row-info">
                <p class="queue-row-title">{{ song.name }}</p>
                <p class="queue-row-artist">{{ songArtist(song) }}</p>
              </div>
              <span class="queue-row-duration">{{ formatDuration(song) }}</span>
              </div>
              <button
                v-if="String(song.id) !== String(currentSong?.id)"
                type="button"
                class="queue-row-remove pg-icobtn pg-icobtn--bare pg-icobtn--sm"
                title="从队列移除"
                aria-label="从队列移除"
                @click.stop="$emit('queue-remove', index)"
              ><PixelIcon name="close" :size="14" /></button>
            </div>
          </template>

          <div class="watch-queue-foot" v-if="queue.length">
            <button class="ink-btn ink-btn--ghost ink-btn--sm" @click="$emit('save-queue')" title="把当前队列存成新歌单">
              <PixelIcon name="save" :size="12" /> 存为歌单
            </button>
            <button
              class="ink-btn ink-btn--ghost ink-btn--sm"
              :disabled="queue.length < 2"
              @click="$emit('clear-queue')"
              title="清空队列（保留当前播放）"
            >清空队列</button>
          </div>

          <!-- YTM UP NEXT 底部：自动播放开关 -->
          <label class="watch-autoplay">
            <input
              type="checkbox"
              class="pg-check"
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
          aria-labelledby="watch-tab-lyrics"
          v-show="tab === 'lyrics'"
          class="watch-side-body"
          ref="lyricContainer"
        >
          <div v-if="!currentSong" class="watch-empty">选择一首歌开始播放喵~</div>
          <template v-else>
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
          aria-labelledby="watch-tab-related"
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
            @click="$emit('play-song', song, relatedSongs)"
            @keydown.enter="$emit('play-song', song, relatedSongs)"
            @keydown.space.prevent="$emit('play-song', song, relatedSongs)"
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
            <div v-else class="watch-queue-thumb watch-queue-thumb--fallback"><PixelIcon name="note" :size="16" /></div>
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
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'
import { shareOrCopy } from '../lib/share'
import { toast } from '../lib/feedback'
import { formatTime } from '../lib/format'
import { httpsCover } from '../lib/url'

export default {
  name: 'WatchView',
  components: { PixelIcon, GlitchText },
  props: {
    currentSong: { type: Object, default: null },
    isPlaying: { type: Boolean, default: false },
    duration: { type: Number, default: 0 },
    songSwitching: { type: Boolean, default: false },
    queue: { type: Array, default: () => [] },
    queueTitle: { type: String, default: '' },
    queueOwner: { type: Object, default: null },
    lyrics: { type: Array, default: () => [] },
    currentLyricIndex: { type: Number, default: -1 },
    loadingLyrics: { type: Boolean, default: false },
    playbackError: { type: String, default: '' },
    durationWarning: { type: String, default: '' },
    tab: { type: String, default: 'queue' },
    autoplay: { type: Boolean, default: false }
  },
  emits: [
    'back', 'open-fullscreen',
    'update:tab', 'update:autoplay',
    'queue-jump', 'queue-remove', 'queue-move', 'save-queue', 'clear-queue',
    'play-song', 'open-source'
  ],
  setup(props, { emit }) {
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

    const songArtist = (song) =>
      (song.ar || song.artists || []).map(a => a?.name).filter(Boolean).join('/') || '未知艺人'

    const formatDuration = (song) => formatTime((song.dt || song.duration || 0) / 1000)

    const TABS = [
      { key: 'queue', label: '待播' },
      { key: 'lyrics', label: '歌词' },
      { key: 'related', label: '相关' },
    ]
    const setTab = (t) => emit('update:tab', t)
    const moveTab = (dir) => {
      const i = TABS.findIndex(t => t.key === props.tab)
      const next = TABS[(i + dir + TABS.length) % TABS.length]
      setTab(next.key)
      document.getElementById(`watch-tab-${next.key}`)?.focus()
    }
    // 队列行稳定 key：按对象身份发 uid。若 key 含 index，每次排序都重建 DOM
    // ——聚焦的握把被销毁、焦点掉回 body，第二次 ↑↓ 会被全局快捷键当成音量调节
    const queueKeyMap = new WeakMap()
    let queueKeySeq = 0
    const queueKeyOf = (song) => {
      if (!queueKeyMap.has(song)) queueKeyMap.set(song, `${song.id}-${++queueKeySeq}`)
      return queueKeyMap.get(song)
    }
    // YTM：当前行之上的已播段淡显（id 匹配定位，乱序队列按 id 不按下标）
    const currentQueueIndex = computed(() =>
      props.queue.findIndex(s => String(s.id) === String(props.currentSong?.id))
    )
    const jumpTo = (index) => emit('queue-jump', index)
    // 键盘排序等价路径：握把聚焦时 ↑↓ 移动该行
    const moveRow = (index, dir) => {
      const to = index + dir
      if (to < 0 || to >= props.queue.length) return
      emit('queue-move', { from: index, to })
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
      if (result === 'copied') toast('分享链接已复制到剪贴板', 'success')
      else if (result === 'failed') toast('分享失败，请手动复制链接', 'error')
    }

    return {
      queueContainer,
      lyricContainer,
      dragIndex,
      coverUrl,
      artistText,
      albumText,
      songArtist,
      formatDuration,
      formatTime,
      httpsCover,
      TABS,
      setTab,
      moveTab,
      queueKeyOf,
      currentQueueIndex,
      jumpTo,
      moveRow,
      startDrag,
      relatedSongs,
      relatedLoading,
      shareSong
    }
  }
}
</script>

<style scoped>
/* 主区页内视图（青纸画布）——走带已移除（底栏承担），信息面板垂直居中 */
.watch-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.watch-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) min(400px, 38vw);
  gap: 24px;
  padding: 20px 20px 20px; /* 顶 20 与全站首行轴齐平（头行已并入左栏） */
}

/* 浮层顶行：返回钉左页角 / 沉浸钉右页角；不占流——待播栏顶部空间整体释放。
   pointer-events:none 带子让下方内容可点，仅按键自身接收点击 */
.watch-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 5;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px;
  pointer-events: none;
}
.watch-top > * { pointer-events: auto; }

/* ── 左栏：封面 + 信息 + 操作 ── */
.watch-main {
  min-width: 0;
  overflow-y: auto;
  /* 居中栏的单边 gutter 会把封面掰偏 ~5px——both-edges 双侧车道保真居中
     （旧浏览器不认两关键字写法时回退到上行 stable） */
  scrollbar-gutter: stable;
  scrollbar-gutter: stable both-edges;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 8px 8px 0; /* 底距交给 .watch-layout 的 20，不再叠 24 */
  text-align: center;
}

.watch-cover {
  /* width 里的 100% 对 shrink-to-fit 父级是循环%——fallback 分支塌成 42px。
     min() 只留物理上限，收窄交给 max-width */
  width: min(46vh, 420px);
  max-width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border: var(--hairline);
  image-rendering: pixelated;
  display: block;
}

.watch-cover--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--paper);
}

.watch-title {
  margin-top: 20px;
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--ink);
  max-width: 34ch;
  overflow-wrap: anywhere;
}

.watch-meta {
  margin-top: 8px;
  font-size: 13px;
  color: var(--ink-64);
}

.watch-actions {
  margin-top: 16px;
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
}

.watch-action { font-size: 12px; }

/* ── 右栏：发丝线分栏的 tab 面板 ── */
.watch-side {
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
  /* gap 24 → padding 24：栏界标尺两侧留白对称 */
  padding-left: 24px;
}

/* 栏界羽化标尺：ink-30 细线、两端渐隐、上下内缩——暗示分栏而非一堵墨墙 */
.watch-side::before {
  content: '';
  position: absolute;
  left: 0;
  top: 24px;
  bottom: 24px;
  width: 1.2px;
  background: linear-gradient(to bottom, transparent, var(--ink-30) 12%, var(--ink-30) 88%, transparent);
  pointer-events: none;
}

/* 状态横幅：纸面发丝盒 + 等宽标签（warn:/error:）——居左栏沉浸键下方，宽与封面同轴 */
.watch-banner {
  margin-top: 14px;
  padding: 8px 10px;
  font-size: 11px;
  background: var(--paper);
  border: var(--hairline);
  color: var(--ink);
  flex-shrink: 0;
  width: min(46vh, 420px);
  max-width: 100%;
  text-align: left;
}

.watch-banner-tag {
  font-family: var(--font-mono);
  font-weight: 300;
  letter-spacing: .05em;
  color: var(--accent-danger-ink);
}

.watch-tabs { flex-shrink: 0; }

.watch-side-body {
  flex: 1;
  min-height: 0;
  scrollbar-gutter: stable;
  overflow-y: auto;
  padding-top: 8px;
  /* 滚动影替尺：画布色盖片 local 随内容滚走 → 钉在顶缘的 scroll 影显露；
     回到顶时盖片重新遮住影——边界只在内容压在 tab 下时出现。
     盖片须跟该处实际底色 --view-canvas（watch=teal），写 --paper 会漏白缝 */
  background:
    linear-gradient(var(--view-canvas, var(--paper)), var(--view-canvas, var(--paper))) 0 0 / 100% 14px local no-repeat,
    radial-gradient(farthest-side at 50% 0, color-mix(in srgb, var(--ink) 16%, transparent), transparent) 0 0 / 100% 10px scroll no-repeat;
}

.watch-empty {
  text-align: center;
  padding: 32px 16px;
  font-size: 12px;
  color: var(--ink-64);
}

.watch-grip {
  flex-shrink: 0;
  width: 20px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 0;
  color: var(--ink-86);
  cursor: grab;
  touch-action: none;
}
.watch-grip:hover { color: var(--ink); }
.watch-grip:active { cursor: grabbing; color: var(--ink); } /* teal 画布上 -ink 档仅 2.17:1，拖拽态用实墨 */

/* 触屏下半透明把手 1.99:1 不可见——直接常显 */
@media (hover: none){
  .watch-grip { color: var(--ink); }
}

.watch-related-row { cursor: pointer; }

.queue-row--dragging {
  outline: 1.2px solid var(--accent-magenta-ink); /* 纸面指示线走深档（火烈鸟本色 ~2.3:1 过浅） */
  outline-offset: -4px;
  background: var(--paper);
}

.watch-queue-thumb {
  width: 30px;
  height: 30px;
  object-fit: cover;
  flex-shrink: 0;
  border: var(--hairline);
  image-rendering: pixelated;
}

.watch-queue-thumb--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--paper);
}

.watch-queue-foot {
  display: flex;
  gap: 8px;
  padding: 12px 4px; /* 底距对齐上距——末行按钮与滚动区下缘同距呼吸 */
}

.watch-autoplay {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 4px 4px;
  font-size: 12px;
  color: var(--ink-86);
  cursor: pointer;
  margin-top: 8px;
  transition: background .12s;
}
.watch-autoplay:hover { background: var(--ink-06); }
/* 空队列时没有行列表可供它尾随——吊在居中空文案下的左对齐控件会变孤儿，随空态居中 */
.watch-empty ~ .watch-autoplay { justify-content: center; }

/* 歌词行：当前行墨色加粗放大，其余 ink-64 */
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
  color: var(--ink-64);
  transition: color .25s;
}

.watch-lyric-line--current {
  color: var(--ink);
  font-weight: 700;
  font-size: 15px;
}

.watch-lyric-translation {
  /* opacity .75 叠在 ink-86 上画布对比度会跌破 3.5:1——升 .9 保读 */
  margin-top: 2px;
  font-size: 11px;
  opacity: .9;
}

/* 窄屏：单列——封面→信息 在上、tab 区在下 */
@media (max-width: 900px) {
  /* 单列态滚动移交 .watch-view——车道跟着滚动器走 */
  .watch-view { overflow-y: auto; scrollbar-gutter: stable; }

  .watch-layout {
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow: visible;
    padding-top: 56px; /* 浮层顶行净空——单列时内容从键位下方起 */
  }

  .watch-main { overflow: visible; }
  .watch-cover { width: min(64vw, 320px); }

  .watch-side {
    padding-left: 0;
    padding-top: 10px;
  }

  /* 单列态栏界转横——同源羽化标尺 */
  .watch-side::before {
    left: 24px;
    right: 24px;
    top: 0;
    bottom: auto;
    width: auto;
    height: 1.2px;
    background: linear-gradient(to right, transparent, var(--ink-30) 12%, var(--ink-30) 88%, transparent);
  }

  /* 不再限高内滚——YTM 是整页滚动，队列随页流；此时本栏不滚，死车道回收 */
  .watch-side-body { max-height: none; scrollbar-gutter: auto; }
}
</style>
