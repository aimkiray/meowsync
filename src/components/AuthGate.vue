<template>
  <div class="auth-gate">
    <form class="auth-card" @submit.prevent="submit">
      <div class="auth-title">
        <PixelIcon :name="isSetup ? 'warn' : 'note'" :size="20" />
        <span>{{ isSetup ? '初始化管理员' : 'MeowSync' }}</span>
      </div>
      <p class="auth-sub">
        {{ isSetup
          ? '首次启动：创建管理员账号。完成前请勿将本实例暴露到公网。'
          : (expired ? '会话已过期，请重新登录' : '登录以继续使用') }}
      </p>
      <input
        v-model.trim="username"
        class="auth-input"
        type="text"
        autocomplete="username"
        placeholder="用户名"
        maxlength="64"
        required
        autofocus
      />
      <input
        v-model="password"
        class="auth-input"
        type="password"
        :autocomplete="isSetup ? 'new-password' : 'current-password'"
        placeholder="密码（至少 8 位）"
        minlength="8"
        maxlength="128"
        required
      />
      <p v-if="error" class="auth-error">{{ error }}</p>
      <button class="auth-btn" type="submit" :disabled="busy">
        {{ busy ? '处理中…' : (isSetup ? '创建并进入' : '登录') }}
      </button>
    </form>
  </div>
</template>

<script>
import { authApi } from '../api/auth'
import PixelIcon from './PixelIcon.vue'

export default {
  name: 'AuthGate',
  components: { PixelIcon },
  props: {
    isSetup: { type: Boolean, default: false },
    expired: { type: Boolean, default: false }
  },
  emits: ['authed'],
  data() {
    return { username: '', password: '', busy: false, error: '' }
  },
  methods: {
    async submit() {
      if (this.busy) return
      this.busy = true
      this.error = ''
      try {
        const body = this.isSetup
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
        this.error = e?.response?.data?.message || '网络错误，请稍后再试'
      } finally {
        this.busy = false
      }
    }
  }
}
</script>

<style scoped>
.auth-gate {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f4f1ea;
  z-index: 1000;
  padding: 16px;
}
.auth-card {
  width: 100%;
  max-width: 360px;
  background: #fff;
  border: 2px solid #1a1a1a;
  border-radius: 10px;
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: 'Courier New', ui-monospace, monospace;
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
  color: #555;
  margin: 0 0 4px;
}
.auth-input {
  border: 1.5px solid #1a1a1a;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 14px;
  font-family: inherit;
  background: #fafaf8;
  outline: none;
}
.auth-input:focus { border-color: #0e8f8f; background: #fff; }
.auth-error {
  font-size: 12px;
  color: #c0392b;
  margin: 0;
}
.auth-btn {
  margin-top: 4px;
  border: 2px solid #1a1a1a;
  border-radius: 6px;
  padding: 10px;
  font-size: 14px;
  font-weight: 700;
  font-family: inherit;
  background: #1a1a1a;
  color: #fff;
  cursor: pointer;
}
.auth-btn:disabled { opacity: 0.5; cursor: default; }
.auth-btn:not(:disabled):hover { background: #0e8f8f; border-color: #0e8f8f; }
</style>
