<template>
  <!-- 全局反馈宿主：toast 栈（右下）+ 确认模态（居中）。像素风，替代原生 alert/confirm -->
  <Teleport to="body">
    <div class="fb-toasts" role="status" aria-live="polite">
      <TransitionGroup name="fb-toast">
        <div
          v-for="t in state.toasts"
          :key="t.id"
          class="fb-toast"
          :class="`fb-toast--${t.type}`"
        >{{ t.text }}</div>
      </TransitionGroup>
    </div>

    <div
      v-if="state.confirm"
      class="fb-overlay"
      @click.self="answer(false)"
      @keydown.esc="answer(false)"
      @keydown.tab.prevent="cycleFocus"
    >
      <div
        class="fb-dialog"
        role="alertdialog"
        aria-modal="true"
        :aria-label="state.confirm.message"
      >
        <p class="fb-message">{{ state.confirm.message }}</p>
        <div class="fb-actions">
          <button
            ref="cancelBtn"
            class="fb-btn"
            @click="answer(false)"
          >取消</button>
          <button
            class="fb-btn"
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

    // 打开确认框时焦点落在「取消」——破坏性操作默认安全项
    watch(() => state.confirm, async (c) => {
      if (c) {
        await nextTick()
        cancelBtn.value?.focus()
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

.fb-toast {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--pixel-text);
  background: var(--pixel-card-bg);
  border: 2px solid var(--pixel-border);
  box-shadow: 3px 3px 0 var(--pixel-dark);
  pointer-events: auto;
}

.fb-toast--success { border-color: #22c55e; }
.fb-toast--error { border-color: #ef4444; }

.fb-toast-enter-active,
.fb-toast-leave-active {
  transition: opacity 0.18s, transform 0.18s;
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
  background: rgba(0, 0, 0, 0.45);
}

.fb-dialog {
  width: min(360px, calc(100vw - 40px));
  padding: 18px;
  background: var(--pixel-card-bg);
  border: 3px solid var(--pixel-border);
  box-shadow: 5px 5px 0 var(--pixel-dark);
}

.fb-message {
  font-size: 13px;
  line-height: 1.6;
  color: var(--pixel-text);
  word-break: break-word;
}

.fb-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}

.fb-btn {
  font-size: 12px;
  padding: 5px 16px;
  color: var(--pixel-text);
  background: var(--pixel-accent);
  border: 2px solid var(--pixel-border);
  cursor: pointer;
}

.fb-btn:hover {
  filter: brightness(1.08);
}

.fb-btn:active {
  transform: translate(1px, 1px);
}

.fb-btn--danger {
  border-color: #ef4444;
  color: #ef4444;
}

:root[data-theme="pixel-retro"] .fb-btn--danger {
  color: #b91c1c;
}
</style>
