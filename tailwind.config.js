/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      /* 颜色单一事实源是 style.css :root 令牌——此处不再镜像，防双源漂移 */
      fontFamily: {
        'sans': ['Inter', 'Noto Sans SC', 'system-ui', 'sans-serif'],
        'mono': ['JetBrains Mono', 'Fusion Pixel', 'ui-monospace', 'monospace'],
        'display': ['Space Grotesk', 'Inter', 'Noto Sans SC', 'sans-serif'],
        'pixel': ['Fusion Pixel', 'JetBrains Mono', 'monospace'],
      },
      borderWidth: {
        'hairline': '1.2px',
      },
      borderRadius: {
        'none': '0',
      },
    },
  },
  plugins: [],
}
