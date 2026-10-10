<template>
  <!-- YTM /watch 沉浸舞台：近黑底 + 封面氛围场，左列媒体舞台、右列
       待播/歌词/相关面板（无面板底）。页头行常显收 返回+⋯。
       走带/进度/音量/歌曲 meta 不重复渲染——底部播放条已覆盖 -->
  <div ref="viewEl" class="watch-view" :class="{ 'watch-view--video': mediaVideoActive }" @touchstart.passive="onWatchTouchStart" @touchmove.passive="pauseLyricFollow" @wheel.passive="pauseLyricFollow">
    <!-- 氛围场：当前封面小图高糊放大铺全屏（fixed+z-index:-1 画在
         app-shell 底之上、内容之下——壳层 isolation:isolate 圈住）。
         key 换 URL 即换元素，Transition 叠化；无封面只剩舞台底色 -->
    <div class="watch-ambient" aria-hidden="true">
      <Transition name="watch-ambient-fade">
        <img v-if="ambientUrl" :key="ambientUrl" :src="ambientUrl" alt="" class="watch-ambient-img" />
      </Transition>
      <div class="watch-ambient-scrim"></div>
    </div>

    <!-- 页头行：返回 + ⋯ 触发键。常显在流——替代旧 sticky 顶条与媒体角
         浮键（操作可发现性）；菜单本体仍 teleport 出 body -->
    <header class="watch-head">
      <button type="button" class="watch-back" @click="$emit('back')" title="返回上一页"><PixelIcon name="chev-l" :size="14" />返回</button>
      <button
        ref="menuBtn"
        type="button"
        class="watch-menu-btn"
        title="更多操作"
        aria-label="更多操作"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        aria-controls="watch-actions-menu"
        @click="toggleMenu"
      ><PixelIcon name="more" :size="18" /></button>
    </header>

    <Teleport to="body">
        <div
          v-if="menuOpen"
          id="watch-actions-menu"
          class="pg-menu watch-actions-menu"
          role="menu"
          aria-label="更多操作"
          :style="menuPos"
          @keydown="cycleMenuItems"
        >
          <!-- 音画模式组：原行内「音画切换」键改写为双 radio（TopNav 主题组
               同式）——态指示由 aria-checked + ✓ 槽承担，键面即模式名。
               出组闸同原出键复合条件（见 setup showAvGroup）；残余
               「判无可放」（hasPlayableVideo=false）降级提示落目标项
               title——字符串仍出自 avToggle 单源，不另造第二套文案 -->
          <div v-if="showAvGroup" role="group" aria-label="音画模式">
            <div class="pg-menu-head" role="presentation">音画模式</div>
            <button
              class="pg-menu-item"
              role="menuitemradio"
              :aria-checked="!videoOn"
              :title="videoOn ? `切到${avToggle.action}` : undefined"
              @click="pickAvMode(false)"
            ><span class="watch-menu-check" aria-hidden="true"><PixelIcon v-if="!videoOn" name="check" :size="12" /></span>音频</button>
            <button
              class="pg-menu-item"
              role="menuitemradio"
              :aria-checked="videoOn"
              :title="!videoOn ? `切到${avToggle.action}` : undefined"
              @click="pickAvMode(true)"
            ><span class="watch-menu-check" aria-hidden="true"><PixelIcon v-if="videoOn" name="check" :size="12" /></span>视频</button>
          </div>
          <button class="pg-menu-item" role="menuitem" title="全屏歌词模式" :disabled="!currentSong" @click="pickFullscreen">
            <PixelIcon name="fullscreen" :size="14" /> 沉浸
          </button>
          <!-- file_ 上传曲没有源站可分享链接（?song= 只收数字 id）——死链不亮 -->
          <button
            v-if="!isFileTrackId(currentSong?.id)"
            class="pg-menu-item"
            role="menuitem"
            :disabled="!currentSong"
            @click="pickShare"
          ><PixelIcon name="share" :size="14" /> 分享歌曲</button>
          <!-- 下载到服务器：file_ 上传曲资产本就在服务端（无可下对象）不亮项。
               busy/已下载三态键面照搬原行内键——提交、镜像、终态轮询全在
               usePlayer 侧，切歌任务照跑、项面随曲换 -->
          <button
            v-if="currentSong && !isFileTrackId(currentSong.id)"
            class="pg-menu-item"
            role="menuitem"
            :disabled="songDownloading || songDownloaded"
            :title="songDownloaded ? '已下载到服务器' : '下载到服务器'"
            @click="pickDownload"
          ><span v-if="songDownloading" class="pixel-loading" aria-hidden="true"></span><PixelIcon v-else :name="songDownloaded ? 'check' : 'download'" :size="14" /> {{ songDownloading ? '下载中…' : (songDownloaded ? '已下载' : '下载') }}</button>
          <!-- 回源：新页打开源站原页。<a> 原生链接语义（可中键/复制链接）——
               click/auxclick 都关菜单（TopNav 控制器项同型）；noreferrer
               不给源站带去本站 Referer -->
          <a
            v-if="sourceUrl"
            class="pg-menu-item"
            role="menuitem"
            :href="sourceUrl"
            target="_blank"
            rel="noopener noreferrer"
            :title="`回源：在${sourceName}打开原页`"
            @click="closeMenu()"
            @auxclick="closeMenu()"
          ><PixelIcon name="external" :size="14" /> {{ sourceName }}</a>
        </div>
    </Teleport>

    <!-- 舞台列（媒体）+ 面板列：宽屏双栏网格、移动纵排（盒模型与断点
         全收 scoped 层——布局只有一处事实源） -->
    <div class="watch-layout">
      <!-- ══ 媒体舞台列 ══ -->
      <div ref="mainColEl" class="watch-main" :class="{ 'watch-main--video': mediaVideoActive }">
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
             操作键已收进页头 ⋯ 菜单；本列只剩媒体本体（YTM mweb 同款取舍）。
             播放错误/时长警告走全局 toast（setup 侧 watcher 接入）——旧行内
             横幅在桌面容器裁口（container-type:size + overflow:hidden）下
             被切半，改走 FeedbackHost 气泡 -->
      </div>

      <!-- ══ 面板列：待播 / 歌词 / 相关（无面板底，行级高亮即可）══ -->
      <aside class="watch-side" aria-label="待播、歌词与相关">

        <!-- 满宽 tab 行：等宽三档 + 激活下划线；语境行是 tablist 的兄弟级
             （role=tablist 只许 tab 子项） -->
        <div class="watch-tabs" role="tablist" aria-label="播放页侧栏面板">
          <button
            v-for="t in TABS"
            :key="t.key"
            :id="`watch-tab-${t.key}`"
            type="button"
            class="watch-tab"
            :class="{ 'watch-tab--active': tab === t.key }"
            role="tab"
            :aria-controls="`watch-panel-${t.key}`"
            :aria-selected="tab === t.key"
            :tabindex="tab === t.key ? 0 : -1"
            @click="setTab(t.key)"
            @keydown.left.prevent="moveTab(-1)"
            @keydown.right.prevent="moveTab(1)"
          >{{ t.label }}</button>
        </div>
        <!-- 语境行：队列=源名+规模 / 相关=艺人+规模；歌词不出行（校准读数
             在歌词工具条） -->
        <div v-if="tab !== 'lyrics'" class="watch-side-meta">
          <template v-if="tab === 'queue'">
            <!-- 无来源名（散曲/临时队列）不出「来自」段——meta 只剩规模读数 -->
            <template v-if="queueTitle">
              <span>来自</span>
              <!-- 归属歌单在库时源名可点回歌单页（原 queue-source--link 语义） -->
              <button
                v-if="queueOwner"
                type="button"
                class="queue-head-name"
                @click="$emit('open-source')"
                :title="`回到歌单 ${queueTitle}`"
              >{{ queueTitle }}</button>
              <span v-else class="queue-head-name queue-head-name--plain">{{ queueTitle }}</span>
            </template>
            <span v-if="queue.length" class="queue-head-meta">{{ queue.length }} 首<template v-if="queueTotalLabel"> · {{ queueTotalLabel }}</template></span>
          </template>
          <span v-else-if="tab === 'related' && relatedSongs.length" class="queue-head-meta">{{ relatedHeadLabel }}</span>
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
          <!-- 队列抬头已并入刊头右段（.watch-side-meta——源名/规模）；
               「正在播放」眉题摘除——tab 自身即面板名代言 -->
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
                    v-if="songThumbUrl(song, 80)"
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
             千行队列时不必滚到底才够得着；面板列是有界 flex 列，
             flex 序把它钉在栏底；空队列时只剩居中开关组 -->
        <div v-show="tab === 'queue'" class="watch-queue-foot" :class="{ 'watch-queue-foot--empty': !queue.length }">
          <template v-if="queue.length">
            <button type="button" class="watch-foot-btn" @click="$emit('save-queue')" title="把当前队列存成新歌单" aria-label="存为歌单">
              <PixelIcon name="save" :size="15" /><span class="watch-foot-btn-label">存为歌单</span>
            </button>
            <button
              type="button"
              class="watch-foot-btn"
              :disabled="queue.length < 2"
              @click="$emit('clear-queue')"
              title="清空队列（保留当前播放）"
              aria-label="清空队列"
            ><PixelIcon name="close" :size="15" /><span class="watch-foot-btn-label">清空队列</span></button>
          </template>
          <!-- ≤640 底栏减负收走 shuffle/模式键后落点在此（YTM UP NEXT 的
               队列顺序控件归队列）。不套 queue.length 闸——空队列时
               repeat 模式键仍有意义；CSS 控 ≤640 才显形，≥641 由底栏承担。
               位置在 autoplay 左邻：autoplay 的 margin-left:auto 把它顶在
               右缘，modes 贴着它组成右端偏好器械组（shuffle/repeat 与
               autoplay 同是持续性播放偏好，与左侧存为/清空的一次性
               操作分群）——插到 autoplay 之后会让 autoplay 离开右缘锚位 -->
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
                :class="{ 'watch-lyric-line--current': index === currentLyricIndex, 'watch-lyric-line--past': index < currentLyricIndex }"
              >
                <p>{{ lyric.text }}</p>
                <p v-if="lyric.translation" class="watch-lyric-translation">{{ lyric.translation }}</p>
              </div>
            </div>
          </template>
        </div>

        <!-- 歌词工具条：字号调节（本机偏好）+ 时间校准（按词源入库）。
             DOM 序钉在歌词面板之后——面板列是有界 flex 列，flex 序把它
             收在栏底（队列页脚同款钉底约定，滚动体之外恒可见） -->
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
            v-for="(song, i) in relatedSongs"
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
              <span class="queue-row-index">{{ i + 1 }}</span>
              <img
                v-if="songThumbUrl(song, 80)"
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
import { songSourceUrl, songSourceName, songCoverUrl, songThumbUrl, fileArtifactUrl, isFileTrackId, proxiedCoverUrl } from '../lib/song'
import { prefVideoOn, prefLyricFontSize, LYRIC_FS_MIN, LYRIC_FS_MAX } from '../lib/prefs'
import { cycleMenuItems } from '../lib/focus-trap.js'

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

    // 离场滚动记忆：换页即整卸——view/主列/相关栏各自还位（舞台布局下
    // view 与主列恒非滚动口、还位恒为 0；related 栏体自滚照旧按键还位）。
    // 队列/歌词两栏不存：重挂即按当前行重居中（与切 tab
    // 同律的 centerCurrentRow），存了也会被居中盖掉
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
    // filteredSongs），前缀窗滚到底全量同构。行高 56px 均匀（overscan
    // 吸收常量误差）；「接下来」分节线的 ~28px 非行高由下方归位块折回
    // spacer，不再是误差项。
    // 快照语义不挂 resetWhen——队列替换/增删不回卷。滚动根候选：
    // 面板体 queueContainer（新舞台布局下恒为内滚口）在前、viewEl
    // 殿后作旧式页滚兜底——每帧按 computed overflow 挑「此刻真会滚的」，
    // breakpoint 翻转不用 matchMedia。
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
      rowHeight: 56,
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

    // 大图位吃原始构图（不改走 songThumbUrl 的缩放/降档语法），但白名单
    // 图床外链统一经服务端 /img-proxy 代取——包装幂等，file_/相对形直通
    const coverUrl = computed(() => proxiedCoverUrl(songCoverUrl(props.currentSong)))
    // 氛围场底图：小尺寸封面高糊放大（舞台底色由它供给）——换曲叠化
    // 由模板 :key + Transition 承担
    const ambientUrl = computed(() => {
      const u = songThumbUrl(props.currentSong, 200)
      return u ? httpsCover(u) : ''
    })
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
    // 刊头 meta「艺人 · N首」：relatedSongs 由当前曲首艺人名搜索得来
    // （与 loadRelated 同一取法）——无艺人字段的源曲只报规模，不硬造归属
    const relatedHeadLabel = computed(() => {
      const artist = (props.currentSong?.ar || props.currentSong?.artists || [])[0]?.name
      const n = relatedSongs.value.length
      return artist ? `${artist} · ${n} 首` : `${n} 首`
    })

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

    // 播放错误/时长警告：行内横幅改走全局 toast——事件语义只在值落地时
    // 弹一次（不加 immediate：重挂载的残留状态不重复弹）。warn 无对应
    // feedback 类型，归 'info'
    watch(() => props.playbackError, v => { if (v) toast(v, 'error') })
    watch(() => props.durationWarning, v => { if (v) toast(v, 'info') })

    // 「容器自身即真滚动口」判定：computed overflow-y 为 auto/scroll
    // （与 useVirtualList.pickScroller 同口径）。舞台布局下面板体恒为
    // 内滚口（所有断点形态都有界）；viewEl 页滚只剩兜底语义——不命中时
    // scrollIntoView/页滚路径照旧工作
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
    // 歌词自动跟随闸：歌词容器自身是滚动口（舞台布局恒如此）时跟随只
    // 滚容器内部——恒放行。页滚兜底态才需要几何闸：歌词区没压到视口中线
    // （用户还停在封面/操作区，或词区偏离正中）时不把整页拽过去。
    // 切 tab 是显式请求，centerCurrentRow 不走此闸
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
    // 断点：歌词容器是自有滚动口时（舞台布局恒如此）只认栏内滑动——
    // 在视频区/队列栏滑不算碰词、不暂停；页滚兜底态整页都是滚动器，
    // 任意处滑动都算。
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
        // 挑当前真滚动根：恒为面板体 queueContainer、viewEl 页滚兜底；越界 -1 内部已挡）
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
    // mediaStreamRetry 戳喂进 bv/yt 支在线 URL 的 retry 参数（旁路服务端
    // 流解析正缓存读，yt 还旁路 gateCache 闸控判定缓存——与 usePlayer 音频链
    // _streamRetried 同口径）；file 链 URL 带 videoV 版本戳本来就换源。
    // 切歌（key 换）清零，新源拿满重试预算
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
    // 音画切换文案单源：action=「切到…」动作短串，供 ⋯ 菜单音画 radio 组里
    // 目标项的 title（当前态项不给——点它不产生动作）。残余「判无可放」
    // （hasPlayableVideo=false）落「需已下载视频档」降级支
    const avToggle = computed(() => ({
      action: videoOn.value
        ? '纯音频（省流量）'
        : (hasPlayableVideo.value ? '视频模式' : '视频模式（需已下载视频档）'),
    }))
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
        // mediaStreamRetry 戳带 retry=1 旁路服务端流解析正缓存读——缓存的
        // 死档不再钉住复位重挂（与 yt 支/usePlayer 音频链 _streamRetried 同口径）
        return downloadedVideoUrl.value
          || ((b?.bvid ? b.hasVideo : bv)
            ? musicApi.bilibiliStreamUrl(b?.bvid || bv?.[1], 'video', b?.cid, b?.page || +bv?.[2] || 1, '', mediaStreamRetry.value)
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
    // 音画开关翻转 = 舞台/分屏几何换轨（面板体恒为滚动口但可视窗骤变），
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
      // 序数戳 mediaStreamRetry++：bv/yt 支 URL 同带 retry=1 旁路服务端正
      // 缓存读——bv 流解析正缓存死档、yt gateCache 闸控判定（SABR 探测无定论
      // 按未闸放行）都不再钉住重挂；file 支 URL 带 videoV 版本戳本来就换源
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

    // ── 媒体区 ⋯ 溢出菜单（TopNav ⋯ 菜单同一份 pg-menu 方案）──
    const menuBtn = ref(null)
    const menuOpen = ref(false)
    const menuPos = ref({})
    // 音画模式组出场闸：原行内切换键的复合条件原样保留——按 provider 存在性
    // 出项（与 mediaVideoKey 同律：导入标记可能被裁/老数据缺标，盘上躺着档
    // 的曲也要能切回音频、VIDEO_MODE=0 的用户也要有入口开视频重探）；裸
    // bv_/yt_ id（缺对象老行）凭 id 形态同出；file_ 仍按 hasVideo。抽成
    // computed 供模板 v-if 与 menuPos 行数估算共用
    const showAvGroup = computed(() =>
      !!(props.currentSong?.bilibili?.bvid || props.currentSong?.youtube?.videoId
        || props.currentSong?.file?.hasVideo || bvM.value || ytM.value))

    const toggleMenu = () => {
      if (menuOpen.value) { closeMenu(); return }
      const rect = menuBtn.value?.getBoundingClientRect?.()
      if (!rect) return
      // 菜单高按可见行数估（item≈39/head≈36——TopNav 同公式）：下方放不下翻到上方
      const fileTrack = isFileTrackId(props.currentSong?.id)
      const items = (showAvGroup.value ? 2 : 0)
        + 1                                          // 沉浸恒在
        + (fileTrack ? 0 : 1)                        // 分享（file_ 不出项）
        + (props.currentSong && !fileTrack ? 1 : 0)  // 下载（同 file_ 闸）
        + (sourceUrl.value ? 1 : 0)                  // 回源
      const h = items * 39 + (showAvGroup.value ? 36 : 0) + 8
      menuPos.value = {
        top: (rect.bottom + 4 + h <= window.innerHeight
          ? rect.bottom + 4 : Math.max(8, rect.top - h - 4)) + 'px',
        // 右缘对齐触发键右缘——菜单从 ⋯ 键右缘向左展开
        right: Math.max(8, window.innerWidth - rect.right) + 'px'
      }
      menuOpen.value = true
      // 菜单 teleport 到 body 末尾——不主动移焦，键盘 Tab 会穿进菜单底下
      // 的页面内容；开菜单即聚焦第一项（.pg-menu-item 均真实 button/a，
      // 编程聚焦在鼠标点击后不出 :focus-visible 环，鼠标用户无感）
      nextTick(() => document.querySelector('#watch-actions-menu .pg-menu-item')?.focus())
    }

    const closeMenu = (restoreFocus = false) => {
      const was = menuOpen.value
      menuOpen.value = false
      if (restoreFocus && was) menuBtn.value?.focus({ preventScroll: true })
    }

    // 点选=执行+关菜单归还焦点（TopNav pickTheme 同型：无下一跳接管焦点，
    // 与 Esc 同为解散语义——沉浸层挂载后自己收焦点，归还先行一步无碍）
    const pickAvMode = (on) => { videoOn.value = on; closeMenu(true) }
    const pickFullscreen = () => { emit('open-fullscreen'); closeMenu(true) }
    const pickShare = () => { shareSong(); closeMenu(true) }
    const pickDownload = () => { emit('download-song'); closeMenu(true) }

    // pointerdown 先于 click 且不受 @click.stop 影响——豁免菜单本体与触发键
    const onMenuDocPointerDown = (e) => {
      if (!(e.target instanceof Element)) return
      if (!e.target.closest('.watch-actions-menu, .watch-menu-btn')) closeMenu()
    }
    // Esc 解散菜单；焦点归还仅在焦点还在菜单/触发键内时进行——
    // 用户已把焦点挪去别处时不得强拽（TopNav onMenuKeydown 同闸）。
    // App onGlobalKeydown 已消费的 Esc 带 defaultPrevented 戳——同发按键
    // 只收一层让位不双收；监听须挂 window 相位才读得到戳
    const onMenuKeydown = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !menuOpen.value) return
      const ae = document.activeElement
      closeMenu(ae === menuBtn.value || !!ae?.closest?.('#watch-actions-menu'))
    }
    // 直传 closeMenu 会把 Event 对象塞进 restoreFocus 形参（真事件源→真值
    // →resize 时强拽焦点）——必须包箭头（PlaylistPanel closeOnScroll 同坑）
    const onMenuResizeClose = () => closeMenu()

    onMounted(() => {
      document.addEventListener('pointerdown', onMenuDocPointerDown)
      window.addEventListener('keydown', onMenuKeydown)
      // 菜单位置按开时视口算死——resize 即过期，直接关（TopNav 同律）
      window.addEventListener('resize', onMenuResizeClose)
    })
    onBeforeUnmount(() => {
      document.removeEventListener('pointerdown', onMenuDocPointerDown)
      window.removeEventListener('keydown', onMenuKeydown)
      window.removeEventListener('resize', onMenuResizeClose)
    })

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
      ambientUrl,
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
      relatedHeadLabel,
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
      menuBtn,
      menuOpen,
      menuPos,
      showAvGroup,
      toggleMenu,
      closeMenu,
      pickAvMode,
      pickFullscreen,
      pickShare,
      pickDownload,
      cycleMenuItems,
      pauseLyricFollow,
      onWatchTouchStart
    }
  }
}
</script>

