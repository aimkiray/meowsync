<template>
  <Teleport to="body">
    <!-- 遮罩 click 要带 mousedown 同源自证：input 里按下拖到遮罩松手，
         click 会派发到公共祖先 overlay——重表单（四字段+四文件位）误关代价太高 -->
    <div v-if="open" class="atp-overlay" @mousedown="onOverlayDown" @mouseup="onOverlayUp" @click="onOverlayClick">
      <div
        class="atp-dialog sfd-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="isEdit ? '编辑歌曲' : '新建歌曲'"
        @click.stop
        @keydown="onDialogKeydown"
      >
        <div class="pg-menu-head">{{ isEdit ? '编辑歌曲' : '新建歌曲' }}</div>

        <div class="sfd-body">
          <label class="sfd-label pg-field">
            <input
              ref="nameInput"
              v-model="form.name"
              placeholder="歌名 *"
              aria-label="歌名"
              @keydown.enter="!($event.isComposing || $event.keyCode === 229) && submit()"
            />
          </label>
          <label class="sfd-label pg-field">
            <input
              v-model="form.artist"
              placeholder="艺术家"
              aria-label="艺术家"
              @keydown.enter="!($event.isComposing || $event.keyCode === 229) && submit()"
            />
          </label>
          <label class="sfd-label pg-field">
            <input
              v-model="form.album"
              placeholder="专辑"
              aria-label="专辑"
              @keydown.enter="!($event.isComposing || $event.keyCode === 229) && submit()"
            />
          </label>
          <label class="sfd-label pg-field">
            <input
              v-model="form.duration"
              placeholder="时长 mm:ss（留空自动）"
              aria-label="时长"
              @keydown.enter="!($event.isComposing || $event.keyCode === 229) && submit()"
            />
          </label>

          <!-- 文件位：create 全亮；edit 仅 file_ 曲可换源（在线曲无本地资产槽） -->
          <template v-if="canEditFiles">
            <p v-if="!isEdit" class="sfd-hint">音频或视频文件至少一项（视频会取其中的音轨播放）</p>
            <div v-for="slot in fileSlots" :key="slot.kind" class="sfd-file">
              <label class="sfd-file-label" :for="`sfd-${slot.kind}`">{{ slot.label }}</label>
              <div class="sfd-file-row">
                <button
                  type="button"
                  class="ink-btn ink-btn--sm"
                  :aria-label="`${picked[slot.kind] ? '重选' : hasExisting(slot.kind) ? '更换' : '选择文件'} · ${slot.label}`"
                  :disabled="busy"
                  @click="fileRefs[slot.kind]?.click()"
                >{{ picked[slot.kind] ? '重选' : (hasExisting(slot.kind) ? '更换' : '选择文件') }}</button>
                <span class="sfd-file-name" :class="{ 'sfd-file-name--picked': picked[slot.kind] }" :title="picked[slot.kind]?.name || ''">{{ picked[slot.kind]?.name || existingHint(slot.kind) }}</span>
                <button
                  v-if="picked[slot.kind]"
                  type="button"
                  class="pg-icobtn pg-icobtn--sm pg-icobtn--bare"
                  :aria-label="`移除已选的${slot.label}`"
                  :disabled="busy"
                  @click="picked[slot.kind] = null"
                ><PixelIcon name="close" :size="11" /></button>
              </div>
              <input
                :id="`sfd-${slot.kind}`"
                :ref="el => fileRefs[slot.kind] = el"
                type="file"
                class="sfd-hidden"
                :accept="slot.accept"
                :disabled="busy"
                @change="onPick(slot.kind, $event)"
              />
              <div
                v-if="progress[slot.kind] != null"
                class="sfd-progress"
                role="progressbar"
                :aria-label="`${slot.label}上传进度`"
                :aria-valuenow="Math.round(progress[slot.kind] * 100)"
              >
                <div class="sfd-progress-bar" :style="{ width: `${Math.round(progress[slot.kind] * 100)}%` }"></div>
              </div>
            </div>
          </template>
          <p v-else-if="isEdit" class="sfd-hint">在线曲目的源文件不在本机——只能编辑元数据（歌名/艺术家/专辑/时长）。</p>

          <p v-if="error" class="sfd-error" role="alert">{{ error }}</p>
        </div>

        <div class="sfd-foot">
          <!-- busy 期左键变「中止上传」：512MB/2GB 大文件必须有逃生通道 -->
          <button class="ink-btn ink-btn--sm ink-btn--ghost" @click="onLeftBtn">
            {{ busy ? '中止上传' : '取消' }}
          </button>
          <button class="ink-btn ink-btn--sm" :disabled="busy || !form.name.trim()" @click="submit">
            {{ busy ? '处理中…' : (isEdit ? '保存' : '创建') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script>
import { ref, reactive, computed, watch, nextTick } from 'vue'
import PixelIcon from './PixelIcon.vue'
import { isFileTrackId } from '../lib/song'
import { parseDurationMs } from '../lib/format'

// 上传文件位表：exts/maxBytes 与服务端 KIND_DEFS 白名单同口径（客户端预选 +
// 预检——能选到必败类型/超体积只在提交后经服务端 400/413 才见太迟）
const MB = 1024 * 1024
const FILE_SLOTS = [
  { kind: 'audio', label: '音频文件', accept: '.mp3,.flac,.m4a,.aac,.ogg,.opus,.wav,.webm', maxBytes: 512 * MB },
  { kind: 'video', label: '视频文件', accept: '.mp4,.webm,.mkv,.mov', maxBytes: 2048 * MB },
  { kind: 'cover', label: '封面图片', accept: '.jpg,.jpeg,.png,.webp', maxBytes: 32 * MB },
  { kind: 'lyrics', label: '歌词文件 (.lrc)', accept: '.lrc,.txt', maxBytes: 4 * MB },
]

export default {
  name: 'SongFormDialog',
  components: { PixelIcon },
  props: {
    open: Boolean,
    // null → create 模式；曲目对象 → edit 模式
    song: { type: Object, default: null },
    busy: Boolean, // 父侧提交中（上传/落库）——锁表单防重复提交
  },
  emits: ['close', 'submit', 'abort'],
  setup(props, { emit }) {
    const isEdit = computed(() => !!props.song)
    // 源文件槽只对上传曲开放：bv_/yt_/qq_/网易云曲的源是远端 provider，无本地槽
    const canEditFiles = computed(() => !props.song || isFileTrackId(props.song.id))

    const form = reactive({ name: '', artist: '', album: '', duration: '' })
    const picked = reactive({ audio: null, video: null, cover: null, lyrics: null })
    const progress = reactive({})
    const error = ref('')
    const nameInput = ref(null)
    const fileRefs = reactive({})
    const fileSlots = FILE_SLOTS

    // create 模式（song=null）没有任何既有资产——「已有/更换」之说必须看真旗标；
    // audio 位读 hasAudio（早期行无此位按有兜底——彼时上传曲定义上必有音源，
    // video-only 曲的服务端播放也走 videoPath 回落）
    const hasExisting = (kind) => {
      const f = props.song?.file
      if (!f) return false
      return kind === 'audio' ? (f.hasAudio ?? true)
        : kind === 'video' ? !!f.hasVideo
        : kind === 'cover' ? !!f.hasCover
        : !!f.hasLyrics
    }
    const existingHint = (kind) => hasExisting(kind) ? '已有（不换即保留）' : '未选择'

    const reset = () => {
      const s = props.song
      form.name = s?.name || ''
      form.artist = (s?.ar || s?.artists || []).map(a => a?.name).filter(Boolean).join(', ')
      form.album = s?.al?.name || s?.album?.name || ''
      const ms = s?.dt || s?.duration || 0
      form.duration = ms ? `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}` : ''
      for (const k of Object.keys(picked)) picked[k] = null
      for (const k of Object.keys(progress)) delete progress[k]
      error.value = ''
    }

    // immediate：App 侧已改 v-if 懒挂载——mount 即 open=true 时 reset+聚焦
    // 依赖首次 immediate 跑。!v 分支在本挂载形态下不可达（open=false 时
    // 父级 v-if 直接卸载整实例、File 句柄随 GC 释放）——防御性保留以兼容
    // 「常挂载+prop 翻转」的旧消费形态
    watch(() => props.open, async (v) => {
      if (!v) {
        for (const k of Object.keys(picked)) picked[k] = null
        for (const k of Object.keys(progress)) delete progress[k]
        return
      }
      reset()
      await nextTick()
      nameInput.value?.focus({ preventScroll: true })
    }, { immediate: true })

    const onPick = (kind, e) => {
      const f = e.target.files?.[0] || null
      e.target.value = '' // 同文件重选也要触发 change
      delete progress[kind] // 任何重选都先清旧进度条——abort 残留/上次失败的都是误导
      const slot = FILE_SLOTS.find(s => s.kind === kind)
      // 预检：扩展名+体积——必败的选择别等提交后服务端 400/413 才告诉用户
      if (f) {
        const ext = (f.name.match(/\.([0-9A-Za-z]{1,8})$/)?.[1] || '').toLowerCase()
        if (!slot.accept.split(',').includes(`.${ext}`)) {
          picked[kind] = null
          error.value = `${slot.label}不支持 ${ext ? `.${ext}` : '无扩展名'}（允许：${slot.accept}）`
          return
        }
        if (f.size > slot.maxBytes) {
          picked[kind] = null
          error.value = `${slot.label}超过上限 ${Math.round(slot.maxBytes / MB)}MB`
          return
        }
      }
      picked[kind] = f
      error.value = ''
    }

    // 中止/失败收尾：busy 落定后清掉半截进度条（完成的留 100%，重选同 kind 才清）
    watch(() => props.busy, (b, prev) => {
      if (prev && !b) {
        for (const k of Object.keys(progress)) if (progress[k] < 1) delete progress[k]
      }
    })

    const submit = () => {
      if (props.busy) return
      const name = form.name.trim()
      if (!name) { error.value = '歌名不能为空'; return }
      const durationMs = parseDurationMs(form.duration)
      if (Number.isNaN(durationMs)) { error.value = '时长格式不对（用 mm:ss 或秒）'; return }
      // create 门槛=「至少一件浏览器可播工件」：audio 白名单全可播；video 里
      // mkv 不解（Matroska 浏览器无解码器），mov 仅 Safari/部分 Chromium——
      // mkv/mov 仍可传（存档/下载价值），但不满足「能播」的建曲底线
      const playableVideo = picked.video && /\.(mp4|webm|mov)$/i.test(picked.video.name)
      if (!isEdit.value && !picked.audio && !playableVideo) {
        error.value = picked.video
          ? 'MKV 容器浏览器无法播放——可作存档，但新建还需一个音频或 mp4/webm/mov 视频'
          : '新建歌曲至少需要一个音频或视频文件'
        return
      }
      emit('submit', {
        song: props.song,
        meta: {
          name,
          artist: form.artist.trim(),
          album: form.album.trim(),
          durationMs,
        },
        files: { ...picked },
        setProgress: (kind, v) => { progress[kind] = v },
        // 提交失败把错误钉回窗内——toast 2.6s 就蒸发，表单却留着等重试
        setError: (m) => { error.value = m },
      })
    }

    // 遮罩 drag-out 误关闸：按下+抬起+click 三点都落在遮罩本体才算主动关闭。
    // click 在按下/抬起不同元素时派发到最近公共祖先（遮罩）——target=self 区分
    // 不了松手点，所以 down/up 各自自证（「按下反悔拖回 dialog」不该关窗）
    let overlayDownSelf = false
    let overlayUpSelf = false
    const onOverlayDown = (e) => { overlayDownSelf = e.target === e.currentTarget }
    const onOverlayUp = (e) => { overlayUpSelf = e.target === e.currentTarget }
    const onOverlayClick = (e) => {
      const isRealOverlayClick = overlayDownSelf && overlayUpSelf && e.target === e.currentTarget
      overlayDownSelf = overlayUpSelf = false
      if (isRealOverlayClick) onCancel()
    }

    const onCancel = () => { if (!props.busy) emit('close') }
    // busy 期左键=中止上传（emit abort 给父侧 xhr.abort），非 busy=取消
    const onLeftBtn = () => { props.busy ? emit('abort') : onCancel() }

    // aria-modal 契约补课：Tab/Shift+Tab 把焦点钳在窗内（可聚焦集首尾互跳），
    // Esc 走 onLeftBtn（与左键/全局热键同口径：闲=取消、busy=中止上传）。
    // getClientRects 滤掉 display:none 的 file input——它们能匹配选择器但不可聚焦，
    // 不滤会让首尾判定落空、Tab 从缝里逃出遮罩
    const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const onDialogKeydown = (e) => {
      if (e.key === 'Escape') {
        // 与 App 全局 Esc 同映射（busy→中止上传、闲→关窗）：走 onLeftBtn 复用
        // 口径而不是裸 onCancel——后者 busy 期静默会让中止通道在窗内失灵；
        // stopPropagation 防事件再到 window 被全局热键二次消费
        e.stopPropagation()
        onLeftBtn()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = [...e.currentTarget.querySelectorAll(FOCUSABLE_SEL)]
        .filter(el => el.getClientRects().length > 0)
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    return {
      isEdit, canEditFiles, form, picked, progress, error,
      nameInput, fileRefs, fileSlots, hasExisting, existingHint,
      onPick, submit, onCancel, onLeftBtn, onOverlayDown, onOverlayUp, onOverlayClick,
      onDialogKeydown,
    }
  },
}
</script>

<style scoped>
/* sfd-*：atp 模态皮的表单变体。弹层是 teleport 出去的 body 子级——
   但 scoped 样式对 teleport 内容照常生效（scoped 按模板归属打 data 属性） */
.sfd-dialog { width: min(340px, 92vw); }
.sfd-body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  min-height: 0;
  overscroll-behavior: contain;
}
.sfd-label { display: flex; }
.sfd-file { display: flex; flex-direction: column; gap: 4px; }
.sfd-file-label {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}
.sfd-file-row { display: flex; align-items: center; gap: 8px; }
.sfd-file-name {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 已选文件名是该行最重信息——hint 态 ink-64 弱化，picked 态回满档 */
.sfd-file-name--picked { color: var(--ink); }
/* display:none 才能出 Tab 序（0 尺寸/opacity 都不出序）；label[for] 与
   程序化 .click() 对 display:none 的 input 照常有效 */
.sfd-hidden { display: none; }
.sfd-progress {
  height: 4px;
  border: var(--hairline);
  background: var(--paper);
}
.sfd-progress-bar { height: 100%; background: var(--ink); transition: width .15s; }
.sfd-hint { font-size: 11px; color: var(--ink-64); margin: 0; }
.sfd-error { font-size: 12px; color: var(--accent-danger-ink); margin: 0; }
.sfd-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 10px;
  border-top: var(--hairline-soft);
}
</style>
