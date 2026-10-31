<template>
  <!-- 首页发现流（白纸画布）：「接着听」主角区 + 最近单曲网格 + 常听歌单
       （仅窄视口）/涉猎专辑横向货架。货架全部由本地播放历史/歌单库派生，
       零网络请求。页脚版本戳收版（print-grid 签名） -->
  <div ref="feedEl" class="home-feed">
    <!-- 接着听：hero = recents[0]——recordPlayHistory 把在播曲置顶，有曲在播时
         它就是当前曲。主键分三态：非当前曲 → 继续播放（play-song，与行点击同语义）；
         当前曲且在播 → 打开播放页（open-watch 不重播——play-song 会重置队列从头放）；
         当前曲但暂停 → 继续播放（resume-watch：进播放页并原地续播，不重置队列）。
         随机漫游作用于最近单曲，挂在这里作次键 -->
    <div v-if="hero" class="home-topgrid" :class="{ 'home-topgrid--open': recentsOpen }">
    <section v-if="hero" class="home-hero" aria-labelledby="home-hero-title">
      <!-- alt 留空：封面与紧邻歌名同源。560 档：主角位最大展示 280px
           （≥1600 视口），@2x 高分屏需 560 才不发虚 -->
      <img
        v-if="coverOk(`h:${hero.id}`, songThumbUrl(hero, 560))"
        :src="httpsCover(songThumbUrl(hero, 560))"
        alt=""
        class="home-hero-cover"
        decoding="async"
        @error="markCoverErr(`h:${hero.id}`, $event.target.getAttribute('src'))"
      />
      <span v-else class="home-hero-cover home-hero-fb" aria-hidden="true"><PixelIcon name="note" :size="28" /></span>
      <div class="home-hero-info">
        <h2 id="home-hero-title" class="home-hero-label">接着听</h2>
        <p class="home-hero-name" :title="hero.name">{{ hero.name }}</p>
        <p class="home-hero-sub">{{ songSubline(hero) }}</p>
        <div class="home-hero-actions">
          <button
            v-if="heroIsCurrent && isPlaying"
            type="button"
            class="ink-btn home-hero-primary"
            @click="$emit('open-watch')"
          ><PixelIcon name="expand" :size="14" /> 打开播放页</button>
          <button
            v-else-if="heroIsCurrent"
            type="button"
            class="ink-btn home-hero-primary"
            @click="$emit('resume-watch')"
          ><PixelIcon name="play" :size="14" /> 继续播放</button>
          <button
            v-else
            type="button"
            class="ink-btn home-hero-primary"
            @click="$emit('play-song', hero, recents)"
          ><PixelIcon name="play" :size="14" /> 继续播放</button>
          <button
            type="button"
            class="ink-btn ink-btn--ghost home-roam-btn"
            title="随机漫游最近单曲"
            @click="roamRecents"
          ><PixelIcon name="shuffle" :size="14" /> 随机漫游</button>
        </div>
      </div>
    </section>

    <!-- 最近单曲：行外壳 div 挂整卡 @click 消除内边距点击死区；主激活区
         .home-songrow-main 是原生 <button> 不重复绑 @click——键盘 Enter/Space
         触发的 click 事件冒泡到外壳，只发一次 play-song；行尾 + 键 @click.stop
         隔离冒泡（反嵌套律：button 不套 button） -->
    <section v-if="visibleRecents.length" class="home-section">
      <div class="home-section-head">
        <div class="home-section-title">
          <h2 class="home-section-sub">最近单曲</h2>
        </div>
      </div>
      <div id="home-songs" class="home-songs">
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
              v-if="coverOk(`s:${song.id}`, songThumbUrl(song, 96))"
              :src="httpsCover(songThumbUrl(song, 96))"
              alt=""
              class="home-songrow-cover"
              loading="lazy"
              decoding="async"
              @error="markCoverErr(`s:${song.id}`, $event.target.getAttribute('src'))"
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
      <!-- 「更多」展开剩余全部：双栏档 6 行默认、点击放全量（≤6 条无键）；
           显隐由 CSS 容器阈值接管（窄档 auto-fill 网格本就全量直排） -->
      <div v-if="visibleRecents.length > 6" class="home-more-wrap">
        <button
          type="button"
          class="ink-btn ink-btn--sm ink-btn--ghost home-more-btn"
          :aria-expanded="recentsOpen"
          aria-controls="home-songs"
          @click="recentsOpen = !recentsOpen"
        >{{ recentsOpen ? '收起' : '更多' }}</button>
      </div>
    </section>
    </div>

    <!-- 空态以实际可见内容为准：宽屏货架收起时库里有歌单也算空（专辑货架
         由 recents 派生，recents 空即无专辑，不另判） -->
    <div v-if="!recents.length && !showPlaylistShelf" class="home-state" role="status">
      <p class="home-state-text">还没有播放记录，去顶部搜索试试喵~</p>
    </div>

    <!-- 常听歌单货架：优先 recentPlaylists（活副本富化，已删除的不上架），无可用
         历史时回退 userPlaylists 前 8 项；≥768 侧栏在场（常驻或窄轨），货架与之完全重复故收起 -->
    <section v-if="showPlaylistShelf" class="home-section">
      <div class="home-section-head">
        <div class="home-section-title">
          <h2 class="home-section-sub">常听歌单</h2>
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
              v-if="coverOk(`pl:${pl.id}`, coverSizeUrl(pl.coverImgUrl, 320))"
              :src="httpsCover(coverSizeUrl(pl.coverImgUrl, 320))"
              alt=""
              loading="lazy"
              decoding="async"
              @error="markCoverErr(`pl:${pl.id}`, $event.target.getAttribute('src'))"
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
          <!-- body 不再扮 role=button：children presentational 会抹平 h3 标题
               语义。键盘「打开」激活点收进卡名真按钮 .grid-card-name-btn
               （原生 Enter/Space→click 无需 keydown 绑），.stop 防冒泡到
               外壳 @click 双 emit；aria-current 卡壳+激活点双挂
               （PlaylistPanel .pl-row-main/.pl-name-btn 同例） -->
          <div
            class="grid-card-body grid-card-main"
            :aria-current="isPlaylistPlaying(pl) ? 'true' : undefined"
          >
            <h3 class="grid-card-name"><button
              type="button"
              class="grid-card-name-btn"
              :aria-current="isPlaylistPlaying(pl) ? 'true' : undefined"
              :title="`打开《${pl.name}》`"
              @click.stop="$emit('open', pl)"
            >{{ pl.name }}</button></h3>
            <p class="grid-card-meta">{{ pl.trackCount ? `${pl.trackCount} 首` : '歌单' }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 涉猎专辑货架（从最近播放歌曲的 al 派生，按专辑去重并聚合本地同键曲目） -->
    <section v-if="recentAlbums.length" class="home-section">
      <div class="home-section-head">
        <div class="home-section-title">
          <h2 class="home-section-sub">涉猎专辑</h2>
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
              v-if="coverOk(`al:${al.key}`, coverSizeUrl(al.picUrl, 320))"
              :src="httpsCover(coverSizeUrl(al.picUrl, 320))"
              alt=""
              loading="lazy"
              decoding="async"
              @error="markCoverErr(`al:${al.key}`, $event.target.getAttribute('src'))"
            />
            <div v-else class="grid-card-cover-fallback"><PixelIcon name="note" :size="22" /></div>
            <span v-if="isAlbumPlaying(al)" class="grid-card-badge" aria-hidden="true"><PixelIcon name="vol" :size="11" /> 播放中</span>
            <!-- 播放键与歌单卡同例挂 cover 层而非 .grid-card-main 内：外壳无
                 role=button，根除 [role=button] > button 的 ARIA 嵌套违规 -->
            <button
              type="button"
              class="grid-card-play"
              title="播放专辑"
              :aria-label="`播放专辑 ${al.name}`"
              @click.stop="playAlbum(al)"
            ><PixelIcon name="play" :size="14" /></button>
          </div>
          <div
            class="grid-card-body grid-card-main"
            :aria-current="isAlbumPlaying(al) ? 'true' : undefined"
          >
            <h3 class="grid-card-name"><button
              type="button"
              class="grid-card-name-btn"
              :aria-current="isAlbumPlaying(al) ? 'true' : undefined"
              :title="`播放《${al.name}》来源曲 ${al.song.name}`"
              @click.stop="playAlbum(al)"
            >{{ al.name }}</button></h3>
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
  components: { PrintMarks, PixelIcon },
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
    // 播放器在播态：hero 是当前曲时据此分「打开播放页」/「继续播放(resume)」
    isPlaying: {
      type: Boolean,
      default: false
    }
  },
  emits: ['open', 'play-song', 'play-playlist', 'add-to-playlist', 'open-watch', 'resume-watch'],
  computed: {
    // 「接着听」主角：历史首曲（在播曲由 recordPlayHistory 置顶）；空历史不渲染
    hero() {
      return this.recents[0] || null
    },
    heroIsCurrent() {
      return !!this.hero && this.isSongPlaying(this.hero)
    },
    /* 歌单货架数据源：有历史时用 userPlaylists 活副本同步字段——history 快照
       里的 name/trackCount/cover 会随改名/增删过期，活副本命中即以库为准
       （本地歌单 tracks 长度兜底 trackCount）。历史里已删除的歌单（库中查
       不到活副本）不上架——点进去会失败；历史全失效时同空历史回退库前 8 项
       （滤 single_song_ 分享壳——是单曲壳不是歌单，上架会混进假卡） */
    displayPlaylists() {
      const fromHistory = this.recentPlaylists.flatMap((pl) => {
        // 双非空闸：任一侧 id 缺席即不比——'undefined'==='undefined' 会误配
        const live = this.userPlaylists.find(p =>
          p?.id != null && pl?.id != null && String(p.id) === String(pl.id))
        if (!live) return []
        return [{
          ...pl, ...live,
          coverImgUrl: live.coverImgUrl || live.picUrl || pl.coverImgUrl || '',
          trackCount: live.trackCount ?? live.tracks?.length ?? pl.trackCount
        }]
      })
      if (fromHistory.length) return fromHistory
      // 回退支：local_pl_ 本地单无 trackCount 字段，tracks.length 兜底 meta
      return this.userPlaylists
        .filter(p => p && p.id != null && !isSingleSongShellId(p.id))
        .slice(0, 8)
        .map(p => ({ ...p, trackCount: p.trackCount ?? p.tracks?.length }))
    },
    // ≥768 侧栏在场（dock 常驻 / rail 窄轨；与 sidebarOpen 无关——那是移动抽屉态），货架与之完全重复
    showPlaylistShelf() {
      return !this.wideViewport && this.displayPlaylists.length > 0
    },
    // 单曲卡网格渲 hero 之后的全部剩余条（recents[0] 已在主角区，网格不重复）
    // ——无展示帽：历史池上限 20 由上游 useHomeFeed 管，slice(1) ≤19 行；默认
    // 6 行显隐归 CSS nth-child(n+7)（display:none 内 lazy 图不加载，无成本），
    // 「更多」翻的是显隐不是数据——按钮语义与全量渲染一致
    visibleRecents() {
      return this.recents.slice(1)
    },
    /* 涉猎专辑：按专辑键去重，保留最近次序，截 12 上货架。桶只扫 recents——
       同键曲目聚合移到点击时懒算（playAlbum），渲染路径零歌单库扫描。
       伪专辑准入两闸：① 专辑键非空（albumKeyOf 合成——netease 真值 id 或
       QQ albummid 域前缀键）；② 专辑名 ≠ 歌名（trim+lowercase 归一）——
       YouTube/B 站曲的 al.name 恒等歌名，网易云同名「单曲专辑」也一并
       滤掉。去重键与准入键同一合成值——name 不作键也不兜底：无 id 又无
       albummid 的行不入架，同名不同 id 的专辑也不坍缩 */
    recentAlbums() {
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
        list.push({ key, name: al?.name ?? '', picUrl: songCoverUrl(song) || '', artist: songArtists(song), song })
      }
      return list.slice(0, 12)
    },
    /* 在播曲所属专辑键：命中的曲对象先在 recents 找，找不到再扫歌单库
       tracks/addedTracks（首个命中即停——在播曲可能不在历史池，如歌单内
       直接点播）。取 albumKeyOf 同口径合成键；无专辑信息归 null */
    playingAlbumKey() {
      if (this.currentSongId == null) return null
      const hit = (s) => s?.id != null && String(s.id) === String(this.currentSongId)
      let song = this.recents.find(hit) || null
      for (const pl of this.userPlaylists) {
        if (song) break
        for (const list of [pl?.tracks, pl?.addedTracks]) {
          if (!Array.isArray(list)) continue
          song = list.find(hit) || null
          if (song) break
        }
      }
      return song ? albumKeyOf(song) : null
    }
  },
  methods: {
    // 封面可渲判定：有 URL 且未记过裂——簿记指纹与渲染 :src 同域
    // （httpsCover(url) 实值），封面源修复/换图后新 URL ≠ 簿记值即放行复图
    coverOk(key, url) {
      return !!url && this.coverErrs.get(key) !== httpsCover(url)
    },
    // 参入记事件目标真实 src 而非重算 URL——prop 换图渲染间隙里旧图 error
    // 派发，此刻重算拿到的是新 URL，会把从未失败的源误簿
    markCoverErr(key, url) {
      this.coverErrs.set(key, url)
    },
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
    /* 专辑卡点击：同键曲目此时懒聚合（渲染路径零库扫描）——recents 先扫、
       库曲（userPlaylists tracks/addedTracks）后补，String(id) 去重保序；
       ≥2 首给专辑队列（伪专辑整专连播），仅 1 首回退 recents——点专辑卡
       只播一首即停太突兀，保连播不断流 */
    playAlbum(al) {
      const seen = new Set()
      const queue = []
      const put = (s) => {
        if (albumKeyOf(s) !== al?.key) return
        // id 缺席曲不入队：String(undefined) 归一会让多首无 id 同键曲坍缩成一首
        if (s?.id == null) return
        const id = String(s.id)
        if (seen.has(id)) return
        seen.add(id)
        queue.push(s)
      }
      for (const s of this.recents) put(s)
      for (const pl of this.userPlaylists) {
        for (const list of [pl?.tracks, pl?.addedTracks]) {
          if (Array.isArray(list)) for (const s of list) put(s)
        }
      }
      this.$emit('play-song', al.song, queue.length >= 2 ? queue : this.recents)
    },
    isSongPlaying(song) {
      return this.currentSongId != null && song?.id != null && String(song.id) === String(this.currentSongId)
    },
    isPlaylistPlaying(pl) {
      return this.playingPlaylistId != null && pl?.id != null && String(pl.id) === String(this.playingPlaylistId)
    },
    // 「在播曲所属专辑」命中即亮——语义不是「同键成员在播」：当前曲经
    // playingAlbumKey 反查专辑键（在播曲不在 recents 时扫歌单库兜底）
    isAlbumPlaying(al) {
      return this.playingAlbumKey != null && al?.key === this.playingAlbumKey
    }
  },
  setup(props) {
    // 离场滚动记忆：换页即整卸——回首页还停在原货架位置（数据全本地，首帧即完整）
    const feedEl = ref(null)
    /* 封面 @error 簿记：裂图位换回图标兜底（前缀键 h:/s:/pl:/al: 防 id 撞名）。
       Map 记「出错时的 img src 实值」作指纹——coverOk 判当前 URL ≠ 簿记值
       即放行：封面源修复/换图（URL 变脸）自动复图，旧簿记不永挡 */
    const coverErrs = reactive(new Map())
    // 「更多」展开态：双栏档最近单曲默认 6 行，点击放剩余全部；
    // 只翻类不改数据——visibleRecents 恒 slice(1) 全量，行数显隐归 CSS 容器阈值管。
    // 展开态随滚动记忆落会话——离场再回保持展开，不塌回 6 行
    const recentsOpen = ref(false)
    // 记忆 setup 期即读：展开态还原必须在首渲前——晚一拍（onMounted 的
    // nextTick 段）会把用户首帧内的「更多」点击覆盖回收起。scrollTop
    // 还位仍走 onMounted+nextTick（要等 DOM 灌入量高）
    const memEntry = readScrollMem('home')
    if (memEntry) recentsOpen.value = !!memEntry.recentsOpen
    let cancelScrollRestore = null

    // 侧栏在场判定（≥768px）：歌单货架门控的唯一外源——dock/rail 歌单库
    // 都可见，货架与其信息完全重复故收起；<768 侧栏是抽屉，货架保留
    const wideViewport = ref(false)
    const mq = typeof window !== 'undefined' ? window.matchMedia?.('(min-width: 768px)') : null
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
      if (memEntry) cancelScrollRestore = restoreScrollTop(feedEl.value, memEntry.top)
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
        wideViewport.value
      ],
      () => nextTick(updateAllShelfNav)
    )
    window.addEventListener('resize', updateAllShelfNav)
    onBeforeUnmount(() => {
      cancelScrollRestore?.() // 等待窗内卸载即停轮询
      writeScrollMem('home', { top: feedEl.value?.scrollTop ?? 0, recentsOpen: recentsOpen.value })
      if (mq?.removeEventListener) mq.removeEventListener('change', onMqChange)
      else mq?.removeListener?.(onMqChange) // 与挂载期 addListener 兜底对称
      window.removeEventListener('resize', updateAllShelfNav)
    })
    return {
      httpsCover, songArtists, coverSizeUrl, songThumbUrl, feedEl, coverErrs,
      wideViewport, plShelfEl, alShelfEl, shelfNav, updateShelfNav, scrollShelf,
      recentsOpen
    }
  }
}
</script>