<style scoped>
/* ══ Watch 沉浸舞台（YTM 播放页语言）══
   盒模型/断点全收本层（布局单一事实源）。全态有界：view 不滚、
   面板体恒为内滚口——脚本的几何滚动根检测保留作页滚兜底 */

.watch-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  --watch-pad-x: 12px;
  padding-inline: var(--watch-pad-x);
}
@media (min-width: 641px) {
  .watch-view { --watch-pad-x: clamp(16px, 2.2vw, 40px); }
}

/* ── 氛围场：封面小图高糊放大铺全屏 + 双层 scrim 压回舞台黑 ── */
.watch-ambient {
  position: fixed;
  inset: 0;
  z-index: -1; /* app-shell isolation:isolate 圈住——画在壳底之上、内容之下 */
  pointer-events: none;
}
.watch-ambient-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(80px) saturate(1.4);
  transform: scale(1.25); /* 收糊化后漏出的未覆盖缘 */
  opacity: .55;
}
.watch-ambient-scrim {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 90% at 50% 0%, transparent 40%, rgba(11, 11, 11, .55) 100%),
    linear-gradient(to bottom, rgba(11, 11, 11, .35), var(--stage-bg, #0b0b0b) 85%);
}
.watch-ambient-fade-enter-active,
.watch-ambient-fade-leave-active { transition: opacity .6s ease; }
.watch-ambient-fade-enter-from,
.watch-ambient-fade-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .watch-ambient-fade-enter-active,
  .watch-ambient-fade-leave-active { transition: none; }
}

