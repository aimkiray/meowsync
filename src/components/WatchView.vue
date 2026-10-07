<template>
  <!-- YTM /watch 播放页：顶行 返回+操作，左栏 媒体本体，右栏 待播/歌词/相关
       tab。走带/进度/音量/歌曲 meta 不重复渲染——底部播放条已覆盖 -->
  <div ref="viewEl" class="watch-view relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden wide:overflow-y-hidden" :class="{ 'watch-view--video': mediaVideoActive }" @touchstart.passive="onWatchTouchStart" @touchmove.passive="pauseLyricFollow" @wheel.passive="pauseLyricFollow">
    <!-- 顶行：移动态 sticky 钉顶（在流占一行），宽屏 absolute 浮层不占流 -->
    <div class="watch-top">
      <button class="ink-btn ink-btn--ghost ink-btn--sm" @click="$emit('back')" title="返回上一页"><PixelIcon name="chev-l" :size="14" />返回</button>
      <!-- 操作键与返回键同排：顶行即页工具栏，左栏只留媒体本体（YTM mweb
           播放器页同款——顶条收 collapse+操作，画面区零干扰） -->
      <div class="watch-actions">
        <button class="ink-btn ink-btn--ghost ink-btn--sm watch-action" @click="$emit('open-fullscreen')" title="全屏歌词模式">
          <PixelIcon name="lyrics" :size="14" /> 沉浸
        </button>
        <!-- file_ 上传曲没有源站可分享链接（?song= 只收数字 id）——死链不亮 -->
        <button v-if="!isFileTrackId(currentSong?.id)" class="ink-btn ink-btn--ghost ink-btn--sm watch-action" @click="shareSong" :disabled="!currentSong">
          <PixelIcon name="share" :size="14" /> 分享歌曲
        </button>
        <!-- 下载到服务器：file_ 上传曲资产本就在服务端（无可下对象）不亮键。
             busy/已下载态由 songDownloading/songDownloaded 透传——提交、镜像、
             终态轮询全在 usePlayer 侧，切歌任务照跑、键面随曲换 -->
        <button
          v-if="currentSong && !isFileTrackId(currentSong.id)"
          class="ink-btn ink-btn--ghost ink-btn--sm watch-action"
          :disabled="songDownloading || songDownloaded"
          :title="songDownloaded ? '已下载到服务器' : '下载到服务器'"
          @click="$emit('download-song')"
        ><span v-if="songDownloading" class="pixel-loading" aria-hidden="true"></span><PixelIcon v-else :name="songDownloaded ? 'check' : 'download'" :size="14" /> {{ songDownloading ? '下载中…' : (songDownloaded ? '已下载' : '下载') }}</button>
        <!-- 回源：新页打开源站原页。<a> 原生链接语义（可中键/复制链接）；
             noreferrer 不给源站带去本站 Referer -->
        <a
          v-if="sourceUrl"
          class="ink-btn ink-btn--ghost ink-btn--sm watch-action"
          :href="sourceUrl"
          target="_blank"
          rel="noopener noreferrer"
          :title="`回源：在${sourceName}打开原页`"
        ><PixelIcon name="external" :size="14" /> {{ sourceName }}</a>
        <!-- 音画切换对「可能有视频」的曲出现；关闭即只拉音频流省流量。
             bv/yt 按 provider 存在性出键（与 mediaVideoKey 同律）——导入标记
             可能被裁/老数据缺标，盘上躺着档的曲也要能切回音频、VIDEO_MODE=0
             的用户也要有入口开视频重探；裸 bv_/yt_ id（缺对象老行）凭 id
             形态同出键；file_ 仍按 hasVideo（上传曲的标记即工件真相，探测链
             对它关闭）。bv/yt 都有在线流位可乐观放行（yt 经 YT_PROXY 恢复）——
             残余「判无可放」情形（hasVideo=false 的 bv 稿且无档）靠 title
             提示降级。
             键面文案=目标动作（点此即切到所示模式），与 title 同向——态指示
             留给 --on 反色承担。aria-pressed 撤掉改 aria-label：pressed 报
             当前态、文案报目标态会把「音频·已按下」读成音频在场——label
             自带「当前 X 模式」句补回态信息。title/aria-label/键面文案同出
             setup 的 avToggle computed——三处串单源，改文案不漂移 -->
        <button
          v-if="currentSong?.bilibili?.bvid || currentSong?.youtube?.videoId
            || currentSong?.file?.hasVideo || bvM || ytM"
          class="ink-btn ink-btn--ghost ink-btn--sm watch-action"
          :class="{ 'watch-action--on': videoOn }"
          @click="videoOn = !videoOn"
          :title="`切到${avToggle.action}`"
          :aria-label="`音画切换，当前${avToggle.current}模式，切到${avToggle.action}`"
        ><PixelIcon name="av-switch" :size="14" /> {{ avToggle.target }}</button>
      </div>
    </div>

    <!-- 槽距走 scoped 层令牌：横槽 --page-pad-x（≤640→12）、宽屏四边
         --watch-vpad 阶梯（纵分量喂 --watch-reserved-h）。侧列份额改 40%
         ——% 的分母是栏域实宽（vw 口径不扣页槽/栏缝，声明 38% 实占 ~41%） -->
    <div class="watch-layout flex flex-col gap-4 pb-5 pt-3 wide:grid wide:min-h-0 wide:flex-1 wide:grid-cols-[minmax(0,1fr)_min(400px,40%)] wide:gap-6">
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

        <!-- 歌名/歌手·专辑·时长/操作键都不在本栏——meta 与底栏播放器重复、
             操作键已并入顶行；左栏只剩媒体本体 + 横幅（YTM mweb 同款取舍） -->

        <!-- 播放错误/警告在媒体下方——归属左栏信息区，不占右栏 tab 顶部 -->
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
            <!-- ≤640 底栏减负收走 shuffle/模式键后，本页语义落点即队列头
                 （YTM UP NEXT 头即置 shuffle/repeat——队列顺序控件归队列面板） -->
            <span class="queue-modes">
              <button
                type="button"
                class="queue-mode-btn"
                :class="{ 'queue-mode-btn--on': shuffleOn }"
                @click="$emit('toggle-shuffle')"
                :title="`随机播放${shuffleOn ? '（开）' : ''}`"
                :aria-pressed="shuffleOn"
                aria-label="随机播放"
              ><PixelIcon name="shuffle" :size="14" /></button>
              <button
                type="button"
                class="queue-mode-btn"
                @click="$emit('toggle-play-mode')"
                :title="`播放模式：${playModeText || '列表循环'}`"
                :aria-label="`切换播放模式，当前：${playModeText}`"
              ><PixelIcon :name="playModeIcon" :size="13" /></button>
            </span>
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
              <!-- 「接下来」分节线：印单的分栏刻痕，只在当前行之后出现。
                   ref 实量真高回喂滑窗垫片归位（见 script 归位块） -->
              <div v-if="queueStartIndex + i === currentQueueIndex && queueStartIndex + i < queue.length - 1" :ref="bindQueueSec" class="queue-sec">接下来 · {{ queue.length - currentQueueIndex - 1 }} 首</div>
            </template>
            <!-- 虚拟滚动下沿 spacer -->
            <div :style="{ height: queueBottomPad + 'px' }" aria-hidden="true"></div>
          </template>
        </div>

        <!-- 队列页脚钉在面板底缘（YTM UP NEXT 同构）——不挂进滚动体，
             千行队列时不必滚到底才够得着；空队列时只剩居中开关。
             移动单列态随页流、视觉位置与嵌在列表尾部相同；视频分屏态
             侧栏是有界 flex 列，flex 序把它钉在栏底（同宽屏/歌词工具条） -->
        <div v-show="tab === 'queue'" class="watch-queue-foot" :class="{ 'watch-queue-foot--empty': !queue.length }">
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

        <!-- 歌词工具条：字号调节（本机偏好）+ 时间校准（按词源入库）。
             DOM 序钉在歌词面板之后——宽屏/视频分屏态由 flex 序收在侧栏
             底缘（队列页脚同款钉底约定，滚动体之外恒可见）；单列整页滚
             态靠 sticky bottom 吸附在滚动口下沿——滚词恒可够到，不必
             翻到全表末尾（低频校准件不抢钉顶，钉顶空间留给 tabs） -->
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
          <div class="lyric-tools-group" role="group" aria-label="歌词获取">
            <!-- 手动重打外源级联（YTM→LRCLIB→酷狗）：曲名以 song.name
                 （手改过的）优先——防降级闸在 usePlayer 侧；busy 由
                 lyricFetching 透传，防重入也在那边收口 -->
            <button type="button" class="lyric-tool lyric-tool--icon"
              :disabled="songSwitching || loadingLyrics || lyricFetching"
              @click="$emit('lyric-fetch')"
              :title="lyrics.length ? '重新从外部词源获取歌词' : '从外部词源获取歌词'"
              :aria-label="lyrics.length ? '重新获取歌词' : '获取歌词'"
            ><PixelIcon name="download" :size="11" /> {{ lyricFetching ? '获取中…' : (lyrics.length ? '重新获取' : '获取歌词') }}</button>
            <!-- 纯文本词（无时间戳行）才露脸——滚动词再对齐是降级 -->
            <button v-if="lyrics.length && lyrics.every(l => !Number.isFinite(l.time))"
              type="button" class="lyric-tool lyric-tool--icon"
              :disabled="songSwitching || loadingLyrics || lyricFetching"
              @click="$emit('lyric-align')"
              title="按已下载音频给歌词打时间轴" aria-label="生成滚动歌词"
            ><PixelIcon name="sand" :size="11" /> {{ lyricFetching ? '生成中…' : '生成滚动词' }}</button>
          </div>
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
import { useVirtualList, dividerPadAdjust, dividerRowShift } from '../composables/useVirtualList.js'
import { readScrollMem, writeScrollMem, restoreScrollTop } from '../lib/scroll-mem'
import { musicApi } from '../api/music'
import { downloadsApi } from '../api/downloads'
import PixelIcon from './PixelIcon.vue'
import { shareOrCopy, songShareUrl } from '../lib/share'
import { toast } from '../lib/feedback'
import { formatTime } from '../lib/format'
import { httpsCover, BV_TRACK_ID_RE, YT_TRACK_ID_RE } from '../lib/url'
import { songSourceUrl, songSourceName, songCoverUrl, songThumbUrl, fileArtifactUrl, isFileTrackId } from '../lib/song'
import { prefVideoOn, prefLyricFontSize, LYRIC_FS_MIN, LYRIC_FS_MAX } from '../lib/prefs'

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
  components: { PixelIcon },
  props: {
    currentSong: { type: Object, default: null },
    isPlaying: { type: Boolean, default: false },
    // 音频时钟（秒，RAF 更新）——外部导入曲视频模式的画面以此锚定做漂移校正
    currentTime: { type: Number, default: 0 },
    songSwitching: { type: Boolean, default: false },
    queue: { type: Array, default: () => [] },
    queueTitle: { type: String, default: '' },
    queueOwner: { type: Object, default: null },
    lyrics: { type: Array, default: () => [] },
    currentLyricIndex: { type: Number, default: -1 },
    loadingLyrics: { type: Boolean, default: false },
    // 手动词务在途（获取歌词/生成滚动词）——工具条 busy 态与防重点击
    lyricFetching: { type: Boolean, default: false },
    // 歌词时间校准（ms，正=提前）——值与持久化都在 App 侧，这里只做调节入口
    lyricOffsetMs: { type: Number, default: 0 },
    playbackError: { type: String, default: '' },
    durationWarning: { type: String, default: '' },
    tab: { type: String, default: 'queue' },
    autoplay: { type: Boolean, default: false },
    // ≤640 队列头模式对的状态（底栏同 prop 契约——图标由 playMode 派生，
    // 与 BottomPlayer 的 playModeIcon 同映射）
    shuffleOn: { type: Boolean, default: false },
    playMode: { type: String, default: 'list' },
    playModeText: { type: String, default: '' },
    // 沉浸歌词层开着时本页仍挂载但被整体盖住——视频此时不可见，
    // mediaVideoActive 据此收掉（卸载 <video> 止流，关层经对齐链重挂续播）
    fullscreenPlayerOpen: { type: Boolean, default: false },
    // 顶行「下载」键态：busy 按曲锚定透传（usePlayer.downloadingSongId）、
    // 已下载态来自 App 侧探测——提交/轮询动作走 download-song emit
    songDownloading: { type: Boolean, default: false },
    songDownloaded: { type: Boolean, default: false }
  },
  emits: [
    'back', 'open-fullscreen', 'toggle-play',
    'toggle-shuffle', 'toggle-play-mode',
    'update:tab', 'update:autoplay',
    'queue-jump', 'queue-remove', 'queue-move', 'save-queue', 'clear-queue',
    'play-song', 'open-source', 'add-to-playlist',
    'lyric-offset-adjust', 'lyric-offset-reset',
    'lyric-fetch', 'lyric-align', 'download-song'
  ],
  setup(props, { emit }) {
    const queueContainer = ref(null)
    const lyricContainer = ref(null)
    const viewEl = ref(null)
    const mainColEl = ref(null)
    const relatedEl = ref(null)

    // 离场滚动记忆：换页即整卸——单列页滚 .watch-view、宽屏左栏 .watch-main、
    // 相关栏各自还位（移动视频分屏态 view 页滚恒为 0，related 栏体自滚、
    // 照旧按键还位）。队列/歌词两栏不存：重挂即按当前行重居中（与切 tab
    // 同律的 centerCurrentRow），存了也会被居中盖掉；view 页滚同理——
    // queue/lyrics tab 下单列态 scrollIntoView 连滚整页，还位只留 related
    const scrollRestoreCancels = []
    onMounted(() => nextTick(() => {
      for (const [key, el] of [
        ...(props.tab === 'related'
          ? [['watch:view', viewEl.value], ['watch:related', relatedEl.value]]
          : []),
        ['watch:main', mainColEl.value],
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
    // 少 1px 发丝边是常量误差，overscan 吸收）；「接下来」分节线的
    // ~28px 非行高由下方归位块折回 spacer，不再是误差项。
    // 快照语义不挂 resetWhen——队列替换/增删不回卷。双滚动根候选：
    // ≥901px 栏内滚或移动视频分屏态（面板体 overflow-y:auto）的
    // queueContainer 在前、<901px 整页滚的 viewEl 殿后——每帧按
    // computed overflow 挑「此刻真会滚的」，breakpoint/分屏翻转
    // 不用 matchMedia。
    // overscan 12（基线 8 +4）：快滚惯性一帧可跳 >8 行（≈444px）越过
    // 窗沿露空白帧——每边多 4 行 DOM 吸掉，代价极小。
    // pinIndex=拖拽行：拖到窗外时行仍留 DOM（--dragging 与几何基准不丢）
    // dragIndex 上移：pinIndex 传 ref 对象本体，setup 时引用不能 TDZ
    const dragIndex = ref(-1)
    // YTM：当前行之上的已播段淡显（id 匹配定位，乱序队列按 id 不按下标）。
    // 声明前移——分节线位置与滑窗 rowShift 都消费它
    const currentQueueIndex = computed(() =>
      props.queue.findIndex(s => String(s.id) === String(props.currentSong?.id))
    )
    // 「接下来」分节线的滑窗归位：线是真 DOM 高但窗数学视其零高——
    // 消费侧按线位把高度并回 spacer（dividerPadAdjust）：线在窗上沿
    // 之上 → topPad、窗下沿之下 → bottomPad、窗内已随 DOM 渲染不补；
    // 三态互斥，垫片+行区合计恒 total*rowH+secH，行位全线连续。
    // 线紧跟当前行且仅 0≤ci<total-1 时存在（曲不在队/当前是末行无线）。
    // 线高不写死：callback ref 在元素挂载时 offsetHeight 实测，未量到
    // （线还没进过窗）前吃 fallback
    const QUEUE_SEC_FALLBACK = 28
    const queueSecIndex = computed(() => {
      const ci = currentQueueIndex.value
      return (ci >= 0 && ci < props.queue.length - 1) ? ci : -1
    })
    const queueSecH = ref(QUEUE_SEC_FALLBACK)
    const bindQueueSec = (el) => {
      if (el?.offsetHeight) queueSecH.value = el.offsetHeight
    }
    const {
      rows: queueRows, startIndex: queueStartIndex, endIndex: queueEndIndex,
      topPad: queueTopPadBase, bottomPad: queueBottomPadBase,
      bindAnchor: bindQueueAnchor,
      scrollToIndex: queueScrollToIndex, ensureVisible: queueEnsureVisible,
    } = useVirtualList({
      source: computed(() => props.queue),
      rowHeight: 55.5,
      overscan: 12,
      scrollRoots: () => [queueContainer.value, viewEl.value],
      pinIndex: dragIndex,
      // 分节线把线下各行整体下移 secH——scrollToIndex/ensureVisible 落点
      // 按此校正；反向 scrollTop→行号的窗数学不补（secH≪overscan 吸收域）
      rowShift: (i) => dividerRowShift(i, queueSecIndex.value, queueSecH.value),
    })
    // spacer 吃归位后垫片——模板仍用 queueTopPad/queueBottomPad 名
    const queuePads = computed(() => dividerPadAdjust({
      topPad: queueTopPadBase.value, bottomPad: queueBottomPadBase.value,
      start: queueStartIndex.value, end: queueEndIndex.value,
      dividerIndex: queueSecIndex.value, dividerH: queueSecH.value,
    }))
    const queueTopPad = computed(() => queuePads.value.topPad)
    const queueBottomPad = computed(() => queuePads.value.bottomPad)

    // 歌词字号/视频模式偏好：共享态在 lib/prefs.js——设置页与本页是同组
    // localStorage 偏好的双写面，持久化 watcher 已收敛在 prefs 层
    const lyricFontSize = prefLyricFontSize
    const lyricOffsetLabel = computed(() => {
      const s = props.lyricOffsetMs / 1000
      return (s >= 0 ? '+' : '') + s.toFixed(1) + 's'
    })

    const coverUrl = computed(() => songCoverUrl(props.currentSong))
    const artistText = computed(() =>
      (props.currentSong?.ar || props.currentSong?.artists || [])
        .map(a => a?.name).filter(Boolean).join(', ') || '未知艺术家'
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

    // 队列头模式键的字形映射：与 BottomPlayer.playModeIcon 同一表——
    // prop 收原始模式串而非图标名，映射留在消费端单一事实源
    const playModeIcon = computed(() =>
      ({ list: 'm-list', loop: 'm-loop', single: 'm-single' })[props.playMode] || 'm-list'
    )

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
      // =全局 queueStartIndex 行
      const rowEls = [...container.querySelectorAll('.queue-row')]
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
      const total = props.queue.length

      const onMove = (e) => {
        if (e.pointerId !== pid || dragIndex.value === -1 || !rowH) return
        const cTop = container.getBoundingClientRect().top
        const y = e.clientY - cTop + container.scrollTop
        // 换算原点 = 顶 spacer（bindQueueAnchor 锚位）顶缘的滚动坐标——锚
        // 钉在全局 0 行位，不随滑窗行集换代移位、不依赖 startIndex：scroll
        // 监听里 update() 同步改 startIndex，而 DOM 行集要等 Vue 下个
        // flush 才换——落在其间的 move 若照旧「当帧窗首行 − start·rowH」
        // 回推会让原点偏 Δstart·rowH（拖拽中并发滚动的一帧竞态）。面板
        // 隐藏/重建期 rect 全空，量不到原点就不换算——拿 0 矩形会 emit
        // 出垃圾 queue-move。分节线不查 DOM：线在窗之上时高度折进 topPad
        // 拿不到节点，其界点 u=(si+1)*rowH 纯算术可算；线随拖拽跨当前曲
        // 搬家由 queueSecIndex 每 move 重读兜住
        const anchor = container.querySelector(':scope > [aria-hidden="true"]')
        if (!anchor?.getClientRects().length) return
        const si = queueSecIndex.value
        const origin = anchor.getBoundingClientRect().top - cTop + container.scrollTop
        // y 折回「无线」均距坐标：线下各行在滚动空间整体下移 secH，落点
        // 在线之下先把 secH 扣回再 round 均距换算（越过行中点才算越过
        // 该行——与原口径一致；落点可命中渲染窗外的行）
        let u = y - origin
        if (si >= 0 && u > (si + 1) * rowH) u -= queueSecH.value
        const target = Math.min(total - 1, Math.max(0, Math.round(u / rowH)))
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
      // 面板 display:none 期 .queue-sec 虽已挂载但 offsetHeight=0——secH
      // 会滞留 fallback 28。回队列 tab 居中落定后的第二拍补实测：第一拍
      // scrollToIndex 只改 startIndex，sec 要等再一拍 flush 才随窗渲出；
      // 量不到（线缺席/未入窗）就保原值
      if (t === 'queue') nextTick(() => nextTick(() =>
        bindQueueSec(queueContainer.value?.querySelector('.queue-sec'))))
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

    // 「容器自身即真滚动口」判定：computed overflow-y 为 auto/scroll
    // （与 useVirtualList.pickScroller 同口径）。命中面=宽屏栏内滚的
    // 侧栏体 + 移动视频分屏态（≤900.98 ∧ ≥600h 媒体块）的侧栏体——
    // 比 matchMedia 宽判多覆盖分屏一种情况；单列整页滚态侧栏体不限高
    // （overflow visible 哑盒、scrollTop 恒 0）不命中
    const isScrollport = (el) => {
      if (!el || !el.getClientRects().length) return false
      const oy = getComputedStyle(el).overflowY
      return oy === 'auto' || oy === 'scroll'
    }
    // 内滚容器走 rect 法只滚容器——scrollIntoView 会连滚所有祖先、拽动
    // 整页/邻栏；整页滚态容器是哑盒、rect 法空转，此时 scrollIntoView
    // 只移动真滚动祖先 .watch-view，恰是单列居中所需
    const scrollRowIntoCenter = (container, el, smooth) => {
      if (!container || !el) return
      if (!isScrollport(container)) {
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
    // 歌词自动跟随闸：歌词容器自身是滚动口（宽屏栏内滚/移动视频分屏的
    // 侧栏体）时跟随只滚容器内部、不动整页——恒放行。单列整页滚才需要
    // 几何闸：歌词区没压到视口中线（用户还停在封面/操作区，或词区偏离
    // 正中）时不把整页拽过去。切 tab 是显式请求，centerCurrentRow 不走此闸
    const lyricsFollowable = () => {
      const c = lyricContainer.value
      if (isScrollport(c)) return true
      const view = c?.closest('.watch-view')
      const list = c?.querySelector('.watch-lyric-list')
      if (!view || !list) return false
      const v = view.getBoundingClientRect()
      const r = list.getBoundingClientRect()
      const mid = v.top + v.height / 2
      return r.top <= mid && r.bottom >= mid
    }
    // 手动滑动后暂停自动跟随：手指滑动/滚轮期间及之后 4s 内不抢滚动——
    // 用户往回翻或往后看歌词时不被下一行拽回。判定走 isScrollport 而非
    // 断点：歌词容器是自有滚动口时（宽屏栏内滚/移动视频分屏）只认栏内
    // 滑动——分屏下在视频区滑不算碰词、不暂停；单列整页滚态整页都是
    // 滚动器，任意处滑动都算（此判据兼容并取代原 wideMq 断点）。
    // 竖向位移 <10px 的 touchmove 视为轻点微漂、不暂停（真机点 A+/播放键常带
    // 1–2 个）；切到歌词 tab 是显式请求，清掉暂停。targetTouches 只读本页内
    // 触点——另根手指搭在页外（如底部播放条）时基线/探测仍配对同一根手指
    const LYRIC_FOLLOW_PAUSE_MS = 4000
    const SWIPE_SLOP_PX = 10
    // lyricFollowPausedUntil 上移到 props.tab watcher 前（immediate 序要）
    let touchStartY = 0
    const onWatchTouchStart = (e) => { touchStartY = e.targetTouches?.[0]?.clientY ?? 0 }
    const pauseLyricFollow = (e) => {
      if (isScrollport(lyricContainer.value) && !lyricContainer.value.contains(e.target)) return
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
        // 挑当前真滚动根：宽屏/分屏 queueContainer、单列 viewEl；越界 -1 内部已挡）
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
    const videoOn = prefVideoOn // 共享偏好（见上）——设置页改动即时生效
    watch(videoOn, v => {
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
    // mediaStreamRetry 戳喂进 yt 支在线 URL 的 retry 参数（旁路服务端
    // gateCache 闸控判定缓存——与 usePlayer 音频链 _streamRetried 同口径）；
    // bv/file 链 URL 不带它，重挂本身即服务端重解。切歌（key 换）清零，
    // 新源拿满重试预算
    const mediaStreamRetry = ref(0)
    let mediaRetryTimer = null
    let mediaRetriedKey = null
    let mediaRetryN = 0
    // 裸 bv_ 轨道 id 解形（缺 bilibili 对象的老持久化行只剩前缀 id）：与
    // usePlayer 音频主链同一张 BV_TRACK_ID_RE——bvid/_pN 分P 全在 id 里，
    // 视频键/探测门/在线位三处共用这一处 match；对象在场时以对象为准
    const bvM = computed(() => String(props.currentSong?.id ?? '').match(BV_TRACK_ID_RE))
    // 裸 yt_ 轨道 id 同型解形：videoId 内嵌在 id 里（usePlayer 音频链同款
    // ytM）。与 bvM 不会同中——轨道 id 前缀互斥
    const ytM = computed(() => String(props.currentSong?.id ?? '').match(YT_TRACK_ID_RE))
    // 视频源键：两个 provider 各取各自的定位串——换曲（哪怕同 provider）必然换键
    const mediaVideoKey = computed(() => {
      const song = props.currentSong
      // 按 provider 存在性出键而非导入期标记：标记被裁/老数据缺
      // hasDownloadableVideo 的曲盘上可能有已下载档（档在不在以
      // videoReady 探测为准），键在才让探测-下载档链路可达；
      // 裸 bv_ id 同键域——bvid/_pN 从 id 还原，cid 缺省按 0（服务端
      // /bilibili/stream 走 view 自愈，与 mediaVideoUrl 同口径）
      const bv = bvM.value
      if (song?.bilibili?.bvid || bv)
        return `bv:${song?.bilibili?.bvid || bv?.[1]}:${song?.bilibili?.cid || 0}:${song?.bilibili?.page || +bv?.[2] || 1}`
      // 裸 yt_ id 同键域——videoId 从 id 还原
      const yt = ytM.value
      if (song?.youtube?.videoId || yt)
        return `yt:${song?.youtube?.videoId || yt?.[1]}`
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
    // 有无「确定可放」的视频源：bv 对象稿按 hasVideo、裸 bv_ id（缺对象
    // 老行）乐观放行（mediaVideoUrl 同口径——BV 号在 id 即视频稿）、yt 有
    // videoId 即计入（在线位经 YT_PROXY 恢复后与 bv 同口径乐观，裸 yt_ id
    // 同律）、file 按 hasVideo、或探测落地的本地档。音画切换键的 title
    // 据此只给残余「判无可放」情形提示「需已下载视频档」
    const hasPlayableVideo = computed(() =>
      !!(props.currentSong?.bilibili?.hasVideo || props.currentSong?.file?.hasVideo
        || props.currentSong?.youtube?.videoId
        || (!props.currentSong?.bilibili && bvM.value)
        || (!props.currentSong?.youtube && ytM.value)
        || downloadedVideoUrl.value))
    // 音画切换键面单源：target=键面目标态文案、current=aria-label「当前 X
    // 模式」的态名、action=title 与 aria-label 共用的动作短串——三个槽位
    // 同一分支族，合在一个 computed 里出，分写两版三元必漂移。残余
    // 「判无可放」（hasPlayableVideo=false）落「需已下载视频档」降级支
    const avToggle = computed(() => videoOn.value
      ? { target: '音频', current: '视频', action: '纯音频（省流量）' }
      : {
        target: '视频',
        current: '音频',
        action: hasPlayableVideo.value ? '视频模式' : '视频模式（需已下载视频档）',
      })
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
      // videoReady 为准，不拿导入时的能力声明当工件真相。裸 bv_/yt_ id
      // （缺对象老行）同放进——服务端按 id 查档不依赖对象。
      // 视频关着时不探——纯音频用户不该为每首视频曲白打一跳 status 请求
      const probeable = videoOn.value
        && (song?.bilibili?.bvid || song?.youtube?.videoId || bvM.value || ytM.value)
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
      const bv = bvM.value
      // 与 mediaVideoKey 同口径按 provider 存在性进支：无标记曲只能靠
      // 本地档——b.hasVideo 为假时在线流位空串，不挂载（档缺席即空）。
      // 裸 bv_ id（缺对象老行）进同一支：bvid/_pN 从 id 还原、cid 缺省留
      // 服务端 view 自愈（usePlayer 音频链同口径）；hasVideo 标记缺席按
      // 乐观放行——BV 号在 id 即视频稿，真无 avc1 流由 error 闩回封面
      // （收藏夹导入 hasVideo:true 同律），本地档仍由 videoReady 探测兜真值
      if (b?.bvid || bv) {
        if (!dlProbeSettled.value) return ''
        return downloadedVideoUrl.value
          || ((b?.bvid ? b.hasVideo : bv)
            ? musicApi.bilibiliStreamUrl(b?.bvid || bv?.[1], 'video', b?.cid, b?.page || +bv?.[2] || 1)
            : '')
      }
      const y = song?.youtube
      const yt = ytM.value
      // 裸 yt_ id（缺对象老行）进同一支：videoId 从 id 还原（bv 支同口径）
      if (y?.videoId || yt) {
        if (!dlProbeSettled.value) return ''
        // 本地档优先（不撞 CDN 闸控）；档缺席挂 /youtube/stream 在线位——
        // YT_PROXY 恢复后与 bv 支同口径乐观放行，真死链由 error 闩回封面。
        // mediaStreamRetry 戳带 retry=1 旁路服务端 gateCache 判定缓存
        // （与 usePlayer 音频链 _streamRetried 同口径）
        return downloadedVideoUrl.value
          || musicApi.youtubeStreamUrl(y?.videoId || yt?.[1], 'video', '', mediaStreamRetry.value)
      }
      // 上传曲的视频资产走 file 端点（kind=video→videoPath 列）；videoV 戳
      // 版本——同 URL 换源 <video> 不会重载，靠它让 mediaVideoUrl 变化触发复位
      return song?.file?.hasVideo ? fileArtifactUrl(song.id, 'video', song.file.videoV) : ''
    })
    // 音画开关翻转 = ≤900 分屏↔整页滚换轨：面板体从哑盒变滚动口（或反之），
    // 词窗骤变但 scrollTop 不动——停在词表顶部等下一个 currentLyricIndex
    // 才回正，间奏空窗可达几十秒；按当前行重居中（centerCurrentRow 内部
    // 自动挑换轨后的真滚动根）
    // 【序】必须列在 mediaVideoUrl 之后——非 immediate watch 注册即 eager
    // 求值 source 取 oldValue，mediaVideoActive 链触到 TDZ 会炸掉整个 setup
    watch(mediaVideoActive, () => nextTick(() => {
      if (props.tab === 'queue' || props.tab === 'lyrics') centerCurrentRow()
    }))
    // 本地档解码失败（hev1/av01-in-mp4 等 Safari 放不动的封装）——bv/yt 两支
    // 同口径先回落在线流再闩封面：清 downloadedVideoUrl 让 mediaVideoUrl
    // 换源重载，watcher 顺带复位 mediaVideoFailed；在线源也失败才真闩。
    // 档被搬别单靠下方 dlProbeNonce 单发重探找回
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
      // 序数戳 mediaStreamRetry++：yt 支 URL 带 retry=1 旁路服务端闸控判定
      // 缓存（SABR 探测无定论按未闸放行，mediaVideoUrl 的 yt 支消费它）；
      // bv/file 支 URL 不带戳——重挂本身即服务端重解 playurl
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
      queueEndIndex,
      queueTopPad,
      queueBottomPad,
      bindQueueAnchor,
      bindQueueSec,
      queueScrollToIndex,
      queueSecIndex,
      queueSecH,
      lyricFontSize,
      LYRIC_FS_MIN,
      LYRIC_FS_MAX,
      lyricOffsetLabel,
      dragIndex,
      coverUrl,
      artistText,
      songArtist,
      formatDuration,
      formatTime,
      httpsCover,
      songCoverUrl, songThumbUrl, isFileTrackId,
      playModeIcon,
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
      bvM,
      ytM,
      hasPlayableVideo,
      avToggle,
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
  /* pg-tab 实高（pad 10×2 + 12 字 + 1.2 底边 ≈ 38）——scroll-padding 同源 */
  --watch-tabs-h: 38px;
  /* 焦点滚达/scrollIntoView 的让位垫：移动单列态顶上有两层 sticky
     （watch-top + watch-tabs），不让位时目标行会滚到钉条底下 */
  scroll-padding-top: calc(var(--watch-top-h, 52px) + var(--watch-tabs-h, 38px));
  /* 宽屏布局槽距令牌（20→24→32，分档媒体块见下）：声明在本层而非
     .watch-layout——--watch-vpad 有两个兄弟消费端（.watch-layout 的
     padding + .watch-top 的浮层槽距：返回键/操作键行的左缘就是视频左缘
     对齐轴），挂子元素会让兄弟够不着。--watch-reserved-h 与其同域：
     自定义属性按已解析计算值向下继承，声明在共同祖先上后代看到的
     都是分档后的值——同域声明为与消费端同源可读，预算只此一处 */
  --watch-vpad: 20px;
  /* 视频高度预算的「非媒体区」构成：顶栏 + 底栏 + 布局纵槽×2 + 视频顶补距
     56。四个分量全走令牌——此前 223 是手算硬编码，任一分量漂移即失真 */
  --watch-reserved-h: calc(
    var(--topnav-h, 57.2px) + var(--player-bar-h, 69.2px)
    + 2 * var(--watch-vpad, 20px) + 56px
  );
}
/* 后声明者胜同带宽叠档：1364 必须在 1150 之后（同为 min-width 同特异性） */
@media (min-width: 1150px) { .watch-view { --watch-vpad: 24px; } }
@media (min-width: 1364px) { .watch-view { --watch-vpad: 32px; } }

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
  gap: 10px;
  /* 横槽吃 --page-pad-x 令牌：≤640 时内容区降到 12——返回键若不跟档，
     会与下方视频/封面的左缘错开 8px */
  padding: 0 var(--page-pad-x, 20px);
  /* 窄屏装不下「返回+四操作键」时行内横滚兜底（移动端滚动条全局隐藏，
     桌面态本规则基本不触发——scrollbar-width 双保险防溢出时出轨道） */
  overflow-x: auto;
  scrollbar-width: none;
  /* sticky 钉顶时衬画布色——滚过的歌词/队列行不透字 */
  background: var(--view-canvas, var(--paper));
  pointer-events: none;
}
.watch-top > * { pointer-events: auto; }

/* 布局槽距：移动基态横槽吃 --page-pad-x 令牌（≤640 降 12），纵槽 pt-3/pb-5
   留模板；≥901 四边统一 --watch-vpad（声明在 .watch-view——与 .watch-top
   的对齐轴同源；其纵分量经 --watch-reserved-h 回喂视频预算，垫厚一分
   视频就少一分）。侧列份额 40% 的分母是栏域实宽；≥1150 向 YTM 36% 档升
   （400 帽过早泄气，YTM 同带侧栏 ~500 宽——min(500,36%) 因 --content-max
   1440 帽实际止于 ~487）。队列行六件（握把 28+序 ~14+缩略 30+信息+
   duration ~30+remove 24+add 24，含缝 ~180 固宽）核对：vw=901 侧栏
   =40%×(901-40-24)=~335 放得下（watch 态 ≥768 侧栏 display:none，
   无 64 轨可扣）；行内信息列弹性截断 */
.watch-layout {
  padding-inline: var(--page-pad-x, 20px);
}
@media (min-width: 901px) {
  .watch-layout { padding: var(--watch-vpad, 20px); }
}
@media (min-width: 1150px) {
  .watch-layout { grid-template-columns: minmax(0, 1fr) min(500px, 36%); }
}

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
   宽恒 100% 贴 wrap——视频盒的实际尺寸由 wrap 承担（移动基态 wrap=栏宽；
   宽屏 wrap 按视口高换算公式，见 min-width 块） */
.watch-cover--video {
  width: min(100%, 1280px);
  aspect-ratio: 16 / 9;
  object-fit: contain;
  image-rendering: auto;
  background: #000;
  /* 点画面=播放/暂停——禁掉双击缩放手势带来的 ~300ms 点击延迟 */
  touch-action: manipulation;
}

/* 视频态 wrap 移动基态占满栏宽：wrap 是 shrink-to-fit 的 flex 项，不给宽
   则视频 width:% 与 wrap 构成循环约束、退回片源内建宽；宽屏改由 min()
   公式贴视频盒（见 min-width 块——控制层 inset:0 锚 wrap，wrap 必须
   精确包住画面）。relative 是悬停控制层（.watch-video-controls）的定位锚。
   高帽 ~70dvh：横屏矮机上全宽视频（804×452）会把 tabs 顶到滚不可及——
   封面态早有 55svh 同款帽，视频态补上；124dvh 宽 ≈ 70dvh 高（×9/16）。
   三档递进：min() 不识的旧内核整条作废回退上行 100%（循环% 塌缩风险
   见 .watch-cover 注释——100% 那行是兜底不是冗余）；vh 档兜识 min
   不识 dvh 的内核（Chrome 88–107/Safari<15.4） */
.watch-cover-wrap--video {
  width: 100%;
  width: min(100%, 124vh);
  width: min(100%, 124dvh);
  position: relative;
}

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
  /* 宽高显式钉满屏：UA 全屏表（width:100%!important）在现代引擎已兜住，
     显式声明是给没有这条 UA 规则的旧 WebKit 兜底——否则 wrap 的 min()
     宽公式会把全屏画面卡在小屏预算里 */
  width: 100%;
  height: 100%;
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
  width: 100%;
  height: 100%;
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
   与 .watch-top 返回键/操作键行的 padding 同源对齐（YTM watch 视频页
   同款排法）。垂直方向仍走父级 safe center——栏内只剩媒体本体，
   居中语义不变 */
.watch-main--video {
  padding-left: 0;
  padding-right: 0;
  align-items: flex-start;
  text-align: left;
}

/* 音画切换的开启态：实心反色——与 pg-tab--active 同一语义。
   双类升特：glitch 主题有 :root[data-theme] .ink-btn--ghost 全局重写
   (0,3,0)，单类 scoped (0,2,0) 会被压——按下态在 glitch 下曾完全
   不可见；双类 (0,3,0) 追平后 scoped 样式加载在后胜出 */
.watch-action.watch-action--on {
  background: var(--ink);
  color: var(--paper);
}
/* 开启态 hover：ghost hover 只给 accent-ink 字色（纸面档）——墨底上
   那是低对比泥色；按 pg-chip--on 法则保墨底、换 on-ink 亮 accent */
.watch-action.watch-action--on:hover:not(:disabled) {
  color: var(--accent-magenta-on-ink);
}

/* 操作键组在 .watch-top 行内（返回键后）——不再占左栏纵向空间；
   nowrap：换行会撑破 52px 定高行，溢出交给行内横滚 */
.watch-actions {
  display: flex;
  gap: 10px;
  flex-wrap: nowrap;
  flex-shrink: 0;
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
     （top 与 --watch-top-h 同源；宽屏块与移动视频分屏块内复位
     static——有界/非滚动 scrollport 上 sticky 的 inset 约束仍生效，
     不复位会被强压 32px） */
  position: sticky;
  top: var(--watch-top-h, 52px);
  z-index: 4;
  /* 滚过内容不透字（同 .watch-top 的画布衬底） */
  background: var(--view-canvas, var(--paper));
  /* 基线降灰档：全局 .pg-tabs 底线是 --hairline 实墨，本区其余分隔件
     （queue-head 底线 / 行间分隔 / queue-sec 尾线 / queue-foot 顶隔）
     全走 --hairline-soft——scoped (0,2,0) 压全局 (0,1,0) 局部看齐。
     ::after 的 2px 实墨激活指示不动：墨指示骑灰基座对比反更清 */
  border-bottom: var(--hairline-soft);
}

/* 移动基态：不限高不内滚（YTM 整页滚动语义——队列/歌词随页流）；
   ≥901px 回栏内滚（flex:1+min-height:0+overflow，见 min-width 块）。
   例外：移动视频分屏态侧栏体也内滚（max-width:900.98 ∧ min-height:600
   媒体块——上行视频钉住、下行面板体自滚） */
.watch-side-body {
  padding-top: 8px;
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

/* 队列头右端模式对：底栏 ≤640 减负后 shuffle/模式在本页无落点——挂队列
   头是 YTM 语义位（队列顺序控件归队列面板；YTM 队列头即放 shuffle/
   repeat）。≥641 由底栏承担，此处不渲染槽位 */
.queue-modes { display: none; }
@media (max-width: 640.98px) {
  /* queue-head 是 baseline 对齐——按钮组转 flex 后须中线回正 */
  .queue-modes { display: flex; gap: 4px; margin-left: auto; align-self: center; }
}
/* 盒型镜像 .lyric-tool：24px 触控地板 + 发丝框 + ink-86 图形 */
.queue-mode-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  min-height: 24px;
  padding: 3px;
  border: var(--hairline);
  background: transparent;
  color: var(--ink-86);
  cursor: pointer;
  transition: color .5s var(--ease-ink), background .5s var(--ease-ink);
}
.queue-mode-btn:hover { background: var(--ink-06); color: var(--ink); }
/* 开启态实心反色——watch-action--on/pg-tab--active 同一语义（底栏
   transport--active 用 accent 墨字，发丝盒件的 print-grid 等价是墨底纸字） */
.queue-mode-btn--on { background: var(--ink); color: var(--paper); }
/* 开启态 hover 保墨底——基态 hover 的 ink-06 会把按下态洗回浅色（pg-chip--on 法则） */
.queue-mode-btn--on:hover { background: var(--ink); color: var(--accent-magenta-on-ink); }
/* 盒件内环（印刷签名——.lyric-tool 在全局内环名单，本件 scoped 补同款） */
.queue-mode-btn:focus-visible { outline-offset: -4px; }
/* HC 下底色态被系统色抹平——透明 outline 被强制显色，反白态不留失 */
@media (forced-colors: active) {
  .queue-mode-btn--on { outline: 1.2px solid transparent; }
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
  /* 宽屏钉在面板底缘（挂出滚动体后 flex 列默认 shrink 会把它压扁） */
  flex-shrink: 0;
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

/* 歌词工具条：字号 / 时间校准两组，钉在歌词面板下缘（DOM 序在面板
   之后——钉底与 watch-queue-foot 同约定：滚动体之外的常驻件）。
   不设分隔线——watch 侧栏约定「静止零装饰」 */
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
/* 图标+文案混排键（歌词获取组）：PixelIcon 是 block 件，inline-flex 收平 */
.lyric-tool--icon { display: inline-flex; align-items: center; gap: 3px; }
.lyric-tool-val {
  font-size: 10px; /* 裸 span 继承 body 16px 会夹在 10px 控件间形制分裂——显式同档 */
  font-variant-numeric: tabular-nums;
  color: var(--ink-86);
}
/* 校准值键兼复位：按最大刻度 ±300.0s 预留宽，避免值跳变时整组位移 */
.lyric-tool-reset { min-width: 56px; }

/* ≤900 单列整页滚态：工具条在 DOM 序上钉于词表末尾，随页流会被整张
   词表压到滚不可及——sticky 吸在滚动口（.watch-view）下沿随手可够，
   滚到真末尾归位（与 watch-tabs 钉顶同一招的镜像）；画布衬底防滚过的
   词行透字。分屏/宽屏态它由 flex 序钉在栏底、天然已在视野内——
   sticky 无事可干（惰性的，不必关） */
@media (max-width: 900.98px) {
  .lyric-tools {
    position: sticky;
    bottom: 0;
    z-index: 3; /* 词行之上、tabs(4)/顶行(5) 之下 */
    background: var(--view-canvas, var(--paper));
  }
}

/* ── 移动视频态分屏（≤900 ∧ 高度 ≥600）：单列整页滚下，读词把画面顶出
   屏、看画面又读不到词——改两行合成：上行 顶行+视频 钉住不动，下行
   侧栏收成有界区（tabs 固定头 / 可见面板体自滚 / 队列页脚与歌词工具条
   钉栏底），与 ≥901 栏内滚同构。高度门槛定 600 而非 480：视频有 300px
   地板保护，480-600 带里词窗只剩 ~0-50px（空壳分屏不如退守）——600
   起词窗 ≥~80px（2-3 行）分屏才真赢整页滚。watch-view 仍
   overflow-y:auto：装不下的边角（横幅/极短窗）内容溢出后整页照旧能滚，
   分屏是「理想态」不是「封死态」 */
@media (max-width: 900.98px) and (min-height: 600px) {
  /* 布局吃满顶行外的滚动口：watch-view 是定高列向滚动口（壳链
     100dvh−顶栏−底栏，watch-top 占 52px），flex:1 让本项恒得
     「滚动口−52px」——与手算 calc(100dvh−topnav−bar−52) 等价但随
     chrome 令牌自动校准、不用挂 vh/dvh 双行兜底。min-height:0 允许
     压到内容高之下，溢出走 watch-view 页滚兜底而非撑破布局 */
  .watch-view--video .watch-layout { flex: 1; min-height: 0; }
  /* 侧栏收上行余量成定高列——没有 flex:1 则栏高随词表内容走，
     面板体的 flex:1 失去参照，内滚无从谈起 */
  .watch-view--video .watch-side { flex: 1; min-height: 0; }
  /* 三块面板体共一条内滚律：v-show 单显，可见的那块即歌词/队列/
     相关的滚动口；tabs/工具条/页脚都在滚动体外由 flex 序钉住
     （min-width:901 块同款结构）。overscroll chaining 截断已在
     style.css 全局白名单（.watch-side-body 在列） */
  .watch-view--video .watch-side-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  /* sticky 钉点是为整页滚设计的——有界栏内栏顶已是固定处，top:52
     的 inset 约束反把 tabs 压出侧栏天然位；归 static 当固定头 */
  .watch-view--video .watch-tabs { position: static; }
  /* 横幅与视频同宽——默认 min(64vw,320px) 吊在全宽播放器下读作孤儿条
     （≥901 块内同一条 width:100% 的 ≤900 镜像） */
  .watch-view--video .watch-main--video .watch-banner { width: 100%; }
  /* 视频不饿死下行：在 124dvh 上限上再叠「视口高−非视频区预算」的
     宽换算项——预算≈chrome（顶栏+底栏+顶行 178-215 + tabs ~38 +
     工具条 ~32 ≈ 248-280）+ 槽距合计 ~66（layout pt/pb + gap +
     侧栏顶补）+ 歌词窗地板 ~130 ≈ 480px；预算项绑定时词窗恒 ~130
     （649-740 带），以下由 100% 栏宽绑定词窗随行高放大。max() 300px
     地板兜住 600h 闸口边缘——地板与预算冲突时保视频（词窗缩到 ~80
     仍可用），再矮门槛外本块不挂、整页滚接管。vh 行兜 dvh 不识的
     老内核（同基态三档递进约定）。注：队列 tab 的页脚 ~55px 比工具条
     ~32 厚——队列面板提前 ~23px 触底，同样随槽退化不破 */
  .watch-view--video .watch-cover-wrap--video {
    width: min(100%, 124vh, max(300px, calc((100vh - 480px) * 16 / 9)));
    width: min(100%, 124dvh, max(300px, calc((100dvh - 480px) * 16 / 9)));
  }
}

/* ── 宽屏增强（mobile-first 反转点 ≥901px，与模板 wide: 断点同源）──
   双栏内滚态：本层不滚、左右栏各自管车道；此前移动基态曾在此犯
   「flex:1+min-height:0 未解除 → 侧栏压成内滚细条」的错——
   反转后限高只存在于宽屏态，单列从结构上不存在挤压路径 */
@media (min-width: 901px) {
  .watch-view { scrollbar-gutter: auto; }

  /* 宽屏顶行回浮层不占流——栏内自滚，键位钉在各栏内容之上。
     槽距吃 --watch-vpad 而非定值：左缘是视频/封面的对齐轴，vpad
     升档（20→24→32）时顶行若不跟档，返回键会与媒体左缘错位 */
  .watch-top {
    position: absolute;
    height: auto;
    padding: var(--watch-vpad, 20px);
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
     safe 让溢出改走底部（不支持 safe 的浏览器回退到上行 flex-start） */
  .watch-main {
    /* safe 不识别的老内核（<Safari 17.6/<Chrome 115）：整条 safe 声明作废后
       不能落回不安全 center——溢出时顶部会被裁且滚不到。先声明 flex-start
       兜底：老内核退化为顶对齐+滚动，功能无损只是不居中 */
    justify-content: flex-start;
    justify-content: safe center;
    scrollbar-gutter: stable;
    scrollbar-gutter: stable both-edges;
    /* 顶行是 absolute 浮层（返回键占 y≈20–52）：UA 焦点滚达/scrollIntoView
       会把目标贴到滚动口顶缘——scroll-padding 给同款让位垫 */
    scroll-padding-top: 56px;
  }
  .watch-main--video {
    scrollbar-gutter: stable;
    /* 顶补距只付给视频态：左缘构图的内容从 x=20 起、safe 退化 start 时
       可滚顶缘会钻到返回键浮层下；封面态居中排布够不着左页角浮层，
       白付 56px 还新增滚动回归带 */
    padding-top: 56px;
  }
  /* 横幅在视频态拉满栏宽——封面宽（min(46vh,420px)）吊在 ~976px
     播放器下读作孤儿条；与视频左缘同轴对齐 */
  .watch-main--video .watch-banner { width: 100%; }

  .watch-cover { width: min(46vh, 420px); }
  /* 上条与 .watch-cover--video 基态同特异性 (0,1,0) 而源码序在后——不拦截
     的话它会盖掉 --video 的 min(100%,1280px)、把视频元素压成封面宽；wrap
     公式宽却仍在 → 控制层 inset:0 锚 wrap 时全屏键吊出画面盒。重声明
     --video 基态同款值归位（实际尺寸仍由下行 wrap 公式承担） */
  .watch-cover--video { width: min(100%, 1280px); }
  /* 视频尺寸落在 wrap 上而非 video 元素：wrap 精确包住视频盒，悬停控制层
     inset:0 才贴画面（wrap 恒 100% 栏宽时，高度约束生效、视频收窄，中央播放
     键/右下全屏键会对到栏而非画面）。尺寸策略对齐 YTM watch 页：按视口高
     预算收窄，非媒体区预算全走 --watch-reserved-h（顶栏+底栏+纵槽×2+顶补距
     56 四令牌合成；基档值≈旧硬编码 223，纵槽升档时自动跟进。YTM 同款
     --player-page-total-height-exclude-player 为 408px），但守 300px 最小
     高度（300×16/9≈533 宽；YTM 300 / ytd 240）——预算低于地板时停止
     压缩、左栏滚动补差（顶补距已让开返回键浮层），视频不再塌成小窗。
     实际上限即左栏宽（1440 壳-边距-右栏≈976，不设额外封顶）；栏宽本身
     <533 的窄断点带（901–1023 开栏）由 100% 先绑定、地板让位——宽度
     饥荒时无法同时保高。vh 行是 dvh 不识别的老内核兜底 */
  .watch-cover-wrap--video {
    width: min(100%, max(533px, calc((100vh - var(--watch-reserved-h, 223px)) * 16 / 9)));
    width: min(100%, max(533px, calc((100dvh - var(--watch-reserved-h, 223px)) * 16 / 9)));
  }
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
