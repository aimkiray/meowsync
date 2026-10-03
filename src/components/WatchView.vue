<template>
  <!-- YTM /watch 播放页：左栏 封面+信息+分享，右栏 待播/歌词/相关 tab。
       走带/进度/音量不重复渲染——底部播放条已覆盖 -->
  <div ref="viewEl" class="watch-view relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden wide:overflow-y-hidden" @touchstart.passive="onWatchTouchStart" @touchmove.passive="pauseLyricFollow" @wheel.passive="pauseLyricFollow">
    <!-- 顶行：移动态 sticky 钉顶（在流占一行），宽屏 absolute 浮层不占流 -->
    <div class="watch-top">
      <button class="ink-btn ink-btn--ghost ink-btn--sm" @click="$emit('back')" title="返回上一页"><PixelIcon name="chev-l" :size="14" />返回</button>
    </div>

    <div class="watch-layout flex flex-col gap-4 px-5 pb-5 pt-3 wide:grid wide:min-h-0 wide:flex-1 wide:grid-cols-[minmax(0,1fr)_min(400px,38vw)] wide:gap-6 wide:p-5">
      <!-- ══ 左栏 ══ -->
      <div ref="mainColEl" class="watch-main flex min-w-0 flex-col items-center overflow-visible px-2 pt-2 text-center wide:justify-center wide:overflow-y-auto" :class="{ 'watch-main--video': mediaVideoActive }">
        <div ref="coverWrapRef" class="watch-cover-wrap"
          :class="{ 'watch-cover-wrap--video': mediaVideoActive, 'watch-cover-wrap--idle': videoFullscreen && !controlsVisible }"
          @mousemove="pokeControls" @pointerdown="pokeControls">
          <!-- 外部导入曲视频模式：封面区渲染视频流（静音，时钟锚 Howler 音频）；
               音频模式回落网易云匹配封面——不加载视频即省流量。
               video+控制层同包一个 template v-if：img/fallback 的 v-else 链
               只挂这一处条件——控制层条件将来分叉不会误把 img 带出场 -->
          <template v-if="mediaVideoActive">
            <video
              ref="mediaVideoRef"
              :key="mediaVideoKey"
              class="watch-cover watch-cover--video"
              :src="mediaVideoUrl"
              :aria-label="`视频画面：${currentSong?.name || ''}`"
              :poster="coverUrl ? httpsCover(coverUrl) : undefined"
              muted
              playsinline
              preload="auto"
              disablepictureinpicture
              disableremoteplayback
              @error="onMediaVideoError"
              @pointerdown="onVideoPointerDown"
              @click="onVideoClick"
            ></video>
            <!-- 悬停控制层：中央半透明播放/暂停走全局 toggle-play（视频元素静音、
                 时钟锚 Howler——syncMediaVideo 自动跟着收放）；右下全屏锁在 wrap
                 上做元素级 fullscreen——控制层随 wrap 一起进全屏仍可用。
                 --on class 驱动露出（mousemove/pointerdown 戳醒 + 播放中 2.6s 自隐，
                 暂停常显）——光标停在屏内 :hover 恒真，CSS 恒显会把中央键全程压在画面上 -->
            <div class="watch-video-controls" :class="{ 'watch-video-controls--on': controlsVisible }">
              <button
                type="button"
                class="watch-video-toggle"
                @click="$emit('toggle-play')"
                :title="isPlaying ? '暂停' : '播放'"
                :aria-label="isPlaying ? '暂停' : '播放'"
              ><PixelIcon :name="isPlaying ? 'pause' : 'play'" :size="26" /></button>
              <!-- iPhone Safari 无元素级 Fullscreen API（只有 video 专属的
                   webkitEnterFullscreen——静音视频进原生全屏会与 Howler 音频脱钩），
                   能力缺失时藏键好过留颗死键 -->
              <button
                v-if="canElementFs"
                type="button"
                class="watch-video-fs"
                @click="toggleVideoFullscreen"
                :title="videoFullscreen ? '退出全屏' : '全屏'"
                :aria-label="videoFullscreen ? '退出全屏' : '视频全屏'"
                :aria-pressed="videoFullscreen"
              ><PixelIcon name="expand" :size="14" /></button>
            </div>
          </template>
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
          <!-- file_ 上传曲没有源站可分享链接（?song= 只收数字 id）——死链不亮 -->
          <button v-if="!isFileTrackId(currentSong?.id)" class="ink-btn ink-btn--ghost watch-action" @click="shareSong" :disabled="!currentSong">
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
          ><PixelIcon name="external" :size="14" /> {{ sourceName }}</a>
          <!-- 音画切换对「可能有视频」的曲出现；关闭即只拉音频流省流量。
               bv/yt 按 provider 存在性出键（与 mediaVideoKey 同律）——导入标记
               可能被裁/老数据缺标，盘上躺着档的曲也要能切回音频、VIDEO_MODE=0
               的用户也要有入口开视频重探；file_ 仍按 hasVideo（上传曲的标记
               即工件真相，探测链对它关闭）。无可放源时靠 title 提示降级
               （探测无果视觉不变） -->
          <button
            v-if="currentSong?.bilibili?.bvid || currentSong?.youtube?.videoId
              || currentSong?.file?.hasVideo"
            class="ink-btn ink-btn--ghost watch-action"
            :class="{ 'watch-action--on': videoOn }"
            @click="videoOn = !videoOn"
            :title="videoOn ? '切到纯音频（省流量）'
              : (hasPlayableVideo ? '切到视频模式' : '切到视频模式（需已下载视频档）')"
            :aria-pressed="videoOn"
          ><PixelIcon name="play" :size="14" /> {{ videoOn ? '视频' : '音频' }}</button>
        </div>

        <!-- 播放错误/警告在操作行下方——归属左栏信息区，不占右栏 tab 顶部 -->
        <div v-if="durationWarning" class="watch-banner" role="status"><span class="watch-banner-tag">warn:</span> {{ durationWarning }}</div>
        <div v-if="playbackError" class="watch-banner" role="alert"><span class="watch-banner-tag">error:</span> {{ playbackError }}</div>
      </div>

      <!-- ══ 右栏：待播 / 歌词 / 相关 ══ -->
      <aside class="watch-side relative flex min-w-0 flex-col pt-2.5 wide:min-h-0 wide:pl-6 wide:pt-0" aria-label="待播与歌词">

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
            <!-- 虚拟滚动上沿 spacer：锚位+衬高，行区起点=全局下标 0 的位置 -->
            <div :ref="bindQueueAnchor" :style="{ height: queueTopPad + 'px' }" aria-hidden="true"></div>
            <!-- v-for 的 i 是窗口内局部下标，全局下标=queueStartIndex+i——
                 jump/remove/move/drag/已播判定全吃全局下标 -->
            <template v-for="(song, i) in queueRows" :key="queueKeyOf(song)">
              <div
                class="queue-row"
                :class="{ 'queue-row--current': String(song.id) === String(currentSong?.id), 'queue-row--played': queueStartIndex + i < currentQueueIndex, 'queue-row--dragging': dragIndex === queueStartIndex + i }"
              >
                <button
                  type="button"
                  class="watch-grip"
                  title="拖拽排序 · ↑↓ 键移动"
                  aria-label="调整队列顺序"
                  @pointerdown.stop="startDrag(queueStartIndex + i, $event)"
                  @keydown.up.prevent.stop="moveRow(queueStartIndex + i, -1)"
                  @keydown.down.prevent.stop="moveRow(queueStartIndex + i, 1)"
                  @click.stop
                ><PixelIcon name="grip" :size="13" /></button>
                <div
                  class="queue-row-main"
                  role="button"
                  tabindex="0"
                  @click="jumpTo(queueStartIndex + i)"
                  @keydown.enter="jumpTo(queueStartIndex + i)"
                  @keydown.space.prevent="jumpTo(queueStartIndex + i)"
                >
                  <span class="queue-row-index">
                    <!-- 当前行：播放中等幅器跳动、暂停定格矮条；已播行打勾 -->
                    <span v-if="String(song.id) === String(currentSong?.id)" class="queue-eq" :class="{ 'queue-eq--paused': !isPlaying }" aria-hidden="true"><i /><i /><i /></span>
                    <template v-else-if="queueStartIndex + i < currentQueueIndex"><PixelIcon name="check" :size="11" /></template>
                    <template v-else>{{ queueStartIndex + i + 1 }}</template>
                  </span>
                  <img
                    v-if="songCoverUrl(song)"
                    :src="httpsCover(songThumbUrl(song, 80))"
                    :alt="song.name"
                    class="watch-queue-thumb"
                    loading="lazy"
                    decoding="async"
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
                  @click.stop="$emit('queue-remove', queueStartIndex + i)"
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
              <div v-if="queueStartIndex + i === currentQueueIndex && queueStartIndex + i < queue.length - 1" class="queue-sec">接下来 · {{ queue.length - currentQueueIndex - 1 }} 首</div>
            </template>
            <!-- 虚拟滚动下沿 spacer -->
            <div :style="{ height: queueBottomPad + 'px' }" aria-hidden="true"></div>
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
             宽屏不挂进侧栏滚动体——面板内滚时恒可见；单列整页滚态随页流
             （钉顶空间留给 tabs——工具条是低频校准件） -->
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
              <div class="pixel-loading mb-4"></div>
              <p>正在切换歌曲喵...</p>
            </div>
            <div v-else-if="loadingLyrics" class="watch-empty">
              <div class="pixel-loading mb-4"></div>
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
          ref="relatedEl"
        >
          <div v-if="relatedLoading" class="watch-empty">
            <div class="pixel-loading mb-4"></div>
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
                :src="httpsCover(songThumbUrl(song, 80))"
                :alt="song.name"
                class="watch-queue-thumb"
                loading="lazy"
                decoding="async"
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
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useVirtualList } from '../composables/useVirtualList.js'
import { readScrollMem, writeScrollMem, restoreScrollTop } from '../lib/scroll-mem'
import { musicApi } from '../api/music'
import { downloadsApi } from '../api/downloads'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'
import { shareOrCopy, songShareUrl } from '../lib/share'
import { toast } from '../lib/feedback'
import { formatTime } from '../lib/format'
import { httpsCover } from '../lib/url'
import { songSourceUrl, songSourceName, songCoverUrl, songThumbUrl, fileArtifactUrl, isFileTrackId } from '../lib/song'
import { LS_KEYS } from '../lib/storage'

