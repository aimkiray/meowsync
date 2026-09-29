<template>
  <!-- 全局反馈宿主：toast 栈（右下）+ 确认模态（居中）。print-grid，替代原生 alert/confirm -->
  <Teleport to="body">
    <div class="fb-toasts" role="status" aria-live="polite">
      <TransitionGroup name="fb-toast">
        <div
          v-for="t in state.toasts"
          :key="t.id"
          class="fb-toast"
          :class="`fb-toast--${t.type}`"
        ><span class="fb-toast-tag">{{ t.type }}:</span> {{ t.text }}</div>
      </TransitionGroup>
    </div>

    <div
      v-if="state.confirm"
      class="fb-overlay"
      @click.self="answer(false)"
      @mousedown.prevent
      @keydown.esc="answer(false)"
      @keydown.tab.prevent="cycleFocus"
    >
      <div
        class="fb-dialog pg-panel pg-corners"
        :class="{ 'fb-dialog--danger': state.confirm.danger }"
        role="alertdialog"
        aria-modal="true"
        :aria-label="state.confirm.message"
      >
        <p class="fb-message">{{ state.confirm.message }}</p>
        <div class="fb-actions">
          <button
            ref="cancelBtn"
            class="fb-btn ink-btn ink-btn--ghost ink-btn--sm"
            @click="answer(false)"
          >取消</button>
          <button
            class="fb-btn ink-btn ink-btn--sm"
            :class="{ 'fb-btn--danger': state.confirm.danger }"
            @click="answer(true)"
          >{{ state.confirm.confirmText }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script>
import { watch, nextTick, ref } from 'vue'
import { useFeedbackState, resolveConfirm } from '../lib/feedback'

export default {
  name: 'FeedbackHost',
  setup() {
    const state = useFeedbackState()
    const cancelBtn = ref(null)

    const answer = (ok) => resolveConfirm(ok)

    // 模态内焦点循环——两个按钮间往复，不让 Tab 逃出去点背景页
    const cycleFocus = (e) => {
      const btns = [...e.currentTarget.querySelectorAll('.fb-btn')]
      const i = btns.indexOf(document.activeElement)
      btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length]?.focus()
    }

    // 打开确认框时焦点落在「取消」——破坏性操作默认安全项；关闭时归还焦点
    let lastFocused = null
    watch(() => state.confirm, async (c) => {
      if (c) {
        lastFocused = document.activeElement
        await nextTick()
        cancelBtn.value?.focus()
      } else if (lastFocused?.isConnected) {
        lastFocused.focus()
        lastFocused = null
      }
    })

    return { state, cancelBtn, answer, cycleFocus }
  }
}
</script>

<style scoped>
.fb-toasts {
  position: fixed;
  right: 16px;
  bottom: calc(96px + env(safe-area-inset-bottom, 0px));
  z-index: calc(var(--z-menu, 9999) + 10);
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(340px, calc(100vw - 32px));
  pointer-events: none;
}

/* 纸面发丝盒 toast：左缘发丝色条（success 绿戳 / error 危险红 / info 墨色） */
.fb-toast {
  padding: 9px 12px;
  font-family: var(--font-mono);
  font-weight: 300;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink);
  background: var(--paper);
  border: var(--hairline);
  pointer-events: auto;
}

/* 类型区分用色块而非彩字——绿色文字在纸面 <3:1 不达标 */
.fb-toast-tag::before {
  content: '■';
  margin-right: 6px;
  font-size: 9px;
  vertical-align: 1px;
  color: var(--ink);
}
.fb-toast--success .fb-toast-tag::before { color: var(--accent-green); }
.fb-toast--error .fb-toast-tag::before { color: var(--accent-danger); }

.fb-toast-tag {
  letter-spacing: .05em;
  color: var(--ink);
}

.fb-toast-enter-active,
.fb-toast-leave-active {
  transition: opacity 0.18s, transform 0.18s;
}
@media (prefers-reduced-motion: reduce) {
  .fb-toast-enter-active,
  .fb-toast-leave-active { transition: none; }
}

.fb-toast-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.fb-toast-leave-to {
  opacity: 0;
}

.fb-overlay {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-menu, 9999) + 20);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
}

/* 纸面盒 + 角部裁切标记（pg-panel/pg-corners 提供盒与 tick） */
.fb-dialog {
  width: min(340px, calc(100vw - 48px));
  padding: 20px;
}

.fb-message {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-86);
  word-break: break-word;
}

.fb-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

/* .fb-btn 类名保留——cycleFocus 靠它抓模态内按钮 */
.fb-btn--danger {
  background: transparent;
  border: 1.2px solid var(--accent-danger);
  color: var(--accent-danger-ink);
}

.fb-btn--danger:hover:not(:disabled) {
  background: var(--accent-danger);
  color: var(--paper);
}
</style>
