console.log('🚀 main.js 开始执行')
import { createApp } from 'vue'
import './style.css'
import App from './App.vue'

console.log('📦 所有模块导入完成')
console.log('🎯 App 组件:', App)

const app = createApp(App)
console.log('✨ Vue 应用创建完成')

app.mount('#app')
console.log('🎪 Vue 应用挂载完成')