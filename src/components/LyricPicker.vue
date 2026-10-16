<template>
  <Teleport to="body">
    <!-- 遮罩三点自证关窗（down/up/click 全落遮罩才算主动关）——App 三弹层同构；
         busy（绑定/解绑提交在飞）期一切关闭通道失效，避免飞中的结果没有落点 -->
    <div
      class="atp-overlay"
      @mousedown="onOverlayDown"
      @mouseup="onOverlayUp"
      @click="onOverlayClick"
    >
      <div
        ref="dialogEl"
        class="atp-dialog lp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="手动匹配歌词"
        tabindex="-1"
        @click.stop
        @keydown="onDialogKeydown"
      >
        <div class="pg-menu-head flex items-center justify-between gap-2">
          <span class="truncate min-w-0">手动匹配歌词<template v-if="songName"> · {{ songName }}</template></span>
          <button
            type="button"
            class="pg-icobtn pg-icobtn--bare pg-icobtn--sm shrink-0"
            aria-label="关闭"
            title="关闭"
            :disabled="busy"
            @click="requestClose"
          ><PixelIcon name="close" :size="13" /></button>
        </div>

        <div class="lp-list" role="list" aria-label="外部词源候选">
          <p v-if="loading" class="lp-state">
            <span class="pixel-loading" aria-hidden="true"></span>
            <span>正在检索外部词源…</span>
          </p>
          <template v-else-if="loadFailed">
            <p class="lp-state">外部词源检索失败：{{ loadFailed }}</p>
            <div class="lp-retry">
              <button type="button" class="ink-btn ink-btn--sm" @click="load">重试</button>
            </div>
          </template>
          <p v-else-if="!candidates.length" class="lp-state">外部词源没有这首歌的候选歌词</p>
          <div v-for="c in candidates" :key="c.extId" role="listitem" class="lp-item">
            <button
              type="button"
              class="pg-menu-item lp-row"
              :disabled="busy"
              @click="pick(c)"
            >
              <span class="lp-badge" :class="`lp-badge--${c.source}`" aria-hidden="true">{{ sourceBadge(c.source) }}</span>
              <span class="lp-text">
                <span class="lp-title">{{ c.title || '（无标题）' }}<template v-if="c.artist"> — {{ c.artist }}</template></span>
                <span v-if="c.preview" class="lp-preview">{{ c.preview }}</span>
              </span>
              <span class="lp-meta" aria-hidden="true">
                <span v-if="c.durationSec" class="lp-dur">{{ formatTime(c.durationSec) }}</span>
                <span class="lp-tag">{{ syncTag(c) }}</span>
              </span>
            </button>
          </div>
        </div>

        <p v-if="pickError" class="lp-pickerr" role="alert">{{ pickError }}</p>

        <!-- 已存在手动绑定才露「恢复自动匹配」：解绑后词载链回落自动级联 -->
        <div v-if="hasManual" class="lp-foot">
          <button
            type="button"
            class="lp-clear"
            :disabled="busy"
            @click="clearManual"
          >恢复自动匹配（解除手动绑定）</button>
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
import PixelIcon from './PixelIcon.vue'

// 词源徽标映射（后端 /lyric/candidates 的 source 枚举）
const SOURCE_BADGE = { lrclib: 'LRC', kugou: 'KGM', netease: '163', qq: 'QQ', ytm: 'YTM' }
// synced 字段可信度白名单：lrclib/ytm 的检索回报带词型信息、netease/qq
// 由服务端出池 lyric 探针回填——集内 synced 是三态语义：探中条 true/
// false 真值（滚动/纯文本），探针故障漏网条 null 如实「未知」（故障≠
// 纯文本断言，不谎报词型）；集外源（kugou 及一切未登记新源）的 synced
// 只是占位值=「未知」——标纯文本/滚动都是谎报，新源默认诚实不谎报
const SYNC_KNOWN_SOURCES = new Set(['lrclib', 'ytm', 'netease', 'qq'])

