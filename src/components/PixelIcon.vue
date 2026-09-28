<template>
  <!-- 16×16 位图图标：fill=currentColor 墨色单彩，crispEdges 保像素棱角 -->
  <svg
    :width="size"
    :height="size"
    :viewBox="viewBox"
    fill="currentColor"
    shape-rendering="crispEdges"
    aria-hidden="true"
    class="pixel-icon"
  >
    <path :d="path" />
  </svg>
</template>

<script>
/* 位图图标集：每条 path 都是像素矩形/阶梯三角的并集（16×16 网格） */
const ICONS = {
  play:    'M4 2h2v1H4zM4 3h3v1H4zM4 4h4v1H4zM4 5h5v1H4zM4 6h6v1H4zM4 7h8v2H4zM4 9h6v1H4zM4 10h5v1H4zM4 11h4v1H4zM4 12h3v1H4zM4 13h2v1H4z',
  pause:   'M4 3h3v10H4zM9 3h3v10H9z',
  prev:    'M2 3h2v10H2zM11 3h2v1h-2zM10 4h3v1h-3zM9 5h4v1H9zM8 6h5v1H8zM6 7h7v2H6zM8 9h5v1H8zM9 10h4v1H9zM10 11h3v1h-3zM11 12h2v1h-2z',
  next:    'M13 3h2v10h-2zM4 3h2v1H4zM4 4h3v1H4zM4 5h4v1H4zM4 6h5v1H4zM4 7h7v2H4zM4 9h5v1H4zM4 10h4v1H4zM4 11h3v1H4zM4 12h2v1H4z',
  shuffle: 'M2 4h9v2H2zM11 2h1v1h1v1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1zM5 10h9v2H5zM5 8H4v1H3v1H2v1H1v1h1v1h1v1h1v1h1z',
  vol:     'M2 6h2v4H2zM4 6V4h1V3h1V2h1v12H6v-1H5v-1H4v-4zM9 5h1v6H9zM11 6h1v4h-1zM13 7h1v2h-1z',
  'vol-mute': 'M2 6h2v4H2zM4 6V4h1V3h1V2h1v12H6v-1H5v-1H4v-4zM9 6h1v1h1v1h1v1h1v1h-1v1h-1v1h-1v1H9v-1H8v-1H9V9h1V8H9V7h1zM11 6h1v1h1v1h-1v1h-1zM11 10h1v1h1v1h1v1h-1v-1h-1v-1zM13 6h1v1h1v1h-1V7h-1zM13 10h1v1h1v1h1v1h-1v-1h-1v-1z',
  expand:  'M2 2h5v2H4v3H2zM14 2v5h-2V4H9V2zM2 14V9h2v3h3v2zM14 14v-5h-2v3H9v2z',
  search:  'M6 2h4v1H6zM4 3h2v1H4zM10 3h2v1h-2zM3 4h1v4H3zM12 4h1v4h-1zM4 8h2v1H4zM10 8h2v1h-2zM6 9h4v1H6zM10 10h1v1h-1zM11 11h1v1h-1zM12 12h2v2h-2z',
  download:'M7 2h2v6H7zM5 8h6v1H5zM6 9h4v1H6zM7 10h2v1H7zM2 11h1v3h10v-3h1v4H2z',
  save:    'M2 3h9v2H2zM2 7h9v2H2zM2 11h5v2H2zM11 8h2v2h2v2h-2v2h-2v-2H9v-2h2z',
  warn:    'M8 2v1H7v1H6v1H5v1H4v1H3v1H2v1H1v2h14v-2h-1V9h-1V8h-1V7h-1V6h-1V5h-1V4h-1V3H9V2zM7 6h2v3H7zM7 10h2v1H7z',
  check:   'M4 6h2v1H5v1h1v1h1v1h1v1h1v-1h1V8h1V7h1V6h1V5h1V4h1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v-1H6v-1H5V9H4V8H3V7H2V6z',
  grip:    'M5 3h2v2H5zM9 3h2v2H9zM5 7h2v2H5zM9 7h2v2H9zM5 11h2v2H5zM9 11h2v2H9z',
  home:    'M7 2h2v1H7zM6 3h4v1H6zM5 4h6v1H5zM4 5h8v1H4zM3 6h10v1H3zM5 7h6v2H5zM5 9h2v4H5zM9 9h2v4H9z',
  note:    'M9 2h5v3H9zM12 5h2v6h-2zM8 9h5v1H8zM7 10h7v2H7zM8 12h5v1H8z',
  phone:   'M5 1h6v2H5zM5 13h6v2H5zM5 3h2v10H5zM9 3h2v10H9zM7 11h2v1H7z',
  heart:   'M3 4h3v1H4v1H3zM10 4h3v1h-1v1h1V5zM3 7h1v1h1v1h1v1h1v1h4V9h1V8h1V7h1z',
  // 来源复刻：22px 网格位图图标（分享链/竖三点）
  share:   'M9 15H8v-1H7v-1h1v-1h1v-1h1v-1h1V9H8V7h7v7h-2v-3h-1v1h-1v1h-1v1H9m9 6H4v-1H3v-1H2V4h1V3h1V2h14v1h1v1h1v14h-1v1h-1m-1-1v-1h1V5h-1V4H5v1H4v12h1v1Z',
  kebab:   'M15 21H8v-1H7v-1H6V3h1V2h1V1h4v1h1v1h1v14h-1v1h-3v-1H9V5h2v11h1V4h-1V3H9v1H8v14h1v1h5v-1h1V5h2v14h-1v1h-1Z',
  dots:    'M7 3h2v2H7zM7 7h2v2H7zM7 11h2v2H7z',
};
// share/kebab 画在 22×22 网格上，其余 16×16
const VIEWBOX = { share: '0 0 22 22', kebab: '0 0 22 22' };

export default {
  name: 'PixelIcon',
  props: {
    name: { type: String, required: true },
    size: { type: [Number, String], default: 16 }
  },
  computed: {
    path() { return ICONS[this.name] || '' },
    viewBox() { return VIEWBOX[this.name] || '0 0 16 16' }
  }
}
</script>

<style scoped>
.pixel-icon {
  display: block;
  flex-shrink: 0;
}
</style>
