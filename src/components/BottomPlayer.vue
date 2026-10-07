<template>
  <div class="bottom-player" role="region" aria-label="播放器">
    <!-- 进度条：沉在墨条顶缘，按下即 seek + 拖拽（按 .1s 量化读数）。
         挂 .bottom-player 直下（relative 包含块=padding box）——外槽
         16/12px 若锚在 .player-content 会把它内缩，贴边抛掷命中丢失。
         无 @click——pointer 链已全覆盖鼠/触/笔，click 会与 pointerup 双发 seek -->
    <div
      class="player-progress-bar bp-progress"
      role="slider"
      aria-label="播放进度"
      :aria-valuenow="Math.round(seekProgress)"
      :aria-valuetext="`${formatTime(currentTime)} / ${formatTime(duration)}`"
      aria-valuemin="0"
      aria-valuemax="100"
      tabindex="0"
      @keydown.arrow-right.prevent="nudgeSeek(5)"
      @keydown.arrow-left.prevent="nudgeSeek(-5)"
      @keydown.home.prevent="seekToPosition(0)"
      @keydown.end.prevent="seekToPosition(1)"
      @keydown.enter.prevent="$emit('toggle-play')"
      @keydown.space.prevent="$emit('toggle-play')"
      @pointerdown="onProgressPointerDown"
      @pointermove="onProgressPointerMove"
      @pointerup="onProgressPointerUp"
      @pointercancel="onProgressPointerCancel"
      @lostpointercapture="onProgressPointerUp"
    >
      <div class="player-progress-fill bp-progress-fill" :style="{ '--p': seekProgress }"></div>
    </div>

    <!-- 当前播放歌曲的迷你信息与走带（无歌曲时同构骨架：控件禁用、占位兜底） -->
    <div class="player-content">
      <div class="player-inner">
        <!-- 当前歌曲缩略信息（左列）——YTM：点击回 watch 播放页（肌肉记忆入口） -->
        <div
          class="track-meta"
          role="button"
          tabindex="0"
          title="打开播放页"
          @click="$emit('open-watch', 'queue')"
          @keydown.enter="$emit('open-watch', 'queue')"
          @keydown.space.prevent="$emit('open-watch', 'queue')"
        >
          <div class="cover-wrap">
            <img
              v-if="coverUrl"
              :src="httpsCover(coverUrl)"
              :alt="`封面：${currentSong.name}`"
              class="track-cover"
              :class="{ 'playing-animation': isPlaying }"
            />
            <div v-else class="track-cover track-cover--fallback"><PixelIcon name="note" :size="16" /></div>
          </div>
          <div class="track-text">
            <p class="track-name">{{ currentSong?.name || '选择歌曲开始播放' }}</p>
            <p class="track-artist">{{ currentSong ? `${songArtists(currentSong)} · ${currentSong.al?.name || '未知专辑'}` : 'meowsync' }}</p>
          </div>
        </div>

        <!-- 走带控制（中列）：YTM 顺序 —— 随机/上一首/播放/下一首/循环 -->
        <div class="player-controls">
          <button
            @click="$emit('toggle-shuffle')"
            class="transport transport--edge"
            :class="{ 'transport--active': shuffleOn }"
            :aria-pressed="shuffleOn"
            :disabled="!currentSong || isTempPlaylist"
            aria-label="随机播放"
            title="随机播放"
          ><PixelIcon name="shuffle" :size="24" /></button>
          <button
            @click="$emit('previous')"
            class="transport"
            :disabled="!currentSong || atQueueStart"
            aria-label="上一首"
            title="上一首"
          ><PixelIcon name="prev" :size="24" /></button>
          <button
            @click="$emit('toggle-play')"
            class="transport transport--play"
            :class="{ 'transport--switching': songSwitching }"
            :disabled="!currentSong"
            :aria-label="songSwitching ? '切换歌曲中' : (isPlaying ? '暂停' : '播放')"
            :title="songSwitching ? '切换歌曲中…' : (isPlaying ? '暂停' : '播放')"
          ><PixelIcon :name="isPlaying ? 'pause' : 'play'" :size="isPlaying ? 26 : 32" /></button>
          <button
            @click="$emit('next')"
            class="transport"
            :disabled="!currentSong || atQueueEnd"
            aria-label="下一首"
            title="下一首"
          ><PixelIcon name="next" :size="24" /></button>
          <!-- 模式字形（m-loop/m-list）在 22 格 viewBox 里横向近满格，
               比箭头类字形视觉宽一倍——图标降 4px 光学配平，键体尺寸不变 -->
          <button
            @click="$emit('toggle-play-mode')"
            class="transport transport--edge"
            :disabled="!currentSong"
            :aria-label="`切换播放模式，当前：${playModeText || '顺序'}`"
            :title="`播放模式：${playModeText || '列表循环'}`"
          ><PixelIcon :name="playModeIcon" :size="20" /></button>
          <!-- YTM：time-info 在中列走带簇尾部（repeat 之后），不在右簇 -->
          <span class="player-time hidden lg:inline">
            {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
          </span>
        </div>

        <!-- 右簇（音量 + 沉浸入口）——watch 页的队列/歌词入口键已删：
             缩略信息点击区仍是回 watch 的主入口（YTM 肌肉记忆位） -->
        <div class="player-right">
          <div class="vol-wrap">
            <button
              @click="$emit('toggle-mute')"
              class="pg-icobtn pg-icobtn--on-ink"
              :class="{ 'pg-icobtn--pressed': muted }"
              :aria-pressed="muted"
              :aria-label="muted ? '取消静音' : '静音'"
              :title="muted ? '取消静音' : '静音'"
            ><PixelIcon :name="muted ? 'vol-mute' : 'vol'" :size="14" /></button>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              :value="volume"
              @input="$emit('update-volume', parseFloat($event.target.value))"
              class="pg-range pg-range--on-ink vol-range"
              aria-label="音量"
            />
          </div>
          <button
            class="pg-icobtn pg-icobtn--on-ink bp-xtra"
            :disabled="!currentSong"
            @click="$emit('enter-fullscreen')"
            aria-label="沉浸模式"
            title="沉浸模式"
          >
            <PixelIcon name="fullscreen" :size="14" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed } from 'vue'
