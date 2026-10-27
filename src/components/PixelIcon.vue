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
  'play': 'M9 5H8v12h1v-1h1v-1h1v-1h1v-1h1v-1h1v-2h-1V9h-1V8h-1V7h-1V6H9',  // memory:menu-right-fill
  'pause': 'M6 4h3v14H6zm7 14V4h3v14z',  // memory:pause
  'prev': 'M15 4v14h-2v-1h-1v-1h-1v-1h-1v-1H9v-1H8v-1H7v-2h1V9h1V8h1V7h1V6h1V5h1V4zm-2 4h-1v1h-1v1h-1v2h1v1h1v1h1z',  // memory:menu-left
  'next': 'M7 18V4h2v1h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1H9v1zm2-4h1v-1h1v-1h1v-2h-1V9h-1V8H9z',  // memory:menu-right
  'shuffle': 'M19 10v2h-1v1h-1v1h-1v1h-1v1h-2v-2h1v-1h1v-1H7v1h1v1h1v2H7v-1H6v-1H5v-1H4v-1H3v-2h1V9h1V8h1V7h1V6h2v2H8v1H7v1h8V9h-1V8h-1V6h2v1h1v1h1v1h1v1',  // memory:arrow-left-right
  'vol': 'M13 2h2v1h1v1h1v1h1v1h1v2h1v6h-1v2h-1v1h-1v1h-1v1h-1v1h-2v-2h1v-1h1v-1h1v-1h1v-2h1V9h-1V7h-1V6h-1V5h-1V4h-1zm1 5v1h1v2h1v2h-1v2h-1v1h-1V7zM2 8h4V7h1V6h1V5h1V4h1V3h1v16h-1v-1H9v-1H8v-1H7v-1H6v-1H2zm2 2v2h3v1h1v1h1V8H8v1H7v1z',  // memory:volume-high
  'vol-mute': 'M12 7h2v1h1v1h2V8h1V7h2v2h-1v1h-1v2h1v1h1v2h-2v-1h-1v-1h-2v1h-1v1h-2v-2h1v-1h1v-2h-1V9h-1zM6 8V7h1V6h1V5h1V4h1V3h1v16h-1v-1H9v-1H8v-1H7v-1H6v-1H2V8zm1 2H4v2h3v1h1v1h1V8H8v1H7z',  // memory:volume-mute
  'vol-low': 'M6 8h4V7h1V6h1V5h1V4h1V3h1v16h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1H6zm2 2v2h3v1h1v1h1V8h-1v1h-1v1z',  // memory:volume-low
  'expand': 'M7 10H5V9h1V8h2v1H7m4 1H9V9h1V8h2v1h-1m4 1h-2V9h1V8h2v1h-1m0 5h-1v-2h1v-1h1v2h-1m4 6H3v-1H2V4h1V3h16v1h1v14h-1m-1-1V5H4v12h10v-1h1v-1h1v2Z',  // memory:relative-scale
  'flask': 'M11 12h2v2h-2zm3-11v1h1v3h-1v2h1v2h1v2h1v2h1v1h1v2h1v4h-1v1H3v-1H2v-4h1v-2h1v-1h1v-2h1V9h1V7h1V5H7V2h1V1zm-2 2h-2v5H9v2H8v2H7v1H6v2H5v2h1v-1h1v-1h1v-1h1v1h1v1h1v1h1v1h2v-1h1v-2h1v-1h-1v-2h-1v-2h-1V8h-1z',  // memory:flask——全屏歌词（沉浸模式）入口字形：实验瓶取「沉浸实验台」义
  'search': 'M19 20h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-2v1H6v-1H4v-1H3v-2H2V6h1V4h1V3h2V2h5v1h2v1h1v2h1v5h-1v2h1v1h1v1h1v1h1v1h1v1h1v1h-1m-8-6v-1h1v-1h1V6h-1V5h-1V4H6v1H5v1H4v5h1v1h1v1Z',  // memory:search
  'download': 'M18 17v2H4v-2zM14 2v6h4v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-1H6v-1H5V9H4V8h4V2zm-2 2h-2v6H9v1h1v1h2v-1h1v-1h-1z',  // memory:download
  'save': 'M2 3h1V2h13v1h1v1h1v1h1v1h1v13h-1v1H3v-1H2zm16 4h-1V6h-1V5h-1v4H6V4H4v14h2v-5h10v5h2zm-7-3v3h2V4zm3 14v-3H8v3z',  // memory:floppy-disk
  'plus': 'M12 16h-2v-4H6v-2h4V6h2v4h4v2h-4Zm6 4H4v-1H3v-1H2V4h1V3h1V2h14v1h1v1h1v14h-1v1h-1Zm-1-2v-1h1V5h-1V4H5v1H4v12h1v1Z',  // memory:plus-box
  'sand': 'M11 8h1V7h-1m-2 3h1V9h1V8h-1V7H9V6h1v1h1V6h1v1h1v1h1V7h1V5h1V4H6v1h1v1h1v2h1m1 3h1v-1h-1m1 2h1v-1h-1m8 9H3v-3h1v-1h1v-2h1v-2h1v-2H6V8H5V6H4V5H3V2h16v3h-1v1h-1v2h-1v2h-1v2h1v2h1v2h1v1h1m-6-7V8h-1v1h-1v1m5 8v-1h-1v-2h-1v-2h-1v-1h-1v2h1v2h1v1H8v-1h1v-2h1v-1h1v-1H9v1H8v2H7v2H6v1Z',  // memory:time-sand
  'warn': 'M20 20H2v-1H1v-4h1v-2h1v-2h1V9h1V7h1V5h1V3h1V2h6v1h1v2h1v2h1v2h1v2h1v2h1v2h1v4h-1zM9 6H8v2H7v2H6v2H5v2H4v2H3v2h16v-2h-1v-2h-1v-2h-1v-2h-1V8h-1V6h-1V4H9zm1 1h2v6h-2zm0 7h2v2h-2z',  // memory:alert
  'check': 'M4 11h2v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h2v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H8v-1H7v-1H6v-1H5v-1H4z',  // memory:check
  'edit': 'M17 2h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1V9h-1V8h-1V7h-1V6h-1V5h-1V4h-1V3h-1V2zM15 8l4 4-9 9H6v-4l9-9z',  // 像素铅笔：斜笔身+左下笔尖（起点 17 收在 22×22 界内）
  'grip': 'M4 10V8h1V7h1V6h1V5h1V4h1V3h1V2h2v1h1v1h1v1h1v1h1v1h1v1h1v2zm0 2h14v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4zm4-4h6V7h-1V6h-1V5h-2v1H9v1H8zm0 6v1h1v1h1v1h2v-1h1v-1h1v-1z',  // memory:menu-up-down
  'broadcast': 'M12 13h-2v-1H9v-2h1V9h2v1h1v2h-1m3 4h-1v-1h-1v-1h1v-1h1V9h-1V8h-1V7H9v1H8v1H7v4h1v1h1v1H8v1H7v-1H6v-1H5V8h1V7h1V6h1V5h6v1h1v1h1v1h1v6h-1v1h-1m2 5h-1v-1h-1v-1h1v-1h1v-1h1v-2h1V8h-1V6h-1V5h-1V4h-2V3H8v1H6v1H5v1H4v2H3v6h1v2h1v1h1v1h1v1H6v1H5v-1H4v-1H3v-1H2v-2H1V7h1V5h1V4h1V3h1V2h2V1h8v1h2v1h1v1h1v1h1v2h1v8h-1v2h-1v1h-1v1h-1Z',  // memory:broadcast——切源钮：菱形信号塔取「多源广播」义
  'compass': 'M15 1v1h2v1h1v1h1v1h1v2h1v8h-1v2h-1v1h-1v1h-1v1h-2v1H7v-1H5v-1H4v-1H3v-1H2v-2H1V7h1V5h1V4h1V3h1V2h2V1zm-1 2H8v1H6v1H5v1H4v2H3v6h1v2h1v1h1v1h2v1h6v-1h2v-1h1v-1h1v-2h1V8h-1V6h-1V5h-1V4h-2zm-4 6V8h2V7h2V6h2v2h-1v2h-1v2h-1v1h-1v1h-2v1H8v1H6v-2h1v-2h1v-2h1V9zm2 1h-2v2h2z',  // memory:compass——切源钮：罗盘指针取「方向选定」义
  'note': 'M11 2h7v5h-5v11h-1v1h-1v1H7v-1H6v-1H5v-4h1v-1h1v-1h4zm0 13h-1v-1H8v1H7v2h1v1h2v-1h1z',  // memory:music-note
  'lyric': 'M8 2h3v1h2v1h2v1h2v2h1v2h1v2h1v3h-2v-2h-1v-1h-1v-1h-2V9h-1V8h-1V6h-1V5h-1V4H8m3 5h1v1h1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v1H2v-1H1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1',  // 用户指定 SVG：斜向折勾——\ 长笔自左上贯至右下、/ 撇自交点撇至左下交成「人」字对勾形，换词钮取「歌词」义
  'share': 'M18 17v2H4v-2zM8 15V9H4V8h1V7h1V6h1V5h1V4h1V3h1V2h2v1h1v1h1v1h1v1h1v1h1v1h1v1h-4v6zm2-2h2V7h1V6h-1V5h-2v1H9v1h1z',  // memory:upload
  'kebab': 'M7 7H3V3h4m6 4H9V3h4m6 4h-4V3h4M7 13H3V9h4m6 4H9V9h4m6 4h-4V9h4M7 19H3v-4h4m6 4H9v-4h4m6 4h-4v-4h4Z',  // memory:apps
  'more': 'M2 13h4V9H2Zm7 0h4V9H9Zm7 0h4v-4h-4Z',  // 手拼：横向三点 ⋯——memory 集 dots-horizontal 是 24 网格 2px 细点，字重太轻；取与 kebab 同径 4×4 块保字重一致，x=2/9/16 间距 3、左右各留 2，22 网格对中线对称（凑 4px 间距只剩 1px 边距显挤）
  'close': 'M16 17h-1v-1h-1v-1h-1v-1h-1v-1h-2v1H9v1H8v1H7v1H6v-1H5v-1h1v-1h1v-1h1v-1h1v-2H8V9H7V8H6V7H5V6h1V5h1v1h1v1h1v1h1v1h2V8h1V7h1V6h1V5h1v1h1v1h-1v1h-1v1h-1v1h-1v2h1v1h1v1h1v1h1v1h-1Z',  // memory:close
  'menu': 'M18 6H4V4h14m0 5H4V7h14m0 5H4v-2h14m0 5H4v-2h14m0 5H4v-2h14Z',  // memory:format-align-justify
  'playlist': 'M3 4h10v2H3zM3 8h10v2H3zM3 12h10v2H3zM3 16h6v2H3zM16 10h4v3h-2v6h-2v-9zM12 17h6v4h-6zM14 18v2h2v-2z',  // 像素歌单：左列表杠+右下音符（memory 集无 playlist 源——手拼，音符裁缩自 note 路径）
  'external': 'M5 8v11h11v-5h-2v3H7v-8h3V8H5zm8-4h8v8h-3V9h-1V8h-1V7h-1V6h-3V4zM9 14h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1z',  // memory:open-in-new——回源外链：左下窗口+右上出箭头
  'chev-l': 'M12 16v1h1v1h2v-2h-1v-1h-1v-1h-1v-1h-1v-1h-1v-2h1V9h1V8h1V7h1V6h1V4h-2v1h-1v1h-1v1h-1v1H9v1H8v1H7v2h1v1h1v1h1v1h1v1',  // memory:chevron-left
  'chev-r': 'M10 6V5H9V4H7v2h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1H9v1H8v1H7v2h2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-2h-1V9h-1V8h-1V7h-1V6',  // memory:chevron-right
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
    path() {
      const p = ICONS[this.name]
      if (p === undefined && import.meta.env.DEV) console.warn(`[PixelIcon] 未注册图标: ${this.name}`)
      return p || ''
    }
  }
}
</script>

<style scoped>
.pixel-icon {
  display: block;
  flex-shrink: 0;
}
</style>