<style scoped>
.home-feed {
  /* 滚动条车道顶部内缩：透明 border-top 把轨道抬离页缘 20px，
     与内容首行轴齐平；底部不缩——border 落在 scrollport 外会
     留出页底色死缝，底缘滚齐播放器发丝线。
     横向页缘走 --feed-max 内容帽公式（主区宽 >帽+页缘时两侧等槽居中——cqw 解析到 .app-main 容器）。
     公式单源进 --feed-bleed：.home-shelf 右出血负边距与回补页距引用同一变量，不再双写 */
  --feed-bleed: max(var(--page-pad-x, 20px), calc((100cqw - var(--feed-max, 1280px)) / 2));
  padding: 0 var(--feed-bleed);
  border-top: 20px solid transparent;
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable;
  position: relative;
}

/* 「接着听」主角区：左封面 + 右信息列。顶距 0——封面顶缘直接落在全站
   20 首行轴（与侧栏 .panel-label 同轴）。与下方区块隔区块距 --rhythm-section(48)，
   不用发丝线——层级靠留白与体量分，不靠框 */
.home-hero {
  display: flex;
  align-items: center;
  gap: 20px;
  padding-bottom: var(--rhythm-section, 48px);
  min-width: 0;
}
.home-hero-cover {
  width: 120px;
  height: 120px;
  object-fit: cover;
  flex-shrink: 0;
  display: block;
  border: var(--hairline);
  background: var(--ink-06); /* 加载中呈浅墨底而非白框（不像坏图） */
}
.home-hero-fb {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-64);
}
.home-hero-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
/* 区块名（这个区的 h2），与下方节题同族但降一档灰——让位给歌名 */
.home-hero-label {
  font-size: var(--fs-row, 13px);
  font-weight: 600;
  line-height: 1.3;
  color: var(--ink-64);
}
.home-hero-name {
  margin-top: 4px;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  line-height: 1.25;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.home-hero-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--ink-64);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.home-hero-actions {
  margin-top: var(--rhythm-intra, 8px);
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* 桌面（≥901）主角区升一档体量：封面 144、歌名 26、间距 24；信息列限宽
   480 让长歌名在宽屏也按合理行长省略（单行 nowrap+ellipsis 不变）。
   ≤900 两档保持原值 */
@media (min-width: 901px) {
  .home-hero { gap: 24px; }
  .home-hero-cover { width: 144px; height: 144px; }
  .home-hero-info { max-width: 480px; }
  .home-hero-name { font-size: 26px; }
}
/* glitch-restoration 主题封面圆角：与 style.css 主题名单同档——大封面随
   货架封面 6px，行缩略图随列表缩略 4px。不用 :global()——Vue scoped 下
   `:global(A) B` 会整条折成全局 `A`（丢掉 B，误伤 :root）；直写即可：
   scoped 属性只挂末段复合选择器，编译为
   :root[data-theme=…] .home-hero-cover[data-v-xxx] */
:root[data-theme="glitch-restoration"] .home-hero-cover { border-radius: 6px; }
:root[data-theme="glitch-restoration"] .home-songrow-cover { border-radius: 4px; }
@media (max-width: 640.98px) {
  .home-hero { gap: 14px; padding-bottom: 32px; }
  .home-hero-cover { width: 88px; height: 88px; }
  .home-hero-name { font-size: 18px; }
  .home-hero-actions { margin-top: 10px; }
}

/* 「接着听｜最近单曲」双栏：阈值走容器轴（.app-main container-type:inline-size，
   style.css 登记）——主区 <960 保持现状堆叠（平板 auto-fill、≤640.98 三行横滑
   不动）。hero 上方 32 = .home-feed 20 车道 + 本列 12 顶槽；区块间 48 由
   .home-topgrid 承底（内层两节底距归零防叠双）。右栏一列默认 6 行、
   「更多」放开剩余全部（visibleRecents 无帽——历史池上限 20 由上游管） */
.home-topgrid {
  display: block;
  padding-top: calc(var(--rhythm-hero-top, 32px) - 20px);
  padding-bottom: var(--rhythm-section, 48px);
}
/* 包内末节底距归零交还给本层承底——否则堆叠态 hero 底距与 recents
   节底距各自 48 与包裹层 48 叠双（两栏态内层两节已由容器规则归零） */
.home-topgrid > :last-child { padding-bottom: 0; }
/* 「更多」键只服务于双栏档——窄档 auto-fill/三行轨全量直排，键藏。
   基规则须排在 @container 块【之前】：同特异度 (0,1,0) 后序者胜，
   容器命中时块内 display:flex 压过基规则 */
.home-more-wrap { display: none; }
@container (min-width: 960px) {
  .home-topgrid {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
    column-gap: 32px;
    align-items: start;
  }
  /* 底缘对齐 hero 侧：撑满行高（右栏 6 行+节头为行高锚）+ 封面顶吸
     （align-items:flex-start 防基线 center 把封面沉进撑高列）+ 信息列
     撑满，按钮 margin-top:auto 钉底——按钮底缘=栏底缘（右栏栏底即
     more-wrap 行底、末行下 ~40px），余量落在元信息与按钮之间；
     「更多」放开右栏反超时同理钉底。
     保持「左封面+右信息列」横排——列向分布走 .home-hero-info 内列，
     不把 hero 本体改 column（会竖排封面违背主角区编排） */
  .home-topgrid .home-hero {
    padding-bottom: 0;
    align-self: stretch;
    align-items: flex-start;
  }
  .home-topgrid .home-hero-info { align-self: stretch; }
  /* 按钮钉底——按钮底缘=右栏栏底（more-wrap 行底、末行下 ~40px） */
  .home-topgrid .home-hero-actions { margin-top: auto; }
  /* 右栏整列吸满行高（align-items:start 只给内容高，stretch 补回栏高）——
     栏内 flex 列把余量交给行表：行距吸余量→末行底缘随栏底对齐 hero 底缘；
     「更多」放开右栏反超 hero 时余量为零，自然退化顶排不压行高 */
  .home-topgrid .home-section {
    padding-bottom: 0;
    align-self: stretch;
    display: flex;
    flex-direction: column;
  }
  /* 仅 1 条历史（hero 有、recents 空）时 hero 占满整行——单栏 5fr
     会把孤 hero 挤成 ~41% 宽 */
  .home-topgrid > .home-hero:only-child { grid-column: 1 / -1; }
  /* 孤 hero 占满行时信息列松绑 480→720：右半不再大片留白，行长仍有上限 */
  .home-topgrid > .home-hero:only-child .home-hero-info { max-width: 720px; }
  .home-topgrid .home-songs {
    grid-template-columns: 1fr;
    /* space-between 摊栏内余高进行隙（行高不动仍 50px——分行距不拉行）；
       基规则 gap 的 4px 行距作地板保留 */
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .home-topgrid:not(.home-topgrid--open) .home-songrow:nth-child(n+7) { display: none; }
  .home-hero-cover { width: 240px; height: 240px; }
  .home-hero-name { font-size: var(--fs-hero, 28px); }
  .home-more-wrap { display: flex; padding-top: var(--rhythm-intra, 8px); }
}
/* ≥1600 视口 hero 封面再升档 240→280（冻结档：视口轴非容器轴；
   ≥1600 主区恒 ≥960 阈值，无需叠加容器条件） */
@media (min-width: 1600px) {
  .home-hero-cover { width: 280px; height: 280px; }
}

/* 区块：间距分组（无发丝线）——区块间 --rhythm-section(48)，节题→内容 --rhythm-head(12) */
.home-section {
  padding-bottom: var(--rhythm-section, 48px);
}

.home-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--rhythm-intra, 8px);
  margin-bottom: var(--rhythm-head, 12px);
}
.home-section-title {
  display: flex;
  align-items: baseline;
  gap: var(--rhythm-intra, 8px);
  min-width: 0;
}