import { formatTime } from '../lib/format'
import { songArtists, songThumbUrl } from '../lib/song'
import { httpsCover } from '../lib/url'
import PixelIcon from './PixelIcon.vue'

export default {
  name: 'BottomPlayer',
  components: { PixelIcon },
  props: {
    currentSong: {
      type: Object,
      default: null
    },
    isPlaying: {
      type: Boolean,
      default: false
    },
    currentTime: {
      type: Number,
      default: 0
    },
    duration: {
      type: Number,
      default: 0
    },
    volume: {
      type: Number,
      default: 0.5
    },
    muted: {
      type: Boolean,
      default: false
    },
    playbackList: {
      type: Array,
      default: () => []
    },
    currentIndex: {
      type: Number,
      default: -1
    },
    isTempPlaylist: {
      type: Boolean,
      default: false
    },
    shuffleOn: {
      type: Boolean,
      default: false
    },
    playMode: {
      type: String,
      default: 'list'
    },
    playModeText: {
      type: String,
      default: ''
    },
    songSwitching: {
      type: Boolean,
      default: false
    },
    autoplayOn: {
      type: Boolean,
      default: false
    }
  },
  emits: ['toggle-play', 'previous', 'next', 'update-volume', 'toggle-mute', 'toggle-shuffle', 'toggle-play-mode', 'open-watch', 'enter-fullscreen', 'seek'],
  setup(props, { emit }) {
    // 封面兜底收口在 lib/song.js:songCoverUrl（picUrl/al/album 三档）
    // 底栏 ~50px 槽位走 CDN 缩略图（96 给 retina 档），不拉原始分辨率
    const coverUrl = computed(() => songThumbUrl(props.currentSong, 96))

    // 进度条拖拽状态：按下期间 UI 播放在这里走，不跟随 props.currentTime 抢
    const dragActive = ref(false)
    const dragProgress = ref(0)
    // 多指隔离：第二指 pointerdown 不得覆写进行中的拖拽（RemoteController 同款纪律）
    const dragPointerId = ref(null)

    const seekProgress = computed(() => {
      if (dragActive.value) return dragProgress.value * 100
      return props.duration ? (props.currentTime / props.duration) * 100 : 0
    })

    // 队尾判定：仅 list 顺序模式在队尾时禁「下一首」——loop 回卷 / single 自循环始终有效。
    // autoplay 开启时队尾可续播相关曲，不锁键（YTM：Up next 永远有下一首）。
    // 临时歌单（single_song/saved_queue）不豁免：它们队尾点下一首只会静默空转
    const atQueueEnd = computed(() =>
      props.playMode === 'list' &&
      props.playbackList.length > 0 &&
      props.currentIndex >= props.playbackList.length - 1 &&
      !props.autoplayOn
    )
    // 队首同款：list 模式在第一首时禁「上一首」（点了也是静默 return）
    const atQueueStart = computed(() =>
      props.playMode === 'list' &&
      props.playbackList.length > 0 &&
      props.currentIndex === 0
    )

    const playModeIcon = computed(() =>
      ({ list: 'm-list', loop: 'm-loop', single: 'm-single' })[props.playMode] || 'm-list'
    )

    const positionFromEvent = (e, bar) => {
      const rect = bar.getBoundingClientRect()
      const x = e.clientX - rect.left
      return Math.min(1, Math.max(0, x / rect.width))
    }

    // seek 契约：emit 归一化比例 0-1（App.seekTo 负责换算秒）。无歌曲时进度条仅作骨架占位
    const seekToPosition = (pos) => {
      if (!props.currentSong) return
      emit('seek', pos)
    }

    const nudgeSeek = (sec) => {
      if (!props.currentSong) return
      const target = Math.max(0, Math.min(props.duration || 0, props.currentTime + sec))
      emit('seek', props.duration ? target / props.duration : 0)
    }

    const onProgressPointerDown = (e) => {
      if (e.button !== 0 || !props.currentSong || dragActive.value) return
      const bar = e.currentTarget
      bar.setPointerCapture?.(e.pointerId)
      dragActive.value = true
      dragPointerId.value = e.pointerId
      dragProgress.value = positionFromEvent(e, bar)
    }

    const onProgressPointerMove = (e) => {
      if (!dragActive.value || e.pointerId !== dragPointerId.value) return
      dragProgress.value = positionFromEvent(e, e.currentTarget)
    }

    const onProgressPointerUp = (e) => {
      if (!dragActive.value || e.pointerId !== dragPointerId.value) return
      dragActive.value = false
      dragPointerId.value = null
      // 发 up 点实况而非末次 move 值——coalesced events 下甩动松手不滞后
      emit('seek', positionFromEvent(e, e.currentTarget))
    }

    /* 浏览器接管手势（pan-y 竖滑起步）时只收拖拽态不 emit——
       用户本意是滚动页面，按触点位置 seek 是误操作 */
    const onProgressPointerCancel = (e) => {
      if (e.pointerId !== dragPointerId.value) return
      dragActive.value = false
      dragPointerId.value = null
    }

    return {
      formatTime,
      songArtists,
      httpsCover,
      coverUrl,
      seekProgress,
      atQueueEnd,
      atQueueStart,
      playModeIcon,
      seekToPosition,
      nudgeSeek,
      onProgressPointerDown,
      onProgressPointerMove,
      onProgressPointerUp,
      onProgressPointerCancel
    }
  }
}
</script>

