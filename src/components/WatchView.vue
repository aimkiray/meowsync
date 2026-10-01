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
        <div class="watch-cover-wrap" :class="{ 'watch-cover-wrap--video': mediaVideoActive }">
          <!-- 外部导入曲视频模式：封面区渲染视频流（静音，时钟锚 Howler 音频）；
               音频模式回落网易云匹配封面——不加载视频即省流量 -->
          <video
            v-if="mediaVideoActive"
            ref="mediaVideoRef"
            class="watch-cover watch-cover--video"
            :src="mediaVideoUrl"
            :aria-label="`视频画面：${currentSong?.name || ''}`"
            muted
            playsinline
            preload="auto"
            @error="mediaVideoFailed = true"
          ></video>
          <img
            v-else-if="coverUrl"
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
          <!-- 回源：新页打开源站原页。<a> 原生链接语义（可中键/复制链接）；
               noreferrer 不给源站带去本站 Referer -->
          <a
            v-if="sourceUrl"
            class="ink-btn ink-btn--ghost watch-action"
            :href="sourceUrl"
            target="_blank"
            rel="noopener noreferrer"
            :title="`回源：在${sourceName}打开原页`"
          ><PixelIcon name="external" :size="14" /> 回源 · {{ sourceName }}</a>
          <!-- 音画切换仅对有视频流的外部导入曲（B 站/YouTube）出现；关闭即只拉音频流省流量 -->
          <button
            v-if="currentSong?.bilibili?.hasVideo || currentSong?.youtube?.hasVideo"
            class="ink-btn ink-btn--ghost watch-action"
            :class="{ 'watch-action--on': videoOn }"
            @click="videoOn = !videoOn"
            :title="videoOn ? '切到纯音频（省流量）' : '切到视频模式'"
            :aria-pressed="videoOn"
          ><PixelIcon name="play" :size="14" /> {{ videoOn ? '视频开' : '仅音频' }}</button>
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
          <!-- 队列抬头（印单式）：mono 眉题 + 来源名 + 规模元信息。
               归属歌单在库时名字可点回歌单页（原 queue-source--link 语义） -->
          <div class="queue-head">
            <span class="queue-head-tag">正在播放</span>
            <button
              v-if="queueOwner"
              class="queue-head-name"
              @click="$emit('open-source')"
              :title="`回到歌单 ${queueTitle}`"
            >{{ queueTitle }}</button>
            <span v-else class="queue-head-name queue-head-name--plain">{{ queueTitle }}</span>
            <span v-if="queue.length" class="queue-head-meta">{{ queue.length }} 首<template v-if="queueTotalLabel"> · {{ queueTotalLabel }}</template></span>
          </div>
          <div v-if="queue.length === 0" class="watch-empty">队列为空喵~</div>
          <template v-else>
            <template v-for="(song, index) in queueRows" :key="queueKeyOf(song)">
              <div
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
                    <!-- 当前行：播放中等幅器跳动、暂停定格矮条；已播行打勾 -->
                    <span v-if="String(song.id) === String(currentSong?.id)" class="queue-eq" :class="{ 'queue-eq--paused': !isPlaying }" aria-hidden="true"><i /><i /><i /></span>
                    <template v-else-if="index < currentQueueIndex"><PixelIcon name="check" :size="11" /></template>
                    <template v-else>{{ index + 1 }}</template>
                  </span>
                  <img
                    v-if="songCoverUrl(song)"
                    :src="httpsCover(songCoverUrl(song))"
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
                <!-- 添加入口恒占最右槽位：当前行缺 remove 时位置依旧一致 -->
                <button
                  type="button"
                  class="row-add-btn pg-icobtn pg-icobtn--bare pg-icobtn--sm"
                  title="添加到歌单"
                  aria-label="添加到歌单"
                  aria-haspopup="dialog"
                  @click.stop="$emit('add-to-playlist', song)"
                ><PixelIcon name="plus" :size="14" /></button>
              </div>
              <!-- 「接下来」分节线：印单的分栏刻痕，只在当前行之后出现 -->
              <div v-if="index === currentQueueIndex && index < queue.length - 1" class="queue-sec">接下来 · {{ queue.length - currentQueueIndex - 1 }} 首</div>
            </template>
            <!-- 渐进渲染哨兵：千曲队列不一次渲全——前缀窗保全局下标语义
                 （drag/move/jump/remove 全是全局 index），IO 或点按扩窗 -->
            <button
              v-if="queueHasMore"
              :ref="bindQueueSentinel"
              class="ink-btn ink-btn--ghost ink-btn--sm watch-queue-more"
              @click="loadMoreQueue()"
            >加载更多 · {{ queueRendered }} / {{ queue.length }}</button>
          </template>

          <!-- 队列页脚：操作与偏好收成一条发丝顶隔的栏；空队列时只剩居中开关 -->
          <div class="watch-queue-foot" :class="{ 'watch-queue-foot--empty': !queue.length }">
            <template v-if="queue.length">
              <button class="ink-btn ink-btn--ghost ink-btn--sm" @click="$emit('save-queue')" title="把当前队列存成新歌单">
                <PixelIcon name="save" :size="12" /> 存为歌单
              </button>
              <button
                class="ink-btn ink-btn--ghost ink-btn--sm"
                :disabled="queue.length < 2"
                @click="$emit('clear-queue')"
                title="清空队列（保留当前播放）"
              >清空队列</button>
            </template>
            <!-- YTM UP NEXT 底部：自动播放开关（语义全文进 title，label 保持短） -->
            <label class="watch-autoplay" title="队列播完接续相关歌曲">
              <input
                type="checkbox"
                class="pg-check"
                :checked="autoplay"
                @change="$emit('update:autoplay', $event.target.checked)"
              />
              <span>自动播放</span>
            </label>
          </div>
        </div>

        <!-- 歌词工具条：字号调节（本机偏好）+ 时间校准（按词源入库）。
             不挂进滚动体——面板滚动时工具条恒可见 -->
        <div v-if="tab === 'lyrics' && currentSong" class="lyric-tools">
          <div class="lyric-tools-group" role="group" aria-label="歌词字号">
            <button type="button" class="lyric-tool" :disabled="lyricFontSize <= LYRIC_FS_MIN"
              @click="lyricFontSize--" title="歌词字号减小" aria-label="减小字号">A−</button>
            <span class="lyric-tool-val" aria-live="polite" aria-label="当前字号">{{ lyricFontSize }}px</span>
            <button type="button" class="lyric-tool" :disabled="lyricFontSize >= LYRIC_FS_MAX"
              @click="lyricFontSize++" title="歌词字号增大" aria-label="增大字号">A+</button>
          </div>
          <div class="lyric-tools-group" role="group" aria-label="歌词时间校准">
            <!-- 切歌/歌词在途期间禁调——此时显示的还是旧曲的词与校准值 -->
            <button type="button" class="lyric-tool"
              :disabled="!lyrics.length || songSwitching || loadingLyrics"
              @click="$emit('lyric-offset-adjust', -500)"
              title="歌词延后 0.5 秒" aria-label="歌词延后 0.5 秒">−0.5s</button>
            <button type="button" class="lyric-tool lyric-tool-val lyric-tool-reset"
              :disabled="!lyrics.length || lyricOffsetMs === 0 || songSwitching || loadingLyrics"
              @click="$emit('lyric-offset-reset')"
              :aria-label="`复位时间校准，当前 ${lyricOffsetLabel}`"
              :title="`当前校准 ${lyricOffsetLabel}，点击复位`"
            ><span aria-live="polite">{{ lyricOffsetLabel }}</span><template v-if="lyricOffsetMs !== 0"> ↺</template></button>
            <button type="button" class="lyric-tool"
              :disabled="!lyrics.length || songSwitching || loadingLyrics"
              @click="$emit('lyric-offset-adjust', 500)"
              title="歌词提前 0.5 秒" aria-label="歌词提前 0.5 秒">+0.5s</button>
          </div>
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
            <div v-else class="watch-lyric-list" :style="{ '--lyric-fs': lyricFontSize + 'px' }">
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
          >
            <div
              class="queue-row-main"
              role="button"
              tabindex="0"
              :title="`播放 ${song.name}`"
              @click="$emit('play-song', song, relatedSongs)"
              @keydown.enter="$emit('play-song', song, relatedSongs)"
              @keydown.space.prevent="$emit('play-song', song, relatedSongs)"
            >
              <img
                v-if="songCoverUrl(song)"
                :src="httpsCover(songCoverUrl(song))"
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
              type="button"
              class="row-add-btn pg-icobtn pg-icobtn--bare pg-icobtn--sm"
              title="添加到歌单"
              aria-label="添加到歌单"
              aria-haspopup="dialog"
              @click.stop="$emit('add-to-playlist', song)"
            ><PixelIcon name="plus" :size="14" /></button>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script>