/* ── 页头行：返回 + ⋯ 触发键（常显在流 40px）── */
.watch-head {
  height: 40px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.watch-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px 0 8px;
  margin-left: -8px; /* 图标键视觉左缘对到栏轴（视频左缘同轴） */
  border: 0;
  border-radius: 999px;
  background: transparent;
  font-size: 13px;
  color: var(--ink);
  cursor: pointer;
}
.watch-back:hover { background: rgba(255, 255, 255, .08); }
.watch-menu-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
}
.watch-menu-btn:hover { background: rgba(255, 255, 255, .08); }
.watch-back:focus-visible,
.watch-menu-btn:focus-visible,
.watch-video-toggle:focus-visible,
.watch-video-fs:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
  box-shadow: 0 0 0 4px rgba(0, 0, 0, .75);
}

/* ── 布局：单列纵排为基态（移动有界），双栏态见底部媒体块 ── */
.watch-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 12px;
}
.watch-main {
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.watch-main--video { align-items: flex-start; }

/* 媒体盒：单列态封面 ≤28svh 方形居中、视频满宽 16:9；双栏态改容器单位 */
.watch-cover-wrap {
  position: relative; /* 控制层/全屏键的锚 */
  flex-shrink: 0;
  width: min(100%, 28svh);
  aspect-ratio: 1;
  border-radius: 12px;
  overflow: hidden; /* 收 media 圆角 */
  box-shadow: 0 24px 64px rgba(0, 0, 0, .5);
}
.watch-cover-wrap--video {
  width: 100%;
  aspect-ratio: 16 / 9;
  box-shadow: none;
}
.watch-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.watch-cover--video {
  object-fit: contain;
  background: #000;
  touch-action: manipulation; /* 点画面=播放/暂停——禁双击缩放延迟 */
}
.watch-cover--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--ink-06);
}