<style scoped>
/* ── 墨条（底栏唯一配色：ink 面 + paper 字）── */
.bottom-player {
  position: relative;
  flex-shrink: 0;
  background: var(--ink);
  color: var(--paper);
  border-top: var(--hairline);
}

.bp-progress {
  position: absolute;
  top: -1px;
  left: 0;
  right: 0;
  background: var(--white-16);
  cursor: pointer;
  z-index: 2;
  /* 横滑 seek 不被浏览器手势抢走；竖滑放行——命中带探进主区底缘，
     none 会在那里造成 16px 滚动死区 */
  touch-action: pan-y;
}
/* 隐形命中带向上探：条体顶缘在 y=-1，带覆盖 y∈[-17,3]（总高 20px，
   对齐触控目标下限）——底沿钉在 y=3，恰在播放键顶缘 y≈4 上方留 1px。
   用 top+height 而非 inset 的 bottom——hover 加高（4→6px）向下生长时
   带形不变；bottom 锚法会把带底拖进控件区回漏点击。
   代价写在明处：向上探 16px 侵入主区末行底缘（song-row 下半段点击
   会变 seek——误触面窄且竖滑仍可滚页，换取不窃控件点击） */
.bp-progress::before {
  content: '';
  position: absolute;
  top: -16px;
  left: 0;
  right: 0;
  height: 20px;
}
/* 触屏半幅命中带：上探 16→8px（带 20→12，底沿仍钉 y=3 不窃控件点击）——
   胖指精度不吃鼠标档的加深命中带，末行曲目点击被抢的侵入面减半 */
@media (hover: none) {
  .bp-progress::before { top: -8px; height: 12px; }
}
.bp-progress-fill { background: var(--accent-magenta); } /* 已播部分=accent 本色（retro 火烈鸟粉 / glitch teal 同覆写） */

.player-inner {
  display: flex;
  align-items: center;
  gap: 16px;
  /* 横槽移到外层 .bottom-player（style.css 同款 max(16px,env)，全档生效）——
     内列居中到 --content-max 后，≥1472 与顶栏/侧栏内容同轴（原为内槽 16px
     错位：内列盒含槽，对齐基准偏半槽）。竖向 padding 4 + 播放键 60/56/52
     （桌面/phone/compact 三档）+ 发丝线 1.2 = 栏高 69.2/65.2/61.2——与
     style.css :root 的 --player-bar-h 令牌梯成对维护（watch 视频预算消费） */
  padding: 4px 0;
  max-width: var(--content-max, 1440px);
  margin: 0 auto;
}

