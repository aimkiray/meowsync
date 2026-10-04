<template>
  <div class="settings-panel">
    <div class="settings-col">
      <header class="settings-head">
        <h2 class="settings-title">设置</h2>
        <p class="settings-sub">留空的项读取服务端环境变量配置；密钥类值只显示是否已配置，不回显内容</p>
      </header>

      <div v-if="loadError" class="settings-error" role="alert">{{ loadError }}
        <button class="ink-btn ink-btn--sm" @click="load">重试</button>
      </div>
      <p v-else-if="loading" class="settings-loading">载入服务端配置…</p>

      <template v-else>
        <!-- ═══ AI 配置 ═══ -->
        <section class="settings-card" aria-labelledby="st-ai">
          <div class="settings-card-head">
            <h3 id="st-ai" class="settings-card-title">AI 配置</h3>
            <span class="pg-chip pg-chip--static" :class="ai.enabled ? 'pg-chip--ok' : 'pg-chip--dim'">
              {{ ai.enabled ? `已启用 · ${ai.model || ''}` : '未启用' }}
            </span>
          </div>
          <p class="settings-hint">OpenAI 兼容接口（chat/completions），用于歌词翻译与归属核验。三项全填才启用。</p>

          <label class="settings-row">
            <span class="settings-label">Base URL
              <em class="settings-src" :class="`settings-src--${fields.ai_base_url?.source || 'none'}`">{{ srcText(fields.ai_base_url) }}</em>
            </span>
            <span class="pg-field"><input v-model="aiBase" :placeholder="fields.ai_base_url?.value || 'http://127.0.0.1:8317/v1'" autocomplete="off" spellcheck="false" /></span>
          </label>
          <label class="settings-row">
            <span class="settings-label">API Key
              <em class="settings-src" :class="`settings-src--${fields.ai_api_key?.source || 'none'}`">{{ srcText(fields.ai_api_key) }}</em>
            </span>
            <span class="pg-field"><input v-model="aiKey" type="password" :placeholder="secretPlaceholder(fields.ai_api_key)" autocomplete="off" spellcheck="false" /></span>
          </label>
          <label class="settings-row">
            <span class="settings-label">模型
              <em class="settings-src" :class="`settings-src--${fields.ai_model?.source || 'none'}`">{{ srcText(fields.ai_model) }}</em>
            </span>
            <span class="pg-field"><input v-model="aiModelName" :placeholder="fields.ai_model?.value || '如 deepseek-v4.1-flash'" autocomplete="off" spellcheck="false" /></span>
          </label>
          <label class="settings-row">
            <span class="settings-label">超时 (ms)
              <em class="settings-src" :class="`settings-src--${fields.ai_timeout_ms?.source || 'none'}`">{{ srcText(fields.ai_timeout_ms) }}</em>
            </span>
            <span class="pg-field"><input v-model="aiTimeout" inputmode="numeric" :placeholder="fields.ai_timeout_ms?.value || '30000'" autocomplete="off" /></span>
          </label>

          <div class="settings-actions">
            <button
              v-if="fields.ai_api_key?.source === 'override'"
              class="ink-btn ink-btn--sm ink-btn--ghost"
              :disabled="saving"
              @click="clearOverride('ai_api_key')"
            >清除已存 Key</button>
            <button class="ink-btn ink-btn--sm ink-btn--ghost" :disabled="testing || saving" @click="testAi">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
            <button class="ink-btn ink-btn--sm" :disabled="saving" @click="saveAi">保存</button>
          </div>
          <p v-if="testResult" class="settings-test" :class="testResult.ok ? 'settings-test--ok' : 'settings-test--fail'" role="status">
            {{ testResultText }}
          </p>
        </section>

        <!-- ═══ 音乐源凭据 ═══ -->
        <section class="settings-card" aria-labelledby="st-cookies">
          <div class="settings-card-head">
            <h3 id="st-cookies" class="settings-card-title">音乐源凭据</h3>
          </div>
          <p class="settings-hint">登录态 Cookie 解锁 VIP/高码率档。只发往对应源站域；QQ 凭据到期前服务端自动续期。</p>

          <div v-for="ck in cookieDefs" :key="ck.key" class="settings-cookie">
            <div class="settings-cookie-head">
              <span class="settings-label">{{ ck.label }}
                <em class="settings-src" :class="`settings-src--${fields[ck.key]?.source || 'none'}`">{{ srcText(fields[ck.key]) }}</em>
              </span>
              <span class="settings-cookie-state">{{ cookieState(ck.key) }}</span>
            </div>
            <textarea
              v-model="cookieDrafts[ck.key]"
              class="settings-textarea"
              rows="3"
              :placeholder="cookiePlaceholder(ck.key)"
              :aria-label="ck.label"
              spellcheck="false"
              autocomplete="off"
            ></textarea>
            <div class="settings-actions">
              <button
                v-if="fields[ck.key]?.source === 'override'"
                class="ink-btn ink-btn--sm ink-btn--ghost"
                :disabled="saving"
                @click="clearOverride(ck.key)"
              >清除自定义值</button>
              <button class="ink-btn ink-btn--sm" :disabled="saving || !cookieDrafts[ck.key].trim()" @click="saveCookie(ck.key)">保存</button>
            </div>
          </div>
        </section>

        <!-- ═══ 界面偏好（本机） ═══ -->
        <section class="settings-card" aria-labelledby="st-local">
          <div class="settings-card-head">
            <h3 id="st-local" class="settings-card-title">界面偏好</h3>
            <span class="pg-chip pg-chip--static pg-chip--dim">本机</span>
          </div>
          <p class="settings-hint">只保存在此设备的浏览器里，与服务端配置无关。</p>

          <div class="settings-row settings-row--flat" role="group" aria-label="主题">
            <span class="settings-label">主题</span>
            <span class="settings-themes">
              <button
                v-for="t in THEMES" :key="t.id"
                class="pg-chip"
                :class="{ 'pg-chip--on': t.id === currentTheme }"
                :aria-pressed="t.id === currentTheme"
                @click="setTheme(t.id)"
              >{{ t.name }}</button>
            </span>
          </div>
          <div class="settings-row settings-row--flat" role="group" aria-label="视频模式">
            <span class="settings-label">视频模式</span>
            <button
              class="pg-chip"
              :class="{ 'pg-chip--on': prefVideoOn }"
              :aria-pressed="prefVideoOn"
              aria-label="视频模式"
              @click="prefVideoOn = !prefVideoOn"
            >{{ prefVideoOn ? '开' : '关' }}</button>
          </div>
          <div class="settings-row settings-row--flat" role="group" aria-label="歌词字号">
            <span class="settings-label">歌词字号</span>
            <span class="settings-stepper">
              <button class="pg-chip" :disabled="prefLyricFontSize <= LYRIC_FS_MIN" @click="prefLyricFontSize--" aria-label="减小字号">A−</button>
              <span class="settings-stepper-val" aria-live="polite" aria-label="当前字号">{{ prefLyricFontSize }}px</span>
              <button class="pg-chip" :disabled="prefLyricFontSize >= LYRIC_FS_MAX" @click="prefLyricFontSize++" aria-label="增大字号">A+</button>
            </span>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<script>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { settingsApi } from '../api/settings.js'
