<template>
  <!-- 首页发现流（白纸画布）：最近单曲网格 + 常听歌单/涉猎专辑横向货架。
       货架全部由本地播放历史/歌单库派生，零网络请求。页脚版本戳收版（print-grid 签名） -->
  <div ref="feedEl" class="home-feed">
    <header class="home-head">
      <div class="home-head-text">
        <h2 class="home-title" data-nosnippet><GlitchText text="音乐概览" /></h2>
      </div>
      <button
        type="button"
        class="ink-btn ink-btn--ghost ink-btn--sm home-roam-btn"
        :disabled="!recents.length"
        title="随机漫游最近单曲"
        @click="roamRecents"
      ><PixelIcon name="shuffle" :size="14" /> 随机漫游</button>
    </header>

    <!-- 最近单曲：行外壳 div 挂整卡 @click 消除内边距点击死区；主激活区
         .home-songrow-main 是原生 <button> 不重复绑 @click——键盘 Enter/Space
         触发的 click 事件冒泡到外壳，只发一次 play-song；行尾 + 键 @click.stop
         隔离冒泡（反嵌套律：button 不套 button） -->
    <section v-if="recents.length" class="home-section">
      <div class="home-section-head">
        <div class="home-section-title">
          <span class="home-section-sub">最近单曲</span>
        </div>
      </div>
      <div class="home-songs">
        <div
          v-for="song in visibleRecents"
          :key="song.id"
          class="home-songrow"
          :class="{ 'home-songrow--playing': isSongPlaying(song) }"
          @click="$emit('play-song', song, recents)"
        >
          <button
            type="button"
            class="home-songrow-main"
            :title="`${song.name} - ${songArtists(song)}`"
            :aria-current="isSongPlaying(song) ? 'true' : undefined"
          >
            <!-- alt 留空：封面与紧邻歌名同源——命名会让 SR 把歌名报两遍 -->
            <img
              v-if="songThumbUrl(song, 96) && !coverErrs.has(`s:${song.id}`)"
              :src="httpsCover(songThumbUrl(song, 96))"
              alt=""
              class="home-songrow-cover"
              loading="lazy"
              decoding="async"
              @error="coverErrs.add(`s:${song.id}`)"
            />
            <span v-else class="home-songrow-cover home-songrow-fb" aria-hidden="true"><PixelIcon name="note" :size="14" /></span>
            <span class="home-songrow-info">
              <span class="home-songrow-name">{{ song.name }}</span>
              <span class="home-songrow-artist">{{ songSubline(song) }}</span>
            </span>
          </button>
          <button
            type="button"
            class="row-add-btn pg-icobtn pg-icobtn--bare pg-icobtn--sm"
            title="添加到歌单"
            aria-label="添加到歌单"
            aria-haspopup="dialog"
            @click.stop="$emit('add-to-playlist', song, $event.currentTarget)"
          ><PixelIcon name="plus" :size="14" /></button>
        </div>
      </div>
    </section>

    <!-- 空态须三源皆空：货架被侧栏门控收掉但 displayPlaylists 非空时，
         再亮「还没有播放记录」是误导 -->
    <div v-if="!recents.length && !recentAlbums.length && !displayPlaylists.length" class="home-state" role="status">
      <p class="home-state-text">还没有播放记录，去顶部搜索试试喵~</p>
    </div>

    <!-- 常听歌单货架：优先 recentPlaylists（活副本富化），空时回退 userPlaylists 前 8 项；
         sidebarOpen && ≥901px 时收起避免与展开侧栏重复 -->
    <section v-if="showPlaylistShelf" class="home-section">
      <div class="home-section-head">
        <div class="home-section-title">
          <span class="home-section-sub">常听歌单</span>
        </div>
        <div v-if="shelfNav.pl.canScroll" class="home-shelf-nav">
          <button
            type="button"
            class="pg-icobtn pg-icobtn--sm home-shelf-btn"
            title="上一页"
            aria-label="常听歌单上一页"
            :disabled="!shelfNav.pl.canPrev"
            @click="scrollShelf('pl', -1)"
          ><PixelIcon name="chev-l" :size="14" /></button>
          <button
            type="button"
            class="pg-icobtn pg-icobtn--sm home-shelf-btn"
            title="下一页"
            aria-label="常听歌单下一页"
            :disabled="!shelfNav.pl.canNext"
            @click="scrollShelf('pl', 1)"
          ><PixelIcon name="chev-r" :size="14" /></button>
        </div>
      </div>
      <div ref="plShelfEl" class="home-shelf" @scroll.passive="updateShelfNav('pl')">
        <div
          v-for="pl in displayPlaylists"
          :key="pl.id"
          class="grid-card"
          :class="{ 'grid-card--playing': isPlaylistPlaying(pl) }"
          :aria-current="isPlaylistPlaying(pl) ? 'true' : undefined"
          @click="$emit('open', pl)"
        >
          <div class="grid-card-cover">
            <!-- alt 留空：封面与紧邻卡名同源——命名会让 SR 把名单报两遍 -->
            <img
              v-if="coverSizeUrl(pl.coverImgUrl, 320) && !coverErrs.has(`pl:${pl.id}`)"
              :src="httpsCover(coverSizeUrl(pl.coverImgUrl, 320))"
              alt=""
              loading="lazy"
              decoding="async"
              @error="coverErrs.add(`pl:${pl.id}`)"
            />
            <div v-else class="grid-card-cover-fallback"><PixelIcon name="note" :size="22" /></div>
            <span v-if="isPlaylistPlaying(pl)" class="grid-card-badge" aria-hidden="true"><PixelIcon name="vol" :size="11" /> 播放中</span>
            <!-- 直播键挂在 cover 层而非 .grid-card-main 内：外壳无 role=button，
                 根除 [role=button] > button 的 ARIA 嵌套违规 -->
            <button
              type="button"
              class="grid-card-play"
              title="播放歌单"
              :aria-label="`播放歌单 ${pl.name}`"
              @click.stop="$emit('play-playlist', pl)"
            ><PixelIcon name="play" :size="14" /></button>
          </div>
          <div
            class="grid-card-body grid-card-main"
            role="button"
            tabindex="0"
            :aria-current="isPlaylistPlaying(pl) ? 'true' : undefined"
            :title="`打开《${pl.name}》`"
            @keydown.enter="$emit('open', pl)"
            @keydown.space.prevent="$emit('open', pl)"
          >
            <h3 class="grid-card-name">{{ pl.name }}</h3>
            <p class="grid-card-meta">{{ pl.trackCount ? `${pl.trackCount} 首` : '歌单' }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 涉猎专辑货架（从最近播放歌曲的 al 派生，按专辑去重并聚合本地同键曲目） -->
    <section v-if="recentAlbums.length" class="home-section">
      <div class="home-section-head">
        <div class="home-section-title">
          <span class="home-section-sub">涉猎专辑</span>
        </div>
        <div v-if="shelfNav.al.canScroll" class="home-shelf-nav">
          <button
            type="button"
            class="pg-icobtn pg-icobtn--sm home-shelf-btn"
            title="上一页"
            aria-label="涉猎专辑上一页"
            :disabled="!shelfNav.al.canPrev"
            @click="scrollShelf('al', -1)"
          ><PixelIcon name="chev-l" :size="14" /></button>
          <button
            type="button"
            class="pg-icobtn pg-icobtn--sm home-shelf-btn"
            title="下一页"
            aria-label="涉猎专辑下一页"
            :disabled="!shelfNav.al.canNext"
            @click="scrollShelf('al', 1)"
          ><PixelIcon name="chev-r" :size="14" /></button>
        </div>
      </div>
      <div ref="alShelfEl" class="home-shelf" @scroll.passive="updateShelfNav('al')">
        <div
          v-for="al in recentAlbums"
          :key="al.key"
          class="grid-card"
          :class="{ 'grid-card--playing': isAlbumPlaying(al) }"
          :aria-current="isAlbumPlaying(al) ? 'true' : undefined"
          @click="playAlbum(al)"
        >
          <div class="grid-card-cover">
            <!-- alt 留空：封面与紧邻卡名同源 -->
            <img
              v-if="coverSizeUrl(al.picUrl, 320) && !coverErrs.has(`al:${al.key}`)"
              :src="httpsCover(coverSizeUrl(al.picUrl, 320))"
              alt=""
              loading="lazy"
              decoding="async"
              @error="coverErrs.add(`al:${al.key}`)"
            />
            <div v-else class="grid-card-cover-fallback"><PixelIcon name="note" :size="22" /></div>
            <span v-if="isAlbumPlaying(al)" class="grid-card-badge" aria-hidden="true"><PixelIcon name="vol" :size="11" /> 播放中</span>
          </div>
          <div
            class="grid-card-body grid-card-main"
            role="button"
            tabindex="0"
            :aria-current="isAlbumPlaying(al) ? 'true' : undefined"
            :title="`播放《${al.name}》来源曲 ${al.song.name}`"
            @keydown.enter="playAlbum(al)"
            @keydown.space.prevent="playAlbum(al)"
          >
            <h3 class="grid-card-name">{{ al.name }}</h3>
            <p class="grid-card-meta">{{ `${al.artist} · 含《${al.song.name}》` }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 页脚收版：版本戳 -->
    <footer class="home-foot">
      <PrintMarks variant="stamp" />
    </footer>
  </div>
</template>

<script>
import { ref, reactive, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { httpsCover } from '../lib/url'
import { readScrollMem, writeScrollMem, restoreScrollTop } from '../lib/scroll-mem'
import { songArtists, songCoverUrl, coverSizeUrl, songThumbUrl, songSourceTag, isSingleSongShellId } from '../lib/song'
import PrintMarks from './PrintMarks.vue'
import PixelIcon from './PixelIcon.vue'
import GlitchText from './GlitchText.vue'

// 最近播放网格展示上限：桌面 4 列×3 行=12；移动窄列行数随之浮动——
// 限的是展示数不是数据（play-song 队列种子仍传全量 recents）
const RECENT_DISPLAY_CAP = 12

// 合成专辑键：netease al.id 真值优先（'0'/0/空都是源站"无专辑"占位归一成
// null 不计）；QQ 曲的 al.id 只在 netease 匹配成功时非 null（buildQQSong），
// 未匹配时退 provider 权威 qq.albummid——'qq:' 域前缀防字符串 albummid 与
// 数值 netease id 撞键；bv_/yt_ 的 provider 块只存视频凭据无专辑 id
// （buildBilibiliSong/buildYouTubeSong 可查），此退路仅 QQ 侧有
const albumKeyOf = (song) => {
  const al = song?.al || song?.album
  const rawId = al?.id
  // 归一成 String：数值 42 与串 '42' 不分桶（去重/聚合键同型才撞得上）
  return (rawId != null && String(rawId) !== '0' ? String(rawId) : null)
    || (song?.qq?.albummid ? `qq:${song.qq.albummid}` : null)
}

export default {
  name: 'HomeFeed',
  components: { PrintMarks, PixelIcon, GlitchText },
  props: {
    recentPlaylists: {
      type: Array,
      default: () => []
    },
    // 歌单库活副本：recentPlaylists 快照富化 + 空历史回退源 + 专辑同键曲目池
    userPlaylists: {
      type: Array,
      default: () => []
    },
    recents: {
      type: Array,
      default: () => []
    },
    // 播放态高亮源：命中行/卡挂 --playing 修饰类 + aria-current
    currentSongId: {
      type: [String, Number],
      default: null
    },
    playingPlaylistId: {
      type: [String, Number],
      default: null
    },
    // 展开侧栏 && 宽视口时收起歌单货架（与侧栏信息重复）
    sidebarOpen: {
      type: Boolean,
      default: false
    }
  },
  emits: ['open', 'play-song', 'play-playlist', 'add-to-playlist'],
  computed: {
    /* 歌单货架数据源：有历史时用 userPlaylists 活副本同步字段——history 快照
       里的 name/trackCount/cover 会随改名/增删过期，活副本命中即以库为准
       （本地歌单 tracks 长度兜底 trackCount）。空历史回退库前 8 项（滤
       single_song_ 分享壳——是单曲壳不是歌单，上架会混进假卡） */
    displayPlaylists() {
      if (this.recentPlaylists.length) {
        return this.recentPlaylists.map((pl) => {
          // 双非空闸：任一侧 id 缺席即不比——'undefined'==='undefined' 会误配
          const live = this.userPlaylists.find(p =>
            p?.id != null && pl?.id != null && String(p.id) === String(pl.id))
          if (!live) return pl
          return {
            ...pl, ...live,
            coverImgUrl: live.coverImgUrl || live.picUrl || pl.coverImgUrl || '',
            trackCount: live.trackCount ?? live.tracks?.length ?? pl.trackCount
          }
        })
      }
      // 空历史回退支：local_pl_ 本地单无 trackCount 字段，tracks.length 兜底 meta
      return this.userPlaylists
        .filter(p => p && p.id != null && !isSingleSongShellId(p.id))
        .slice(0, 8)
        .map(p => ({ ...p, trackCount: p.trackCount ?? p.tracks?.length }))
    },
    showPlaylistShelf() {
      return !(this.sidebarOpen && this.wideViewport) && this.displayPlaylists.length > 0
    },
    // 单曲卡网格只渲前 RECENT_DISPLAY_CAP 条（截尾部保原序）；
    // 不影响 @click emit 的队列种子——那边仍给 this.recents 全量
    visibleRecents() {
      return this.recents.slice(0, RECENT_DISPLAY_CAP)
    },
    /* 涉猎专辑：按专辑键去重，保留最近次序，截 12 上货架。
       伪专辑准入两闸：① 专辑键非空（albumKeyOf 合成——netease 真值 id 或
       QQ albummid 域前缀键）；② 专辑名 ≠ 歌名（trim+lowercase 归一）——
       YouTube/B 站曲的 al.name 恒等歌名，网易云同名「单曲专辑」也一并
       滤掉。去重键与准入键同一合成值——name 不作键也不兜底：无 id 又无
       albummid 的行不入架，同名不同 id 的专辑也不坍缩。
       tracks 是同键本地曲目聚合（recents + 歌单库 tracks/addedTracks，按
       String(id) 去重）——点卡时 ≥2 首才给专辑队列，单曲回退 recents 连播 */
    recentAlbums() {
      const bucket = new Map()
      const put = (s) => {
        const key = albumKeyOf(s)
        if (key == null) return
        let arr = bucket.get(key)
        if (!arr) { arr = []; bucket.set(key, arr) }
        if (!arr.some(t => String(t?.id) === String(s?.id))) arr.push(s)
      }
      for (const s of this.recents) put(s)
      for (const pl of this.userPlaylists) {
        for (const list of [pl?.tracks, pl?.addedTracks]) {
          if (Array.isArray(list)) for (const s of list) put(s)
        }
      }
      const norm = (s) => String(s ?? '').trim().toLowerCase()
      const seen = new Set()
      const list = []
      for (const song of this.recents) {
        const al = song?.al || song?.album
        const key = albumKeyOf(song)
        if (!key || seen.has(key)) continue
        if (norm(al?.name) === norm(song?.name)) continue
        seen.add(key)
        // songCoverUrl 收口：file_ 上传曲封面走 file 端点，provider 曲走 al.picUrl
        list.push({ key, name: al?.name ?? '', picUrl: songCoverUrl(song) || '', artist: songArtists(song), song, tracks: bucket.get(key) || [song] })
      }
      return list.slice(0, 12)
    }
  },
  methods: {
    // 行尾副行：歌手 · 来源——行尾黑框 chip 摘除后来源并进副行文本
    songSubline(song) {
      const artist = songArtists(song)
      const src = songSourceTag(song)
      return src ? `${artist} · ${src}` : artist
    },
    // 随机漫游：Fisher-Yates 洗牌全量 recents 后从首曲起播——队列种子是乱序
    // 副本不是原数组（洗牌就地，不篡改 props 历史序）
    roamRecents() {
      if (!this.recents.length) return
      const pool = this.recents.slice()
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[pool[i], pool[j]] = [pool[j], pool[i]]
      }
      this.$emit('play-song', pool[0], pool)
    },
    // 专辑卡点击：同键本地曲目 ≥2 首才给专辑队列（伪专辑整专连播）；
    // 仅 1 首回退 recents——点专辑卡只播一首即停太突兀，保连播不断流
    playAlbum(al) {
      const queue = Array.isArray(al?.tracks) && al.tracks.length >= 2 ? al.tracks : this.recents
      this.$emit('play-song', al.song, queue)
    },
    isSongPlaying(song) {
      return this.currentSongId != null && song?.id != null && String(song.id) === String(this.currentSongId)
    },
    isPlaylistPlaying(pl) {
      return this.playingPlaylistId != null && pl?.id != null && String(pl.id) === String(this.playingPlaylistId)
    },
    isAlbumPlaying(al) {
      return this.currentSongId != null && Array.isArray(al?.tracks)
        && al.tracks.some(s => String(s?.id) === String(this.currentSongId))
    }
  },
  setup(props) {
    // 离场滚动记忆：换页即整卸——回首页还停在原货架位置（数据全本地，首帧即完整）
    const feedEl = ref(null)
    // 封面 @error 簿记：裂图位换回图标兜底（前缀键 s:/pl:/al: 防 id 撞名）
    const coverErrs = reactive(new Set())
    let cancelScrollRestore = null

    // 宽视口判定（≥901px）：歌单货架门控的唯一外源——展开侧栏态下货架与
    // 侧栏信息重复故收起；桌面常态 sidebarOpen=false 不挡货架常显
    const wideViewport = ref(false)
    const mq = typeof window !== 'undefined' ? window.matchMedia?.('(min-width: 901px)') : null
    wideViewport.value = !!mq?.matches
    const onMqChange = (e) => { wideViewport.value = !!e?.matches }
    // Safari <14 的 MediaQueryList 只有旧式 add/removeListener——双写兜底
    if (mq?.addEventListener) mq.addEventListener('change', onMqChange)
    else mq?.addListener?.(onMqChange)

    // 货架翻页状态机：canScroll 定 [‹][›] 显隐，canPrev/canNext 定 disabled——
    // scroll/resize/数据变更都要复测（scrollWidth/clientWidth 同源真值）
    const plShelfEl = ref(null)
    const alShelfEl = ref(null)
    const shelfNav = reactive({
      pl: { canScroll: false, canPrev: false, canNext: false },
      al: { canScroll: false, canPrev: false, canNext: false }
    })
    const updateShelfNav = (kind) => {
      const el = kind === 'pl' ? plShelfEl.value : alShelfEl.value
      const nav = shelfNav[kind]
      if (!el) { nav.canScroll = false; nav.canPrev = false; nav.canNext = false; return }
      const max = el.scrollWidth - el.clientWidth
      nav.canScroll = max > 1
      nav.canPrev = nav.canScroll && el.scrollLeft > 1
      nav.canNext = nav.canScroll && el.scrollLeft < max - 1
    }
    const updateAllShelfNav = () => { updateShelfNav('pl'); updateShelfNav('al') }
    const scrollShelf = (kind, dir) => {
      const el = kind === 'pl' ? plShelfEl.value : alShelfEl.value
      if (!el) return
      const delta = dir * (el.clientWidth || 320)
      if (typeof el.scrollBy === 'function') {
        el.scrollBy({ left: delta, behavior: 'smooth' })
      } else {
        el.scrollLeft += delta
      }
      updateShelfNav(kind)
    }

    onMounted(() => nextTick(() => {
      const m = readScrollMem('home')
      if (m) cancelScrollRestore = restoreScrollTop(feedEl.value, m.top)
      updateAllShelfNav() // 首帧货架量完再定翻页键显隐
    }))
    // 数据/门控变脸后货架尺寸可能变——nextTick 等 DOM patch 落地再复测。
    // 盯 id 签名串而非 length：playlistHistory 顶满替换/userPlaylists 同长
    // 换装时成员已变、长度未变，签名变更才抓得住（翻页键态不滞后）
    watch(
      () => [
        props.recentPlaylists.map(p => p?.id).join(','),
        props.userPlaylists.map(p => p?.id).join(','),
        props.recents.map(s => s?.id).join(','),
        props.sidebarOpen,
        wideViewport.value
      ],
      () => nextTick(updateAllShelfNav)
    )
    window.addEventListener('resize', updateAllShelfNav)
    onBeforeUnmount(() => {
      cancelScrollRestore?.() // 等待窗内卸载即停轮询
      writeScrollMem('home', { top: feedEl.value?.scrollTop ?? 0 })
      if (mq?.removeEventListener) mq.removeEventListener('change', onMqChange)
      else mq?.removeListener?.(onMqChange) // 与挂载期 addListener 兜底对称
      window.removeEventListener('resize', updateAllShelfNav)
    })
    return {
      httpsCover, songArtists, coverSizeUrl, songThumbUrl, feedEl, coverErrs,
      wideViewport, plShelfEl, alShelfEl, shelfNav, updateShelfNav, scrollShelf
    }
  }
}
</script>

<style scoped>
.home-feed {
  /* 滚动条车道顶部内缩：透明 border-top 把轨道抬离页缘 20px，
     与内容首行轴齐平；底部不缩——border 落在 scrollport 外会
     留出页底色死缝，底缘滚齐播放器发丝线。
     横向页缘走 --page-pad-x 全站档（≤640 收 12px） */
  padding: 0 var(--page-pad-x, 20px);
  border-top: 20px solid transparent;
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable;
  position: relative;
}

/* 页头：大字标题居左，「随机漫游」键贴右——flex-end 底对齐让键下缘与
   标题块下缘齐平。顶距 0——overview 微标签摘除后 .home-title 顶缘
   直接落在全站 20 首行轴（与侧栏 .panel-label 同轴，y≈77） */
.home-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding: 0 0 16px;
  position: relative;
}

.home-title {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--ink);
}

