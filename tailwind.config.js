/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    /* 设计令牌单一事实源是 style.css :root——此处不留镜像配置，防双源漂移 */
  },
  plugins: [],
}
