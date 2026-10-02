/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    /* 设计令牌单一事实源仍是 style.css :root——这里只建 var() 别名桥、
       不复制数值，双源漂移为零。
       分工约定（mobile-first）：布局/间距/响应式走工具类；发丝线/渐变/
       像素化等装饰性视觉留在组件 scoped CSS。 */
    extend: {
      colors: {
        ink: 'var(--ink)',
        'ink-86': 'var(--ink-86)',
        'ink-64': 'var(--ink-64)',
        'ink-30': 'var(--ink-30)',
        'ink-10': 'var(--ink-10)',
        'ink-06': 'var(--ink-06)',
        paper: 'var(--paper)',
        page: 'var(--page)',
        'label-grey': 'var(--label-grey)',
        'canvas-teal': 'var(--canvas-teal)',
        'canvas-sage': 'var(--canvas-sage)',
        'canvas-pink': 'var(--canvas-pink)',
        'accent-magenta': 'var(--accent-magenta)',
        'accent-magenta-ink': 'var(--accent-magenta-ink)',
        'accent-green': 'var(--accent-green)',
        'accent-green-ink': 'var(--accent-green-ink)',
        'accent-danger': 'var(--accent-danger)',
        'accent-danger-ink': 'var(--accent-danger-ink)',
      },
      fontFamily: {
        body: 'var(--font-body)',
        mono: 'var(--font-mono)',
        display: 'var(--font-display)',
        pixel: 'var(--font-pixel)',
      },
      /* 全站响应式断点名：wide = 双栏布局可用的最小宽度
         （旧桌面优先写法 (max-width:900px) 的 mobile-first 反转） */
      screens: {
        wide: '901px',
      },
    },
  },
  plugins: [],
}