// 已下载视频档的会话缓存（mediaVideoKey → 本地 URL）：离开再进 watch 时
// 本地档即知即挂，不等探测 RTT。模块域共享——组件每次重挂 setup 全新，
// 下载删除由探测复验清条目（FIFO 封顶防长会话膨胀）
const dlVideoCache = new Map()
const DL_VIDEO_CACHE_CAP = 80
const dlCacheSet = (k, v) => {
  dlVideoCache.delete(k)
  dlVideoCache.set(k, v)
  if (dlVideoCache.size > DL_VIDEO_CACHE_CAP) dlVideoCache.delete(dlVideoCache.keys().next().value)
}

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
    autoplay: { type: Boolean, default: false },
    // 沉浸歌词层开着时本页仍挂载但被整体盖住——视频此时不可见，
    // mediaVideoActive 据此收掉（卸载 <video> 止流，关层经对齐链重挂续播）
    fullscreenPlayerOpen: { type: Boolean, default: false }
  },
  emits: [
    'back', 'open-fullscreen', 'toggle-play',
    'update:tab', 'update:autoplay',
    'queue-jump', 'queue-remove', 'queue-move', 'save-queue', 'clear-queue',
    'play-song', 'open-source', 'add-to-playlist',
    'lyric-offset-adjust', 'lyric-offset-reset'
  ],
  setup(props, { emit }) {
    const queueContainer = ref(null)
    const lyricContainer = ref(null)
    const viewEl = ref(null)
    const mainColEl = ref(null)
    const relatedEl = ref(null)

    // 离场滚动记忆：换页即整卸——单列页滚 .watch-view、宽屏左栏 .watch-main、
    // 相关栏各自还位。队列/歌词两栏不存：重挂即按当前行重居中（与切 tab
    // 同律的 centerCurrentRow），存了也会被居中盖掉；view 页滚同理——
    // queue/lyrics tab 下单列态 scrollIntoView 连滚整页，还位只留 related
    const scrollRestoreCancels = []
    onMounted(() => nextTick(() => {
      for (const [key, el] of [
        ...(props.tab === 'related' ? [['watch:view', viewEl.value]] : []),
        ['watch:main', mainColEl.value],
        ['watch:related', relatedEl.value],
      ]) {
        const m = readScrollMem(key)
        if (m && el) scrollRestoreCancels.push(restoreScrollTop(el, m.top))
      }
    }))
    onBeforeUnmount(() => {
      scrollRestoreCancels.forEach(fn => fn?.()) // 等待窗内卸载即停轮询
      writeScrollMem('watch:view', { top: viewEl.value?.scrollTop ?? 0 })
      writeScrollMem('watch:main', { top: mainColEl.value?.scrollTop ?? 0 })
      writeScrollMem('watch:related', { top: relatedEl.value?.scrollTop ?? 0 })
    })

    // 待播队列真虚拟滚动：滑窗替代前缀窗——队列可达千曲规模（快照自
    // filteredSongs），前缀窗滚到底全量同构。行高 55.5px 均匀（首行
    // 少 1px 发丝边/中途 queue-sec ~28px 是常量误差，overscan 吸收）。
    // 快照语义不挂 resetWhen——队列替换/增删不回卷。双滚动根候选：
    // ≥901px 内滚 queueContainer、<901px 整页 viewEl——每帧挑「此刻
    // 真会滚的」，breakpoint 翻转不用 matchMedia。
    // pinIndex=拖拽行：拖到窗外时行仍留 DOM（--dragging 与几何基准不丢）
    // dragIndex 上移：pinIndex 传 ref 对象本体，setup 时引用不能 TDZ
    const dragIndex = ref(-1)
    const {
      rows: queueRows, startIndex: queueStartIndex,
      topPad: queueTopPad, bottomPad: queueBottomPad,
      bindAnchor: bindQueueAnchor,
      scrollToIndex: queueScrollToIndex, ensureVisible: queueEnsureVisible,
    } = useVirtualList({
      source: computed(() => props.queue),
      rowHeight: 55.5,
      scrollRoots: () => [queueContainer.value, viewEl.value],
      pinIndex: dragIndex,
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
        parseInt(safeGetLs(LS_KEYS.LYRIC_FONT_SIZE)) || 18)))
    watch(lyricFontSize, v => {
      safeSetLs(LS_KEYS.LYRIC_FONT_SIZE, String(v))
    })
    const lyricOffsetLabel = computed(() => {
      const s = props.lyricOffsetMs / 1000
      return (s >= 0 ? '+' : '') + s.toFixed(1) + 's'
    })

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
      // 窗边界排序：目标行在窗外时先滚进窗——否则行移出滑窗后 DOM
      // （含聚焦的握把）卸载，焦点掉回 body，后续 ↑↓ 会命中全局音量热键
      queueEnsureVisible(to)
      emit('queue-move', { from: index, to })
    }

    // ── 队列拖拽排序（YTM UP NEXT：握把按下后拖动实时换位）──
    // 拖拽中组件被卸（q 热键跳页等）时兜底摘 window 监听——不然 onMove
    // 会继续向存活父级 emit queue-move，队列在不可见页下被改
    let activeDragEnd = null
    const startDrag = (index, event) => {
      event.preventDefault()
      const container = queueContainer.value
      if (!container) return
      const pid = event.pointerId
      dragIndex.value = index
      // 命中判定走几何而非 DOM：等距行列表把 clientY 换算成全队列下标——
      // 不必再「物化到底」让落点域全量渲染（那会把大队列的瞬间 DOM 成本
      // 绑进每次握把按下）。pitch 取相邻行 top 差的中位数：单行 height
      // 会把「.queue-row+.queue-row」发丝边漏掉（无边行——窗内首行/分节线
      // 后行/全局 0 行——量矮 ~1.2px，乘上深下标就是数行级落点偏差）；
      // 中位数天然滤掉跨 queue-sec（+~28px）的异常对。虚拟窗下 DOM 首行
      // =全局 queueStartIndex 行，行顶原点回推至全局 0
      const rowEls = [...container.querySelectorAll('.queue-row')]
      const firstRow = rowEls[0]
      const draggedRow = rowEls[index - queueStartIndex.value]
      const diffs = []
      for (let k = 1; k < rowEls.length; k++) {
        const d = rowEls[k].getBoundingClientRect().top - rowEls[k - 1].getBoundingClientRect().top
        if (d > 30 && d < 80) diffs.push(d) // pitch ~54-56px；跨 queue-sec 对（~83px）滤出
      }
      diffs.sort((a, b) => a - b)
      const rowH = diffs.length
        ? diffs[diffs.length >> 1]
        : (draggedRow ? draggedRow.getBoundingClientRect().height : 0)
      const rowTop0 = firstRow
        ? firstRow.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
          - queueStartIndex.value * rowH
        : 0
      const total = props.queue.length

      const onMove = (e) => {
        if (e.pointerId !== pid || dragIndex.value === -1 || !rowH) return
        const cTop = container.getBoundingClientRect().top
        let y = e.clientY - cTop + container.scrollTop
        // 「接下来」分节线插在 currentQueueIndex 之后（~25px）——线下方的行
        // 在可视空间整体下移了 secH，均距换算前得从 y 里扣掉；分隔线随拖拽
        // 跨过当前曲会搬家，故每次 move 重查不缓存
        const sec = container.querySelector('.queue-sec')
        if (sec) {
          const secTop = sec.getBoundingClientRect().top - cTop + container.scrollTop
          if (y >= secTop) y -= sec.getBoundingClientRect().height
        }
        // 与原口径一致：越过行中点才算越过该行 → round 而非 floor；
        // 现在能命中渲染窗外的行（原实现被 rows.length 截断）
        const target = Math.min(total - 1, Math.max(0, Math.round((y - rowTop0) / rowH)))
        if (target !== dragIndex.value) {
          // 落点可越出滑窗——pinIndex(dragIndex) 会把被拖行钉在 DOM 里，
          // 换位后 dragIndex=target 窗跟着挪；窗内行按真实位置渲染，
          // 窗下被拖行只是不可见，不影响次序正确性
          emit('queue-move', { from: dragIndex.value, to: target })
          dragIndex.value = target
        }
      }
      const onEnd = () => {
        activeDragEnd = null
        dragIndex.value = -1
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
        window.removeEventListener('blur', onEnd)
      }
      activeDragEnd = onEnd
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

    // 【序】immediate 挂载即跑——离开再进 watch 时按持久化 tab 补一次
    // centerCurrentRow/loadRelated（旧版只在「变化」时跑：related tab 重进
    // 恒空、歌词/队列栏塌回顶部）。centerCurrentRow/lyricFollowPausedUntil
    // 声明都在下方——箭头包一层惰性求值躲 TDZ；let 声明只能上移到 watcher 前
    let lyricFollowPausedUntil = 0
    watch(() => props.tab, (t) => {
      if (t === 'related' && relatedFor !== props.currentSong?.id) loadRelated()
      // 切到队列/歌词时把当前行滚进视野（与原抽屉一致）
      if (t === 'queue' || t === 'lyrics') nextTick(() => centerCurrentRow())
      if (t === 'lyrics') lyricFollowPausedUntil = 0
    }, { immediate: true })
    // 恢复链/换曲晚到也要落位：挂载 immediate 跑时队列还空、currentSong 未
    // 落地，centerCurrentRow/loadRelated 双双扑空——对象到齐后按切 tab 同律
    // 补一次（队列跟随当前行本就应随换曲走，不算抢滚动）
    watch(() => props.currentSong?.id, () => {
      if (props.tab === 'related') loadRelated()
      if (props.tab === 'queue') nextTick(() => centerCurrentRow())
    })
    // 歌词异步到稿：暂停态下 currentLyricIndex 不变，其 watcher 不会触发——
    // 挂载时 tab=lyrics 的居中扑空后恒停在词首，到稿补一次。每曲只补一
    // 次：AI 译文合并会二次重赋值 lyrics（初稿后秒级落地），那时用户
    // 可能已滚离当前行——无闸再居中等于硬拽
    let lyricCenteredFor = null
    watch(() => props.lyrics, (l) => {
      if (props.tab !== 'lyrics' || !l?.length) return
      if (lyricCenteredFor === props.currentSong?.id) return
      lyricCenteredFor = props.currentSong?.id
      nextTick(() => centerCurrentRow())
    })

    // 单列态（<901px，与模板 wide: 断点同源）滚动器是 .watch-view 整页——
    // 容器不限高不内滚、scrollTop 恒 0，rect 法空转；此时 scrollIntoView
    // 只移动真滚动祖先，恰是整页居中所需。宽屏态用 rect 法只滚指定容器
    // ——scrollIntoView 会连滚所有祖先，双栏态拽动整页。
    const scrollRowIntoCenter = (container, el, smooth) => {
      if (!container || !el) return
      if (!window.matchMedia('(min-width: 901px)').matches) {
        el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
        return
      }
      const containerRect = container.getBoundingClientRect()
      const rowRect = el.getBoundingClientRect()
      const scrollOffset = (rowRect.top - containerRect.top + rowRect.height / 2) - containerRect.height / 2
      container.scrollTo({ top: container.scrollTop + scrollOffset, behavior: smooth ? 'smooth' : 'auto' })
    }
    const scrollLyricIntoCenter = (i, smooth) => {
      scrollRowIntoCenter(lyricContainer.value,
        lyricContainer.value?.querySelector(`[data-lyric-index="${i}"]`), smooth)
    }
    // 单列态整页滚：自动跟随只在歌词区覆盖视口中线时进行——用户还停在
    // 封面/操作区，或歌词区偏离正中时，不把整页拽过去。宽屏歌词栏自滚、
    // 不动整页，恒跟随。切 tab 是显式请求，centerCurrentRow 不走此闸
    const lyricsFollowable = () => {
      if (window.matchMedia('(min-width: 901px)').matches) return true
      const view = lyricContainer.value?.closest('.watch-view')
      const list = lyricContainer.value?.querySelector('.watch-lyric-list')
      if (!view || !list) return false
      const v = view.getBoundingClientRect()
      const r = list.getBoundingClientRect()
      const mid = v.top + v.height / 2
      return r.top <= mid && r.bottom >= mid
    }
    // 手动滑动后暂停自动跟随：手指滑动/滚轮期间及之后 4s 内不抢滚动——
    // 用户往回翻或往后看歌词时不被下一行拽回。单列态整页都是歌词的滚动器，
    // 页内任意处滑动都算；宽屏只认歌词栏内的滑动（左栏/队列滚动不影响歌词）。
    // 竖向位移 <10px 的 touchmove 视为轻点微漂、不暂停（真机点 A+/播放键常带
    // 1–2 个）；切到歌词 tab 是显式请求，清掉暂停。targetTouches 只读本页内
    // 触点——另根手指搭在页外（如底部播放条）时基线/探测仍配对同一根手指
    const LYRIC_FOLLOW_PAUSE_MS = 4000
    const SWIPE_SLOP_PX = 10
    // lyricFollowPausedUntil 上移到 props.tab watcher 前（immediate 序要）
    let touchStartY = 0
    const wideMq = window.matchMedia('(min-width: 901px)')
    const onWatchTouchStart = (e) => { touchStartY = e.targetTouches?.[0]?.clientY ?? 0 }
    const pauseLyricFollow = (e) => {
      if (wideMq.matches && !lyricContainer.value?.contains(e.target)) return
      if (e.type === 'touchmove'
        && Math.abs((e.targetTouches?.[0]?.clientY ?? touchStartY) - touchStartY) < SWIPE_SLOP_PX) return
      lyricFollowPausedUntil = Date.now() + LYRIC_FOLLOW_PAUSE_MS
    }
    const lyricFollowPaused = () => Date.now() < lyricFollowPausedUntil

    // ── 歌词/队列定位滚动 ──
    const centerCurrentRow = () => {
      if (props.tab === 'lyrics') {
        scrollLyricIntoCenter(props.currentLyricIndex, false)
      } else {
        // 当前行可能在滑窗外——直接按全局下标滚到位（scrollToIndex 自动
        // 挑当前真滚动根：宽屏 queueContainer、单列 viewEl；越界 -1 内部已挡）
        queueScrollToIndex(currentQueueIndex.value, { align: 'center' })
      }
    }

    watch(() => props.currentLyricIndex, async (i) => {
      if (props.tab !== 'lyrics' || i < 0) return
      await nextTick()
      if (lyricFollowPaused() || !lyricsFollowable()) return
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      scrollLyricIntoCenter(i, smooth)
    })

    // 字号变化全列重排——不等下一 tick 就重居中当前行，长间奏不空屏
    watch(lyricFontSize, () => nextTick(() => {
      if (props.tab === 'lyrics' && props.currentLyricIndex >= 0 && !lyricFollowPaused() && lyricsFollowable()) {
        scrollLyricIntoCenter(props.currentLyricIndex, false)
      }
    }))

    // ── 外部导入曲视频模式（B 站/YouTube 同一机制） ──
    // 偏好持久化：'0' 显式关，其余为开——视频源曲的价值就是画面，默认开。
    // LS_KEYS.VIDEO_MODE 沿用 B 站时代键名：YouTube 接入不换名重置用户选择
    const mediaVideoRef = ref(null)
    const coverWrapRef = ref(null)
    // <video> 止流清场：pause+摘 src+load 让解码器/缓冲区当帧释放——
    // 不等 DOM 移除后 GC 的惰性回收（脱离文档的媒体元素照样拉流，
    // 缓冲面按 MB 计）。v-if 摘元素的所有路径共用：切音频/开沉浸层/
    // 换 key/组件卸载
    const releaseVideoEl = (v) => {
      if (!v) return
      try { v.pause(); v.removeAttribute('src'); v.load() } catch { /* 卸载期媒体异常无碍 */ }
    }
    const videoOn = ref(safeGetLs(LS_KEYS.VIDEO_MODE) !== '0')
    watch(videoOn, v => {
      safeSetLs(LS_KEYS.VIDEO_MODE, v ? '1' : '0')
      // 开视频就是用户最自然的重试入口——复位失败闩重新拉流；
      // 自愈预算与档重探戳同刷：手动重试后当 key 可再排一次自动重试/重探
      if (v) { mediaVideoFailed.value = false; mediaRetriedKey = null; dlReprobedKey = null }
    })

    // 元素级全屏锁在封面 wrap 上（不是 video 元素本身）——悬停控制层随
    // wrap 一起进全屏仍可用；视频元素静音、时钟锚 Howler，全屏态音频继续
    // 走原管线不中断。webkit 前缀兜底旧 Safari
    const videoFullscreen = ref(false)
    const toggleVideoFullscreen = async () => {
      try {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement
        if (fsEl) {
          await (document.exitFullscreen || document.webkitExitFullscreen).call(document)
        } else {
          const el = coverWrapRef.value
          await (el?.requestFullscreen || el?.webkitRequestFullscreen)?.call(el)
        }
      } catch { /* 全屏被权限/iframe 策略拒——静默，icon 态随 fullscreenchange 不翻 */ }
    }
    // Esc/手势/系统级退出不经过本键——以 fullscreenchange 同步 icon 态；
    // 元素身份闸：别家元素（如 video 右键菜单的原生全屏）进全屏时 icon
    // 不该翻成「退出」态
    const onFullscreenChange = () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement
      videoFullscreen.value = fsEl === coverWrapRef.value
    }
    // iPhone Safari 无元素级 Fullscreen API（webkitEnterFullscreen 只挂
    // video 元素）——能力探测一次定案，不支持就不渲染全屏键
    const canElementFs = typeof document !== 'undefined'
      && !!(document.documentElement.requestFullscreen
        || document.documentElement.webkitRequestFullscreen)
    // 请求被拒走 fullscreenerror 而非 change——promise reject 已静默，
    // 这里补用户可见反馈（事件 target 是请求元素，只认自己 wrap 的）
    const onFullscreenError = (e) => {
      if (e?.target === coverWrapRef.value) toast('全屏请求被浏览器拒绝', 'error')
    }
    // 视频全屏下全局热键（←→/↑↓/m 等）也是操作——戳醒控制层给读数，不盲按。
    // 声明在此（监听挂载点之前）：pokeControls 后声明但回调体惰性求值，无 TDZ
    const onFsKey = () => { if (videoFullscreen.value) pokeControls() }
    // 后台 tab：rAF 冻结→syncMediaVideo 停摆，<video> 自走续播+拉流——
    // 隐藏即暂停（不卸载：切窗频繁，卸载=全量重缓冲；pause 后 preload 仅
    // 续到 buffer-ahead 上限，有界）。后台换曲的新挂载也不许起播——
    // play 分支全部带 hidden 闸；回前台经 syncMediaVideo 接回（isPlaying
    // 续播 + 0.45s 漂移校正）。可见性迁移=重试点：hidden 期 error 闩的
    // failed 一并复位，声明同 onFsKey 惰性求值
    const onVis = () => {
      const v = mediaVideoRef.value
      if (!document.hidden) {
        mediaVideoFailed.value = false
        syncMediaVideo()
        return
      }
      if (v) v.pause()
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('fullscreenchange', onFullscreenChange)
      window.addEventListener('webkitfullscreenchange', onFullscreenChange)
      window.addEventListener('fullscreenerror', onFullscreenError)
      window.addEventListener('webkitfullscreenerror', onFullscreenError)
      window.addEventListener('keydown', onFsKey)
      document.addEventListener('visibilitychange', onVis)
      onBeforeUnmount(() => {
        window.removeEventListener('fullscreenchange', onFullscreenChange)
        window.removeEventListener('webkitfullscreenchange', onFullscreenChange)
        window.removeEventListener('fullscreenerror', onFullscreenError)
        window.removeEventListener('webkitfullscreenerror', onFullscreenError)
        clearTimeout(controlsHideTimer)
        clearTimeout(mediaRetryTimer)
        activeDragEnd?.() // 拖拽中卸载：摘 window 指针监听
        window.removeEventListener('keydown', onFsKey)
        document.removeEventListener('visibilitychange', onVis)
        // <video> 显式清场：pause+摘 src+load 让解码器/缓冲区当帧释放，
        // 不等 DOM 移除后 GC 的惰性回收（视频流的缓冲面是按 MB 计的）
        releaseVideoEl(mediaVideoRef.value)
        // 卸载先于 DOM 移除——主动退掉自持的全屏，不等浏览器对脱离
        // 元素的事后清理（行为更确定，少一帧悬空全屏帧）
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement
        if (fsEl === coverWrapRef.value) {
          try {
            // 同步错误 try 兜，异步 reject（竞态下已先退）走 catch——不留 unhandled
            (document.exitFullscreen || document.webkitExitFullscreen)
              ?.call(document)?.catch?.(() => {})
          } catch { /* 退出被拒无碍——元素马上移除，UA 会兜底清场 */ }
        }
      })
    }
    // 控制层自隐：JS 驱动（CSS :hover 会让静止光标下的控件恒显）——
    // mousemove/pointerdown 戳醒 + 播放中 2.6s 自隐；暂停态常显
    // （画面静止时控件是唯一状态读数）。非全屏同律：光标停在画面上
    // 不动也要收。键盘焦点露出在 CSS 层走 :has(:focus-visible)
    const controlsOn = ref(false)
    let controlsHideTimer = null
    const pokeControls = () => {
      if (!mediaVideoActive.value) return // 封面/图态没有控制层，不空转戳醒
      controlsOn.value = true
      clearTimeout(controlsHideTimer)
      if (props.isPlaying) controlsHideTimer = setTimeout(() => { controlsOn.value = false }, 2600)
    }
    const controlsVisible = computed(() => controlsOn.value || !props.isPlaying)
    // 首触语义（YTM 同款）：层隐时首触只戳醒不暂停（戳＝亮控件，再点才动作），
    // 层显态点击才 toggle。pointerdown 在 video 上先于 wrap 冒泡的戳醒执行，
    // 捕获的是戳前可见性——桌面鼠标路径恒先 mousemove 故点击恒可暂停
    let tapWasVisible = false
    const onVideoPointerDown = () => { tapWasVisible = controlsVisible.value }
    const onVideoClick = () => { if (tapWasVisible) emit('toggle-play') }
    watch(videoFullscreen, (on) => {
      clearTimeout(controlsHideTimer)
      // 进全屏走 poke（亮一轮＋播放中顺便挂上自隐计时）；退出即清态
      if (on) pokeControls()
      else controlsOn.value = false
    })
    watch(() => props.isPlaying, (p) => {
      if (p) pokeControls()                 // 恢复播放→亮一轮重新计自隐
      else clearTimeout(controlsHideTimer)  // 暂停→常显（computed 的 !isPlaying 兜底）
    })
    // 视频流加载失败（CDN 全被拒/404）→ 回落封面图而不是黑盒；切歌重置
    const mediaVideoFailed = ref(false)
    // 瞬时断流自愈：每 mediaVideoKey 至多两次延迟复位重试——复位重挂即
    // 真重试，真死链会再 error 回闩且不再排新计时（上界=2，防重试循环）。
    // mediaStreamRetry 喂 youtube 流 URL 的 retry 参数——重试旁路服务端
    // 闸控判定缓存强制重探（见 onMediaVideoError）；bili/file 链用它只
    // 作重试计数。切歌（key 换）清零，新源拿满重试预算
    const mediaStreamRetry = ref(0)
    let mediaRetryTimer = null
    let mediaRetriedKey = null
    let mediaRetryN = 0
    // 视频源键：两个 provider 各取各自的定位串——换曲（哪怕同 provider）必然换键
    const mediaVideoKey = computed(() => {
      const song = props.currentSong
      // 按 provider 存在性出键而非导入期标记：标记被裁/老数据缺
      // hasDownloadableVideo 的曲盘上可能有已下载档（档在不在以
      // videoReady 探测为准），键在才让探测-下载档链路可达
      if (song?.bilibili?.bvid)
        return `bv:${song.bilibili.bvid}:${song.bilibili.cid || 0}:${song.bilibili.page || 1}`
      if (song?.youtube?.videoId)
        return `yt:${song.youtube.videoId}`
      // videoV 版本戳随换源刷新——key 不变 <video> 不重载，旧画面继续播
      if (song?.file?.hasVideo) return `file:${song.id}:${song.file.videoV || 0}`
      return null
    })
    // 切歌换键：重试预算清零——新源拿满重试机会（sync 抢在 mediaVideoUrl
    // 重算前落地，避免新曲首 URL 就带旧 key 的 retry 戳）
    watch(mediaVideoKey, () => { mediaStreamRetry.value = 0 }, { flush: 'sync' })
    // mediaVideoUrl 空串（探测在途）不挂载 <video>：src="" 会解析成页面
    // URL 被当媒体加载，error 误闩封面；URL 就绪才出元素
    // 视频只在 watch 页真正可见时存在：videoOn 是偏好而非在场证明——
    // 离开本页组件整体卸载；被沉浸歌词层盖住时虽仍挂载同样收掉（止流止损）。
    // 关层时本 computed 随 fullscreenPlayerOpen 翻回 true → <video> 重挂，
    // 对齐 watcher 负责接回音频时钟
    const mediaVideoActive = computed(() =>
      !!(mediaVideoKey.value && videoOn.value && !props.fullscreenPlayerOpen
        && !mediaVideoFailed.value && mediaVideoUrl.value))
    // 有无「确定可放」的视频源：在线流（hasVideo）或探测落地的本地档——
    // 音画切换键的 title 据此提示「需已下载视频档」而非空许诺
    const hasPlayableVideo = computed(() =>
      !!(props.currentSong?.bilibili?.hasVideo || props.currentSong?.youtube?.hasVideo
        || props.currentSong?.file?.hasVideo || downloadedVideoUrl.value))
    // 关层重挂=天然重试点：failed 闩若来自限流/瞬时断流（层开关不动 URL，
    // watch(mediaVideoUrl) 不会自愈），复位让这次重挂真重试——流确实死了
    // 会再 error 回闩，代价一跳
    watch(() => props.fullscreenPlayerOpen, (open) => {
      if (!open) mediaVideoFailed.value = false
    })
    // 已下载视频工件优先于在线流：本地 mp4 不撞 CDN 403/签名过期——歌单下
    // 的视频下载此前是纯只写功能（App 内无处可播）。探测跨歌单寻址——
    // 任务行按 (playlist,song) 登记，暂存/搜索队列或别单借源的播放没有
    // 归属歌单上下文，服务端 videoReady 按全表找档并回带寻址键
    // videoPlaylistId。切歌竞态用序号丢弃
    const downloadedVideoUrl = ref(null)
    // 探测在途闸：探测未落地前不往 <video> 绑在线流——否则每首已下载曲
    // 都白烧一次 CDN 请求，且秒挂型流（闸控 403）的 error 会先于探测闩封面
    const dlProbeSettled = ref(false)
    let dlVideoSeq = 0
    // 依赖不含 queueOwner：videoReady 跨歌单寻址后与归属无关——挂着它，
    // 播放到一半增删歌单翻转 queueOwner 会把 dlProbeSettled 打回 false
    // 拆掉 <video> 重缓冲。plId 仍随行报送（服务端给本单 task 字段用）
    // dlProbeNonce 重探戳：本地档播放期 404（档被搬到别单/重下到新单）
    // 时补一次重探找回——见 onMediaVideoError 本地档分支
    const dlProbeNonce = ref(0)
    // 重探单发戳：本地档 404 每 key 只补一次（坏档找回→再 error→不再探）
    let dlReprobedKey = null
    watch([mediaVideoKey, videoOn, dlProbeNonce], async () => {
      const seq = ++dlVideoSeq
      const song = props.currentSong
      const plId = props.queueOwner?.id ?? null
      // 下载档会话缓存（模块域 dlVideoCache）：离开再进 watch 时本地档
      // 即知即挂——免等探测 RTT 才出 <video>（封面→16:9 的迟到换形）；探测
      // 照跑复验：档没了清缓存换在线源，探测失败则信任缓存值继续用
      const cached = dlVideoCache.get(mediaVideoKey.value) ?? null
      downloadedVideoUrl.value = cached
      // 探测门按 provider 存在性而非导入期标记：标记被裁/老数据缺
      // hasDownloadableVideo 的 bv_/yt_ 曲盘上可能有档——档在不在以
      // videoReady 为准，不拿导入时的能力声明当工件真相。
      // 视频关着时不探——纯音频用户不该为每首视频曲白打一跳 status 请求
      const probeable = videoOn.value
        && (song?.bilibili?.bvid || song?.youtube?.videoId)
      if (!probeable) {
        dlProbeSettled.value = true
        return
      }
      // 缓存命中即放行（本地档当帧可挂，探测后台复验）；未命中才压闸等 RTT
      dlProbeSettled.value = !!cached
      try {
        const st = await downloadsApi.getSongDownloadStatus(plId, song.id)
        if (seq !== dlVideoSeq) return
        // videoReady 是服务端按工件维度的在盘判定（任一歌单 completed 行
        // videoPath 存在）——不查 filesIntact 合取：歌词/封面档缺失会把
        // 在盘视频误杀；videoPlaylistId 是 /file 的寻址键，工件按歌单
        // 目录组织，寻址用命中行的 playlistId 而非当前队列归属
        const url = (st?.data?.videoReady === true && st?.data?.videoPlaylistId != null)
          ? downloadsApi.songFileUrl(st.data.videoPlaylistId, song.id, 'video')
          : null
        downloadedVideoUrl.value = url
        if (url) dlCacheSet(mediaVideoKey.value, url)
        else dlVideoCache.delete(mediaVideoKey.value)
      } catch { /* 探测失败回落在线流（缓存值保留） */ }
      finally { if (seq === dlVideoSeq) dlProbeSettled.value = true }
    }, { immediate: true })
    const mediaVideoUrl = computed(() => {
      const song = props.currentSong
      const b = song?.bilibili
      // 与 mediaVideoKey 同口径按 provider 存在性进支：无标记曲只能靠
      // 本地档——b.hasVideo 为假时在线流位空串，不挂载（档缺席即空）
      if (b?.bvid) {
        if (!dlProbeSettled.value) return ''
        return downloadedVideoUrl.value
          || (b.hasVideo ? musicApi.bilibiliStreamUrl(b.bvid, 'video', b.cid, b.page) : '')
      }
      const y = song?.youtube
      if (y?.videoId) {
        if (!dlProbeSettled.value) return ''
        // mediaStreamRetry 戳进 URL：服务端闸控判定缓存可能错——重试带
        // &retry=1 旁路缓存读强制重探（retry>0 恒映射 retry=1，重载实际靠
        // mediaVideoFailed 闩的拆装而非 URL 换绑）；成功后 retry 戳保留——
        // 后续重挂继续旁路缓存读拿最新判定，比重放可能过期的缓存更安全
        return downloadedVideoUrl.value
          || (y.hasVideo ? musicApi.youtubeStreamUrl(y.videoId, 'video', '', mediaStreamRetry.value) : '')
      }
      // 上传曲的视频资产走 file 端点（kind=video→videoPath 列）；videoV 戳
      // 版本——同 URL 换源 <video> 不会重载，靠它让 mediaVideoUrl 变化触发复位
      return song?.file?.hasVideo ? fileArtifactUrl(song.id, 'video', song.file.videoV) : ''
    })
    // 本地档解码失败（hev1/av01-in-mp4 等 Safari 放不动的封装）——先回落
    // 在线流再闩封面：清 downloadedVideoUrl 让 mediaVideoUrl 换源重载，
    // watcher 顺带复位 mediaVideoFailed；在线源也失败才真闩
    const onMediaVideoError = (e) => {
      // 迟到的旧元素 error（换曲后 DOM 复用期）：key 换绑后旧元素的迟投
      // 事件不能打到新歌状态——按 target 身份闸
      if (e?.target && e.target !== mediaVideoRef.value) return
      // 同元素 src 换绑的迟投 error（本地档失败后已切在线流、旧资源又补发
      // 一次 error）：currentSrc 仍是旧资源时与当前 URL 不符——丢弃
      const curSrc = e?.target?.currentSrc
      if (curSrc && mediaVideoUrl.value
        && new URL(mediaVideoUrl.value, window.location.href).href !== curSrc) return
      if (downloadedVideoUrl.value && mediaVideoUrl.value === downloadedVideoUrl.value) {
        downloadedVideoUrl.value = null
        dlVideoCache.delete(mediaVideoKey.value) // 404 过的档别留缓存，下次挂载不再先挂死链
        // 档可能被搬到别单（404 而非坏档）：同 key 补一次重探找回——
        // 找回的是坏档会再 error，单次戳自然收敛，不会循环重探
        if (dlReprobedKey !== mediaVideoKey.value) {
          dlReprobedKey = mediaVideoKey.value
          dlProbeNonce.value++
        }
        return
      }
      mediaVideoFailed.value = true
      // 中途 CDN 抖一下不该把整曲打成封面——10s 后复位闩重挂真重试；
      // 每 key 至多两次（mediaRetriedKey 戳+计数），死链回闩后不再自愈。
      // 预算口径按挂载计：另一 key 也报过 error 才重置单槽戳——
      // A→B(error)→A 给 A 新预算，A→B(干净)→A 不重置，防重试循环。
      // 重试戳 mediaStreamRetry：youtube URL 带 &retry=1——服务端闸控
      // 判定缓存可能误判（SABR 探测无定论按未闸放行），重试旁路缓存读
      // 强制重探拿新候选，不是重放同一条死链；bili/file 链无判定缓存，
      // 计数不影响 URL，重挂本身即服务端重解
      if (mediaRetriedKey !== mediaVideoKey.value) {
        mediaRetriedKey = mediaVideoKey.value
        mediaRetryN = 0
      }
      if (mediaRetryN < 2) {
        mediaRetryN++
        clearTimeout(mediaRetryTimer)
        mediaRetryTimer = setTimeout(() => {
          if (mediaVideoFailed.value && mediaRetriedKey === mediaVideoKey.value) {
            mediaStreamRetry.value++
            mediaVideoFailed.value = false
          }
        }, 10000)
      }
    }
    // 复位键用 mediaVideoUrl——同曲换源（B 站换P/YouTube 重导）时新源该重新尝试
    watch(mediaVideoUrl, () => { mediaVideoFailed.value = false })

    // 全屏中视频模式确定消失（切到无视频曲/关视频开关/换源失败闩封面）——控制层
    // 随之卸载，留在全屏只剩 Esc 一条路；主动退全屏交还页面。
    // 双信号并查 dlProbeSettled：切到需探测的 bili/yt 曲时探测窗内 active 也会
    // 翻 false（URL 空串），探测在途不算「视频没了」——否则会连播到视频曲必退
    // 全屏；元素身份同查：只退自己 wrap 的全屏，不碰别家（原生全屏等）的
    // 【序】必须列在 mediaVideoActive/dlProbeSettled/mediaVideoUrl 三 const 之后——
    // 非 immediate watch 注册即 eager 求值 oldValue，靠前会 TDZ
    watch([mediaVideoActive, dlProbeSettled], () => {
      if (mediaVideoActive.value || !dlProbeSettled.value) return
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement
      if (fsEl === coverWrapRef.value) {
        try {
          (document.exitFullscreen || document.webkitExitFullscreen)
            ?.call(document)?.catch?.(() => {})
        } catch { /* 已在退出流程中 */ }
      }
    })

    // v-if 摘 <video> 不等于止流——脱离 DOM 的媒体元素照样拉流到 GC 回收。
    // 切音频（「省流量」键的本职）、开沉浸层、换 key 重建全走这条路：
    // flush:'pre' 抢在 patch 前跑，此刻元素仍在 DOM、ref 仍指向它——就地
    // pause+摘 src+load 当帧止流，与 onBeforeUnmount 同函数。
    // mediaVideoUrl 刻意不入依赖：同键换源（本地↔在线）元素不摘，
    // src 属性更新自身即触发资源重选，剥 src 反而打断续播
    watch([mediaVideoActive, mediaVideoKey], () => {
      releaseVideoEl(mediaVideoRef.value)
    }, { flush: 'pre' })

    // 音画同步：视频元素静音播放，时钟完全听 Howler——每帧对比 currentTime，
    // 漂移超阈值才 seek（RAF 每帧触发，此处只做减法+偶尔 seek，开销可忽略）。
    // 顺带 reconcile paused 态——watch(isPlaying) 只在翻转时触发，组件重挂载
    // （返回→重进 watch）与单曲循环重播时视频会停在末帧/暂停态，这里兜底拉起
    const VIDEO_DRIFT_SEC = 0.3 // 唇形可感约 0.1s 起——在可感偏移与校正跳切频率间取中
    let mediaPlayTrying = false
    // play() 在极端旧内核可同步抛错、部分内核不返 promise——统一走带闩封装：
    // 闩挡同元素并发 play（竞速 abort 报错噪音），finally 保证闩必解。
    // 身份闸：旧元素被 key 重建/摘除后其迟 settle 的 finally 不能误清新
    // 元素的闩（新闩由挂载 watcher 自管复位）
    const tryMediaPlay = (v) => {
      mediaPlayTrying = true
      try {
        Promise.resolve(v.play()).catch(() => {}).finally(() => {
          if (mediaVideoRef.value === v) mediaPlayTrying = false
        })
      } catch { mediaPlayTrying = false }
    }
    const syncMediaVideo = () => {
      const v = mediaVideoRef.value
      // document.hidden 闸：后台 tab 里 rAF 虽停，本函数仍会被 onVis 外的
      // watcher（isPlaying 翻转等）调到——后台不许 play/seek，回前台由 onVis 接回
      if (!v || !mediaVideoActive.value || v.error || document.hidden) return
      // 音画时长错位（导入曲常态）：音频更长的尾段里 v.ended 是真「播完」——
      // 不戳 play（否则每帧空戳一遍）；seek 目标按时长截断，钉在 duration
      // 的指针不再每帧重 seek 同一值（旧版此处是 seek+play 双风暴）
      const dur = Number.isFinite(v.duration) ? v.duration : Infinity
      // 钉在流边界即终态：容器元数据 duration 可比实际流长（尾包缺口），
      // seekable.end 才是真终点——目标不可达时 UA 钳回的点会永远 |diff|>阈，
      // 每完成一次 seek 立刻重发下一个（串行空 seek）。缓冲卡顿期画面同样
      // 钉在边界上，此处不戳 seek 等缓冲续上再跳，顺带降噪
      const seekEnd = v.seekable?.length ? v.seekable.end(v.seekable.length - 1) : dur
      // 音频已越过真实流尾且视频钉在流尾（或已 ended）= 终态：不戳 play
      // （ended 元素 play 会从头重播再 ended，每帧一遍是风暴）、不重发
      // 不可达 seek。回拖音频到流尾内即解锁（比较基准是 seekEnd 而非
      // duration——duration 元数据可能虚高）
      const atTail = props.currentTime >= seekEnd
        && (v.ended || v.currentTime >= seekEnd - VIDEO_DRIFT_SEC)
      if (props.isPlaying && v.paused && !mediaPlayTrying && !atTail) {
        tryMediaPlay(v)
      } else if (!props.isPlaying && !v.paused) v.pause()
      const target = Math.min(props.currentTime, dur)
      // v.seeking 中不叠 seek——缓冲卡顿期的校正打进未缓冲段只会再卡
      if (!v.seeking && !atTail && Math.abs(v.currentTime - target) > VIDEO_DRIFT_SEC) {
        v.currentTime = target
      }
    }
    watch(() => props.currentTime, syncMediaVideo)
    watch(() => props.isPlaying, syncMediaVideo)
    // 切歌/开关视频时 src 变化或元素重建——等到新 metadata 落地再对齐时钟，
    // 避免对空 player 空 seek；监听键含 mediaVideoUrl——同曲换源（本地档
    // 解码失败回落在线流）active/key 都不变，但新资源要从 0 起播需重对齐
    // immediate 覆盖挂载瞬间条件已满足的情形（syncMediaVideo 也兜底）
    watch([mediaVideoActive, mediaVideoKey, mediaVideoUrl], async () => {
      if (!mediaVideoActive.value) return
      pokeControls() // 重挂（沉浸层关/切歌/开关视频）亮一轮控件，沿用自隐计时
      await nextTick()
      const v = mediaVideoRef.value
      if (!v) return
      mediaPlayTrying = false // 新元素不继承旧元素可能永不 settle 的 play 闩
      const align = () => { v.currentTime = props.currentTime }
      if (v.readyState >= 1) align()
      else v.addEventListener('loadedmetadata', align, { once: true })
      // hidden 闸：后台 tab 里换曲/重挂不许起播——静音视频后台自走=整首白烧
      // 流+解码；align 照常（seek 静默无流损），回前台由 onVis→syncMediaVideo 续播
      if (props.isPlaying && !document.hidden) tryMediaPlay(v)
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
      viewEl,
      mainColEl,
      relatedEl,
      queueTotalLabel,
      queueRows,
      queueStartIndex,
      queueTopPad,
      queueBottomPad,
      bindQueueAnchor,
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
      songCoverUrl, songThumbUrl, isFileTrackId,
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
      coverWrapRef,
      videoFullscreen,
      toggleVideoFullscreen,
      canElementFs,
      controlsVisible,
      pokeControls,
      onVideoPointerDown,
      onVideoClick,
      videoOn,
      mediaVideoActive,
      mediaVideoKey,
      mediaVideoUrl,
      hasPlayableVideo,
      onMediaVideoError,
      pauseLyricFollow,
      onWatchTouchStart
    }
  }
}
</script>

