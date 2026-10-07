<template>
  <!-- 单条下载任务卡：封面 + 名称/状态戳 + 资源章 + 进度/错误/完成尾注 -->
  <div class="dtr">
    <div class="dtr-cover">
      <!-- alt 留空：封面与紧邻的 .dtr-name 同源文本——命名会让 SR 把歌名报两遍 -->
      <img
        v-if="task.coverUrl"
        :src="coverSrc"
        alt=""
        class="dtr-cover-img"
        loading="lazy"
        decoding="async"
      />
      <div v-else class="dtr-cover-fb"><PixelIcon name="note" :size="14" /></div>
    </div>
    <div class="dtr-body">
      <div class="dtr-top">
        <div class="dtr-headcell">
          <div class="dtr-namerow">
            <h4 class="dtr-name">{{ task.songName }}</h4>
            <span class="pg-chip pg-chip--static dtr-chip" :class="chipTierClass">{{ statusLabel }}</span>
          </div>
          <p class="dtr-artist">{{ task.artist }}</p>
        </div>
        <div class="dtr-id">#{{ task.id }}</div>
      </div>
      <div class="dtr-flags">
        <span v-if="task.downloadAudio" class="dtr-flag">音频</span>
        <span v-if="task.downloadVideo" class="dtr-flag" :title="videoFlagTitle">视频{{ task.videoMeta?.h ? ' ' + task.videoMeta.h + 'p' : '' }}</span>
        <span v-if="task.downloadLyrics" class="dtr-flag">歌词</span>
        <span v-if="task.downloadCover" class="dtr-flag">封面</span>
      </div>
      <div v-if="task.status === 'downloading'" class="dtr-progress-wrap">
        <div
          class="dtr-progress"
          role="progressbar"
          :aria-valuenow="clampedProgress"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-label="下载进度"
        >
          <div class="dtr-progress-fill" :style="`--p: ${clampedProgress}`"></div>
        </div>
        <div class="dtr-progress-num">{{ clampedProgress }}%</div>
      </div>
      <div v-else-if="task.status === 'failed'" class="dtr-err">
        <p class="dtr-err-line"><span class="dtr-err-tag">error:</span> {{ task.errorMessage || '下载失败喵' }}</p>
        <p v-if="task.retryCount > 0" class="dtr-retry-note">已重试 {{ task.retryCount }} 次</p>
        <button
          class="ink-btn ink-btn--ghost ink-btn--sm dtr-retry-btn"
          :disabled="isRetrying"
          @click="$emit('retry-task', task.id)"
        >{{ isRetrying ? '重试中...' : '重试任务' }}</button>
      </div>
      <div v-else-if="task.status === 'completed'" class="dtr-done">
        <PixelIcon name="check" :size="11" />下载完成喵
      </div>
      <!-- standalone 行的删除入口：downloading/pending 都藏——pending 的
           standalone 多在退避协程里（standaloneRunning），服务端一样 409 -->
      <div v-if="deletable && task.status !== 'downloading' && task.status !== 'pending'" class="dtr-actions">
        <button
          class="ink-btn ink-btn--ghost ink-btn--sm dtr-del-btn"
          :disabled="deleting"
          @click="$emit('delete-task', task.id)"
        >{{ deleting ? '删除中...' : '删除' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { httpsCover } from '../lib/url'
import { coverSizeUrl } from '../lib/song'
import { taskStatusMeta, statusChipClass } from '../lib/downloadStatus.js'
import PixelIcon from './PixelIcon.vue'

const props = defineProps({
  task: {
    type: Object,
    required: true
  },
  retryingTaskIds: {
    type: Array,
    default: () => []
  },
  // standalone 分节才开删除入口（队列任务生命周期归队列管，行级删除会
  // 绕开调度器状态机）；deleting 由父级 deletingTaskIds 派生
  deletable: {
    type: Boolean,
    default: false
  },
  deleting: {
    type: Boolean,
    default: false
  }
})

defineEmits(['retry-task', 'delete-task'])

// coverPath 是服务器相对路径（无对应文件路由），当 img src 只会 404——不兜底。
// coverUrl 是上游 http 明文 CDN 地址：HTTPS 部署下被动混合内容
// 会被浏览器拦截，显式升级 https（*.music.126.net 均支持 TLS）
const coverSrc = computed(() => httpsCover(coverSizeUrl(props.task.coverUrl, 96)))
const statusLabel = computed(() => taskStatusMeta(props.task.status).label)
const chipTierClass = computed(() => statusChipClass(taskStatusMeta(props.task.status).tier))
const isRetrying = computed(() => props.retryingTaskIds.includes(props.task.id))
// undefined/>100 会产生非法/溢出样式
const clampedProgress = computed(() => Math.max(0, Math.min(100, props.task.progress || 0)))
// 实际到手档位透出：1080p avc1 / 合流降级等——比裸"视频"章多一层对账面
const videoFlagTitle = computed(() => {
  const meta = props.task.videoMeta
  if (!meta?.h) return null
  return `实际画质 ${meta.h}p${meta.codec ? ' ' + meta.codec : ''}${meta.source === 'progressive' ? '（合流）' : ''}`
})
</script>

<style scoped>
.dtr {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.dtr-cover {
  width: 40px;
  height: 40px;
  border: var(--hairline);
  flex-shrink: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--paper);
}

.dtr-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  image-rendering: pixelated;
  display: block;
}

.dtr-cover-fb {
  display: flex;
  align-items: center;
  justify-content: center;
}

.dtr-body { flex: 1; min-width: 0; }

.dtr-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.dtr-headcell { flex: 1; min-width: 0; }

.dtr-namerow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dtr-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.dtr-artist {
  margin-top: 2px;
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dtr-id {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  flex-shrink: 0;
  text-align: right;
}
/* ≤640 id 列让位——mono id 与歌名行争宽，队列侧 dql-meta 仍带 #id 可查 */
@media (max-width: 640.98px) {
  .dtr-id { display: none; }
}

.dtr-flags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 4px;
}

.dtr-flag {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}

/* 芯片紧凑化（任务卡密度高于标签云）；色档走全局 pg-chip--ok/fail/dim */
.dtr-chip {
  height: 20px;
  padding: 0 8px;
  font-size: 10px;
  flex-shrink: 0;
}

.dtr-progress-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.dtr-progress {
  flex: 1;
  height: 4px;
  background: var(--ink-10);
  overflow: hidden;
}

.dtr-progress-fill {
  height: 100%;
  width: 100%;
  transform: scaleX(calc(var(--p, 0) / 100));
  transform-origin: left;
  background: var(--ink);
  transition: transform .3s var(--ease-ink);
}

.dtr-progress-num {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
  width: 36px;
  text-align: right;
  flex-shrink: 0;
}

.dtr-err { margin-top: 5px; }

.dtr-err-line {
  font-size: 11px;
  color: var(--ink);
  word-break: break-word;
}

.dtr-err-tag {
  font-family: var(--font-mono);
  font-weight: 300;
  letter-spacing: .05em;
  color: var(--accent-danger-ink);
}

.dtr-retry-note {
  margin-top: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-64);
}

.dtr-retry-btn { margin-top: 6px; }

.dtr-done {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  font-size: 11px;
  color: var(--ink-86);
}

.dtr-done svg { color: var(--accent-green); }

/* standalone 删除动作行：与重试键同族 ghost 小钮 */
.dtr-actions { margin-top: 8px; }

.dtr-del-btn {
  color: var(--accent-danger-ink);
  border-color: var(--accent-danger-ink);
}

.dtr-del-btn:hover:not(:disabled) {
  background: var(--accent-danger-ink);
  color: var(--paper);
}
</style>