import { aiApi } from '../api/ai.js'
import { apiErrorMessage } from '../api/http.js'
import { toast } from '../lib/feedback.js'
import { refreshServerCaps } from '../lib/caps.js'
import { THEMES, currentTheme, setTheme } from '../lib/theme.js'
import { prefVideoOn, prefLyricFontSize, LYRIC_FS_MIN, LYRIC_FS_MAX } from '../lib/prefs.js'

export default {
  name: 'SettingsPanel',
  setup() {
    const loading = ref(true)
    const loadError = ref('')
    const fields = ref({})
    const ai = ref({ enabled: false, model: null })

    // 非密字段：输入值=覆盖值（空=回落 env）；密字段：输入恒空起手，
    // 填了才算改（服务端掩码回显不可编辑——空送 '' 会误清覆盖）
    const aiBase = ref('')
    const aiKey = ref('')
    const aiModelName = ref('')
    const aiTimeout = ref('')
    const cookieDrafts = reactive({ bili_cookie: '', qq_cookie: '' })

    const cookieDefs = [
      { key: 'bili_cookie', label: 'B 站 Cookie' },
      { key: 'qq_cookie', label: 'QQ 音乐 Cookie' },
    ]

    const saving = ref(false)
    const testing = ref(false)
    const testResult = ref(null)

    // keys=本次写入的键——只复位被写的输入，兄弟区未存草稿不被清
    // （B 站长 cookie 粘一半点存 QQ，draft 不应陪葬）；load 全量复位
    const applyFields = (f, keys = null) => {
      fields.value = f || {}
      const touched = (k) => !keys || keys.includes(k)
      // 非密字段直接回显生效/覆盖值——override 态进输入框可改，env 态作占位符
      if (touched('ai_base_url')) aiBase.value = fields.value.ai_base_url?.source === 'override' ? (fields.value.ai_base_url.value || '') : ''
      if (touched('ai_model')) aiModelName.value = fields.value.ai_model?.source === 'override' ? (fields.value.ai_model.value || '') : ''
      if (touched('ai_timeout_ms')) aiTimeout.value = fields.value.ai_timeout_ms?.source === 'override' ? (fields.value.ai_timeout_ms.value || '') : ''
      if (touched('ai_api_key')) aiKey.value = ''
      if (touched('bili_cookie')) cookieDrafts.bili_cookie = ''
      if (touched('qq_cookie')) cookieDrafts.qq_cookie = ''
    }

    const load = async () => {
      loading.value = true
      loadError.value = ''
      try {
        const r = await settingsApi.get()
        applyFields(r?.fields)
        ai.value = r?.ai || { enabled: false, model: null }
      } catch (e) {
        loadError.value = `读取服务端配置失败：${apiErrorMessage(e)}`
      } finally {
        loading.value = false
      }
    }
    onMounted(load)

    const srcText = (f) => {
      if (f?.source === 'override') return '自定义'
      if (f?.source === 'env') return '服务端配置'
      return '未配置'
    }
    const secretPlaceholder = (f) =>
      f?.set ? `已配置（${srcText(f)}${f.hint ? ` · ${f.hint}` : ''}），输入以替换` : '未配置——输入以设置'
    const cookiePlaceholder = (key) => secretPlaceholder(fields.value[key])
    const cookieState = (key) => {
      const f = fields.value[key]
      return f?.set ? `${srcText(f)}${f.hint ? ` · ${f.hint}` : ''}` : '未配置'
    }

    const afterSave = (r, keys) => {
      applyFields(r?.fields, keys)
      ai.value = r?.ai || ai.value
      testResult.value = null // 配置已变，旧测试结果不再对应
      // AI 启用态/caps 凭据是会话缓存——不落缓存失效，新配置要等刷新才生效
      aiApi.invalidateStatus()
      refreshServerCaps()
      toast('已保存', 'success')
    }

    const saveAi = async () => {
      saving.value = true
      try {
        const patch = {
          ai_base_url: aiBase.value.trim(),
          ai_model: aiModelName.value.trim(),
          ai_timeout_ms: aiTimeout.value.trim(),
        }
        if (aiKey.value.trim()) patch.ai_api_key = aiKey.value.trim()
        const r = await settingsApi.save(patch)
        afterSave(r, Object.keys(patch))
      } catch (e) {
        toast(`保存失败：${apiErrorMessage(e)}`, 'error')
      } finally {
        saving.value = false
      }
    }

    const saveCookie = async (key) => {
      const v = cookieDrafts[key].trim()
      if (!v) return
      saving.value = true
      try {
        const r = await settingsApi.save({ [key]: v })
        afterSave(r, [key])
      } catch (e) {
        toast(`保存失败：${apiErrorMessage(e)}`, 'error')
      } finally {
        saving.value = false
      }
    }

    const clearOverride = async (key) => {
      saving.value = true
      try {
        const r = await settingsApi.save({ [key]: '' })
        afterSave(r, [key])
      } catch (e) {
        toast(`清除失败：${apiErrorMessage(e)}`, 'error')
      } finally {
        saving.value = false
      }
    }

    const testAi = async () => {
      testing.value = true
      testResult.value = null
      try {
        // 草稿值直送——「填了还没存先测」是设置页的自然动作；
        // 空段由服务端回落生效配置
        testResult.value = await settingsApi.testAi({
          baseUrl: aiBase.value.trim(),
          apiKey: aiKey.value.trim(),
          model: aiModelName.value.trim(),
        })
      } catch (e) {
        testResult.value = { ok: false, message: apiErrorMessage(e) }
      } finally {
        testing.value = false
      }
    }
    // 输入一改旧结果即失效——避免「连接成功」挂在已改的配置下误导
    watch([aiBase, aiKey, aiModelName], () => { testResult.value = null })
    const testResultText = computed(() => {
      const r = testResult.value
      if (!r) return ''
      if (!r.ok) return r.message || '连接失败'
      const m = r.modelCount != null ? ` · 模型 ${r.modelCount} 个` : ''
      const found = r.modelFound === true ? ` · ${r.model} 在列` : r.modelFound === false ? ` · ${r.model} 不在名单` : ''
      return `连接成功${m}${found}`
    })

    return {
      loading, loadError, load,
      fields, ai, aiBase, aiKey, aiModelName, aiTimeout,
      cookieDefs, cookieDrafts,
      saving, testing, testResult, testResultText,
      srcText, secretPlaceholder, cookiePlaceholder, cookieState,
      saveAi, saveCookie, clearOverride, testAi,
      THEMES, currentTheme, setTheme,
      prefVideoOn, prefLyricFontSize, LYRIC_FS_MIN, LYRIC_FS_MAX,
    }
  }
}
</script>

