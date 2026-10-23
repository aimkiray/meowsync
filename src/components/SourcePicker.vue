<template>
  <Teleport to="body">
    <!-- 遮罩三点自证关窗（down/up/click 全落遮罩才算主动关）——与
         LyricPicker/App 三弹层同构；busy（绑定/解绑提交在飞）期一切
         关闭通道失效，避免飞中的结果没有落点 -->
    <div
      class="atp-overlay"
      @mousedown="onOverlayDown"
      @mouseup="onOverlayUp"
      @click="onOverlayClick"
    >
      <div
        ref="dialogEl"
        class="atp-dialog sp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="手动选择播放源"
        tabindex="-1"
        @click.stop
        @keydown="onDialogKeydown"
      >
        <div class="pg-menu-head flex items-center justify-between gap-2">
          <span class="truncate min-w-0">手动选择播放源<template v-if="songName"> · {{ songName }}</template></span>
          <button
            type="button"
            class="pg-icobtn pg-icobtn--bare pg-icobtn--sm shrink-0"
            aria-label="关闭"
            title="关闭"
            :disabled="busy"
            @click="requestClose"
          ><PixelIcon name="close" :size="13" /></button>
        </div>

        <!-- 检索条：改词重检候选池。词与默认派生口径同串（预填词回车）走
             默认词入池——「提交预填词」语义是重打默认检索；词偏离默认口径
             才记手动形态（lastFeed.manual 分口径空态文案与恢复默认显隐）。
             首载恒显式传派生词——服务端 keyword 在场跳过 song_detail
             兜底派生零多跳。busy（绑定/解绑在飞）期整行禁用，与关窗通道
             同闸；song0 无 id 时 load 早退、提交静默无效——整行同闸禁用 -->
        <div class="sp-search" role="search">
          <div class="pg-field sp-search-field">
            <input
              v-model="query"
              type="text"
              aria-label="搜索关键词"
              placeholder="搜索关键词"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy || !song0?.id"
              @keydown.enter.prevent="runSearch"
            />
          </div>
          <button
            type="button"
            class="pg-icobtn sp-search-go"
            aria-label="搜索"
            title="搜索"
            :disabled="busy || !song0?.id || !query.trim()"
            @click="runSearch"
          ><PixelIcon name="search" :size="15" /></button>
          <!-- 词偏离默认派生口径才露：回填+立即以默认词重检一体（不是只填不搜） -->
          <button
            v-if="!isDefaultQuery"
            type="button"
            class="sp-search-reset"
            :disabled="busy || !song0?.id"
            @click="restoreQuery"
          >恢复默认</button>
        </div>

        <!-- 粘贴直绑行：不占检索框语义的独立输入——本地纯正则解析
             （BVID_IN_TEXT_RE 命中→bilibili，extractYouTubeId 命中→
             youtube），识别成功即走与 pick 同一条 POST（不带 title/owner
             ——服务端存空串，读口 UI 回落显示 mediaId）；服务端永不接
             URL 串，av 号/b23.tv 短链不解析（跳解需出站，本批不做） -->
        <div class="sp-direct">
          <div class="pg-field sp-direct-field">
            <input
              v-model="directInput"
              type="text"
              aria-label="粘贴媒体链接或 ID 直接绑定"
              placeholder="粘贴 BV 号 / B 站链接 / YouTube 链接 / 视频 ID 直接绑定"
              title="支持 BV 号、bilibili.com 视频链接、youtube.com/youtu.be 链接、11 位 YouTube 视频 ID；av 号与 b23.tv 短链暂不解析"
              autocomplete="off"
              spellcheck="false"
              :disabled="busy || !song0?.id"
              @keydown.enter.prevent="bindDirect"
            />
          </div>
          <button
            type="button"
            class="pg-icobtn sp-direct-go"
            aria-label="直接绑定"
            title="直接绑定"
            :disabled="busy || !song0?.id || !directInput.trim()"
            @click="bindDirect"
          ><PixelIcon name="broadcast" :size="15" /></button>
        </div>

        <div class="sp-list" role="list" aria-label="媒体源候选">
          <p v-if="loading" class="sp-state">
            <span class="pixel-loading" aria-hidden="true"></span>
            <span>正在检索媒体源…</span>
          </p>
          <template v-else-if="loadFailed">
            <p class="sp-state">媒体源检索失败：{{ loadFailed }}</p>
            <div class="sp-retry">
              <button type="button" class="ink-btn ink-btn--sm" @click="retry">重试</button>
            </div>
          </template>
          <template v-else>
            <!-- 单源故障部行：服务端 errors 在场说明另一源照常出池——
                 提示行如实留痕但不挡列表（双源全灭是 loadFailed 不是这里） -->
            <p v-if="errors.length" class="sp-partial" :title="partialTitle">
              部分源检索失败：{{ partialSources }}
            </p>
            <p v-if="!sortedCandidates.length" class="sp-state">{{ emptyText }}</p>
            <div v-for="c in sortedCandidates" :key="c.source + ':' + c.mediaId" role="listitem" class="sp-item">
              <button
                type="button"
                class="pg-menu-item sp-row"
                :class="{ 'sp-row--current': isCurrent(c) }"
                :aria-label="rowLabel(c)"
                :disabled="busy"
                @click="pick(c)"
              >
                <span class="sp-badge" :class="`sp-badge--${c.source}`" aria-hidden="true">{{ sourceBadge(c.source) }}</span>
                <img
                  v-if="coverUrl(c) && !coverErrs.has(ckey(c))"
                  :src="coverUrl(c)"
                  alt=""
                  class="sp-thumb"
                  loading="lazy"
                  decoding="async"
                  @error="coverErrs.add(ckey(c))"
                />
                <span v-else class="sp-thumb sp-thumb--fallback" aria-hidden="true"><PixelIcon name="note" :size="14" /></span>
                <span class="sp-text">
                  <span class="sp-title">{{ c.title || '（无标题）' }}<template v-if="c.owner"> — {{ c.owner }}</template></span>
                  <span v-if="isCurrent(c)" class="sp-current">当前绑定</span>
                </span>
                <span class="sp-meta" aria-hidden="true">
                  <span v-if="c.durationSec" class="sp-dur">{{ formatTime(c.durationSec) }}</span>
                  <span v-if="c.publishedTimeText" class="sp-pub">{{ c.publishedTimeText }}</span>
                </span>
              </button>
            </div>
          </template>
        </div>

        <p v-if="pickError" class="sp-pickerr" role="alert">{{ pickError }}</p>

        <!-- 已存在手动绑定才露解绑口，文案分轨道形态：数值曲解绑后
             解锁链回落 pyncmd→youtube→bilibili 自动搜索（恢复自动匹配）；
             qq_/bv_/yt_ 外源曲回落自有源腿（恢复原始源——外源无「自动
             匹配」可恢复）。摘要行如实展示绑定快照（title/owner 是绑定
             时刻展示快照非权威，缺省回落 mediaId） -->
        <div v-if="hasManual" class="sp-foot">
          <p class="sp-manual" :title="manualSummary">
            当前绑定：<span class="sp-badge" :class="`sp-badge--${manual.source}`" aria-hidden="true">{{ sourceBadge(manual.source) }}</span> {{ sourceName(manual.source) }} · {{ manualSummary }}
          </p>
          <button
            type="button"
            class="sp-clear"
            :disabled="busy"
            @click="clearManual"
          >{{ isExtTrack ? '恢复原始源（解除手动绑定）' : '恢复自动匹配（解除手动绑定）' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script>
import { musicApi } from '../api/music.js'
import { apiErrorMessage } from '../api/http.js'
import { toast } from '../lib/feedback.js'
import { formatTime } from '../lib/format.js'
import { trapTabKeydown, cycleMenuItems } from '../lib/focus-trap.js'
import { BVID_IN_TEXT_RE, extractYouTubeId, QQ_SONG_ID_RE, BV_TRACK_ID_RE, YT_TRACK_ID_RE } from '../lib/url.js'
import { proxiedCoverUrl } from '../lib/song.js'
import PixelIcon from './PixelIcon.vue'

// 媒体源徽标映射（服务端 /unlock/* 的 source 枚举——pyncmd 是零错配
// 官方直解无候选面，手动池只收两个搜索型源）
const SOURCE_BADGE = { youtube: 'YT', bilibili: 'B站' }
// 徽标是视觉缩写（YT）且 aria-hidden——无障碍文本/页脚摘要/textContent
// 语境用全名口径（SR 用户要听得出这是 youtube 还是 bilibili 候选）
const SOURCE_NAME = { youtube: 'YouTube', bilibili: 'B站' }

export default {
  name: 'SourcePicker',
  components: { PixelIcon },
  props: {
    song: { type: Object, required: true }
  },
  emits: ['close', 'applied'],
  data() {
    return {
      // 开窗时的曲快照——prop 是活引用（媒体键/遥控切歌会换 currentSong），
      // 而本窗的候选与绑定语义都钉在「开窗那首歌」上：全程用 song0 而不回
      // 读 prop，避免把 A 曲的候选绑去 B 曲
      song0: this.song,
      candidates: [],
      errors: [],
      loading: true,
      loadFailed: '',
      // 现行手动绑定行（hasManual/当前绑定高亮/页脚摘要共用）——读口
      // 失败归 null：「读不到绑定」与「没绑过」同口径不挡挑选
      manual: null,
      busy: false,
      pickError: '',
      // 检索框现值——开窗预填默认派生词（mounted 置），提交后保留作
      // 「当前检索词」读数不另开指示条
      query: '',
      // 「恢复默认」判定的锚：初始=客户端镜像派生词，首载/默认口径检索的
      // 回包 keyword 回显校正（服务端回显为锚——它才是实际用掉的词）
      defaultKeyword: '',
      // 最后一次实际提交的检索口径 {keyword,manual}——幂等闸/重试键/
      // 空态文案都认它不认输入框现值（框里可能是改了一半没提交的词）
      lastFeed: null,
      // 直绑输入行现值——与检索框分槽（不占检索语义，互不清扰）
      directInput: '',
      // 封面裂图记黑（key=source:mediaId）——换 fallback 音符块，
      // watch-related-row 同款（img 元素随 v-if 拆，不重试烧外联）
      coverErrs: new Set()
    }
  },
  computed: {
    songName() {
      return this.song0?.name || this.song0?.title || ''
    },
    hasManual() {
      return !!this.manual
    },
    // 「恢复默认」只在词偏离默认口径时露——trim 后比较，尾部空格不唤醒
    isDefaultQuery() {
      return this.query.trim() === this.defaultKeyword
    },
    // qq_/bv_/yt_ 外源轨道判定：自有源曲（自有源败亡时手动绑定媒体顶替，
    // 服务端 isUnlockManualTrackId 的外源三段——数值段是解锁链纠错面）。
    // 派生词基值（provider 原标题优先）与页脚/解绑文案分形态都吃它——
    // 本组件只需「是否外源」二分，数值曲仍走原口径
    isExtTrack() {
      const id = String(this.song0?.id ?? '')
      return QQ_SONG_ID_RE.test(id) || BV_TRACK_ID_RE.test(id) || YT_TRACK_ID_RE.test(id)
    },
    // 候选展示序：按时长贴近升序（|c.durationSec - song0.dt/1000|）——
    // 排序是展示态，客户端持 song0.dt 自排（服务端不收 duration 参数
    // 不掺展示态）；durationSec/dt 缺席殿后，平手保源序（sort 稳定）
    sortedCandidates() {
      const dt = this.song0?.dt
      const base = Number.isFinite(dt) ? dt / 1000 : null
      const rank = (c) => (base != null && Number.isFinite(c?.durationSec))
        ? Math.abs(c.durationSec - base)
        : Infinity
      return [...this.candidates].sort((a, b) => rank(a) - rank(b))
    },
    // 空态分口径：手动检索的空池念用户词（「kw」没有候选），默认首载的
    // 空池维持原曲面文案——同一份空列表两种语境，一刀切会误导「哪次检索扑空」
    emptyText() {
      return this.lastFeed?.manual
        ? `「${this.lastFeed.keyword}」没有候选媒体源`
        : 'YouTube / B 站都没有这首歌的候选媒体源'
    },
    // 部分源故障提示行：列源名做摘要，msg 明细进 title（单行不挡列表）
    partialSources() {
      return this.errors.map(e => e?.source).filter(Boolean).join('、') || '未知源'
    },
    partialTitle() {
      return this.errors.map(e => `${e?.source || '?'}：${e?.msg || ''}`).join('\n')
    },
    // 页脚绑定摘要：title/owner 是绑定时刻展示快照（非权威——媒体本体
    // 随时可能下架/改题），title 缺席回落 mediaId；mediaId 恒括注殿后
    // （title 在场时）——快照名与真值键一眼对得上
    manualSummary() {
      const m = this.manual || {}
      const head = (m.title || m.mediaId || '') + (m.owner ? ` — ${m.owner}` : '')
      return m.title && m.mediaId ? `${head}（${m.mediaId}）` : head
    }
  },
  mounted() {
    this._aborter = new AbortController()
    this._prevFocus = document.activeElement
    // 焦点先落窗体——Esc/↑↓ 键处理挂在 dialog 根的 @keydown（冒泡段）上
    this.$refs.dialogEl?.focus({ preventScroll: true })
    // App 全局热键冻结补丁：本窗不在 App 的四窗冻结链里（emit 接线表在
    // App.vue，不在组件域）——capture 段在 window 截胡「焦点漏出窗」的
    // 键，否则点击遮罩把焦点洗回 body 后 k/←→/空格 会穿透到播放器全局热键
    this._onWinKeyCapture = (e) => {
      const d = this.$refs.dialogEl
      if (!d || d.contains(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      // 漏出窗的键照旧全吞（防穿透 App 全局热键），唯 Esc 例外——点过遮罩
      // 焦点洗回 body 后关窗通道不能死，路由去 requestClose（busy 闸照管）
      if (e.key === 'Escape') this.requestClose()
    }
    window.addEventListener('keydown', this._onWinKeyCapture, true)
    // 检索框预填与首载同一份默认派生口径（deriveKeyword 与 load 的默认
    // feed 同源——两处各写一份迟早口径漂移）；defaultKeyword 初始锚同时
    // 落位，首载回包 keyword 再校正
    this.query = this.defaultKeyword = this.deriveKeyword()
    this.load()
  },
  beforeUnmount() {
    this._aborter?.abort()
    window.removeEventListener('keydown', this._onWinKeyCapture, true)
    this._prevFocus?.focus?.({ preventScroll: true })
  },
  methods: {
    formatTime,
    // 源徽标：youtube/bilibili → YT/B站，未知源取前 3 位大写兜底
    sourceBadge(source) {
      return SOURCE_BADGE[source] || String(source || '').slice(0, 3).toUpperCase() || 'SRC'
    },
    // 源显示名（全名口径——徽标是 aria-hidden 的视觉缩写，SR/文本语境
    // 消费这个）：未知源回落徽标口径兜底
    sourceName(source) {
      return SOURCE_NAME[source] || this.sourceBadge(source)
    },
    // 候选行无障碍名：徽标/时长都是 aria-hidden 视觉件，行按钮自报
    // 「<源名> 候选：<title> — <owner>」——SR 用户据此分清这是 YouTube
    // 还是 B站候选；当前绑定行补标（sp-current 小标也是视觉件）
    rowLabel(c) {
      const t = `${this.sourceName(c?.source)} 候选：${c?.title || '（无标题）'}${c?.owner ? ` — ${c.owner}` : ''}`
      return this.isCurrent(c) ? `${t}（当前绑定）` : t
    },
    ckey(c) {
      return `${c?.source || ''}:${c?.mediaId || ''}`
    },
    // 封面走 /img-proxy：i.ytimg.com（videoId 确定性推导）与 *.hdslb.com
    // （bili 归一 pic）都在 IMG_PROXY_HOSTS 白名单——零被动外联不变式
    // 不破；proxiedCoverUrl 对协议相对/非白名单/畸形串恒归 ''，空串喂
    // v-if 落 fallback 音符块
    coverUrl(c) {
      return proxiedCoverUrl(c?.cover)
    },
    // 当前绑定行高亮：source+mediaId 双键全中才算（同 mediaId 异源不亮）
    isCurrent(c) {
      const m = this.manual
      return !!(m && c && m.source === c.source && m.mediaId === c.mediaId)
    },
    // 默认检索词的客户端镜像派生（数值曲与服务端 baseUnlockInfo 同一条
    // [canonical KWFORM] 规则句：artists 在场 `${name} - ${a / b}`、
    // 空回落裸 name——客户端显式传 keyword 则服务端跳过 detail 兜底，
    // 同一公式源不许另写拼接）。
    // 外源变体：bv_/yt_ 的 song.name 可能被匹配覆写，bilibili.title /
    // youtube.title 才是源站原标题——基值取 provider 原标题优先，比展示
    // 名更贴源站水域；qq_ 无 provider title 字段（name 即权威曲名）自然
    // 回落。qq_ 的 ar 是真实艺人表、bv_/yt_ 是上传者/频道净名——副词位
    // 帮助排歧。外源 id 服务端本无 detail 派生面（keyword 缺席即 400），
    // 首载显式传词是唯一通道
    deriveKeyword() {
      const s = this.song0 || {}
      const base = this.isExtTrack
        ? (s.bilibili?.title || s.youtube?.title || s.name || '')
        : (s.name || '')
      const artists = (s.ar || s.artists || [])
        .map(a => a?.name).filter(Boolean).join(' / ')
      return artists ? `${base} - ${artists}` : base
    },
    // 改词重检，两形态分家：词与默认口径同串（预填词原样回车）→ 默认
    // 词入池——「提交预填词」语义是重打默认检索；词偏离默认口径才记
    // 手动形态。空串无意义不提交；与上次实际提交同口径且非失败态 →
    // 静默跳过不重复扇出上游（失败态放行是重试通道）；在飞期间换词再
    // 提交允许——load 里 _aborter 重铸会掐断前一发
    runSearch() {
      const kw = this.query.trim()
      if (!kw || this.busy) return
      const last = this.lastFeed
      if (kw === this.defaultKeyword) {
        // 默认支路的幂等闸：lastFeed 已是默认口径且非失败态 → 跳闸
        if (!this.loadFailed && last && last.manual === false) return
        this.load({ keyword: this.defaultKeyword, manual: false })
        return
      }
      if (!this.loadFailed && last && last.manual === true && last.keyword === kw) return
      this.load({ keyword: kw, manual: true })
    },
    // 恢复默认：回填默认词并立即以默认口径重检——显式传默认口径而非空参，
    // 否则 load 会沿用 lastFeed 复打手动词（空参语义是「上次那发再来一遍」）
    restoreQuery() {
      if (this.busy) return
      this.query = this.defaultKeyword
      this.load({ keyword: this.defaultKeyword, manual: false })
    },
    // 重试复打「最后一次实际提交的口径」（lastFeed）——手动词失败重试仍打
    // 手动词不回落默认词；默认首载失败时 lastFeed 已是默认口径，同一条路。
    // busy 闸与 runSearch/restoreQuery 同律（绑定在飞期不允再发检索）
    retry() {
      if (this.busy) return
      this.load()
    },
    // 开屏并行：候选扇出 + 现有手动绑定读口（决定「当前绑定」高亮与页脚
    // 显隐）。over 在场=本轮检索口径覆盖（手动改词 {keyword,manual:true}；
    // 恢复默认传 {keyword,manual:false}）；缺省沿用 lastFeed——首载为 null
    // 落默认派生词，「重试」也走这里复打最后一次实际提交的口径。
    // keyword 恒显式传——服务端 keyword 在场跳过 song_detail 兜底派生
    // 零多跳；回包 keyword 校正 defaultKeyword（默认口径时）与 lastFeed
    // 记录（服务端回显为锚——它才是实际用掉的词）
    async load(over) {
      const song = this.song0
      if (!song?.id) { this.loading = false; return }
      this.loading = true
      this.loadFailed = ''
      this.pickError = ''
      this._aborter?.abort()
      this._aborter = new AbortController()
      const signal = this._aborter.signal
      const eff = over || this.lastFeed || { keyword: this.defaultKeyword || this.deriveKeyword(), manual: false }
      this.lastFeed = { keyword: eff.keyword, manual: eff.manual === true }
      // 候选扇出 + 现有绑定读口并行开跑。两条腿都套 Promise.resolve() 再起——
      // 桩缺席（测试/契约漂移）的同步 TypeError 落进 promise 链才被 catch
      // 兜住；读口失败归 null（按未绑处理），候选失败归 loadFailed 错误
      // 态——「读不到绑定」与「检索挂了」是两种结局不能混
      const manualP = Promise.resolve()
        .then(() => musicApi.getManualUnlock(song.id, signal))
        .then(hit => hit || null).catch(() => null)
      const candP = Promise.resolve()
        .then(() => musicApi.getUnlockCandidates({ id: song.id, keyword: eff.keyword }, signal))
        .then(res => ({ res })).catch(err => ({ err }))
      const [manual, candResult] = await Promise.all([manualP, candP])
      if (signal.aborted) return
      this.manual = manual
      if (candResult.err) {
        const e = candResult.err
        // 中止错误（关窗/重载拆掉在飞请求）不入错误态——窗可能已在收
        if (e?.name !== 'CanceledError' && e?.name !== 'AbortError' && e?.code !== 'ERR_CANCELED') {
          this.candidates = []
          this.errors = []
          this.loadFailed = apiErrorMessage(e)
        }
      } else {
        const res = candResult.res || {}
        const echoed = typeof res.keyword === 'string' && res.keyword.trim() ? res.keyword : null
        if (echoed) {
          // 服务端回显为锚：lastFeed 记实际用掉的词；默认口径的回显
          // 一并校正 defaultKeyword（手动词不回灌默认锚——否则「恢复
          // 默认」闸会把刚打的手动词误判成默认口径藏起来）
          this.lastFeed.keyword = echoed
          if (this.lastFeed.manual === false) this.defaultKeyword = echoed
        }
        this.candidates = Array.isArray(res.candidates) ? res.candidates : []
        this.errors = Array.isArray(res.errors) ? res.errors : []
      }
      this.loading = false
    },
    // 选定候选 → POST /unlock/manual 落绑定 → 上行 applied（父链经
    // notifyUnlockManualChange 对正播同曲保位重取址）。媒体失效（HTTP
    // 404 或业务码 404——服务端 resolveById 验流不过）只打内联
    // 「已失效或不可播」留窗重挑；其余错误出 toast 不关窗
    async pick(c) {
      if (this.busy || !this.song0?.id || !c?.mediaId || !c?.source) return
      await this.submitPick({
        source: c.source, mediaId: c.mediaId,
        title: c.title, owner: c.owner, durationSec: c.durationSec
      })
    },
    // 直绑行：本地纯正则解析（零出站——BVID_IN_TEXT_RE 命中→bilibili
    // 优先，extractYouTubeId 命中→youtube，av 号/b23.tv 短链不解析），
    // 识别成功走与 pick 同一条 POST（不带 title/owner——服务端存空串，
    // 读口 UI 回落显示 mediaId）；都不中打内联错留窗
    bindDirect() {
      const s = this.directInput.trim()
      if (!s || this.busy || !this.song0?.id) return
      const bv = s.match(BVID_IN_TEXT_RE)?.[0]
      let feed = null
      // BVID_IN_TEXT_RE 是 /i 宽松形——小写 bv1xxx 原样 POST 过小写校验
      // 但 bvid 对 B 站接口大小写敏感，resolveById 验流会 404；只正前缀
      //（后 9 位是大小写敏感的编码串，不动）
      if (bv) feed = { source: 'bilibili', mediaId: bv.replace(/^bv/i, 'BV') }
      else {
        const yt = extractYouTubeId(s)
        if (yt) feed = { source: 'youtube', mediaId: yt }
      }
      if (!feed) {
        this.pickError = '无法识别的链接或 ID'
        return
      }
      void this.submitPick(feed)
    },
    // pick/bindDirect 共用提交通道：busy 闸 + 404 内联 / 其余 toast
    // 分诊 + 成功后 applied+close——两入口只有「喂料形态」差异，
    // 绑定语义是同一条（直绑不带 title/owner 快照键）
    async submitPick(feed) {
      this.busy = true
      this.pickError = ''
      try {
        await musicApi.pickManualUnlock({ id: this.song0.id, ...feed })
        toast(`已绑定 ${this.sourceBadge(feed.source)} 媒体源`, 'success')
        this.$emit('applied', this.song0.id)
        this.$emit('close')
      } catch (e) {
        const status = e?.response?.status ?? e?.bizCode
        if (status === 404) {
          this.pickError = '该媒体源已失效或不可播'
        } else {
          toast(apiErrorMessage(e), 'error')
        }
      } finally {
        this.busy = false
      }
    },
    // 解绑 → 回落原链：数值曲恢复自动匹配（解锁链自动搜索）、外源曲
    // 恢复自有源（toast 分形态——外源无「自动匹配」可恢复，文案不许
    // 谎报回落面）。与 pick 共用 busy 闸，防双击并发；applied 上行
    // 同样走 notifyUnlockManualChange——解绑也是绑定变更，正播同曲
    // 要重取址回原链
    async clearManual() {
      if (this.busy || !this.song0?.id) return
      this.busy = true
      this.pickError = ''
      try {
        await musicApi.clearManualUnlock(this.song0.id)
        toast(this.isExtTrack ? '已解除手动绑定' : '已恢复自动匹配', 'success')
        this.$emit('applied', this.song0.id)
        this.$emit('close')
      } catch (e) {
        toast(apiErrorMessage(e), 'error')
      } finally {
        this.busy = false
      }
    },
    requestClose() {
      // busy 期关窗通道全熄：绑定提交在飞，关了也没有结果落点
      if (this.busy) return
      this.$emit('close')
    },
    // 遮罩三点自证：down/up/click 全落遮罩本体才算主动关窗（点击窗内
    // 元素冒泡到遮罩的 click 不算，按下在窗内抬起在外也不算）
    onOverlayDown(e) { this._selfDown = e.target === e.currentTarget },
    onOverlayUp(e) { this._selfUp = e.target === e.currentTarget },
    onOverlayClick(e) {
      if (e.target === e.currentTarget && this._selfDown && this._selfUp) this.requestClose()
      this._selfDown = false
      this._selfUp = false
    },
    onDialogKeydown(e) {
      // 窗内键一律截停——不再放给 App 全局热键（本窗不在其四窗冻结链）
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.requestClose()
        return
      }
      trapTabKeydown(e)
      // ↑↓ 在候选行间循环移焦（pg-menu 同律，items 选择器换成本窗行类）
      cycleMenuItems(e, '.sp-row:not([disabled])')
    }
  }
}
</script>

<style scoped>
/* 弹体：沿用 atp-dialog 纸面基底拓宽到候选行可读的 440px（lp-dialog
   同族）；候选行多一条 44px 封面位，max-height 比词选窗抬一档 */
.sp-dialog {
  width: min(440px, calc(100vw - 24px));
  max-height: min(460px, calc(100vh - 48px));
}
/* 检索条与直绑行同一行盒语言：field 吃全局 pg-field（纸面发丝盒 +
   focus-within 环），本层收密实档：32px 高（--ctrl-h-sm 与同行 pg-icobtn
   同盒）+ mono 11px（弹内读数一律这档）；直绑行收检索条同槽位下方 */
.sp-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: var(--hairline-soft);
}
.sp-direct {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: var(--hairline-soft);
}
.sp-search-field { flex: 1; min-width: 0; height: var(--ctrl-h-sm); }
.sp-search-field input { padding: 0 8px; font-family: var(--font-mono); font-size: 11px; }
.sp-search-field input:disabled { opacity: .45; }
.sp-direct-field { flex: 1; min-width: 0; height: var(--ctrl-h-sm); }
.sp-direct-field input { padding: 0 8px; font-family: var(--font-mono); font-size: 11px; }
.sp-direct-field input:disabled { opacity: .45; }
/* 「恢复默认」小号文本钮：弱于搜索钮的墨档出现（次级动作不抢眼），
   disabled/hover/focus 律与 sp-clear 同 */
.sp-search-reset {
  flex: none;
  padding: 0 2px;
  border: none;
  background: transparent;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  cursor: pointer;
}
.sp-search-reset:hover:not(:disabled) { color: var(--ink); }
.sp-search-reset:focus-visible { outline: 1px solid var(--ink); outline-offset: -1px; }
.sp-search-reset:disabled { opacity: .45; cursor: default; }
@media (pointer: coarse) {
  /* 防缩放地板线对弹内输入框同样生效——模态不豁免 iOS 聚焦整页 zoom；
     不写则 scoped 高特异度会压住全局 pg-field 的 16px 抬档 */
  .sp-search-field input,
  .sp-direct-field input { font-size: 16px; }
  /* 同行钮（pg-icobtn 常规档）在 coarse 抬到 40px 触达盒——输入盒跟到
     同高，否则行内 32px 盒配 40px 钮高低不齐 */
  .sp-search-field,
  .sp-direct-field { height: 40px; }
}
.sp-list {
  overflow-y: auto;
  min-height: 0;
  flex: 1;
}
/* 状态文本：对齐 atp-empty/watch-empty 的像素风小字空态 */
.sp-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 12px;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}
.sp-retry {
  display: flex;
  justify-content: center;
  padding: 0 0 14px;
}
/* 单源故障部行：弱墨档如实留痕不挡列表（msg 明细在 title attr） */
.sp-partial {
  margin: 0;
  padding: 6px 12px;
  border-bottom: var(--hairline-soft);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}
.sp-item { display: flex; }
/* 候选行：基底吃全局 pg-menu-item（全宽/hover 变色/发线分隔/禁用态），
   三段式内件 [源徽标+封面 | 标题—频道+当前绑定标 | 时长/发布档]。
   last-child 挂 .sp-item——行外包着 role=listitem 壳 */
.sp-row { padding: 8px 12px; }
.sp-item:last-child .sp-row { border-bottom: none; }
/* 当前绑定行底色：--ink-10 是全站「当前行」统一令牌（queue-row--current
   同口径）——主题随动；亮纸面写死的浅黑后备在暗色主题下≈不可见 */
.sp-row--current { background: var(--ink-10); }
.sp-badge {
  flex: none;
  align-self: flex-start;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  padding: 3px 4px;
  border: var(--hairline-soft);
  color: var(--ink-64);
}
/* 源徽标品牌位：YT 红借 danger 深档、B站粉借 magenta 深档（accent 本色
   在纸面 <4.5:1，11px 小字须用 -ink 档——lp-badge 同口径） */
.sp-badge--youtube { color: var(--accent-danger-ink, var(--ink)); }
.sp-badge--bilibili { color: var(--accent-magenta-ink, var(--ink)); }
/* 封面缩略图：44px 固宽位（16:9 裁 26px 高），发丝边收形；裂图记黑
   换 fallback 音符块（watch-queue-thumb--fallback 同款占位语言） */
.sp-thumb {
  flex: none;
  width: 44px;
  height: 26px;
  object-fit: cover;
  border: var(--hairline-soft);
}
.sp-thumb--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
}
.sp-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sp-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 「当前绑定」小标：行底色之外再加显式签——单靠底色在键盘移焦/
   hover 态下不够可辨 */
.sp-current {
  align-self: flex-start;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  padding: 2px 4px;
  border: var(--hairline-soft);
  color: var(--ink-86);
}
.sp-meta {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}
/* yt 本地化相对发布档原样透传（灰字小标，不参与排序） */
.sp-pub {
  padding: 2px 4px;
  border: var(--hairline-soft);
}
.sp-pickerr {
  margin: 0;
  padding: 6px 12px;
  border-top: var(--hairline-soft);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent-magenta-ink, var(--ink));
}
.sp-foot {
  border-top: var(--hairline-soft);
  flex: none;
}
/* 绑定摘要行：徽标 + 快照文案一行截断（title 在 title attr 里给全） */
.sp-manual {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 12px 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sp-clear {
  display: block;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--ink-64);
  font-family: var(--font-mono);
  font-size: 11px;
  text-align: center;
  cursor: pointer;
}
.sp-clear:hover:not(:disabled) { color: var(--ink); }
.sp-clear:focus-visible {
  outline: 1px solid var(--ink);
  outline-offset: -1px;
}
.sp-clear:disabled { opacity: .45; cursor: default; }
</style>