<style scoped>
/* 主区页内视图（青纸画布）——走带已移除（底栏承担），信息面板垂直居中 */
/* 布局壳的盒模型已上模板工具类（mobile-first）：移动基态单列整页滚
   ——本层是唯一滚动器；≥901px 转双栏内滚，车道移交各栏 */
.watch-view {
  scrollbar-gutter: stable;
  /* 顶条钉高：watch-tabs 的 sticky top 与本条 height 同源（--topnav-h 先例） */
  --watch-top-h: 52px;
}

/* 浮层顶行：返回键钉左页角。
   移动基态入流 sticky——.watch-view 是真滚动器，absolute 会随内容滚走、
   深滚后失去唯一返回路径；宽屏态改回 absolute 不占流（栏内自滚）。
   pointer-events:none 带子让下方内容可点，仅按键自身接收点击 */
.watch-top {
  position: sticky;
  top: 0;
  left: 0;
  right: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  /* 定高 52px（10 上 + 32 ink-btn--sm + 10 下）让 tabs 钉点有单一事实源 */
  height: var(--watch-top-h, 52px);
  /* 列向 flex 滚动器里内容一溢出，收缩全落到本项（min-content 仅 32px 键高），
     tabs 钉点下漏 20px 透字缝——与 .watch-tabs 同律禁缩；宽屏 absolute 出流后无效无碍 */
  flex-shrink: 0;
  padding: 0 20px;
  /* sticky 钉顶时衬画布色——滚过的歌词/队列行不透字 */
  background: var(--view-canvas, var(--paper));
  pointer-events: none;
}
.watch-top > * { pointer-events: auto; }