export default {
  name: 'LyricPicker',
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
      loading: true,
      loadFailed: '',
      hasManual: false,
      busy: false,
      pickError: ''
    }
  },
  computed: {
    songName() {
      return this.song0?.name || this.song0?.title || ''
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
    this.load()
  },
  beforeUnmount() {
    this._aborter?.abort()
    window.removeEventListener('keydown', this._onWinKeyCapture, true)
    this._prevFocus?.focus?.({ preventScroll: true })
  },
  methods: {
    formatTime,
    // 词源徽标：lrclib/kugou/netease/qq/ytm → LRC/KGM/163/QQ/YTM，未知源取前 3 位大写兜底
    sourceBadge(source) {
      return SOURCE_BADGE[source] || String(source || '').slice(0, 3).toUpperCase() || 'EXT'
    },
    // 滚动性标签分源诚实化：白名单内（lrclib/ytm 检索回报、netease/qq
    // lyric 探针回填）synced 三态——null/缺键=「未知」（探针漏网条如实
    // 呈现）、false=「纯文本」、true=「滚动」；集外源检索回报无词型信息，
    // synced:false 只是占位——标纯文本是谎报；未登记新源同样默认「未知」
    syncTag(c) {
      if (!SYNC_KNOWN_SOURCES.has(c?.source)) return '未知'
      if (c?.synced == null) return '未知'
      return c.synced === false ? '纯文本' : '滚动'
    },
    // 开屏并行：候选扇出 + 现有手动绑定读口（决定页脚「恢复自动匹配」显隐）。
    // 检索喂料与 usePlayer 词载链同一份口径（字段抽取见下方 feed 注）——
    // 口径漂移会让用户看到两套词源集
    async load() {
      const song = this.song0
      if (!song?.id) { this.loading = false; return }
      this.loading = true
      this.loadFailed = ''
      this.pickError = ''
      this._aborter?.abort()
      this._aborter = new AbortController()
      const signal = this._aborter.signal
      const ext = song.youtube || song.bilibili || null
      const durationMs = song.dt || song.duration
      const feed = {
        id: song.id,
        // 标题序随 song.custom 分家（与 usePlayer manualFetchLyrics 同口径）：
        // custom=true 才是「SongFormDialog 手改过名」的真信号——手改曲
        // song.name 优先；非 custom 一律 provider 原标题（ext.title）优先，
        // 缺省回退曲面 name（错绑烘进 name 的 matched 残留名是污染不是用户
        // 意图）；artist 取 provider author，缺省回退曲面 ar（artistsJoined）。
        // 时长只认 ms 槽位做 /1000——三槽同形才保证候选池与词载链同批词源集
        title: song.custom ? (song.name || ext?.title || '') : (ext?.title || song.name || ''),
        artist: ext?.author
          || (song.ar || song.artists || []).map(a => a?.name).filter(Boolean).join('/')
          || '',
        durationSec: Number.isFinite(durationMs) ? Math.round(durationMs / 1000) : undefined
      }
      // 候选扇出 + 现有绑定读口并行开跑。两条腿都套 Promise.resolve() 再起——
      // 桩缺席（测试/契约漂移）的同步 TypeError 落进 promise 链才被 catch
      // 兜住；读口失败归 false（页脚「恢复自动匹配」藏起），候选失败归
      // loadFailed 错误态——「没绑过」与「检索挂了」是两种结局不能混
      const manualP = Promise.resolve()
        .then(() => musicApi.getManualLyric(song.id, signal))
        .then(hit => Boolean(hit)).catch(() => false)
      const candP = Promise.resolve()
        .then(() => musicApi.getLyricCandidates(feed, signal))
        .then(list => ({ list })).catch(err => ({ err }))
      const [hasManual, candResult] = await Promise.all([manualP, candP])
      if (signal.aborted) return
      this.hasManual = hasManual
      if (candResult.err) {
        const e = candResult.err
        // 中止错误（关窗/重载拆掉在飞请求）不入错误态——窗可能已在收
        if (e?.name !== 'CanceledError' && e?.name !== 'AbortError' && e?.code !== 'ERR_CANCELED') {
          this.candidates = []
          this.loadFailed = apiErrorMessage(e)
        }
      } else {
        this.candidates = candResult.list || []
      }
      this.loading = false
    },
    // 选定候选 → POST /lyric/manual 落绑定 → 上行 applied（父链重载词载链）。
    // 词源失效（HTTP 404 或业务码 404）只打内联「该词源已失效」留窗重挑；
    // 其余错误出 toast 不关窗——候选还在，用户可换一条
    async pick(c) {
      if (this.busy || !this.song0?.id || !c?.extId) return
      this.busy = true
      this.pickError = ''
      try {
        await musicApi.pickManualLyric({ id: this.song0.id, extId: c.extId, token: c.token })
        toast(`已绑定 ${this.sourceBadge(c.source)} 词源`, 'success')
        this.$emit('applied', this.song0.id)
        this.$emit('close')
      } catch (e) {
        const status = e?.response?.status ?? e?.bizCode
        if (status === 404) {
          this.pickError = '该词源已失效'
        } else {
          toast(apiErrorMessage(e), 'error')
        }
      } finally {
        this.busy = false
      }
    },
    // 解绑 → 恢复自动级联。与 pick 共用 busy 闸，防双击并发
    async clearManual() {
      if (this.busy || !this.song0?.id) return
      this.busy = true
      this.pickError = ''
      try {
        await musicApi.clearManualLyric(this.song0.id)
        toast('已恢复自动匹配', 'success')
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
      cycleMenuItems(e, '.lp-row:not([disabled])')
    }
  }
}
</script>

<style scoped>
/* 弹体：沿用 atp-dialog 纸面基底，拓宽到候选行可读的 440px */
.lp-dialog {
  width: min(440px, calc(100vw - 24px));
  max-height: min(420px, calc(100vh - 48px));
}
.lp-list {
  overflow-y: auto;
  min-height: 0;
  flex: 1;
}
/* 状态文本：对齐 atp-empty/watch-empty 的像素风小字空态 */
.lp-state {
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
.lp-retry {
  display: flex;
  justify-content: center;
  padding: 0 0 14px;
}
.lp-item { display: flex; }
/* 候选行：基底吃全局 pg-menu-item（全宽/hover 变色/发线分隔/禁用态），
   这里只收密实档 padding 与三段式内件 [词源徽标 | 标题+预览 | 时长/滚动性]。
   last-child 挂 .lp-item——行外包着 role=listitem 壳，原生 :last-child
   锚不到按钮本体 */
.lp-row { padding: 8px 12px; }
.lp-item:last-child .lp-row { border-bottom: none; }
.lp-badge {
  flex: none;
  font-family: var(--font-mono);
  /* 词源徽标是功能读数（词源可辨识性）——收 11px 功能字地板线，不再用
     9px 邮票档；mono 等宽下芯片仍紧凑 */
  font-size: 11px;
  line-height: 1;
  padding: 3px 4px;
  border: var(--hairline-soft);
  color: var(--ink-64);
}
.lp-badge--lrclib { color: var(--ink); }
.lp-badge--kugou { color: var(--accent-magenta-ink, var(--ink)); }
/* netease 品牌红——借 danger 通道的纸面小字深档（无 --accent-red-ink token，
   accent 本色在纸面 <4.5:1，徽标是 11px 小字须用 -ink 档） */
.lp-badge--netease { color: var(--accent-danger-ink, var(--ink)); }
/* qq 品牌绿——与 magenta/danger 同族深档，保持纸面小字对比度 */
.lp-badge--qq { color: var(--accent-green-ink, var(--ink)); }
.lp-badge--ytm { color: var(--ink-86); }
.lp-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lp-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-preview {
  font-size: 11px;
  color: var(--ink-64);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-meta {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}
.lp-tag {
  padding: 2px 4px;
  border: var(--hairline-soft);
}
.lp-pickerr {
  margin: 0;
  padding: 6px 12px;
  border-top: var(--hairline-soft);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent-magenta-ink, var(--ink));
}
.lp-foot {
  border-top: var(--hairline-soft);
  flex: none;
}
.lp-clear {
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
.lp-clear:hover:not(:disabled) { color: var(--ink); }
.lp-clear:focus-visible {
  outline: 1px solid var(--ink);
  outline-offset: -1px;
}
.lp-clear:disabled { opacity: .45; cursor: default; }
</style>
