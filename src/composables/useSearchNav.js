import { ref, computed, onBeforeUnmount } from 'vue'
import { musicApi } from '../api/music.js'
import { apiErrorMessage } from '../api/http.js'
import { toast, toastDismiss } from '../lib/feedback.js'
import { writeNavParams, readNavParams, resolveNavView } from '../lib/navUrl.js'
import { buildQQSong, buildYouTubeSong, upsertProviderShell } from '../lib/external-songs.js'
import { providerPlaylistShellId } from '../lib/url.js'

// 导航+搜索域：URL 可寻址视图（YTM 式 history 栈）、顶栏双区搜索（歌单+单曲）、
// 单曲深挖翻页、id 预览、watch 页进出。
//
// deps（App 注入的跨域共享）：
//   gates.search / gates.preview — 搜索与预览竞态闸
//   searchQuery / currentSong / watchTab / isFullscreenPlayerOpen — App 持有的
//     共享输入与播放器态（沉浸层开时 popstate 先收层不换页）
//   userPlaylists / selectedPlaylist / loadingSongs / selectPlaylist /
//     savePlaylistsToStorage — 库域（落盘收口唯一实现：指纹簿记/队列剪枝/
//     瘦身投影都在它内部，本域不再自备投影——两份持久化实现会漂簿记）
//   playSong / playSongFromSearch / playSongFromRelated / playPlaylist —
//     播放器域（usePlayer 先实例化；惰性转发是双向循环依赖下的惯例写法）
export function useSearchNav({
  gates,
  searchQuery, currentSong, watchTab, isFullscreenPlayerOpen,
  userPlaylists, selectedPlaylist, loadingSongs, selectPlaylist,
  savePlaylistsToStorage,
  playSong, playSongFromSearch, playSongFromRelated, playPlaylist,
}) {
  const centerView = ref('home') // 'home' | 'songs' | 'search' | 'watch' | 'downloads' | 'settings'
  const sidebarOpen = ref(false) // 移动端歌单库抽屉
  const searching = ref(false)   // 仅驱动搜索结果网格的加载态（勿与歌单库 loading 混用）
  const searchResults = ref([])     // 歌单搜索结果
  const searchSongResults = ref([]) // 单曲搜索结果（与歌单结果同区展示）
  // 单曲搜索深挖态：query/total 驱动 PlaylistGrid 的「加载更多」键；
  // total=null 表示本批结果不可深挖（上游不吐 total 时灭灯）
  const searchSongQuery = ref('')
  const searchSongTotal = ref(null)
  const searchSongLoadingMore = ref(false)
  // QQ 深挖页游标：>0 表示当前单曲结果集来自 QQ 源且已拉到第 N 页——
  // QQ 上游吃页码 p 不吃 offset，深挖发 p=N+1；0=网易云口径（深挖按
  // 现有结果数当 offset）。两个搜索 handler 都复位它，不能做成算出来的
  let qqSongPage = 0
  // YT 深挖游标：YouTube 搜索无总数（searchSongTotal 恒 null）——深挖走
  // continuation 不透明 token；非 null 表示当前单曲结果集来自 YT 且还有
  // 下一页，null=深挖通道关闭（见底/非 YT 源）。各搜索 handler 复位它
  const ytContinuation = ref(null)

  // 深挖键亮灯总闸（PlaylistGrid 直读）：total 源（网易云/QQ）= 已载数未
  // 到 total；YT 无总数——continuation 游标非 null 即还有下一页。与
  // loadMoreSearchSongs 的三口径同一张真值表，灭键语义（零进展收 total/
  // 游标）经它自然传导，不改 NetEase/QQ 旧行为
  const searchSongHasMore = computed(() =>
    ytContinuation.value != null
    || (searchSongTotal.value != null && searchSongResults.value.length < searchSongTotal.value))

  // ── URL 导航（YTM 式：视图/歌单可寻址，浏览器前进后退生效） ──
  // 寻址规则本体在 lib/navUrl.js（writeNavParams/readNavParams/resolveNavView
  // 纯函数可测）；这里只剩 window.history/location 的薄壳与歌单回选副作用
  let suppressNavPush = false // popstate 回放时不再重复入栈

  // 首帧视图种子：onMounted 的恢复链是 await 串行（歌单详情/续播动辄秒级），
  // 等 applyUrlNav 落定会先渲一帧首页再跳回刷新前视图——此处按 ?view= 预置，
  // 合法性（pl 存在/歌曲恢复成功）仍由 applyUrlNav 终局修正；
  // search 冷加载必无结果必弹回首页，不预置
  const urlParams = new URLSearchParams(window.location.search)
  const initialView = urlParams.get('view')
  if (['songs', 'watch', 'downloads', 'settings'].includes(initialView)) centerView.value = initialView

  // downloads 深链预选意图（?view=downloads&pl=<侧栏歌单id>）：
  // 必须此刻快照捕获——normalizeNavEntry 挂载期就会重建 URL，
  // 等 DownloadsPanel 挂载再读 location 早已没有 pl。
  // 此后只被「查看进度」导航与 popstate 回放更新，面板消费后自行一次性预选
  const downloadsPl = ref(initialView === 'downloads' ? urlParams.get('pl') : null)
  // 意图序号：同一歌单再次点「查看进度」时值不变、prop watcher 不 fire——
  // 序号单调递增把同值重发穿透给面板（popstate 回放不 bump，靠 pl 变化区分）
  const downloadsPlSeq = ref(0)

  // 导航 URL 构造：push 与初始化 normalize 共用，保证 pl 语义一致。
  // playlist 显式传入——调用处先 push 再 selectPlaylist，读 selectedPlaylist
  // 会记成"上一个"歌单（off-by-one 历史错位）
  const buildNavUrl = (playlist = selectedPlaylist.value) => {
    const url = new URL(window.location.href)
    writeNavParams(url.searchParams, {
      view: centerView.value,
      songsPl: playlist?.id,
      downloadsPl: downloadsPl.value
    })
    return url
  }

  const pushNavState = (playlist) => {
    if (suppressNavPush) return
    const url = buildNavUrl(playlist)
    // 同视图重复操作（重搜/重点同一歌单）不堆历史，否则 Back 显得失灵
    if (url.toString() === window.location.href) return
    // 打标记供 watchBack 判断：冷启动直达页（无站内历史）按「返回」应回首页而非退站；
    // dplSeq 随条目冻结——回放旧条目时不重发已被新意图取代的预选
    window.history.pushState({ meowsyncNav: 1, dplSeq: downloadsPlSeq.value }, '', url.toString())
  }

  // popstate → 按 URL 还原视图；view=songs&pl= 时回选对应歌单
  const applyUrlNav = () => {
    const params = new URLSearchParams(window.location.search)
    const { view, pl } = readNavParams(params)
    if (view === 'songs') {
      const target = pl
        ? userPlaylists.value.find(p => String(p.id) === String(pl))
        : null
      // pl 无效/歌单已被删：有选中歌单则仅切视图，否则退回首页。
      // 库外数字 pl = 预览单地址栏态——回落预览路径让 ?pl= 可刷新/可回退
      //（分享链 ?playlist=X&view=songs&pl=X 的接收端若删过默认单也能预览兜底）
      if (target) selectPlaylist(target)
      else if (pl && /^\d+$/.test(pl)) { previewPlaylistById(pl); return }
      else if (!selectedPlaylist.value) { centerView.value = 'home'; return }
    }
    // popstate 回放深链：pl 与 seq 一起回放——消费键 pl::seq 随条目冻结，
    // 回到已结算过的条目是幂等 no-op，不会强抢用户在其后手选的队列
    if (view === 'downloads') {
      downloadsPl.value = pl
      // state=null 的只有归一化首条目，其 pl 意图在冷启动 seq 0 时已结算
      downloadsPlSeq.value = window.history.state?.dplSeq ?? 0
    }
    // 兜底阶梯（lib 纯函数）：search 无结果落 home、watch 无曲落 songs/home
    centerView.value = resolveNavView({
      view,
      hasSelectedPlaylist: selectedPlaylist.value != null,
      hasSong: currentSong.value != null,
      hasSearchResults: searchResults.value.length > 0
        || searchSongResults.value.length > 0,
      searching: searching.value
    })
  }

  // 规范化当前历史条目：回退到首个条目时不会退出应用。
  // 与 pushNavState 共用 buildNavUrl——pl 也要同步（applyUrlNav 兜底
  // 后 URL 里可能留着失效 pl，或 view=songs 缺 pl）
  const normalizeNavEntry = () => {
    suppressNavPush = true
    try {
      window.history.replaceState(null, '', buildNavUrl().toString())
    } finally { suppressNavPush = false }
  }

  // history.back() 的 popstate 是异步派发的——派发落地前再调 back() 会
  // 连弹两级。发起即上闩，popstate 落地解锁；兜底超时防极端情况下闩死
  let navBackPending = false
  const navBack = () => {
    if (navBackPending) return
    navBackPending = true
    setTimeout(() => { navBackPending = false }, 500)
    window.history.back()
  }

  // 浏览器前进/后退：按 URL 回放视图（不重入栈）
  const onPopState = () => {
    navBackPending = false
    // 沉浸层还开着时的 Back 先收层不换页（YTM 全屏歌词同款）——否则层下
    // 页面被悄悄换掉，收层才惊觉。重推当前视图 URL 消费掉这次后退：
    // 条目深度不变，被弹掉的 forward 条目作废可接受
    if (isFullscreenPlayerOpen.value) {
      isFullscreenPlayerOpen.value = false
      pushNavState()
      return
    }
    suppressNavPush = true
    try { applyUrlNav() } finally { suppressNavPush = false }
  }
  window.addEventListener('popstate', onPopState)
  onBeforeUnmount(() => window.removeEventListener('popstate', onPopState))

  const watchBack = () => {
    // 当前条目是我们 push 的 → 站内还有上一页可回；否则（分享链冷启动）回首页
    if (window.history.state?.meowsyncNav) navBack()
    else {
      centerView.value = 'home'
      // 同步地址栏——否则 UI 在首页而 URL 停在 ?view=watch，刷新又回 watch
      window.history.replaceState(null, '', buildNavUrl().toString())
    }
  }

  // ── 视图切换 ──

  // 顶栏标题/首页键：回发现流
  const navHome = () => {
    centerView.value = 'home'
    sidebarOpen.value = false
    pushNavState()
  }

  // 搜索结果返回键：回首页（YTM 语义）而不是硬跳歌曲视图
  const closeSearchView = () => {
    centerView.value = 'home'
    pushNavState()
  }

  // 顶栏「下载」键：在 下载页 ⇄ 上一视图 之间往返；搜索态点它应进下载页。
  // 通用入口无预选目标——清掉残留意图，否则旧深链的 pl 会借尸还魂进 URL
  const toggleCenterView = () => {
    if (centerView.value === 'downloads') {
      // 「返回」言出必行=回到进入下载页前的条目：站内历史走 back 回放
      //（watch/search 进的下载页能真回去，而不是新压一条 songs/home 把
      // Back 键语义搞成死循环）；直达页无站内历史才落确定性路由
      if (window.history.state?.meowsyncNav) { navBack(); return }
      centerView.value = selectedPlaylist.value ? 'songs' : 'home'
      pushNavState() // URL 还停在 ?view=downloads——无 popstate 可放，手动同步
      return
    }
    downloadsPl.value = null
    centerView.value = 'downloads'
    sidebarOpen.value = false // 与同族入口同律（toggleSettings/openDownloadsForPlaylist 都收）
    pushNavState()
  }

  // 顶栏 ⋯ 菜单「设置」：与 toggleCenterView 同型往返——设置页再点「返回」
  // 走 back 回放上一视图，无站内历史才落确定性路由
  const toggleSettings = () => {
    if (centerView.value === 'settings') {
      if (window.history.state?.meowsyncNav) { navBack(); return }
      centerView.value = selectedPlaylist.value ? 'songs' : 'home'
      pushNavState()
      return
    }
    centerView.value = 'settings'
    sidebarOpen.value = false // 移动端抽屉下点进来也要落主区
    pushNavState()
  }

  // 「查看进度」深链：预选意图 + 切下载页。DownloadsPanel 首个队列
  // 快照落地后按 neteasePlaylistId === pl 匹配队列并选中
  const openDownloadsForPlaylist = (playlistId) => {
    downloadsPl.value = playlistId != null ? String(playlistId) : null
    downloadsPlSeq.value += 1 // 同 pl 重发也要穿透——序号是意图的新鲜度戳
    centerView.value = 'downloads'
    sidebarOpen.value = false // 移动端抽屉下点进来也要落主区
    pushNavState()
  }

  // 预选意图的失效通道：DownloadsPanel 匹配落空（队列已级联清掉等）或
  // 预选队列被删除时上报——清意图并在当前历史条目上同步 URL，否则 &pl=
  // 死链挂在地址栏，刷新/回放每次都重放一次「还没有下载队列」
  const clearDownloadsPl = () => {
    if (downloadsPl.value == null) return
    downloadsPl.value = null
    window.history.replaceState(window.history.state, '', buildNavUrl().toString())
  }

  // 侧栏选歌单：回歌曲视图 + 移动端收起抽屉
  const selectPlaylistAndShow = async (playlist, opts) => {
    centerView.value = 'songs'
    sidebarOpen.value = false
    pushNavState(playlist)
    await selectPlaylist(playlist, opts)
  }

  // 点搜索结果卡片 = 打开歌单（不入库）；「+ 收藏」才进侧栏库。
  // provider==='qq' 的卡 disstid 不在网易云 id 空间——selectPlaylist 的
  // /playlist_detail 链不认它，走 QQ 导入链（/qq/playlist 拉全量曲目 →
  // local_pl_qq_ 幂等壳 → 选中），与顶栏 QQ 歌单链同一落点
  const openSearchPlaylist = async (playlist) => {
    if (playlist?.provider === 'qq' && playlist?.disstid != null) {
      return openQqPlaylistCard(playlist)
    }
    centerView.value = 'songs'
    pushNavState(playlist)
    await selectPlaylist(playlist)
  }

  // QQ 歌单卡打开：与 useExternalImport.importQQPlaylist 同款行为
  // （编排各归各域——闸/进度 toast/选中是本域职责；幂等归并走共享的
  // external-songs.upsertProviderShell）。占 mediaImport 闸作废在途
  // 选单/导入 → /qq/playlist 拉全量 → local_pl_qq_<disstid> 幂等壳
  // upsert（远端集前插、本地追加保尾、trackOrder 覆盖层沿旧序）→
  // 库域 save 落盘 → force 选中。壳 id 与 providerPlaylistShellId('qq',·)
  // 同源——顶栏导入/搜索卡点卡/卡上「+ 收藏」三条入口收敛同一库行
  const openQqPlaylistCard = async (card) => {
    const disstid = String(card.disstid || '').trim()
    if (!/^\d{1,15}$/.test(disstid)) return // 卡面脏数据不烧上游
    gates.select.invalidate()
    const myReq = gates.mediaImport.claim()
    loadingSongs.value = false // 被顶的 selectPlaylist 不会再复位 loading——收掉
    const opening = toast('正在导入 QQ 歌单…', 'info', 120000)
    try {
      const data = await musicApi.getQQPlaylist(disstid)
      if (!gates.mediaImport.isCurrent(myReq)) return
      const tracks = (data.tracks || []).map(buildQQSong)
      if (!tracks.length) {
        toast('QQ 歌单为空或全部不可解析', 'error')
        return
      }
      const pl = upsertProviderShell(userPlaylists.value, {
        shellId: providerPlaylistShellId('qq', disstid),
        tracks,
        name: data.name || card.name || `QQ 歌单 ${disstid}`,
        coverImgUrl: data.cover || card.coverImgUrl || tracks[0]?.al?.picUrl || '',
        creator: data.creator || card.creator?.nickname || 'QQ 音乐',
      })
      savePlaylistsToStorage()
      await selectPlaylistAndShow(pl, { force: true })
      toast(`已导入 QQ 歌单「${pl.name}」（${tracks.length} 首${data.truncated ? '，超出上限部分未导入' : ''}）`, 'success', 6000)
    } catch (e) {
      if (!gates.mediaImport.isCurrent(myReq)) return
      toast('QQ 歌单导入失败: ' + apiErrorMessage(e), 'error', 5000)
    } finally {
      toastDismiss(opening)
    }
  }

  // 货架卡片（榜单/最近歌单共用）：歌单还在库时用活副本——
  // 本地歌单（saved_queue_*）的 tracks 只在库里，stub 打开会空列表
  const openShelfPlaylist = (pl) => {
    const live = userPlaylists.value.find(p => String(p.id) === String(pl.id))
    openSearchPlaylist(live || pl)
  }

  // ── watch 页进出 ──

  // 播放条 ☰/词 开关 → 打开 watch 页对应 tab（YTM：UP NEXT/歌词都是页内栏位）。
  // 已在 watch 且同 tab 再点 = 收起回上一页（YTM miniplayer 同款开合）
  const openWatchPanel = (tab) => {
    if (!currentSong.value) return // 没在播的歌：空 watch 页无意义
    sidebarOpen.value = false // 热键/遥控链路不经过 scrim，抽屉不会自闭——与 navHome 同律收
    if (centerView.value === 'watch') {
      if (watchTab.value === tab) return watchBack()
      watchTab.value = tab
      return
    }
    watchTab.value = tab
    centerView.value = 'watch'
    pushNavState()
  }

  // 点歌进入 watch 播放页（YTM：任何地方点歌都导航到 /watch）。
  // 调用处紧跟着就是 playSong——不能用 currentSong 做守卫，冷启动点歌时它还是 null
  const enterWatch = () => {
    sidebarOpen.value = false // 键盘 q/遥控链路不经过 scrim，抽屉不会自闭
    if (centerView.value !== 'watch') {
      centerView.value = 'watch'
      pushNavState()
    }
  }

  const openWatchSong = (song) => {
    enterWatch()
    playSong(song)
  }

  const openWatchSearchSong = (song) => {
    enterWatch()
    playSongFromSearch(song)
  }

  // 首页最近播放：队列上下文就是历史列表本身（连播沿着记录往下走）
  const openWatchRecent = (song, list) => {
    enterWatch()
    playSongFromRelated(song, list)
  }

  const playPlaylistAndWatch = (shuffle) => {
    if (!playPlaylist(shuffle)) return // 空单不跳 watch（toast 在 playPlaylist 内）
    enterWatch()
  }

  // ── 搜索 ──

  // 顶栏搜索：并行搜 歌单 + 单曲（YTM 分区结果）；序号守卫防连搜覆盖
  const handlePlaylistSearch = async (query) => {
    gates.preview.invalidate() // 新搜索意图作废在途 id 预览
    centerView.value = 'search'
    pushNavState()
    const myReq = gates.search.claim()
    searching.value = true
    searchSongResults.value = []
    searchSongQuery.value = '' // 同步清：在途旧深挖的 query 守卫即刻失效
    searchSongTotal.value = null
    qqSongPage = 0 // 结果集换回网易云口径——深挖走 offset 不走页码
    ytContinuation.value = null
    try {
      const [plRes, songRes] = await Promise.allSettled([
        musicApi.searchPlaylists(query),
        musicApi.searchSongsPage(query, { limit: 20 })
      ])
      if (!gates.search.isCurrent(myReq)) return
      // 两腿全败 = 搜索不可用而非「零结果」——必须报出，否则失败被吞成
      // 「没有找到相关内容」假空态；单腿败留 console 痕迹，半幅结果仍有效
      if (plRes.status === 'rejected' && songRes.status === 'rejected') {
        toast('搜索失败: ' + apiErrorMessage(plRes.reason || songRes.reason), 'error')
      } else {
        if (plRes.status === 'rejected') console.warn('[search] 歌单搜索失败:', plRes.reason)
        if (songRes.status === 'rejected') console.warn('[search] 单曲搜索失败:', songRes.reason)
      }
      searchResults.value = plRes.status === 'fulfilled' ? (plRes.value.playlists || []) : []
      searchSongResults.value = songRes.status === 'fulfilled' ? (songRes.value?.songs || []) : []
      searchSongQuery.value = query
      searchSongTotal.value = songRes.status === 'fulfilled' ? songRes.value.total : null
    } finally {
      if (gates.search.isCurrent(myReq)) searching.value = false
    }
  }

  // 单曲深挖：cloudsearch offset 翻页 / QQ 页码翻页（p 游标，qqSongPage
  // 区分口径）——query 快照比对挡「深挖在途时新搜索」竞态；上游翻页间
  // 结果可能漂移重叠，按 id 去重追加
  const loadMoreSearchSongs = async () => {
    const q = searchSongQuery.value
    const myReq = gates.search.current()
    // YT 深挖走 ytContinuation 游标而非 total——游标非 null 即还有下一页
    //（无 token 的 YT 结果集与其他源一样，深挖通道天然关闭）
    const ytDive = ytContinuation.value != null
    if (!q || searchSongLoadingMore.value) return
    if (!ytDive && searchSongTotal.value == null) return
    if (searchSongTotal.value != null && searchSongResults.value.length >= searchSongTotal.value) return
    searchSongLoadingMore.value = true
    try {
      let more, total, nextYt = null
      if (ytDive) {
        // YT 深挖：不透明 continuation 游标原样回传——失败游标不动可重试
        const r = await musicApi.searchYouTubeSongs(q, { limit: 20, continuation: ytContinuation.value })
        more = (r.items || []).map(buildYouTubeSong)
        nextYt = r.continuation ?? null
      } else if (qqSongPage > 0) {
        // QQ 深挖：页码游标——取第 N+1 页；失败游标不动可重试
        const r = await musicApi.searchQQSongs(q, { limit: 20, page: qqSongPage + 1 })
        more = (r.songs || []).map(buildQQSong)
        total = r.total
      } else {
        const r = await musicApi.searchSongsPage(q, {
          limit: 20, offset: searchSongResults.value.length,
        })
        more = r.songs
        total = r.total
      }
      // 双代次守卫：query 快照挡异词切换；reqId 快照挡同词重搜
      // （同词重搜后 results 已回写首页，旧深挖再落地会造队列缺口）
      if (searchSongQuery.value !== q || !gates.search.isCurrent(myReq)) return
      if (ytDive) ytContinuation.value = nextYt // 游标只在真消费后推进；null 收键=见底
      if (qqSongPage > 0) qqSongPage += 1 // 页游标只在真消费后推进
      if (total != null) searchSongTotal.value = total
      const seen = new Set(searchSongResults.value.map(s => String(s.id)))
      const fresh = more.filter(s => !seen.has(String(s.id)))
      searchSongResults.value = [...searchSongResults.value, ...fresh]
      // 零进展灭键：上游返空页/整页撞重时游标原地踏步，再点必空转——
      // YT 侧同口径收游标（token 还在但页页撞重，续拉只会烧配额）
      if (!fresh.length) {
        if (ytDive) ytContinuation.value = null
        else searchSongTotal.value = searchSongResults.value.length
      }
    } catch (e) {
      // 与上方落地闸同口径：旧深挖的迟到失败不盖新搜索的结果区
      if (searchSongQuery.value === q && gates.search.isCurrent(myReq)) {
        console.warn('[search] 深挖失败:', e?.message || e)
        toast('加载更多失败，点按重试', 'error')
      }
    } finally {
      // 复位不能带闸——flag 只挡 loadMore 重入非世代态，闸了会让
      // 新搜索的深挖永远看到 flag=true 而 early-return 死掉
      searchSongLoadingMore.value = false
    }
  }

  // qq: 关键词 → QQ 曲库搜索：结果与网易云单曲共用 songs 结果区
  // （qq_ 曲对象的播放/下载/分享链与列表渲染已兼容）；歌单腿并行——
  // QQ 卡带 provider:'qq'，openSearchPlaylist 走 /qq/playlist 导入链
  const handleQQSongSearch = async (kw) => {
    gates.preview.invalidate()
    centerView.value = 'search'
    pushNavState()
    const myReq = gates.search.claim()
    searching.value = true
    searchResults.value = []
    searchSongResults.value = []
    searchSongQuery.value = ''
    searchSongTotal.value = null
    qqSongPage = 0
    ytContinuation.value = null
    try {
      const [songRes, plRes] = await Promise.allSettled([
        musicApi.searchQQSongs(kw, { limit: 20, page: 1 }),
        musicApi.searchQQPlaylists(kw, { limit: 20 }),
      ])
      if (!gates.search.isCurrent(myReq)) return
      // 双腿全败 = QQ 搜索不可用而非「零结果」——与 handlePlaylistSearch
      // 同口径：单腿败留 console 痕迹，半幅结果仍有效
      if (songRes.status === 'rejected' && plRes.status === 'rejected') {
        toast('QQ 音乐搜索失败: ' + apiErrorMessage(songRes.reason || plRes.reason), 'error')
        return
      }
      if (songRes.status === 'rejected') console.warn('[search] QQ 单曲搜索失败:', songRes.reason)
      if (plRes.status === 'rejected') console.warn('[search] QQ 歌单搜索失败:', plRes.reason)
      searchSongResults.value = songRes.status === 'fulfilled' ? (songRes.value?.songs || []).map(buildQQSong) : []
      searchResults.value = plRes.status === 'fulfilled' ? (plRes.value?.playlists || []) : []
      searchSongQuery.value = kw
      qqSongPage = 1 // 第 1 页已在手——深挖从 p=2 起（游标>0 也是 QQ 口径标记）
      searchSongTotal.value = songRes.status === 'fulfilled' ? (songRes.value?.total ?? null) : null
    } finally {
      if (gates.search.isCurrent(myReq)) searching.value = false
    }
  }

  // yt: 关键词 → YouTube 曲库搜索：单腿（YT 无歌单搜索腿——歌单走链接
  // 导入链）。服务端行形即 buildYouTubeSong 输入形（yt_ 曲对象的播放/
  // 下载/分享链与列表渲染已兼容）；searchSongTotal 恒 null——YT 无总数，
  // 深挖走 ytContinuation 游标（非 null 即还有下一页，null=收键见底）
  const handleYTSongSearch = async (kw) => {
    gates.preview.invalidate()
    centerView.value = 'search'
    pushNavState()
    const myReq = gates.search.claim()
    searching.value = true
    searchResults.value = []
    searchSongResults.value = []
    searchSongQuery.value = ''
    searchSongTotal.value = null
    qqSongPage = 0
    ytContinuation.value = null
    try {
      const r = await musicApi.searchYouTubeSongs(kw, { limit: 20 })
      if (!gates.search.isCurrent(myReq)) return
      searchSongResults.value = (r.items || []).map(buildYouTubeSong)
      searchSongQuery.value = kw
      ytContinuation.value = r.continuation || null
    } catch (e) {
      // 单腿搜索——失败须报出，不能像 QQ 双腿那样单腿败留半幅结果
      if (!gates.search.isCurrent(myReq)) return
      console.warn('[search] YT 单曲搜索失败:', e?.message || e)
      toast('YouTube 搜索失败: ' + apiErrorMessage(e), 'error')
    } finally {
      if (gates.search.isCurrent(myReq)) searching.value = false
    }
  }

  // 预览落空（未命中/拉取失败）的视图+URL 归一：popstate 路径上
  // applyUrlNav 调本函数后即 return——不补救的话视图从未按 URL 落定，
  // 地址栏还挂着 ?view=songs&pl=<失效 id> 死链，刷新/再回放必重放失败。
  // 按 applyUrlNav 兜底阶梯同口径落定视图，replaceState 把 pl 归一回当前条目
  //（不 push——popstate 回放不该产生新历史）
  const recoverFailedPreview = () => {
    const { view: urlView } = readNavParams(new URLSearchParams(window.location.search))
    centerView.value = urlView === 'songs'
      ? (selectedPlaylist.value ? 'songs' : 'home')
      : resolveNavView({
        view: urlView,
        hasSelectedPlaylist: selectedPlaylist.value != null,
        hasSong: currentSong.value != null,
        hasSearchResults: searchResults.value.length > 0 || searchSongResults.value.length > 0,
        searching: searching.value
      })
    window.history.replaceState(window.history.state, '', buildNavUrl().toString())
  }

  // 顶栏数字 id 搜索：只预览不自动入库——入库与否由用户决定
  // （hero「收藏歌单」/搜索结果卡 + 键/点歌台直加自动收藏），
  // 避免「搜过一次 = 永久长进侧栏」的噪音积累。已入库则直接打开。
  const previewPlaylistById = async (id, rawQuery) => {
    const myReq = gates.preview.claim()
    try {
      // loadingSongs 而非 loading——loading 是侧栏整板 spinner，预览期间侧栏全空闪
      loadingSongs.value = true
      const lib = userPlaylists.value.find(p => String(p.id) === String(id))
      if (lib) {
        await selectPlaylistAndShow(lib)
        if (!rawQuery || searchQuery.value.trim() === rawQuery.trim()) searchQuery.value = ''
        return
      }
      const playlist = await musicApi.getPlaylistDetail(id)
      // 在途间用户做了别的（新搜索/点歌/选单）→ 预览作废，不得抢视图
      if (!gates.preview.isCurrent(myReq)) return
      // 接口对不存在的歌单返回无 id 的空壳对象（{ tracks: [] }），须校验后再打开
      if (playlist && playlist.id != null) {
        await openSearchPlaylist(playlist)
        // 只在框里还是本次提交的输入时才清——预览途中用户新敲的字不抹
        if (!rawQuery || searchQuery.value.trim() === rawQuery.trim()) searchQuery.value = ''
      } else {
        toast('未找到该歌单', 'info')
        recoverFailedPreview()
      }
    } catch (error) {
      if (!gates.preview.isCurrent(myReq)) return
      console.error('❌ 加载歌单预览失败:', error)
      toast('歌单加载失败: ' + (apiErrorMessage(error)), 'error')
      recoverFailedPreview()
    } finally {
      if (gates.preview.isCurrent(myReq)) loadingSongs.value = false
    }
  }

  return {
    // 视图/搜索态
    centerView, sidebarOpen, searching,
    searchResults, searchSongResults,
    searchSongQuery, searchSongTotal, searchSongLoadingMore,
    ytContinuation, searchSongHasMore,
    // 导航
    buildNavUrl, pushNavState, applyUrlNav, normalizeNavEntry,
    navHome, closeSearchView, toggleCenterView, toggleSettings, watchBack,
    downloadsPl, downloadsPlSeq, openDownloadsForPlaylist, clearDownloadsPl,
    enterWatch, openWatchPanel,
    // 打开动作
    selectPlaylistAndShow, openSearchPlaylist, openShelfPlaylist,
    previewPlaylistById,
    openWatchSong, openWatchSearchSong, openWatchRecent, playPlaylistAndWatch,
    // 搜索
    handlePlaylistSearch, handleQQSongSearch, handleYTSongSearch, loadMoreSearchSongs,
  }
}