/* 左列：封面 + 文字 */
.track-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
  cursor: pointer;
}
.track-meta:focus-visible { outline: 1.2px solid var(--paper); outline-offset: 2px; }
.cover-wrap { width: 40px; height: 40px; flex-shrink: 0; }
.track-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: 1.2px solid var(--white-40);
  image-rendering: pixelated;
  display: block;
}
.track-cover--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--label-grey);
}
.track-text { min-width: 0; }
.track-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--paper);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.track-artist {
  font-size: 11px;
  color: var(--label-grey);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}

/* 中列：走带 */
.player-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  position: relative; /* player-time 挂出流的锚点 */
}
.transport {
  width: 48px;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--paper);
  border: 1.2px solid transparent;
  cursor: pointer;
  transition: color .2s, opacity .15s;
}
/* hover 统一语言：仅品红字色，不出框——墨条自身即铬，框是多余装饰 */
.transport:hover:not(:disabled) { color: var(--accent-magenta-on-ink); }
.transport:disabled { opacity: .45; cursor: default; }
.transport--active { color: var(--accent-magenta-on-ink); }
.transport--play {
  width: 60px;
  height: 60px;
}

/* 切换中：不换字形，整键灰化。busy≠disabled——仍可按（togglePlay 内有
   howl 守卫），用 progress 光标区分于死键；opacity .15s 柔化瞬闪 */
.transport--switching { opacity: .45; cursor: progress; }

/* 切换态图标的按下态（纸面反白）——静音/随机/循环等 toggle 键共用 */
.pg-icobtn--pressed {
  background: var(--paper);
  color: var(--ink);
}

/* 右列：时间 + 音量 + 沉浸入口 */
.player-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  justify-content: flex-end;
  flex-shrink: 0;
}
/* 时间戳挂出流：absolute 贴中列右尾——五键簇恢复 play 键的几何对称，
   使其落在 player-inner 正中心（左右 flank 同为 flex:1 等宽）；
   若在流内，其宽度会把簇中心向右推，播放键偏左 ~29px */
.player-time {
  position: absolute;
  left: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-left: 8px;
  pointer-events: none; /* 压在 player-right 空置区上，勿吞点击 */
  user-select: none;
  font-family: var(--font-mono);
  font-weight: 400; /* 数值档——标签才是 300 */
  font-size: 12px;
  color: var(--label-grey);
  white-space: nowrap;
}

.vol-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  /* 音量组与视图入口三键组的组间分隔抬到 16px——与栏右缘页距同档
     （三键组左边 8px 档距 vs 页缘 16px 曾是不对称书挡；槽在外层） */
  margin-right: 8px;
}
.vol-range { width: 76px; }

/* 墨条上的图标键：透明底白字（无发丝盒——墨条自身即是铬） */
.pg-icobtn--on-ink {
  border-color: transparent;
  color: var(--paper);
}
.pg-icobtn--on-ink:hover:not(:disabled) { color: var(--accent-magenta-on-ink); }
/* 墨条上的按下态=变色图标：纸底白块会与 --on-ink 纸字叠成空白方块，改 accent 字色无底色 */
.pg-icobtn--on-ink.pg-icobtn--pressed,
.pg-icobtn--on-ink.pg-icobtn--pressed:hover:not(:disabled) {
  background: transparent;
  color: var(--accent-magenta-on-ink);
}

/* ≤768 首轮减负：右簇只留静音键——滑条（76）与沉浸入口同档收掉；
   分权拓扑未启，走带仍居中（YTM ≤1149 收 shuffle/repeat/volume 同档）。
   横槽由外层 .bottom-player 全档供给（16px 地板），内列只调 gap */
@media (max-width: 768px) {
  .vol-range, .bp-xtra { display: none; }
  /* bp-xtra 隐后静音键已是右簇尾件——组间分隔垫转成贴缘死缝，收掉 */
  .vol-wrap { margin-right: 0; }
  .player-inner { gap: 10px; }
  .transport--play { width: 56px; height: 56px; }
}

/* ≤640 分权拓扑（YTM mweb 底栏）：meta 左 / prev·play·next 右，
   不再守对称半幅——右簇与边键（shuffle/模式）整簇让位给标题区。
   走带 44/52 触控地板（原 ≤420 的 36 低于 WCAG/YTM 48 地板线）。
   shuffle/模式功能落点在 watch 页队列头（≤640 同档挂出）。
   类选择器标边键——免疫簇内加键/挪位导致的序号漂移（nth-of-type 脆弱） */
@media (max-width: 640.98px) {
  .player-inner { gap: 8px; }
  .player-controls { margin-left: auto; }
  .player-right, .player-controls .transport--edge { display: none; }
  .transport { width: 44px; height: 44px; }
  .transport--play { width: 52px; height: 52px; }
}
</style>