/* 区块：发丝线起头 + 节题行 */
.home-section {
  border-top: var(--hairline-soft);
  padding: 12px 0 18px;
}

.home-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.home-section-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

/* 节题：英文 pg-label 微标签摘除后中文副题升格为唯一节题——13px/600。
   （已出彩布白名单——scoped --ink 全壳生效，不再被 ink-86 托档） */
.home-section-sub {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

/* 货架翻页键组：贴节头右缘，self-center 对齐节头盒而非基线 */
.home-shelf-nav {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  align-self: center;
}

/* 最近播放单曲卡网格：auto-fill 自适应列数，230px 地板收两行信息 */
.home-songs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 8px;
}

/* 单曲行：div 外壳挂整卡 @click（内边距可点零死区），微框边界把歌名与
   行尾 + 键连成一个容器——大列宽下左右两端不再视觉断裂 */
.home-songrow {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 6px 8px;
  border: var(--hairline-soft);
  background: var(--paper);
  cursor: pointer;
  transition: background .12s, border-color .12s;
}
/* 行 hover 走浅墨+实发丝——song-result-row:hover 同档 */
.home-songrow:hover {
  background: var(--ink-06);
  border: var(--hairline);
}
/* 主激活区是原生 <button>：Enter/Space 天然可激活，点击冒泡给外壳统一定音 */
.home-songrow-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  cursor: pointer;
}
/* 正在播放：整行反白（墨色底+纸色文），+ 键随行走反白对比档 */
.home-songrow--playing,
.home-songrow--playing:hover {
  background: var(--ink);
  border: var(--hairline);
}
.home-songrow--playing .home-songrow-name { color: var(--paper); }
.home-songrow--playing .home-songrow-artist { color: var(--label-grey); }
.home-songrow--playing .home-songrow-cover { border-color: var(--paper); }
.home-songrow--playing .row-add-btn { color: var(--label-grey); }
.home-songrow--playing .row-add-btn:hover {
  color: var(--paper);
  outline-color: var(--paper);
}

