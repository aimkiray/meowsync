import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// 前端测试通道（vitest + jsdom）：与 node:test 服务端测试并存。
// npm test  = node --test tests/     —— 服务端真库真路由用例（CJS require）
// npm run test:ui = vitest run       —— 前端用例：ESM 导入 src/（import.meta.env
//   只有经 Vite 管线才可用）、Vue 响应式/组件、jsdom DOM
// 用例命名 .spec.mjs 而非 .test.mjs——node --test tests/ 按文件名模式递归
// 拾取（*.test.?js/test-*/等），.spec.mjs 不在其词表，两套运行器天然错开
export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __BUILD_TIME__: JSON.stringify('1970-01-01T00:00:00.000Z')
  },
  test: {
    environment: 'jsdom',
    include: ['tests/ui/**/*.spec.{js,mjs}'],
    setupFiles: ['tests/ui/setup.mjs'],
    // 前端用例不打真服务端——fetch/axios 一律桩
    testTimeout: 15000
  }
})