import { ref, computed, watch, nextTick } from 'vue'
import { usePagedList } from '../composables/usePagedList.js'
import { musicApi } from '../api/music'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'
import { shareOrCopy, songShareUrl } from '../lib/share'
import { toast } from '../lib/feedback'
import { formatTime } from '../lib/format'
import { httpsCover } from '../lib/url'
import { songSourceUrl, songSourceName, songCoverUrl } from '../lib/song'

export default {
  name: 'WatchView',
  components: { PixelIcon, GlitchText },
  props: {
    currentSong: { type: Object, default: null },
    isPlaying: { type: Boolean, default: false },
    duration: { type: Number, default: 0 },
    // 音频时钟（秒，RAF 更新）——外部导入曲视频模式的画面以此锚定做漂移校正
    currentTime: { type: Number, default: 0 },
    songSwitching: { type: Boolean, default: false },
    queue: { type: Array, default: () => [] },
    queueTitle: { type: String, default: '' },
    queueOwner: { type: Object, default: null },
    lyrics: { type: Array, default: () => [] },
    currentLyricIndex: { type: Number, default: -1 },
    loadingLyrics: { type: Boolean, default: false },
    // 歌词时间校准（ms，正=提前）——值与持久化都在 App 侧，这里只做调节入口
    lyricOffsetMs: { type: Number, default: 0 },
    playbackError: { type: String, default: '' },
    durationWarning: { type: String, default: '' },
    tab: { type: String, default: 'queue' },
    autoplay: { type: Boolean, default: false }
  },
  emits: [
    'back', 'open-fullscreen',
    'update:tab', 'update:autoplay',
    'queue-jump', 'queue-remove', 'queue-move', 'save-queue', 'clear-queue',
    'play-song', 'open-source', 'add-to-playlist',
    'lyric-offset-adjust', 'lyric-offset-reset'
  ],
  setup(props, { emit }) {
    const queueContainer = ref(null)
    const lyricContainer = ref(null)

    // 待播队列渐进渲染窗：前缀窗保 index==全局下标（拖拽/jump/remove 语义不破）；
    // 快照语义不挂 resetWhen——队列替换/增删不回卷，centerCurrentRow 前
    // ensureRendered 物化目标行。pageSize 300：队列行远轻于曲目行
    const {
      rows: queueRows, hasMore: queueHasMore, renderedCount: queueRendered,
      loadMore: loadMoreQueue, ensureRendered: queueEnsureRendered,
      bindSentinel: bindQueueSentinel,
    } = usePagedList({
      source: computed(() => props.queue),
      pageSize: 300,
      scrollRoot: () => queueContainer.value,
    })

    // 歌词字号：本机偏好存 localStorage（不像时间校准那样随歌曲入库）。
    // CSS 变量 --lyric-fs 挂在列表上，当前行/译文用 calc 相对值随动
    const LYRIC_FS_MIN = 10
    const LYRIC_FS_MAX = 24
    // 隐私模式/存储禁用时 localStorage 抛 SecurityError——裸读会砸整个 setup
    const safeGetLs = (k) => { try { return localStorage.getItem(k) } catch { return null } }
    const safeSetLs = (k, v) => { try { localStorage.setItem(k, v) } catch { /* 存不上就只用会话值 */ } }
    const lyricFontSize = ref(
      Math.min(LYRIC_FS_MAX, Math.max(LYRIC_FS_MIN,
        parseInt(safeGetLs('meowsync-lyric-fs')) || 18)))
    watch(lyricFontSize, v => {
      safeSetLs('meowsync-lyric-fs', String(v))
    })
    const lyricOffsetLabel = computed(() => {
      const s = props.lyricOffsetMs / 1000
      return (s >= 0 ? '+' : '') + s.toFixed(1) + 's'
    })
    const dragIndex = ref(-1)

    const coverUrl = computed(() => songCoverUrl(props.currentSong))
    const artistText = computed(() =>
      (props.currentSong?.ar || props.currentSong?.artists || [])
        .map(a => a?.name).filter(Boolean).join(', ') || '未知艺术家'
    )
    const albumText = computed(() =>
      props.currentSong?.al?.name || props.currentSong?.album?.name || ''
    )

    // 队列抬头元信息：总时长未知字段（dt/duration 皆缺）的歌按 0 计，
    // 全缺时不显时长段
    const queueTotalLabel = computed(() => {
      const ms = props.queue.reduce((sum, s) => sum + (s.dt || s.duration || 0), 0)
      return ms > 0 ? formatTime(ms / 1000) : null
    })
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
      // 窗边界排序：目标行在窗外时先物化——否则行移出前缀窗后
      // DOM（含聚焦的握把）卸载，焦点掉回 body，后续 ↑↓ 会命中全局音量热键
      queueEnsureRendered(to)
      emit('queue-move', { from: index, to })
    }

    // ── 队列拖拽排序（YTM UP NEXT：握把按下后拖动实时换位）──
    const startDrag = (index, event) => {
      event.preventDefault()
      const container = queueContainer.value
      if (!container) return
      // 拖拽的落点域是全队列——渲染窗必须物化到底，
      // 否则 querySelectorAll 只数得到已渲行，向下拖会被窗底截断
      queueEnsureRendered(props.queue.length - 1)
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
        // 当前行可能在渲染窗外——先扩窗物化再定位（nextTick 等 DOM 落地）
        queueEnsureRendered(currentQueueIndex.value)
        nextTick(() => {
          const el = queueContainer.value?.querySelector('.queue-row--current')
          el?.scrollIntoView({ block: 'center' })
        })
      }
    }

    // rect 法只滚 lyricContainer——scrollIntoView 会连滚所有祖先，
    // 单列态拽动整页。字号重排后同样用这只滚容器
    const scrollLyricIntoCenter = (i, smooth) => {
      const container = lyricContainer.value
      const el = container?.querySelector(`[data-lyric-index="${i}"]`)
      if (!container || !el) return
      const containerRect = container.getBoundingClientRect()
      const lyricRect = el.getBoundingClientRect()
      const scrollOffset = (lyricRect.top - containerRect.top + lyricRect.height / 2) - containerRect.height / 2
      container.scrollTo({ top: container.scrollTop + scrollOffset, behavior: smooth ? 'smooth' : 'auto' })
    }

    watch(() => props.currentLyricIndex, async (i) => {
      if (props.tab !== 'lyrics' || i < 0) return
      await nextTick()
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      scrollLyricIntoCenter(i, smooth)
    })

    // 字号变化全列重排——不等下一 tick 就重居中当前行，长间奏不空屏
    watch(lyricFontSize, () => nextTick(() => {
      if (props.tab === 'lyrics' && props.currentLyricIndex >= 0) {
        scrollLyricIntoCenter(props.currentLyricIndex, false)
      }
    }))

    // ── 外部导入曲视频模式（B 站/YouTube 同一机制） ──
    // 偏好持久化：'0' 显式关，其余为开——视频源曲的价值就是画面，默认开。
    // LS key 留 'meowsync-bili-video'：YouTube 接入沿用既有偏好，不换名重置用户选择
    const mediaVideoRef = ref(null)
    const videoOn = ref(safeGetLs('meowsync-bili-video') !== '0')
    watch(videoOn, v => {
      safeSetLs('meowsync-bili-video', v ? '1' : '0')
      // 开视频就是用户最自然的重试入口——复位失败闩重新拉流
      if (v) mediaVideoFailed.value = false
    })
    // 视频流加载失败（CDN 全被拒/404）→ 回落封面图而不是黑盒；切歌重置
    const mediaVideoFailed = ref(false)
    // 视频源键：两个 provider 各取各自的定位串——换曲（哪怕同 provider）必然换键
    const mediaVideoKey = computed(() => {
      const song = props.currentSong
      if (song?.bilibili?.hasVideo) return `bv:${song.bilibili.bvid}:${song.bilibili.cid || 0}:${song.bilibili.page || 1}`
      if (song?.youtube?.hasVideo) return `yt:${song.youtube.videoId}`
      return null
    })
    const mediaVideoActive = computed(() => !!(mediaVideoKey.value && videoOn.value && !mediaVideoFailed.value))
    const mediaVideoUrl = computed(() => {
      const song = props.currentSong
      const b = song?.bilibili
      if (b?.hasVideo) return musicApi.bilibiliStreamUrl(b.bvid, 'video', b.cid, b.page)
      const y = song?.youtube
      return y?.hasVideo ? musicApi.youtubeStreamUrl(y.videoId, 'video') : ''
    })
    // 复位键用 mediaVideoUrl——同曲换源（B 站换P/YouTube 重导）时新源该重新尝试
    watch(mediaVideoUrl, () => { mediaVideoFailed.value = false })

    // 音画同步：视频元素静音播放，时钟完全听 Howler——每帧对比 currentTime，
    // 漂移超阈值才 seek（RAF 每帧触发，此处只做减法+偶尔 seek，开销可忽略）。
    // 顺带 reconcile paused 态——watch(isPlaying) 只在翻转时触发，组件重挂载
    // （返回→重进 watch）与单曲循环重播时视频会停在末帧/暂停态，这里兜底拉起
    const VIDEO_DRIFT_SEC = 0.45
    let mediaPlayTrying = false
    const syncMediaVideo = () => {
      const v = mediaVideoRef.value
      if (!v || !mediaVideoActive.value || v.error) return
      if (props.isPlaying && v.paused && !mediaPlayTrying) {
        mediaPlayTrying = true
        // play() 在极端旧内核可同步抛错——try 兜底防 mediaPlayTrying 卡死
        try {
          Promise.resolve(v.play()).catch(() => {}).finally(() => { mediaPlayTrying = false })
        } catch { mediaPlayTrying = false }
      } else if (!props.isPlaying && !v.paused) v.pause()
      if (Math.abs(v.currentTime - props.currentTime) > VIDEO_DRIFT_SEC) {
        v.currentTime = props.currentTime
      }
    }
    watch(() => props.currentTime, syncMediaVideo)
    watch(() => props.isPlaying, syncMediaVideo)
    // 切歌/开关视频时 src 变化或元素重建——等到新 metadata 落地再对齐时钟，
    // 避免对空 player 空 seek；监听键用 mediaVideoKey（两首外部曲互切时 active 不变）。
    // immediate 覆盖挂载瞬间条件已满足的情形（syncMediaVideo 也兜底）
    watch([mediaVideoActive, mediaVideoKey], async () => {
      if (!mediaVideoActive.value) return
      await nextTick()
      const v = mediaVideoRef.value
      if (!v) return
      const align = () => { v.currentTime = props.currentTime }
      if (v.readyState >= 1) align()
      else v.addEventListener('loadedmetadata', align, { once: true })
      if (props.isPlaying) v.play().catch(() => {})
    }, { immediate: true })

    const shareSong = async () => {
      const song = props.currentSong
      if (!song) return
      // 链形态（?bili/?yt/?qq/?song + view=watch 直达）统一在 lib/share.js
      const shareUrl = songShareUrl(song)
      const result = await shareOrCopy({
        title: `🎵 ${song.name} - ${artistText.value}`,
        text: `来听听这首歌：${song.name} - ${artistText.value}`,
        url: shareUrl
      })
      if (result === 'copied') toast('分享链接已复制到剪贴板', 'success')
      else if (result === 'failed') toast('分享失败，请手动复制链接', 'error')
    }

    // 回源：跳到曲目在源站的原页——B站视频（含分P）/YouTube watch/QQ 详情/网易云 song
    const sourceUrl = computed(() => songSourceUrl(props.currentSong))
    const sourceName = computed(() => songSourceName(props.currentSong) || '源站')

    return {
      queueContainer,
      lyricContainer,
      queueTotalLabel,
      queueRows,
      queueHasMore,
      queueRendered,
      loadMoreQueue,
      bindQueueSentinel,
      lyricFontSize,
      LYRIC_FS_MIN,
      LYRIC_FS_MAX,
      lyricOffsetLabel,
      dragIndex,
      coverUrl,
      artistText,
      albumText,
      songArtist,
      formatDuration,
      formatTime,
      httpsCover,
      songCoverUrl,
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
      shareSong,
      sourceUrl,
      sourceName,
      mediaVideoRef,
      videoOn,
      mediaVideoFailed,
      mediaVideoActive,
      mediaVideoUrl
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

/* 外部导入曲视频模式：16:9 信箱（外部视频多为横屏，方形裁切会砍画面）；
   image-rendering 像素化是封面的印刷效果，视频不该继承。
   视频是主内容、须明显大于方形封面：宽顶满栏位，上限 62vh 反推宽
   （封面 min(46vh,420px) 面积约 17.6万px²；960×540 ≈ 51.8万，~3×） */
.watch-cover--video {
  width: min(100%, 1080px, calc(62vh * 16 / 9));
  aspect-ratio: 16 / 9;
  object-fit: contain;
  image-rendering: auto;
  background: #000;
}

/* 视频态 wrap 必须占满栏宽：wrap 在 align-items:center 的 flex 栏里是
   shrink-to-fit，否则视频 width:% 与 wrap 构成循环约束、退回片源内建宽 */
.watch-cover-wrap--video { width: 100%; }

/* 音画切换的开启态：实心反色——与 pg-tab--active 同一语义 */
.watch-action--on {
  background: var(--ink);
  color: var(--paper);
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

/* 拖拽把手悬停/聚焦/拖拽中才显形——常显是每行常驻的视觉噪音
   （与 queue-row-remove/row-add-btn 同纪律），隐形态仍占位保对齐 */
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
  opacity: 0;
  pointer-events: none; /* 隐形时不吃点击 */
  transition: opacity .12s, color .2s;
}
.queue-row:hover .watch-grip,
.queue-row:focus-within .watch-grip,
.queue-row--dragging .watch-grip,
.watch-grip:focus-visible { opacity: 1; pointer-events: auto; }
.watch-grip:hover { color: var(--ink); }
.watch-grip:active { cursor: grabbing; color: var(--ink); } /* teal 画布上 -ink 档仅 2.17:1，拖拽态用实墨 */

/* 触屏无 hover——把手常显（且升到实墨，半透明档不可见） */
@media (hover: none){
  .watch-grip { opacity: 1; pointer-events: auto; color: var(--ink); }
}

/* 相关行点击区已收进 .queue-row-main（行容器化以容纳行尾 + 键），cursor 由它提供 */

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

/* 队列页脚：发丝顶隔把操作/偏好收成一条栏，与行列表的记账线呼应 */
.watch-queue-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 4px 12px;
  border-top: var(--hairline-soft);
  margin-top: 6px;
}
/* 空队列只剩自动播放开关——去掉顶隔线并居中，不吊在角落 */
.watch-queue-foot--empty { border-top: none; justify-content: center; }