/* ≤640 视频贴缘出血：负边距吃回页槽、去圆角。width 须一并加双槽——
   width:100% 只够到栏盒，负边距会把右缘短口留在屏内（实测右缺 ~2×槽） */
@media (max-width: 640.98px) {
  .watch-cover-wrap--video {
    width: calc(100% + 2 * var(--watch-pad-x));
    margin-inline: calc(-1 * var(--watch-pad-x));
    border-radius: 0;
  }
}

/* 视频悬停控制层：默认隐，JS --on 驱动露出（戳醒 2.6s 自隐，暂停常显）；
   键盘 Tab 由 :has(:focus-visible) 兜底露出——透明可聚焦键是键盘陷阱 */
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
.watch-cover-wrap--video:has(:focus-visible) .watch-video-controls { opacity: 1; }
.watch-video-controls :is(.watch-video-toggle, .watch-video-fs) { pointer-events: none; }
.watch-video-controls--on :is(.watch-video-toggle, .watch-video-fs),
.watch-cover-wrap--video:has(:focus-visible) :is(.watch-video-toggle, .watch-video-fs) {
  pointer-events: auto;
}
/* 无 :has 的老内核退 focus-within：宁恒显勿键盘陷阱 */
@supports not (selector(:has(:focus-visible))) {
  .watch-cover-wrap--video:focus-within .watch-video-controls { opacity: 1; }
  .watch-cover-wrap--video:focus-within :is(.watch-video-toggle, .watch-video-fs) { pointer-events: auto; }
}
/* 全屏下控件收掉时连光标一起隐——流媒体播放器的 idle 手势 */
.watch-cover-wrap--idle { cursor: none; }
@media (prefers-reduced-motion: reduce) {
  .watch-video-controls, .watch-video-toggle, .watch-video-fs { transition: none; }
}

