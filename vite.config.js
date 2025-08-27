import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

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
      host: env.HOST || 'localhost',
      open: env.VITE_OPEN_BROWSER !== 'false' && process.platform !== 'linux'
    },
    
    // 预览服务器配置
    preview: {
      port: parseInt(env.VITE_PORT) || 3000,
      host: env.HOST || 'localhost'
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
            audio: ['howler'],
            utils: ['@vueuse/core', 'crypto-js']
          }
        }
      }
    },
    
    // 环境变量配置
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString())
    }
  }
})