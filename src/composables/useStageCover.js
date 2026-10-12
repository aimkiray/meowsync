import { computed, ref, watch } from 'vue'
import { resolveStageCover, proxiedCoverUrl } from '../lib/song'

// 舞台位（WatchView 播放页 / FullscreenPlayer 沉浸层大封面槽）HD 升档
// 协议单点——两组件原 ~13 行逐字同构块收这一处。机制本体在
// lib/song.js:resolveStageCover（yt 档位实探、126/hdslb 剥缩放尾缀、
// gtimg 升 T002R800）；本层只管协议：先铺 baseCover 占位零闪烁，解析
// 落地再顶替为更优档。
//   watch 双源：曲 id 换曲重解 + baseCover 管同曲换封面（trackOverrides
//     改图/封面自愈——resolveStageCover 只吃 songCoverUrl，同 id 换封面
//     不重解会钉住旧图）
//   onCleanup stale 闸：切曲/卸载后迟到的探测结果丢弃不写
//   返回值收口「HD 已落地 || 占位」口径——img/poster 消费位同吃一处
export function useStageCover(getSong, baseCoverRef) {
  const stageCover = ref('')
  watch([() => getSong()?.id, baseCoverRef], async (_v, _prev, onCleanup) => {
    stageCover.value = baseCoverRef.value       // 先铺即时占位
    const song = getSong()
    if (!song) return
    let stale = false
    onCleanup(() => { stale = true })
    const hd = await resolveStageCover(song)    // 裸 URL，照常过代理包装链
    if (stale || !hd) return
    stageCover.value = proxiedCoverUrl(hd)
  }, { immediate: true })
  return computed(() => stageCover.value || baseCoverRef.value)
}