/* 队列渐进渲染哨兵：居中 ghost 键 */
.watch-queue-more {
  display: flex;
  margin: 8px auto 0;
}

.watch-autoplay {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  padding: 2px 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-86);
  cursor: pointer;
  transition: background .12s;
}
.watch-autoplay:hover { background: var(--ink-06); }
.watch-queue-foot--empty .watch-autoplay { margin: 0 auto; }

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
  font-size: var(--lyric-fs, 18px);
  color: var(--ink-64);
  transition: color .25s, font-size .25s;
}

/* 当前行三层强调：accent 深档字色（双主题都过纸面对比度线）+ 放一档
   字号 + 行内三角界标。字号差拉大后普通行淡色与之层级清晰 */
.watch-lyric-line--current {
  color: var(--accent-magenta-ink);
  font-weight: 700;
  font-size: calc(var(--lyric-fs, 18px) + 4px);
}
/* 界标挂首个 <p> 的内联伪元素——随居中文字流两侧对称占位，不破坏居中 */
.watch-lyric-line--current > p:first-child::before,
.watch-lyric-line--current > p:first-child::after {
  font-size: .8em;
  font-weight: 400;
}
.watch-lyric-line--current > p:first-child::before { content: '▸'; margin-right: .5em; }
.watch-lyric-line--current > p:first-child::after { content: '◂'; margin-left: .5em; }