.watch-video-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, .55);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  color: #fff;
  cursor: pointer;
  transition: background .15s, transform .15s;
}
.watch-video-toggle:hover { background: rgba(0, 0, 0, .75); transform: scale(1.06); }
.watch-video-fs {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, .55);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  color: #fff;
  cursor: pointer;
  transition: background .15s;
}
.watch-video-fs:hover { background: rgba(0, 0, 0, .75); }

/* 元素全屏：wrap 黑场满屏居中（:-webkit-full-screen 单列——不识伪类会让
   整条规则作废） */
.watch-cover-wrap:fullscreen {
  width: 100%;
  height: 100%;
  border-radius: 0;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.watch-cover-wrap:fullscreen .watch-cover--video { width: 100%; height: 100%; }
.watch-cover-wrap:-webkit-full-screen {
  width: 100%;
  height: 100%;
  border-radius: 0;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.watch-cover-wrap:-webkit-full-screen .watch-cover--video { width: 100%; height: 100%; }

/* ── 面板列：无底——行级 hover/当前高亮即可 ── */
.watch-side {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* tab 行：满宽等分三档，激活 = 墨字 + 2px 下划线 */
.watch-tabs {
  flex-shrink: 0;
  display: flex;
  border-bottom: var(--hairline-soft);
}
.watch-tab {
  flex: 1;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  border: 0;
  background: transparent;
  font-size: 14px;
  font-weight: 500;
  color: var(--ink-64);
  cursor: pointer;
  transition: color .2s;
}
.watch-tab:hover { color: var(--ink); }
.watch-tab--active { color: var(--ink); }
.watch-tab::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -1px;
  height: 2px;
  background: var(--ink);
  transform: scaleX(0);
}
.watch-tab--active::after { transform: scaleX(1); }
@media (prefers-reduced-motion: no-preference) {
  .watch-tab::after { transition: transform .2s var(--ease-ink); }
}

/* 语境行：队列=源名+规模 / 相关=艺人+规模（36px 矮行，歌词不出行） */
.watch-side-meta {
  flex-shrink: 0;
  height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
}
.watch-side-meta .queue-head-name { font-size: 12px; }

/* 面板体：全态恒为内滚口（虚拟滑窗/歌词跟随的滚动根）；
   container-type:size 让歌词 35cqh 内边距以面板高为参照 */
.watch-side-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-top: 4px;
  container-type: size;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, .2) transparent;
  scrollbar-gutter: stable;
}

