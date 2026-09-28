/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* print-grid 令牌（typesafe.ai print-sheet 语言） */
        'ink': '#1e1e1e',
        'paper': '#fefefe',
        'label-grey': '#dedede',
        'canvas-teal': '#09aea1',
        'canvas-sage': '#abbab9',
        'canvas-pink': '#f386a1',
        'accent-magenta': '#d45bb6',
        'accent-green': '#03aa5c',
      },
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