/* 照片封面不 pixelated——高分辨率封面缩放时 pixelated 会出劣质锯齿 */
.home-songrow-cover {
  width: 38px;
  height: 38px;
  object-fit: cover;
  border: var(--hairline);
  flex-shrink: 0;
  display: block;
}
.home-songrow-fb {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
  background: var(--paper);
}

.home-songrow-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.home-songrow-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.home-songrow-artist {
  font-size: 11px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.home-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 64px 16px;
  border-top: var(--hairline-soft);
}

.home-state-text {
  font-size: 12px;
  color: var(--ink-64);
}

/* 横向货架：滚动条行（YTM carousel 语义）。左缘 padding 12 + margin -12
   把首卡外缘拉回 --page-pad-x 左轴同时给卡影留 12px 内收车道；右缘
   margin-right 负一页边距出血到容器右界（末卡不再半卡硬裁），padding-right
   补回页距让滚到的末卡与右缘仍隔一档 */
.home-shelf {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 160px;
  gap: 16px;
  overflow-x: auto;
  padding: 4px 12px 8px;
  margin-inline: -12px;
  margin-right: calc(-1 * var(--page-pad-x, 20px));
  padding-right: var(--page-pad-x, 20px);
}
/* ≥641 货架卡 160→180（YTM carousel ≤615=160/mid=180 阶梯） */
@media (min-width: 641px) { .home-shelf { grid-auto-columns: 180px; gap: 24px; } }

/* 卡片外壳已上收全局 style.css——这里只留「整卡可点」语义 */
.grid-card { cursor: pointer; }

/* 移动窄屏：12 行单列霸屏退成三行横滑轨——grid-auto-flow:column +
   3 行模板把 12 条折成 4 列滑卡，scroll-snap 列级停靠；右缘同款出血
   到容器边界（末列不再硬裁在页距内） */
@media (max-width: 640.98px) {
  .home-songs {
    grid-template-columns: none;
    grid-auto-flow: column;
    grid-template-rows: repeat(3, auto);
    grid-auto-columns: min(88vw, 320px);
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    margin-right: calc(-1 * var(--page-pad-x, 12px));
    padding-right: var(--page-pad-x, 12px);
  }
  .home-songrow {
    scroll-snap-align: start;
  }
}

/* 页脚收版（pg-stamp 自带 text-align:center，无需再排栅） */
.home-foot {
  border-top: var(--hairline-soft);
  margin-top: 8px;
  padding: 18px 0 12px;
}
</style>