/* ── 左栏：封面 + 信息 + 操作 ──
   盒模型走模板工具类；本规则只剩宽屏双车道（见 min-width 块） */

.watch-cover {
  /* width 里的 100% 对 shrink-to-fit 父级是循环%——fallback 分支塌成 42px。
     min() 只留物理上限，收窄交给 max-width。移动基态按视口宽取小（单列）；
     横屏矮机再受 55svh 高约束（svh 不可识别时整条作废、回退上行声明） */
  width: min(64vw, 320px);
  width: min(64vw, 320px, 55svh);
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
   移动基态占满栏宽（整页滚动，高度不占视口预算）；宽屏上限 70vh 反推宽
   （封面 min(46vh,420px) 面积约 17.6万px²；1152×648 ≈ 74.7万，~4×） */
.watch-cover--video {
  width: min(100%, 1280px);
  aspect-ratio: 16 / 9;
  object-fit: contain;
  image-rendering: auto;
  background: #000;
  /* 点画面=播放/暂停——禁掉双击缩放手势带来的 ~300ms 点击延迟 */
  touch-action: manipulation;
}

/* 视频态 wrap 必须占满栏宽：wrap 在 align-items:center 的 flex 栏里是
   shrink-to-fit，否则视频 width:% 与 wrap 构成循环约束、退回片源内建宽。
   relative 是悬停控制层（.watch-video-controls）的定位锚 */
.watch-cover-wrap--video { width: 100%; position: relative; }

/* 视频悬停控制层：默认隐，JS --on 驱动露出（戳醒 2.6s 自隐，暂停常显；
   全屏/非全屏/触屏同律——CSS :hover 与 hover:none 都会让控件恒显压屏，
   故全态移交 JS）；键盘 Tab 由 :has(:focus-visible) 兜底露出——透明度
   为 0 的键可聚焦但不可见是键盘陷阱。层自身不吃指针，穿透到视频/行
   背景，两枚子键各开 pointer-events */
.watch-video-controls {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity .16s ease;
  pointer-events: none;
}
.watch-video-controls--on,
.watch-cover-wrap--video:has(:focus-visible) .watch-video-controls {
  opacity: 1;
}
/* 子键 pointer-events 随可见性走：层隐（opacity 0）时键不可见也不可点——
   否则静止画面上的点击会命中隐形全屏键；键盘焦点露出态同样恢复可点 */
.watch-video-controls :is(.watch-video-toggle, .watch-video-fs) { pointer-events: none; }
.watch-video-controls--on :is(.watch-video-toggle, .watch-video-fs),
.watch-cover-wrap--video:has(:focus-visible) :is(.watch-video-toggle, .watch-video-fs) {
  pointer-events: auto;
}
/* 键盘焦点露出用 :has(:focus-visible) 而非 :focus-within——鼠标点过的键
   持 :focus 不持 :focus-visible：focus-within 会把控件钉成恒显（配合
   cursor:none 形成「恒显控件+消失光标」的最坏组合）。range 拖杆点击
   持 :focus-visible——焦点在可操作件上就该常显，语义正确。
   无 :has 的老浏览器退 focus-within：宁恒显勿键盘陷阱 */
@supports not (selector(:has(:focus-visible))) {
  .watch-cover-wrap--video:focus-within .watch-video-controls { opacity: 1; }
  .watch-cover-wrap--video:focus-within :is(.watch-video-toggle, .watch-video-fs) {
    pointer-events: auto;
  }
}
/* 全屏下控件收掉时连光标一起隐——同沉浸页/流媒体播放器的 idle 手势 */
.watch-cover-wrap--idle { cursor: none; }

@media (prefers-reduced-motion: reduce) {
  .watch-video-controls, .watch-video-toggle, .watch-video-fs { transition: none; }
}

/* 中央播放/暂停：半透明墨底圆形——像素风的方角体系里，圆形是「媒体
   传输键」的跨站通用符（YouTube/Netflix 同款），特意破例 */
.watch-video-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 58px;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, .55);
  color: #fff;
  cursor: pointer;
  transition: background .15s ease, transform .15s ease;
}
.watch-video-toggle:hover { background: rgba(0, 0, 0, .75); transform: scale(1.06); }
/* 焦点环白描边在亮画面（MV 高光帧）下不可见——外圈补暗晕保证双底色可读；
   box-shadow 随 border-radius 走，圆键得圆环 */
