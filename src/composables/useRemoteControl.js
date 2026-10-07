import { ref, watch, onBeforeUnmount } from 'vue'
import { resolveApiBaseUrl } from '../lib/api-base.js'
import { songCoverUrl } from '../lib/song.js'
import { toast } from '../lib/feedback.js'
// WS 消息类型与服务端 remote.js 同源
import { MSG_TYPES, REMOTE_LIMITS } from '../shared/protocol.js'

// 远程控制 host 端：state_update 每 2s 广播 + 指令即时响应 + 断线重连。
// deps 由宿主注入（refs 直接传；howl 是可被置 null 重建的裸 let，用 getter 传活引用）
export function useRemoteControl(deps) {
  // currentPlayingIndex 不再消费：queueIndex 改为在已发送 queue 内按 id 重定位
  const {
    getHowl, isPlaying, currentSong, currentTime, duration, volume,
    playingSongs, songSwitching, filteredSongs,
    playSong, nextSong, previousSong, updateVolume, playbackList
  } = deps

  // 远程控制模式
  const urlParams = new URLSearchParams(window.location.search)
  const rawMode = urlParams.get('mode')
  // 'remote' 是 'controller' 的别名——用户/旧链接手滑写 remote 时应进控制器而非普通应用
  const normalizedMode = rawMode === 'remote' ? 'controller' : rawMode
  const remoteMode = ref(['host', 'controller'].includes(normalizedMode) ? normalizedMode : 'off') // 'off' | 'host' | 'controller'

  const apiBase = resolveApiBaseUrl()
  const remoteToken = import.meta.env.VITE_REMOTE_TOKEN || ''
  // token 优先走 Sec-WebSocket-Protocol 子协议——?token= 会落进反代 access log
  // 与浏览器历史。协议值须为 RFC7230 token 字符集，含其他字符时回退 URL 参数
  const tokenSafeForProto = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(remoteToken)
  const remoteWsProtocols = remoteToken && tokenSafeForProto ? [`remote.${remoteToken}`] : undefined
  const remoteTokenParam = remoteToken && !tokenSafeForProto
    ? `&token=${encodeURIComponent(remoteToken)}` : ''
  const remoteWsUrl = apiBase.replace(/^http/, 'ws') + '/remote'
  const remoteHostWsUrl = `${remoteWsUrl}?role=host${remoteTokenParam}`
  const remoteControllerWsUrl = `${remoteWsUrl}?role=controller${remoteTokenParam}`
  let remoteWs = null
  // 当前连接角色：'host' 常态 / 'controller' 被顶替后的降级观望期
  let remoteWsRole = 'host'
  let remoteStateTimer = null
  let remoteReconnectTimer = null
  let remoteRetries = 0
  // 顶替降级标记：本端曾被 4000 收编为旁观——自愈回接管成功时补一条回执
  let remoteDemoted = false

  // state_update 只保留 controller 端用到的字段，避免整个 song 对象
  // （含 alias/privilege 等大字段）每 2s 全量序列化并广播
  function serializeRemoteSong(song) {
    if (!song) return null
    // ar/artists 可能是非数组脏值——无守卫的 .map 会让 2s 心跳每次抛错，广播静默死亡
    const artistList = Array.isArray(song.ar) ? song.ar
      : (Array.isArray(song.artists) ? song.artists : [])
    // 本服务工件封面（file_ 曲走 /downloads file 端点）发 apiBase 相对路径：
    // host 视角拼出的绝对 URL 对异机 controller 是死链（localhost 指向它
    // 自己）；接收端用自身 resolveApiBaseUrl 拼回。外部 CDN http(s) 链原样
    // 透传；apiBase 为 ''（无 DOM 测试态）时 startsWith('/') 判断原样放行
    const cover = songCoverUrl(song)
    return {
      id: song.id,
      name: song.name,
      al: { picUrl: cover.startsWith(`${apiBase}/`) ? cover.slice(apiBase.length) : cover },
      ar: artistList.map(a => ({ name: a?.name ?? '' }))
    }
  }

  function sendRemoteState() {
    // 观望期的降级连接是 controller 角色——服务端只认 host 的 state_update，
    // 上行会白占消息配额（30/s 比 host 桶紧），本地直接不发
    if (remoteWsRole !== 'host' || !remoteWs || remoteWs.readyState !== WebSocket.OPEN) return
    // 待播队列广播：封顶 50 条防止大歌单撑爆状态帧上限
    const queue = playingSongs.value.slice(0, 50).map(serializeRemoteSong)
    // queueIndex 以「已发送 queue」为准按 id 重定位——currentPlayingIndex
    // 是 playbackList 全量坐标系，快照截断/快照源切换都会让它漂出已发
    // 队列的窗口；按 id 重定位天然与 frame 内队列同口径（找不到发 -1）
    const buildFrame = (q) => JSON.stringify({
      type: MSG_TYPES.STATE_UPDATE,
      payload: {
        isPlaying: isPlaying.value,
        currentSong: serializeRemoteSong(currentSong.value),
        currentTime: currentTime.value,
        duration: duration.value,
        volume: volume.value,
        queue: q,
        queueIndex: currentSong.value?.id == null ? -1
          : q.findIndex(s => String(s.id) === String(currentSong.value.id))
      }
    })
    let frame = buildFrame(queue)
    // 状态帧上行封顶（与服务端广播侧同值）：超了砍 queue 尾重算——队列
    // 截尾展示胜过整帧超限被服务端丢；砍空仍超是 currentSong 单体超限，
    // 丢帧等下一拍（2s 心跳/下一次变更推送自然补）。按字节量封顶——
    // string.length 把中文按 1 计，UTF-8 线上实际 3B
    const frameBytes = () => new TextEncoder().encode(frame).length
    while (queue.length && frameBytes() > REMOTE_LIMITS.MAX_STATE_PAYLOAD_BYTES) {
      queue = queue.slice(0, Math.ceil(queue.length / 2))
      frame = buildFrame(queue)
    }
    if (frameBytes() <= REMOTE_LIMITS.MAX_STATE_PAYLOAD_BYTES) remoteWs.send(frame)
  }

  // 远端控制命令：play/pause 幂等执行（controller 端状态有延迟，不能用 toggle）
  function handleRemoteMessage(msg) {
    const howl = getHowl()
    switch (msg.type) {
      case 'play':
        // 与 togglePlay 同款的恢复路径：实例已被错误处理销毁时重走 playSong，
        // 否则远端 play 在加载失败后静默失效
        if (!howl) {
          if (currentSong.value && !songSwitching.value) {
            // resumeSeek 与本地 togglePlay 的 !howl 分支同口径：加载失败挂着的
            // 续播位（pendingSeekTime）优先于已被清零的 currentTime——挂账是
            // usePlayer 闭包私有值，换算放在 playSong 内部做
            playSong(currentSong.value, { preserveContext: true, resumeSeek: true })
          }
        // 与 togglePlay 同款加载窗闸：state==='loading' 时 play() 只进 Howler
        // _queue，onload 的 autoplay 分支再 play 一次——两条 _inactiveSound
        // 各起一个轨道叠成双音轨；加载中吞掉这次指令是唯一不叠轨的口径
        } else if (!isPlaying.value && howl.state?.() !== 'loading') {
          howl.play()
        }
        break
      case 'pause':
        if (howl && isPlaying.value) howl.pause()
        break
      case 'next':
        nextSong()
        break
      case 'prev':
        previousSong()
        break
      case 'seek': {
        // 严格校验：null/true/'' 会被 Number() 强转成 0/1 蒙混过 isFinite
        const t = msg.payload
        if (howl && typeof t === 'number' && Number.isFinite(t)) {
          const clamped = Math.max(0, Math.min(t, duration.value || 0))
          howl.seek(clamped)
          currentTime.value = clamped
        }
        break
      }
      case 'volume':
        updateVolume(msg.payload)
        break
      case 'play_song': {
        // 先在播放快照中定位（队列内导航）；命中浏览列表则视为用户跨歌单点歌，
        // 拍新快照；两边都没有则记录日志便于排查，不静默吞掉
        let list = playbackList()
        let targetIndex = list.findIndex(s => String(s.id) === String(msg.payload))
        if (targetIndex !== -1) {
          playSong(list[targetIndex], { preserveContext: true })
        } else {
          list = filteredSongs.value
          targetIndex = list.findIndex(s => String(s.id) === String(msg.payload))
          if (targetIndex !== -1) {
            playSong(list[targetIndex])
          } else {
            console.warn('[remote] play_song 目标不在播放队列或当前列表:', msg.payload)
          }
        }
        break
      }
      case MSG_TYPES.REQUEST_STATE:
        sendRemoteState()
        break
    }
  }

  // asRole 是连接角色而非页面模式：remoteMode 恒为 'host'，被顶替的窗口
  // 降级成 'controller' 观望连接，对端让出 host 位后经 host_absent /
  // host_disconnected 自愈回接管——顶替事件不再永久杀死本端遥控
  function connectRemoteHost(asRole = 'host') {
    if (remoteMode.value !== 'host') return
    // 幂等：重进（手动调用/降级/晋升/重连定时器叠加）先清挂单再关旧
    // socket——旧 socket 的 onclose 置空，迟到的 close 不会再抢重连权
    if (remoteReconnectTimer) {
      clearTimeout(remoteReconnectTimer)
      remoteReconnectTimer = null
    }
    if (remoteWs) {
      remoteWs.onclose = null
      remoteWs.onerror = null
      try { remoteWs.close() } catch { /* 已关 */ }
      remoteWs = null
    }
    remoteWsRole = asRole
    // 回调一律操作局部 ws：迟到的 onerror/onclose 若引用共享 remoteWs，
    // 会把已被取代的新 socket 误关/清空
    const ws = remoteWs = new WebSocket(
      asRole === 'host' ? remoteHostWsUrl : remoteControllerWsUrl,
      remoteWsProtocols)
    // 观望连接见到 host 位空缺时置位——onclose 据此直接回接管，不走失败计数
    let promoteToHost = false
    ws.onopen = () => {
      remoteRetries = 0
      console.log(`[remote] WS connected as ${asRole}`)
      // 只有真 host 角色才推状态；降级观望期只收不发
      if (asRole === 'host') remoteStateTimer = setInterval(sendRemoteState, 2000)
      if (asRole === 'host' && remoteDemoted) {
        remoteDemoted = false
        toast('远程控制已恢复主机模式', 'info')
      }
    }
    ws.onmessage = (e) => {
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch { return }
      if (asRole !== 'host') {
        // 观望期只消费 host 位信号：空位即回接管（HOST_ABSENT 是入会时的
        // "从未有过"，HOST_DISCONNECTED 是"对端刚走"）——多路降级连接同时
        // 晋升由服务端顶替序收编，败方再吃 4000 回到观望，不会互踢死循环
        if (msg && (msg.type === MSG_TYPES.HOST_ABSENT || msg.type === MSG_TYPES.HOST_DISCONNECTED)) {
          promoteToHost = true
          ws.close()
        }
        return
      }
      try {
        handleRemoteMessage(msg)
      } catch { /* 忽略畸形消息 */ }
    }
    ws.onclose = (e) => {
      const isCurrent = remoteWs === ws
      if (isCurrent) remoteWs = null
      clearInterval(remoteStateTimer)
      remoteStateTimer = null
      // 该 socket 已被更新的本地连接取代——迟到的 close（含顶替 4000）
      // 不弹「被接管」提示、不抢新连接的重连/晋升权（新连接自己负责）
      if (!isCurrent) return
      // 观望期发现 host 位空缺：立即回接管（不算失败重试）
      if (promoteToHost) {
        remoteRetries = 0
        connectRemoteHost('host')
        return
      }
      // 被新 host 顶替（服务端 close code 4000）：自动降级为 controller
      // 观望而非永久停摆——「第二个窗口临时接管」不该是本端遥控的死刑；
      // 夺权是用户可见事件，toast 保留
      if (e && e.code === 4000) {
        console.warn('[remote] 已有新的 host 接管，本端降级为旁观连接')
        // 降级观望是新一轮生命：host 期积的重连欠账不带入观望期
        remoteRetries = 0
        remoteDemoted = true
        toast('远程控制已被另一设备接管，本端转为旁观；对方断开后自动恢复', 'error', 5000)
        remoteReconnectTimer = setTimeout(() => connectRemoteHost('controller'), 800)
        return
      }
      // 断线重连有上限：握手即被拒（token/Origin 不通过）时避免无限重试
      remoteRetries++
      if (remoteRetries > 5) {
        // 与顶替路径对称：遥控静默失效会让用户误以为还在生效
        console.warn('[remote] host 重连次数超限，停止重连（请检查 REMOTE_TOKEN/服务状态）')
        toast('远程控制连接多次失败，已停止重连（刷新页面可重试）', 'error', 5000)
        return
      }
      remoteReconnectTimer = setTimeout(() => connectRemoteHost(remoteWsRole), 3000)
    }
    ws.onerror = () => ws.close()
  }

  // host 模式：状态变化时立即推送
  watch([isPlaying, currentSong, volume], () => {
    if (remoteMode.value === 'host') sendRemoteState()
  })

  // 队列快照变更（shuffle/增删/换单）也要即时推送——2s 轮询兜底但点歌不该等
  watch(playingSongs, () => {
    if (remoteMode.value === 'host') sendRemoteState()
  })

  onBeforeUnmount(() => {
    remoteReconnectTimer && clearTimeout(remoteReconnectTimer)
    remoteReconnectTimer = null
    // onclose 被置 null 后不会再清 remoteStateTimer，这里必须手动清，否则 interval 泄漏
    remoteStateTimer && clearInterval(remoteStateTimer)
    remoteStateTimer = null
    if (remoteWs) {
      remoteWs.onclose = null
      remoteWs.close()
      remoteWs = null
    }
  })

  return { remoteMode, remoteControllerWsUrl, remoteWsProtocols, connectRemoteHost }
}