/* 节题：英文 pg-label 微标签摘除后中文副题升格为唯一节题——15px/600
   （发丝线摘除后区块边界全靠节题体量撑）。
   （已出彩布白名单——scoped --ink 全壳生效，不再被 ink-86 托档） */
.home-section-sub {
  margin: 0; /* 节题是 h2——默认 margin 会破节头 baseline 排布，归零 */
  font-size: var(--fs-section, 16px);
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

/* 最近播放单曲卡网格：auto-fill 自适应列数，230px 地板收两行信息。
   行无框后列间 16 撑开列界，行间 4 + 行内 padding 撑点击面 */
.home-songs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 4px 16px;
}

/* 单曲行：div 外壳挂整卡 @click（内边距可点零死区）。常态无框无底——
   一格一框是噪声；hover 浅墨底把歌名与行尾 + 键连成一个容器。
   点击面 6+38+6=50px ≥ 44 触屏下限，padding 不能再缩 */
.home-songrow {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 6px 8px;
  cursor: pointer;
  transition: background .12s;
}
.home-songrow:hover {
  background: var(--ink-06);
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
/* 正在播放：整行反白（墨色底+纸色文），+ 键随行走反白对比档。
   color 置纸色：全局焦点环 outline: 2px solid currentColor 在墨底上才可见
   （与 style.css 既有反白行同构） */
.home-songrow--playing,
.home-songrow--playing:hover {
  background: var(--ink);
  color: var(--paper);
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
  background: var(--ink-06); /* 懒加载中呈浅墨底而非白框 */
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
  font-size: var(--fs-row, 13px);
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.home-songrow-artist {
  font-size: var(--fs-meta, 11px);
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
}

.home-state-text {
  font-size: 12px;
  color: var(--ink-64);
}

/* 横向货架：滚动条行（YTM carousel 语义）。左缘 padding 12 + margin -12
   把首卡外缘拉回 --page-pad-x 左轴同时给卡影留 12px 内收车道；右缘
   margin-right 负一页边距出血到容器右界（末卡不再半卡硬裁），padding-right
   补回页距让滚到的末卡与右缘仍隔一档。两式与页缘公式同源——
   --feed-bleed 单源（.home-feed 声明），不再双写 */
.home-shelf {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 160px;
  gap: 16px;
  overflow-x: auto;
  padding: 4px 12px 8px;
  margin-inline: -12px;
  margin-right: calc(-1 * var(--feed-bleed));
  padding-right: var(--feed-bleed);
}
/* ≥641 货架卡 160→200（新节奏档：卡体升一档撑全宽首屏） */
@media (min-width: 641px) { .home-shelf { grid-auto-columns: 200px; gap: 24px; } }

/* 卡片外壳已上收全局 style.css——这里只留「整卡可点」语义 */
.grid-card { cursor: pointer; }

/* 首页货架卡去外框：卡外框 + 封面框是双层框噪声，首页只留封面框
   （PlaylistGrid 同类卡不动）。.home-feed 前缀把特异性抬到 (0,4,0)，
   压过 glitch-restoration 的 :root[data-theme] .grid-card（0,3,0）圆角柔影，
   不靠样式表加载顺序 */
.home-feed .home-shelf .grid-card {
  border: 0;
  padding: 0;
  background: transparent;
  box-shadow: none;
  border-radius: 0;
}
/* 封面加载占位：懒加载中呈浅墨底而非白框 */
.home-feed .home-shelf .grid-card-cover { background: var(--ink-06); }
/* 播放中卡：原卡外框 inset 描边随外框摘除——改由封面外加一圈 accent 环
   （外扩 box-shadow 不被封面自身 overflow:hidden 裁；货架上 4px 内边距容得下），
   左上「播放中」戳保留 */
.home-feed .home-shelf .grid-card--playing {
  border: 0;
  box-shadow: none;
}
.home-feed .home-shelf .grid-card--playing .grid-card-cover {
  border-color: var(--accent-magenta-ink, var(--ink));
  box-shadow: 0 0 0 1.2px var(--accent-magenta-ink, var(--ink));
}

/* 触屏（无 hover / 粗指针）：横滑本身就是翻页手势，‹ › 键无用 */
@media (hover: none), (pointer: coarse) {
  .home-shelf-nav { display: none; }
}

/* 移动窄屏：长单列霸屏退成三行横滑轨——grid-auto-flow:column +
   3 行模板把行表折成多列滑卡，scroll-snap 列级停靠；右缘同款出血
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

/* 页脚收版（pg-stamp 自带 text-align:center，无需再排栅）——与区块同走
   间距分组，不再起发丝线 */
.home-foot {
  padding: 8px 0 12px;
}
</style>
