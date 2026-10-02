// 上传端点客户端：POST /uploads?kind&filename&songId —— 服务端走 octet-stream
// 流式落盘（禁 multipart），客户端发原始 File/Blob body。
// 走 XMLHttpRequest 而非 http 实例：fetch/axios 都拿不到上行进度
// （upload.onprogress 是浏览器里唯一的上行进度事件源）。
// 返回 { promise, abort }——大文件（audio 512MB / video 2GB）上传中必须给
// 逃生通道；abort 走 xhr.onabort → promise reject('已取消')
import { API_BASE_URL } from './http'
import { UPLOADS_PLAYLIST_ID, fileArtifactUrl } from '../lib/song'

export { UPLOADS_PLAYLIST_ID, fileArtifactUrl }

export function uploadFile({ kind, file, filename, songId, onProgress }) {
  const params = new URLSearchParams({ kind })
  params.set('filename', filename || file?.name || 'file')
  if (songId) params.set('songId', songId)

  const xhr = new XMLHttpRequest()
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', `${API_BASE_URL}/uploads?${params}`)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      let body = null
      try { body = JSON.parse(xhr.responseText) } catch { /* 非 JSON 错误页 */ }
      if (xhr.status >= 200 && xhr.status < 300 && body?.code === 200) {
        resolve(body.data) // {songId, kind, size}——包封同仓 {code,data} 惯例
      } else {
        reject(new Error(body?.message || `上传失败（HTTP ${xhr.status}）`))
      }
    }
    xhr.onerror = () => reject(new Error('网络错误，上传失败'))
    xhr.onabort = () => reject(new Error('已取消'))
    // File 直发——Blob 本体进请求体，不包 FormData（服务端 octet-stream 裸读）
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}

export async function deleteUploadedSong(songId) {
  const doDelete = () => fetch(`${API_BASE_URL}/uploads/${encodeURIComponent(songId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  let r = await doDelete()
  // abort→DELETE 竞态：xhr.abort 后服务端 inflight 锁要走「socket 断→流读失败
  // →finally」才释放——DELETE 抢在释放前到吃 409 锁遗留孤儿行。锁极短，缓一拍重试
  if (r.status === 409) {
    await new Promise(res => setTimeout(res, 400))
    r = await doDelete()
  }
  // 与 uploadFile 同口径校验——401/404/409/429 不能报「已删除」（破坏性操作
  // 谎报结果 = 用户以为资产清了实际还在盘上）
  let body = null
  try { body = await r.json() } catch { /* 非 JSON 错误页 */ }
  if (!r.ok || body?.code !== 200) {
    throw new Error(body?.message || `删除失败（HTTP ${r.status}）`)
  }
  return body
}