.watch-empty {
  text-align: center;
  padding: 48px 16px;
  font-size: 13px;
  color: var(--ink-64);
}

/* ── 队列/相关行族（YTM 密度：56px 行、40px 缩略）── */
.watch-side-body .queue-row {
  padding: 8px;
  gap: 8px;
  border-radius: 8px;
}
.watch-side-body .queue-row + .queue-row { border-top: none; }
.watch-side-body .queue-row-main { gap: 10px; padding: 0; }
.watch-side-body .queue-row--current { box-shadow: none; } /* accent 书脊退役——当前行=白 .10 块+等幅器 */
/* 已播行只淡标题（缩略图/序号读数保持原亮） */
.watch-side-body .queue-row--played { opacity: 1; }
.watch-side-body .queue-row--played .queue-row-title { color: var(--ink-64); }
.watch-side-body .queue-row-title { font-size: 14px; }
.watch-side-body .queue-row-artist,
.watch-side-body .queue-row-duration { font-size: 12px; }
.watch-side-body .queue-row--dragging { background: var(--ink-10); }
.watch-queue-thumb {
  width: 40px;
  height: 40px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
}
.watch-queue-thumb--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--ink-06);
}

/* 拖拽把手：悬停/聚焦/拖拽中才显形（触控恒显——同 remove/add 键纪律） */
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
  color: var(--ink-64);
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
.watch-grip:active { cursor: grabbing; color: var(--ink); }
@media (hover: none) {
  .watch-grip { opacity: 1; pointer-events: auto; color: var(--ink); width: 28px; }
}