.watch-video-toggle:focus-visible,
.watch-video-fs:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
  box-shadow: 0 0 0 4px rgba(0, 0, 0, .75);
}

/* 右下全屏键：同款半透明墨底，方角小键贴视频下缘 */
.watch-video-fs {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  background: rgba(0, 0, 0, .55);
  color: #fff;
  cursor: pointer;
  transition: background .15s ease;
}
.watch-video-fs:hover { background: rgba(0, 0, 0, .75); }

/* 元素全屏态：wrap 黑场居中，视频吃满屏（16:9 信箱由 object-fit:contain
   兜住，宽高 100% 只为占满容器）；悬停控制层此时仍在屏内可用。
   :-webkit-full-screen 是 Safari≤16.3 的旧伪类——不能并进 :fullscreen
   选择器组（不识别的伪类会让整条规则作废），单列一份 */
.watch-cover-wrap:fullscreen {
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.watch-cover-wrap:fullscreen .watch-cover--video {
  width: 100%;
  height: 100%;
  border: 0; /* .watch-cover 的墨发丝框在纯黑场里只剩噪点 */
}
.watch-cover-wrap:-webkit-full-screen {
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.watch-cover-wrap:-webkit-full-screen .watch-cover--video {
  width: 100%;
  height: 100%;
  border: 0;
}

/* 视频态整栏转左缘构图：剥 px-2 内补距让播放器左缘落在页缘 20px——
   与 .watch-top 返回键的 padding 同源对齐；居中态下的标题/操作在
   左对齐大播放器下面会失调，一并转左（YTM watch 视频页同款排法） */
.watch-main--video {
  padding-left: 0;
  padding-right: 0;
  align-items: flex-start;
  text-align: left;
}
.watch-main--video .watch-actions { justify-content: flex-start; }

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

/* ── 右栏：发丝线分栏的 tab 面板 ──
   盒模型走模板工具类；本规则只剩栏界标尺 */

/* 栏界羽化标尺：ink-30 细线、两端渐隐。移动基态转横（单列态栏界在上方）；
   ≥901px 回竖版（见 min-width 块） */
.watch-side::before {
  content: '';
  position: absolute;
  left: 24px;
  right: 24px;
  top: 0;
  height: 1.2px;
  background: linear-gradient(to right, transparent, var(--ink-30) 12%, var(--ink-30) 88%, transparent);
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
  /* 宽与封面同轴——移动基态跟随封面 min(64vw,320px[,55svh])：
     横屏矮机上封面按 55svh 收缩，横幅不跟上就会比封面还宽 */
  width: min(64vw, 320px);
  width: min(64vw, 320px, 55svh);
  max-width: 100%;
  text-align: left;
}

.watch-banner-tag {
  font-family: var(--font-mono);
  font-weight: 300;
  letter-spacing: .05em;
  color: var(--accent-danger-ink);
}

.watch-tabs {
  flex-shrink: 0;
  /* 单列整页滚下 tabs 随页流走会迫使深滚用户滚回顶——钉在顶条之下
     （top 与 --watch-top-h 同源；宽屏块内复位 static——sticky 的 inset
     约束在非滚动 scrollport 上仍生效，不复位会被强压 32px） */
  position: sticky;
  top: var(--watch-top-h, 52px);
  z-index: 4;
  /* 滚过内容不透字（同 .watch-top 的画布衬底） */
  background: var(--view-canvas, var(--paper));
}

/* 移动基态：不限高不内滚（YTM 整页滚动语义——队列/歌词随页流）；
   ≥901px 回栏内滚（flex:1+min-height:0+overflow，见 min-width 块） */
.watch-side-body {
  padding-top: 8px;
  /* 滚动影叠尺：基座发丝线之外，内容压到 tab 下时再叠一道 scroll 影——
     画布色盖片 local 随内容滚走 → 钉在顶缘的影显露；回顶时盖片重新遮住。
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

/* 触屏无 hover——把手常显（且升到实墨，半透明档不可见）；
   宽 20→28px 够到 24px 触控地板外沿，也给拖拽一根能抓住的条 */
@media (hover: none){
  .watch-grip { opacity: 1; pointer-events: auto; color: var(--ink); width: 28px; }
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

/* 队列页脚：发丝顶隔把操作/偏好收成一条栏，与行列表的记账线呼应。
   顶隔贴死末行底缘（margin 悬空会让线读成「最后一卡的下边框带间隙」）；
   行间分隔靠 .queue-row + .queue-row 的 border-top 同口径 */
.watch-queue-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 窄屏三件套（存为/清空/自动播放 label）放不下时换行，不硬裁 */
  flex-wrap: wrap;
  padding: 10px 4px 12px;
  border-top: var(--hairline-soft);
}
/* 空队列只剩自动播放开关——去掉顶隔线并居中，不吊在角落 */
.watch-queue-foot--empty { border-top: none; justify-content: center; }

.watch-autoplay {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  padding: 4px 6px; /* 命中高 ~24.5——对齐仓内 24px 触控地板（lyric-tool 同档） */
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
  /* 长歌词（串烧/整张碟上千行）的屏外行跳布局/绘制；字号变档时 auto
     记录的真实尺寸随之更新，scrollIntoView 会强制即时渲染目标行 */
  content-visibility: auto;
  contain-intrinsic-size: auto 30px;
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
  gap: 6px 10px;
  /* ≤330px 视口两组 ~290px 放不下——换行而不裁右边组 */
  flex-wrap: wrap;
  padding: 4px 16px;
  flex-shrink: 0;
}
.lyric-tools-group { display: flex; align-items: center; gap: 4px; }
.lyric-tool {
  font-size: 10px;
  line-height: 1;
  padding: 5px 7px;
  min-height: 24px; /* 触控地板与仓内 pg-icobtn--sm 同档（pad-block 5 凑整 24） */
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
  font-size: 10px; /* 裸 span 继承 body 16px 会夹在 10px 控件间形制分裂——显式同档 */
  font-variant-numeric: tabular-nums;
  color: var(--ink-86);
}
/* 校准值键兼复位：按最大刻度 ±300.0s 预留宽，避免值跳变时整组位移 */
.lyric-tool-reset { min-width: 56px; }

/* ── 宽屏增强（mobile-first 反转点 ≥901px，与模板 wide: 断点同源）──
   双栏内滚态：本层不滚、左右栏各自管车道；此前移动基态曾在此犯
   「flex:1+min-height:0 未解除 → 侧栏压成内滚细条」的错——
   反转后限高只存在于宽屏态，单列从结构上不存在挤压路径 */
@media (min-width: 901px) {
  .watch-view { scrollbar-gutter: auto; }

  /* 宽屏顶行回浮层不占流——栏内自滚，键位钉在各栏内容之上 */
  .watch-top {
    position: absolute;
    height: auto;
    padding: 20px;
    background: none;
  }

  /* sticky inset 约束在非滚动 scrollport 上仍生效——不显式复位，
     tabs 会被 --watch-top-h(52px) 钉点从侧栏天然位（20px）强压 32px */
  .watch-tabs { position: static; }

  /* 居中栏的单边 gutter 会把封面掰偏 ~5px——both-edges 双侧车道保真居中
     （旧浏览器不认两关键字写法时回退到上行 stable）。
     视频态是左缘构图：左车道反把播放器推离返回键左缘（经典滚动条 11px）——
     只留右车道，播放器向左吃满到返回键轴（栏宽绑定时增宽 11px、右缘不动）。
     safe center：内容超高时向上对称溢出，顶部封面被裁且无法滚达——
     safe 让溢出改走底部（不支持 safe 的浏览器回退原 center 行为） */
  .watch-main {
    justify-content: safe center;
    scrollbar-gutter: stable;
    scrollbar-gutter: stable both-edges;
  }
  .watch-main--video { scrollbar-gutter: stable; }

  .watch-cover { width: min(46vh, 420px); }
  /* 视频是主内容、须明显大于方形封面 */
  .watch-cover--video { width: min(100%, 1280px, calc(70vh * 16 / 9)); }
  .watch-banner { width: min(46vh, 420px); }

  /* 栏界标尺回竖版（gap 24 → 栏内 padding-left 24：标尺两侧留白对称） */
  .watch-side::before {
    left: 0;
    right: auto;
    top: 24px;
    bottom: 24px;
    width: 1.2px;
    height: auto;
    background: linear-gradient(to bottom, transparent, var(--ink-30) 12%, var(--ink-30) 88%, transparent);
  }

  .watch-side-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }
}
</style>