.watch-lyric-translation {
  /* opacity .75 叠在 ink-86 上画布对比度会跌破 3.5:1——升 .9 保读；
     字号下限 9px——字号调到最小档时译文不比这更小 */
  margin-top: 2px;
  font-size: max(9px, calc(var(--lyric-fs, 18px) - 2px));
  opacity: .9;
}

/* 歌词工具条：字号 / 时间校准两组，顶在歌词面板上方。
   不设分隔线——watch 侧栏约定「静止零装饰，边界交给滚动影」 */
.lyric-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 16px;
  flex-shrink: 0;
}
.lyric-tools-group { display: flex; align-items: center; gap: 4px; }
.lyric-tool {
  font-size: 10px;
  line-height: 1;
  padding: 6px;
  min-height: 24px; /* 触控地板与仓内 pg-icobtn--sm 同档 */
  min-width: 24px;
  border: var(--hairline);
  background: transparent;
  color: var(--ink-86);
  cursor: pointer;
  transition: color .5s var(--ease-ink), background .5s var(--ease-ink);
}
.lyric-tool:hover:not(:disabled) { background: var(--ink-06); color: var(--ink); }
.lyric-tool:disabled { opacity: .38; cursor: default; }
.lyric-tool-val {
  font-variant-numeric: tabular-nums;
  color: var(--ink-86);
}
/* 校准值键兼复位：按最大刻度 ±300.0s 预留宽，避免值跳变时整组位移 */
.lyric-tool-reset { min-width: 56px; }

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
  /* 视频例外：单列态占满栏宽（整页滚动，高度不占视口预算） */
  .watch-cover--video { width: 100%; }

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
