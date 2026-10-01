import { ref, watch, onBeforeUnmount } from 'vue'
import { resolveApiBaseUrl } from '../lib/api-base'
import { toast } from '../lib/feedback'

// 远程控制 host 端：state_update 每 2s 广播 + 指令即时响应 + 断线重连。
// deps 由宿主注入（refs 直接传；howl 是可被置 null 重建的裸 let，用 getter 传活引用）
export function useRemoteControl(deps) {
  const {
    getHowl, isPlaying, currentSong, currentTime, duration, volume,
    playingSongs, songSwitching, filteredSongs,
    playSong, nextSong, previousSong, updateVolume, currentPlayingIndex, playbackList
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
  const tokenSafeForProto = /^[A-Za-z0-9._~-]+$/.test(remoteToken)
  const remoteWsProtocols = remoteToken && tokenSafeForProto ? [`remote.${remoteToken}`] : undefined
  const remoteTokenParam = remoteToken && !tokenSafeForProto
    ? `&token=${encodeURIComponent(remoteToken)}` : ''
  const remoteWsUrl = apiBase.replace(/^http/, 'ws') + '/remote'
  const remoteHostWsUrl = `${remoteWsUrl}?role=host${remoteTokenParam}`
  const remoteControllerWsUrl = `${remoteWsUrl}?role=controller${remoteTokenParam}`
  let remoteWs = null
  let remoteStateTimer = null
  let remoteReconnectTimer = null
  let remoteRetries = 0

  // state_update 只保留 controller 端用到的字段，避免整个 song 对象
  // （含 alias/privilege 等大字段）每 2s 全量序列化并广播
  function serializeRemoteSong(song) {
    if (!song) return null
    const artistList = song.ar || song.artists || []
    return {
      id: song.id,
      name: song.name,
      al: { picUrl: song.al?.picUrl ?? song.album?.picUrl ?? '' },
      ar: artistList.map(a => ({ name: a?.name ?? '' }))
    }
  }

  function sendRemoteState() {
    if (!remoteWs || remoteWs.readyState !== WebSocket.OPEN) return
    remoteWs.send(JSON.stringify({
      type: 'state_update',
      payload: {
        isPlaying: isPlaying.value,
        currentSong: serializeRemoteSong(currentSong.value),
        currentTime: currentTime.value,
        duration: duration.value,
        volume: volume.value,
        // 待播队列广播：封顶 50 条防止大歌单撑爆 64KB 帧限制；
        // 当前曲在截断窗外时发 -1——否则服务端 clamp 到 49 会点亮错误的行
        queue: playingSongs.value.slice(0, 50).map(serializeRemoteSong),
        queueIndex: (i => (i >= 0 && i < 50 ? i : -1))(currentPlayingIndex())
      }
    }))
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
            playSong(currentSong.value, { preserveContext: true, seekTime: currentTime.value })
          }
        } else if (!isPlaying.value) {
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
      case 'request_state':
        sendRemoteState()
        break
    }
  }

  function connectRemoteHost() {
    if (remoteMode.value !== 'host') return
    // 回调一律操作局部 ws：迟到的 onerror/onclose 若引用共享 remoteWs，
    // 会把已被取代的新 socket 误关/清空
    const ws = remoteWs = new WebSocket(remoteHostWsUrl, remoteWsProtocols)
    ws.onopen = () => {
      remoteRetries = 0
      console.log('[remote] host WS connected')
      remoteStateTimer = setInterval(sendRemoteState, 2000)
    }
    ws.onmessage = (e) => {
      try {
        handleRemoteMessage(JSON.parse(e.data))
      } catch { /* 忽略畸形消息 */ }
    }
    ws.onclose = (e) => {
      if (remoteWs === ws) remoteWs = null
      clearInterval(remoteStateTimer)
      remoteStateTimer = null
      // 被新 host 顶替（服务端 close code 4000）：不再重连，
      // 否则两端会反复互踢形成踢皮球循环。这是夺权事件——静默停在 console
      // 会让用户以为遥控还在生效，必须可见提示
      if (e && e.code === 4000) {
        console.warn('[remote] 已有新的 host 接管，本端停止远程控制')
        toast('远程控制已被另一设备接管，本端已退出主机模式（刷新页面可重新接管）', 'error', 5000)
        return
      }
      // 该 socket 已被更新的连接取代，不重连（新连接自己负责）
      if (remoteWs && remoteWs !== ws) return
      // 断线重连有上限：握手即被拒（token/Origin 不通过）时避免无限重试
      remoteRetries++
      if (remoteRetries > 5) {
        // 与 4000 顶替路径对称：遥控静默失效会让用户误以为还在生效
        console.warn('[remote] host 重连次数超限，停止重连（请检查 REMOTE_TOKEN/服务状态）')
        toast('远程控制连接多次失败，已停止重连（刷新页面可重试）', 'error', 5000)
        return
      }
      remoteReconnectTimer = setTimeout(connectRemoteHost, 3000)
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