/* 「接下来」分节线：12px 弱字 + 顶距，不画线 */
.watch-side-body .queue-sec {
  padding: 18px 8px 6px;
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0;
}
.watch-side-body .queue-sec::after { content: none; }

/* 相关行没有 remove 键——补其占位让时长列与队列行对轴 */
.watch-related-row .queue-row-main { margin-right: 30px; }

/* ── 面板页脚（钉栏底）── */
.watch-queue-foot,
.lyric-tools {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 0;
  border-top: var(--hairline-soft);
}
/* 空队列只剩偏好组——去线居中，不吊在角落 */
.watch-queue-foot--empty { border-top: none; justify-content: center; }

/* 幽灵胶囊键（页脚动作：存为歌单/清空队列） */
.watch-foot-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, .16);
  border-radius: 999px;
  background: transparent;
  color: var(--ink);
  font-size: 12px;
  cursor: pointer;
  transition: background .15s;
}
.watch-foot-btn:hover:not(:disabled) { background: rgba(255, 255, 255, .08); }
.watch-foot-btn:disabled { opacity: .45; cursor: default; }

/* ≤640 底栏减负收走 shuffle/模式键后落点在此——圆胶囊联排组 */
.queue-modes { display: none; }
@media (max-width: 640.98px) {
  .queue-modes {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: 999px;
    background: rgba(255, 255, 255, .08);
  }
}
.queue-mode-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
  padding: 3px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--ink-86);
  cursor: pointer;
}
.queue-mode-btn:hover { background: rgba(255, 255, 255, .08); color: var(--ink); }
.queue-mode-btn--on,
.queue-mode-btn--on:hover { background: rgba(255, 255, 255, .9); color: #0b0b0b; }

/* 自动播放：原生 checkbox 语义保留，外观改拨片开关 */
.watch-autoplay {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-size: 12px;
  color: var(--ink-86);
  cursor: pointer;
}
/* 空队列居中态只收基态 margin-left:auto（否则 autoplay 独置正中、
   modes 被挤回左缘角落） */
.watch-queue-foot--empty .watch-autoplay { margin-left: 0; }
.watch-autoplay .pg-check {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
  width: 32px;
  height: 18px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, .24);
  position: relative;
  flex-shrink: 0;
  cursor: pointer;
  transition: background .15s;
}
.watch-autoplay .pg-check::after {
  content: '';
  position: absolute;
  inset: 2px auto auto 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform .15s;
}
.watch-autoplay .pg-check:checked { background: #f1f1f1; }
.watch-autoplay .pg-check:checked::after {
  content: ''; /* 盖全局 ✓ 字形 */
  transform: translateX(14px);
  background: #0b0b0b;
}
@media (prefers-reduced-motion: reduce) {
  .watch-autoplay .pg-check, .watch-autoplay .pg-check::after { transition: none; }
}

/* ── 歌词：左对齐大行，当前行白、过去行 .32、未到行 .45 ── */
.watch-lyric-list {
  display: flex;
  flex-direction: column;
  gap: .9em;
  font-size: var(--lyric-fs, 18px);
  /* 顶底大垫 ≈35% 面板高：让当前行能停进面板纵向中段
     （svh 不识的老内核退 8em 常数档，再退 cqh 精确档） */
  padding-block: 8em;
  padding-block: 30svh;
  padding-block: 35cqh;
  padding-inline: 16px;
}
.watch-lyric-line {
  font-size: 1em;
  font-weight: 700;
  line-height: 1.35;
  color: rgba(255, 255, 255, .45);
  transition: color .3s;
  /* 长歌词屏外行跳布局/绘制；scrollIntoView 会强制即时渲染目标行 */
  content-visibility: auto;
  contain-intrinsic-size: auto 30px;
}
.watch-lyric-line--past { color: rgba(255, 255, 255, .32); }
.watch-lyric-line--current { color: #fff; }
.watch-lyric-translation {
  margin-top: .35em;
  font-size: .72em;
  font-weight: 500;
  opacity: .6;
}
@media (prefers-reduced-motion: reduce) {
  .watch-lyric-line { transition: none; }
}

/* 歌词工具条：无盒联排紧凑键，组间 12px 呼吸缝 */
.lyric-tools-group {
  display: flex;
  align-items: center;
  gap: 2px;
}
.lyric-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 32px;
  min-width: 32px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  line-height: 1;
  color: var(--ink-86);
  cursor: pointer;
  transition: background .15s, color .15s;
}
.lyric-tool:hover:not(:disabled) { background: rgba(255, 255, 255, .08); color: var(--ink); }
.lyric-tool:disabled { opacity: .38; cursor: default; }
/* 图标+文案混排键（歌词获取组） */
.lyric-tool--icon { gap: 5px; }
.lyric-tool-val {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px 6px;
  min-height: 32px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-64);
}
/* 校准值键兼复位：按最大刻度预留宽，值跳变时整组不位移 */
.lyric-tool-reset { min-width: 56px; }

