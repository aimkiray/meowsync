import { defineConfig, loadEnv } from 'vite'
import { readFileSync } from 'node:fs'
import vue from '@vitejs/plugin-vue'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig(({ command, mode }) => {
  // 加载环境变量
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [vue()],

    // 基础路径配置
    base: env.VITE_BASE_PATH || '/',

    // 开发服务器配置
    server: {
      port: parseInt(env.VITE_PORT) || 3000,
      // VITE_HOST 独立于后端 HOST，避免共享变量互相影响
      host: env.VITE_HOST || 'localhost',
      open: env.VITE_OPEN_BROWSER !== 'false' && process.platform !== 'linux',
      allowedHosts: [
        'localhost',
        '127.0.0.1',
        ...(env.VITE_ALLOWED_HOSTS ? env.VITE_ALLOWED_HOSTS.split(',').map(h => h.trim()).filter(Boolean) : [])
      ]
    },

    // 预览服务器配置
    preview: {
      port: parseInt(env.VITE_PORT) || 3000,
      host: env.VITE_HOST || 'localhost'
    },

    // 构建配置
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      sourcemap: mode === 'development',
      minify: mode === 'production' ? 'esbuild' : false,

      // 生产环境优化
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['vue', 'axios'],
            audio: ['howler']
          }
        }
      }
    },

    // 环境变量配置
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString())
    }
  }
})
