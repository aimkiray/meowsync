<template>
  <div class="auth-gate">
    <form class="auth-card" @submit.prevent="submit">
      <div class="auth-title">
        <PixelIcon :name="effectiveSetup ? 'warn' : 'note'" :size="20" />
        <span>{{ effectiveSetup ? '初始化管理员' : 'MeowSync' }}</span>
      </div>
      <p class="auth-sub">
        {{ effectiveSetup
          ? '首次启动：创建管理员账号。完成前请勿将本实例暴露到公网。'
          : (expired ? '会话已过期，请重新登录' : '登录以继续使用') }}
      </p>
      <input
        ref="usernameInput"
        v-model.trim="username"
        class="auth-input"
        type="text"
        autocomplete="username"
        placeholder="用户名（字母/数字/._-/@）"
        aria-label="用户名"
        :aria-invalid="!!error"
        pattern="[\w.@-]{1,64}"
        maxlength="64"
        required
      />
      <input
        v-model="password"
        class="auth-input"
        type="password"
        :autocomplete="effectiveSetup ? 'new-password' : 'current-password'"
        placeholder="密码（至少 8 位）"
        aria-label="密码"
        :aria-invalid="!!error"
        minlength="8"
        maxlength="128"
        required
      />
      <!-- role=alert 自带 assertive live region——提交失败即时播报不等浏览到 -->
      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
      <button class="auth-btn" type="submit" :disabled="busy">
        {{ busy ? '处理中…' : (effectiveSetup ? '创建并进入' : '登录') }}
      </button>
      <button
        v-if="effectiveSetup"
        class="auth-skip"
        type="button"
        @click="$emit('skip')"
      >暂不设置（局域网自用）</button>
    </form>
  </div>
</template>

<script>
import { authApi } from '../api/auth'
import { apiErrorMessage } from '../api/http'
import PixelIcon from './PixelIcon.vue'

export default {
  name: 'AuthGate',
  components: { PixelIcon },
  props: {
    isSetup: { type: Boolean, default: false },
    expired: { type: Boolean, default: false }
  },
  emits: ['authed', 'skip'],
  data() {
    return { username: '', password: '', busy: false, error: '', forceLogin: false }
  },
  computed: {
    // setup 期间收到 409（另一客户端抢先建号）→ 本地翻成登录模式
    effectiveSetup() { return this.isSetup && !this.forceLogin }
  },
  mounted() {
    // autofocus 对动态插入的组件不保证生效——显式聚焦
    this.$refs.usernameInput?.focus()
  },
  methods: {
    async submit() {
      if (this.busy) return
      this.busy = true
      this.error = ''
      try {
        const body = this.effectiveSetup
          ? await authApi.setup(this.username, this.password)
          : await authApi.login(this.username, this.password)
        if (body?.code === 200) {
          // 登录态确立后整页重载：以 cookie 重新走一遍初始化管线，
          // 免去把 App.vue 的启动序列重构成可重入
          this.$emit('authed')
          return
        }
        this.error = body?.message || '操作失败'
      } catch (e) {
        const status = e?.response?.status
        if (status === 409 && this.effectiveSetup) {
          // 已被抢先建号——翻登录模式让表单立即可用
          this.forceLogin = true
        }
        this.error = apiErrorMessage(e)
      } finally {
        this.busy = false
      }
    }
  }
}
</script>

<style scoped>
/* 门页也吃全局令牌——主题换肤时门页不该是另一种纸面（色值/层级全部走
   style.css 令牌表：--page/--paper/--ink/--accent-*-ink/--z-menu） */
.auth-gate {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--page);
  z-index: var(--z-menu);
  padding: 16px;
  /* 键盘弹出/横屏矮视口时卡片可高过视口——容器可滚，提交键不被裁 */
  overflow-y: auto;
  overscroll-behavior: contain;
}
.auth-card {
  width: 100%;
  max-width: 360px;
  background: var(--paper);
  border: 2px solid var(--ink);
  border-radius: 10px;
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: 'Courier New', ui-monospace, monospace;
  /* 超高时 margin:auto 居中语义+可滚：顶缘不被 flex 居中裁掉 */
  margin: auto;
  max-height: calc(100vh - 32px);
  max-height: calc(100dvh - 32px);
}
.auth-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.auth-sub {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-64);
  margin: 0 0 4px;
}
.auth-input {
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  padding: 10px 12px;
  /* ≥16px：iOS 聚焦不触发整页 zoom（autofocus 挂载即聚焦，低于 16 必中招） */
  font-size: 16px;
  font-family: inherit;
  background: var(--ink-06);
  outline: none;
}
/* 聚焦描边走纸面深档 accent 令牌——原 teal 硬编码无对应令牌；
   accent-magenta-ink 是全站纸面文字 accent 的统一深档 */
.auth-input:focus { border-color: var(--accent-magenta-ink); background: var(--paper); }
.auth-error {
  font-size: 12px;
  color: var(--accent-danger-ink);
  margin: 0;
}
.auth-btn {
  margin-top: 4px;
  border: 2px solid var(--ink);
  border-radius: 6px;
  padding: 10px;
  font-size: 14px;
  font-weight: 700;
  font-family: inherit;
  background: var(--ink);
  color: var(--paper);
  cursor: pointer;
}
.auth-btn:disabled { opacity: 0.5; cursor: default; }
.auth-btn:not(:disabled):hover { background: var(--accent-magenta-ink); border-color: var(--accent-magenta-ink); }
.auth-skip {
  border: none;
  background: none;
  font-family: inherit;
  font-size: 12px;
  color: var(--ink-64);
  text-decoration: underline;
  cursor: pointer;
  padding: 2px;
}
.auth-skip:hover { color: var(--ink); }
</style>
