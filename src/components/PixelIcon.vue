<template>
  <!-- 22×22 位图图标：fill=currentColor 墨色单彩，crispEdges 保像素棱角 -->
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 22 22"
    fill="currentColor"
    shape-rendering="crispEdges"
    aria-hidden="true"
    class="pixel-icon"
  >
    <path :d="path" />
  </svg>
</template>

<script>
/* 图标源：Iconify memory 集（22×22 像素网格，fill=currentColor）
   https://icon-sets.iconify.design/memory/ */
const ICONS = {
  'play': 'M10 5v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H7V4h2v1zm2 5h-1V9h-1V8H9v6h1v-1h1v-1h1z',  // memory:play
  'pause': 'M6 4h3v14H6zm7 14V4h3v14z',  // memory:pause
  'prev': 'M13 17h1V5h-1v1h-1v1h-1v1h-1v1H9v1H8v2h1v1h1v1h1v1h1v1h1',  // memory:menu-left-fill
  'next': 'M9 5H8v12h1v-1h1v-1h1v-1h1v-1h1v-1h1v-2h-1V9h-1V8h-1V7h-1V6H9',  // memory:menu-right-fill
  'shuffle': 'M12 4h2v1h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2zm-2 0v14H8v-1H7v-1H6v-1H5v-1H4v-1H3v-1H2v-2h1V9h1V8h1V7h1V6h1V5h1V4zm4 4v6h1v-1h1v-1h1v-2h-1V9h-1V8zM8 8H7v1H6v1H5v2h1v1h1v1h1z',  // memory:menu-left-right
  'vol': 'M13 2h2v1h1v1h1v1h1v1h1v2h1v6h-1v2h-1v1h-1v1h-1v1h-1v1h-2v-2h1v-1h1v-1h1v-1h1v-2h1V9h-1V7h-1V6h-1V5h-1V4h-1zm1 5v1h1v2h1v2h-1v2h-1v1h-1V7zM2 8h4V7h1V6h1V5h1V4h1V3h1v16h-1v-1H9v-1H8v-1H7v-1H6v-1H2zm2 2v2h3v1h1v1h1V8H8v1H7v1z',  // memory:volume-high
  'vol-mute': 'M12 7h2v1h1v1h2V8h1V7h2v2h-1v1h-1v2h1v1h1v2h-2v-1h-1v-1h-2v1h-1v1h-2v-2h1v-1h1v-2h-1V9h-1zM6 8V7h1V6h1V5h1V4h1V3h1v16h-1v-1H9v-1H8v-1H7v-1H6v-1H2V8zm1 2H4v2h3v1h1v1h1V8H8v1H7z',  // memory:volume-mute
  'expand': 'M7 10H5V9h1V8h2v1H7m4 1H9V9h1V8h2v1h-1m4 1h-2V9h1V8h2v1h-1m0 5h-1v-2h1v-1h1v2h-1m4 6H3v-1H2V4h1V3h16v1h1v14h-1m-1-1V5H4v12h10v-1h1v-1h1v2Z',  // memory:relative-scale
  'search': 'M19 20h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-2v1H6v-1H4v-1H3v-2H2V6h1V4h1V3h2V2h5v1h2v1h1v2h1v5h-1v2h1v1h1v1h1v1h1v1h1v1h1v1h-1m-8-6v-1h1v-1h1V6h-1V5h-1V4H6v1H5v1H4v5h1v1h1v1Z',  // memory:search
  'download': 'M18 17v2H4v-2zM14 2v6h4v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-1H6v-1H5V9H4V8h4V2zm-2 2h-2v6H9v1h1v1h2v-1h1v-1h-1z',  // memory:download
  'save': 'M2 3h1V2h13v1h1v1h1v1h1v1h1v13h-1v1H3v-1H2zm16 4h-1V6h-1V5h-1v4H6V4H4v14h2v-5h10v5h2zm-7-3v3h2V4zm3 14v-3H8v3z',  // memory:floppy-disk
  'warn': 'M20 20H2v-1H1v-4h1v-2h1v-2h1V9h1V7h1V5h1V3h1V2h6v1h1v2h1v2h1v2h1v2h1v2h1v2h1v4h-1zM9 6H8v2H7v2H6v2H5v2H4v2H3v2h16v-2h-1v-2h-1v-2h-1v-2h-1V8h-1V6h-1V4H9zm1 1h2v6h-2zm0 7h2v2h-2z',  // memory:alert
  'check': 'M4 11h2v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h2v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H8v-1H7v-1H6v-1H5v-1H4z',  // memory:check
  'grip': 'M4 10V8h1V7h1V6h1V5h1V4h1V3h1V2h2v1h1v1h1v1h1v1h1v1h1v1h1v2zm0 2h14v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4zm4-4h6V7h-1V6h-1V5h-2v1H9v1H8zm0 6v1h1v1h1v1h2v-1h1v-1h1v-1z',  // memory:menu-up-down
  'home': 'M19 20H3v-8H1V9h1V6h1V3h1V2h14v3h1v2h1v2h1v3h-1v1h-1m-3-3V9h2V8h-1V6h-1V4H6v2H5v2H4v1h2v1h3V9h4v1m-1 8v-3h-2v3m7 0v-7h-1v1h-4v-1h-2v1H6v-1H5v7h3v-5h6v5Z',  // memory:home-thatched
  'note': 'M11 2h7v5h-5v11h-1v1h-1v1H7v-1H6v-1H5v-4h1v-1h1v-1h4zm0 13h-1v-1H8v1H7v2h1v1h2v-1h1z',  // memory:music-note
  'phone': 'M2 1h18v1h.94v18H20v1H2v-1h-.94V2H2zm1 2v16h16V3zm1 1h14v8H4zm1 10h3v3H5zm7 1h2v2h-2zm3-1h2v2h-2z',  // memory:device
  'heart': 'M12 20h-2v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3v-1H2v-2H1V5h1V4h1V3h1V2h5v1h1v1h2V3h1V2h5v1h1v1h1v1h1v5h-1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1zm-7-9v1h1v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V6h-1V5h-1V4h-3v1h-1v1h-1v1h-2V6H9V5H8V4H5v1H4v1H3v3h1v2z',  // memory:heart
  'share': 'M18 17v2H4v-2zM8 15V9H4V8h1V7h1V6h1V5h1V4h1V3h1V2h2v1h1v1h1v1h1v1h1v1h1v1h1v1h-4v6zm2-2h2V7h1V6h-1V5h-2v1H9v1h1z',  // memory:upload
  'kebab': 'M7 7H3V3h4m6 4H9V3h4m6 4h-4V3h4M7 13H3V9h4m6 4H9V9h4m6 4h-4V9h4M7 19H3v-4h4m6 4H9v-4h4m6 4h-4v-4h4Z',  // memory:apps
  'dots': 'M8 8H6V6h2m4 2h-2V6h2m4 2h-2V6h2m-8 6H6v-2h2m4 2h-2v-2h2m4 2h-2v-2h2m-8 6H6v-2h2m4 2h-2v-2h2m4 2h-2v-2h2m2 6H4v-1H3v-1H2V4h1V3h1V2h14v1h1v1h1v14h-1v1h-1m-1-1v-1h1V5h-1V4H5v1H4v12h1v1Z',  // memory:apps-box
  'close': 'M16 17h-1v-1h-1v-1h-1v-1h-1v-1h-2v1H9v1H8v1H7v1H6v-1H5v-1h1v-1h1v-1h1v-1h1v-2H8V9H7V8H6V7H5V6h1V5h1v1h1v1h1v1h1v1h2V8h1V7h1V6h1V5h1v1h1v1h-1v1h-1v1h-1v1h-1v2h1v1h1v1h1v1h1v1h-1Z',  // memory:close
  'menu': 'M18 6H4V4h14m0 5H4V7h14m0 5H4v-2h14m0 5H4v-2h14m0 5H4v-2h14Z',  // memory:format-align-justify
  'chev-l': 'M12 16v1h1v1h2v-2h-1v-1h-1v-1h-1v-1h-1v-1h-1v-2h1V9h1V8h1V7h1V6h1V4h-2v1h-1v1h-1v1h-1v1H9v1H8v1H7v2h1v1h1v1h1v1h1v1',  // memory:chevron-left
  'chev-r': 'M10 6V5H9V4H7v2h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1H9v1H8v1H7v2h2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-2h-1V9h-1V8h-1V7h-1V6',  // memory:chevron-right
  'first': 'M17 15h-1v-3h-3v-2h3V7h1v1h1v1h1v1h1v2h-1v1h-1v1h-1m-5 8h-2v-4H6V4h4V0h2m-1 16V6H8v10Z',  // memory:table-top-door-one-way-right
  'last': 'M6 15H5v-1H4v-1H3v-1H2v-2h1V9h1V8h1V7h1v3h3v2H6m6 10h-2V0h2v4h4v14h-4m2-2V6h-3v10Z',  // memory:table-top-door-one-way-left
  /* 播放模式：顺序(列表+右箭) / 循环(顺时针) / 单曲(逆时针) */
  'm-list': 'M19 6H3V4h16m-6 6H3V8h10m0 6H3v-2h10m0 6H3v-2h10m5 2h-2v-1h-1v-1h-1v-1h2V8h2v7h2v1h-1v1h-1Z',  // memory:format-text-multiline
  'm-loop': 'M22 11v1h-1v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h-1v-1h3V9h-1V7h-1V6h-2V5H9v1H7v1H6v2H5v4h1v2h1v1h2v1h4v-1h3v2h-2v1H8v-1H6v-1H5v-1H4v-2H3V8h1V6h1V5h1V4h2V3h6v1h2v1h1v1h1v2h1v3z',  // memory:rotate-clockwise
  'm-single': 'M0 11v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1H5V9h1V7h1V6h2V5h4v1h2v1h1v2h1v4h-1v2h-1v1h-2v1H9v-1H6v2h2v1h6v-1h2v-1h1v-1h1v-2h1V8h-1V6h-1V5h-1V4h-2V3H8v1H6v1H5v1H4v2H3v3z',  // memory:rotate-counterclockwise
};

export default {
  name: 'PixelIcon',
  props: {
    name: { type: String, required: true },
    size: { type: [Number, String], default: 16 }
  },
  computed: {
    path() { return ICONS[this.name] || '' }
  }
}
</script>

<style scoped>
.pixel-icon {
  display: block;
  flex-shrink: 0;
}
</style>