/* ── ⋯ 菜单两件特件（盒模型全走全局 .pg-menu 族）── */
/* 音画组与后续项的分隔：组内末项命中 .pg-menu-item:last-child 无底线，
   组后还有项时由组级发丝线补上 */
.watch-actions-menu [role="group"]:not(:last-child) {
  border-bottom: var(--hairline-soft);
}
/* 音画 radio 项 ✓ 槽定宽对齐——无图标侧空槽占位，两档文字左缘对齐 */
.watch-menu-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--accent-magenta-ink);
}

/* ── 双栏态：宽屏（≥901）与窄屏矮窗（≤900.98∧<600h 横屏）──
   舞台列 + 面板列；页头退居舞台列顶行、面板跨两行吃满视高——
   ⋯ 键不再悬在面板上压出 40px 空行（两态同一摆放模型） */
@media (min-width: 901px) {
  .watch-view {
    grid-template-columns: minmax(0, 1fr) clamp(340px, 30vw, 520px);
    column-gap: clamp(24px, 2.5vw, 48px);
    padding-bottom: 24px; /* layout 透明化后底垫移到网格本体 */
  }
}
@media (max-width: 900.98px) and (max-height: 599.98px) {
  /* 264px 视图里多腾一整行列表 */
  .watch-view {
    grid-template-columns: minmax(0, 1fr) min(46vw, 420px);
    column-gap: 16px;
  }
  /* 矮窗面板收紧：语境行让位、tab 降 40px、页脚减垫——保 ≥3 列表行 */
  .watch-side-meta { display: none; }
  .watch-tab { height: 40px; }
  .watch-queue-foot,
  .lyric-tools { padding-block: 8px; }
}
@media (min-width: 901px), (max-width: 900.98px) and (max-height: 599.98px) {
  .watch-view {
    display: grid;
    grid-template-rows: 40px minmax(0, 1fr);
  }
  .watch-layout { display: contents; }
  .watch-head { grid-column: 1; grid-row: 1; min-width: 0; }
  .watch-main { grid-column: 1; grid-row: 2; min-width: 0; }
  .watch-side { grid-column: 2; grid-row: 1 / -1; }
  .watch-main {
    /* 定尺寸查询容器：媒体按列内剩余空间取尺寸 */
    container-type: size;
    overflow: hidden; /* 媒体超高不外溢 */
  }
  .watch-cover-wrap { width: min(100cqw, 100cqh, 760px); }
  .watch-cover-wrap--video { width: min(100cqw, 100cqh * 16 / 9); }
}
@media (min-width: 901px) {
  /* 宽屏面板让位页头行（顶缘与媒体列行 2 对齐、底缘吃 24px 底垫）——
     须晚于合并态的 1/-1 跨行规则才生效；矮窗态不动，仍跨两行吃满视高 */
  .watch-side { grid-row: 2; }
}
/* 容器单位缺席的老内核：回旧式视口高预算 */
@supports not (width: 1cqh) {
  @media (min-width: 901px), (max-width: 900.98px) and (max-height: 599.98px) {
    .watch-cover-wrap { width: min(100%, 60svh, 760px); }
    .watch-cover-wrap--video { width: min(100%, calc((100dvh - 260px) * 16 / 9)); }
  }
}

/* 紧凑页脚态（≤640 窄屏与矮窗横屏同收）：页脚动作键变 36px 圆图标键
   保单行——文案进 title/aria-label；触控地板 ≥36px 同步罩 lyric 工具键 */
@media (max-width: 640.98px), (max-width: 900.98px) and (max-height: 599.98px) {
  .watch-foot-btn {
    width: 36px;
    height: 36px;
    padding: 0;
    border-radius: 50%;
    justify-content: center;
  }
  .watch-foot-btn-label { display: none; }
  .watch-queue-foot { flex-wrap: nowrap; }
  .lyric-tool, .lyric-tool-val { min-height: 36px; }
  .queue-mode-btn { min-width: 36px; min-height: 36px; }
}
</style>
