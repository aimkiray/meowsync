<template>
  <Teleport to="body">
    <div v-if="open" class="atp-overlay" @click="onCancel">
      <div
        class="atp-dialog sfd-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="isEdit ? '编辑歌曲' : '新建歌曲'"
        @click.stop
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
                  :disabled="busy"
                  @click="fileRefs[slot.kind]?.click()"
                >{{ picked[slot.kind] ? '重选' : (hasExisting(slot.kind) ? '更换' : '选择文件') }}</button>
                <span class="sfd-file-name" :title="picked[slot.kind]?.name || ''">{{ picked[slot.kind]?.name || existingHint(slot.kind) }}</span>
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

    watch(() => props.open, async (v) => {
      if (!v) {
        // 关窗即释放 File 句柄——500MB 的 Blob 引用不能驻留到下次开窗
        for (const k of Object.keys(picked)) picked[k] = null
        for (const k of Object.keys(progress)) delete progress[k]
        return
      }
      reset()
      await nextTick()
      nameInput.value?.focus({ preventScroll: true })
    })

    const onPick = (kind, e) => {
      const f = e.target.files?.[0] || null
      e.target.value = '' // 同文件重选也要触发 change
      const slot = FILE_SLOTS.find(s => s.kind === kind)
      // 预检：扩展名+体积——必败的选择别等提交后服务端 400/413 才告诉用户
      if (f) {
        const ext = (f.name.match(/\.([0-9A-Za-z]{1,8})$/)?.[1] || '').toLowerCase()
        if (!slot.accept.split(',').includes(`.${ext}`)) {
          picked[kind] = null
          error.value = `${slot.label}不支持 .${ext}（允许：${slot.accept}）`
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

    // 时长输入宽松解析：mm:ss / 纯秒 / m:ss.ms 都收，空=0（自动）
    const parseDuration = (s) => {
      const t = String(s || '').trim()
      if (!t) return 0
      const m = /^(\d{1,5})(?::([0-5]?\d)(?:\.(\d{1,2}))?)?$/.exec(t)
      if (!m) return NaN
      return (+m[1]) * (m[2] != null ? 60000 : 1000) + (m[2] ? +m[2] * 1000 : 0) + (m[3] ? +m[3].padEnd(2, '0') * 10 : 0)
    }

    const submit = () => {
      if (props.busy) return
      const name = form.name.trim()
      if (!name) { error.value = '歌名不能为空'; return }
      const durationMs = parseDuration(form.duration)
      if (Number.isNaN(durationMs)) { error.value = '时长格式不对（用 mm:ss 或秒）'; return }
      if (!isEdit.value && !picked.audio && !picked.video) {
        error.value = '新建歌曲至少需要一个音频或视频文件'
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
      })
    }

    const onCancel = () => { if (!props.busy) emit('close') }
    // busy 期左键=中止上传（emit abort 给父侧 xhr.abort），非 busy=取消
    const onLeftBtn = () => { props.busy ? emit('abort') : onCancel() }

    return {
      isEdit, canEditFiles, form, picked, progress, error,
      nameInput, fileRefs, fileSlots, hasExisting, existingHint,
      onPick, submit, onCancel, onLeftBtn,
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