<style scoped>
/* 主区全宽视图（与 DownloadsPanel 同型）：纵向单列卡片流，最大宽收 720 */
.settings-panel {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-contain: contain;
  padding: 20px 16px 40px;
}
.settings-col { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }

.settings-title { font-size: 20px; font-weight: 600; color: var(--ink); margin: 0; }
.settings-sub { font-size: 12px; color: var(--ink-64); margin: 6px 0 0; }
.settings-loading, .settings-error {
  font-size: 13px; color: var(--ink-64); padding: 24px; text-align: center;
}
.settings-error { color: var(--accent-danger-ink, #c0392b); display: flex; gap: 12px; align-items: center; justify-content: center; }

.settings-card {
  border: var(--hairline);
  background: var(--paper);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.settings-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.settings-card-title { font-size: 15px; font-weight: 600; color: var(--ink); margin: 0; }
.settings-hint { font-size: 12px; color: var(--ink-64); margin: 0; line-height: 1.6; }

.settings-row { display: flex; flex-direction: column; gap: 6px; }
.settings-row--flat { flex-direction: row; align-items: center; justify-content: space-between; }
.settings-label { font-size: 12px; color: var(--ink-86); display: flex; align-items: center; gap: 8px; }
.settings-src { font-style: normal; font-size: 11px; font-family: var(--font-mono); }
.settings-src--override { color: var(--accent-magenta-ink, #b03a7c); }
.settings-src--env { color: var(--ink-64); }
.settings-src--none { color: var(--ink-30); }

.settings-actions { display: flex; gap: 8px; justify-content: flex-end; }
.settings-test { font-size: 12px; margin: 0; font-family: var(--font-mono); }
.settings-test--ok { color: var(--accent-green-ink, #1e7d4f); }
.settings-test--fail { color: var(--accent-danger-ink, #c0392b); }

.settings-cookie { display: flex; flex-direction: column; gap: 6px; padding-top: 12px; border-top: var(--hairline-soft); }
.settings-cookie:first-of-type { border-top: 0; padding-top: 0; }
.settings-cookie-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.settings-cookie-state { font-size: 11px; color: var(--ink-64); font-family: var(--font-mono); }
.settings-textarea {
  width: 100%;
  border: var(--hairline);
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 8px 12px;
  resize: vertical;
  min-height: 60px;
  outline: none;
}
.settings-textarea:focus { outline: 2px solid currentColor; outline-offset: -1px; }
.settings-textarea::placeholder { color: var(--ink-64); }

.settings-themes, .settings-stepper { display: flex; gap: 6px; align-items: center; }
.settings-stepper-val { font-family: var(--font-mono); font-size: 12px; min-width: 44px; text-align: center; }

@media (max-width: 640px) {
  .settings-panel { padding: 14px 10px 32px; }
  .settings-card { padding: 12px; }
}
</style>
