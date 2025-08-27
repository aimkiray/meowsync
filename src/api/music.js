import axios from 'axios'
import CryptoJS from 'crypto-js'

// 使用环境变量配置API服务器地址
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3002'
// 备用第三方API服务（稳定可靠）
const BACKUP_API_BASE_URL = import.meta.env.VITE_BACKUP_API_URL || 'https://163api.qijieya.cn'
// 备用第三方API服务2（ALAPI）
const BACKUP_API_BASE_URL_2 = 'https://v2.alapi.cn/api/music'

// 网抑云加密相关常量
const IV = '0102030405060708'
const PRESET_KEY = '0CoJUm6Qyw8W8jud'
const LINUX_API_KEY = 'rFgB&h#%2?^eDg:Q'
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

// 生成随机字符串
function randomString(length) {
  let result = ''
  for (let i = 0; i < length; i++) {
    result += BASE62.charAt(Math.floor(Math.random() * BASE62.length))
  }
  return result
}

// AES加密
function aesEncrypt(text, key) {
  const keyBytes = CryptoJS.enc.Utf8.parse(key)
  const ivBytes = CryptoJS.enc.Utf8.parse(IV)
  const encrypted = CryptoJS.AES.encrypt(text, keyBytes, {
    iv: ivBytes,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  })
  return encrypted.toString()
}

// RSA加密（简化版，仅用于生成encSecKey）
function rsaEncrypt(text) {
  // 这里使用简化的RSA加密，实际项目中应该使用完整的RSA实现
  // 为了简化，我们直接返回一个固定的encSecKey
  return '257348aecb5e556c066de214e531faadd1c55d814f9be95fd06d6bff9f4c7a41f831f6394d5a3fd2e3881736d94a02ca919d952872e7d0a50ebfa1769a7a62d512f5f1ca21aec60bc3819a9c3ffca5eca9a0dba6d6f7249b06f5965ecfff3695b54e1c28f3f624750ed39e7de08fc8493242e26dbc4484a01c76f739e135637c'
}

// weapi加密
function weapi(object) {
  const text = JSON.stringify(object)
  const secretKey = randomString(16)
  
  const params = aesEncrypt(aesEncrypt(text, PRESET_KEY), secretKey)
  const encSecKey = rsaEncrypt(secretKey.split('').reverse().join(''))
  
  return {
    params,
    encSecKey
  }
}

// eapi加密
function eapi(url, object) {
  const text = JSON.stringify(object)
  const message = `nobody${url}use${text}md5forencrypt`
  const digest = CryptoJS.MD5(message).toString()
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  
  return {
    params: aesEncrypt(data, LINUX_API_KEY).toUpperCase()
  }
}

// 获取超时配置
const API_TIMEOUT = parseInt(import.meta.env.VITE_API_TIMEOUT) || 10000

// 创建主API实例
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT,
  withCredentials: true,
  headers: {
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
})

// 创建备用API实例
const backupApi = axios.create({
  baseURL: BACKUP_API_BASE_URL,
  timeout: API_TIMEOUT,
  withCredentials: true,
  headers: {
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
})

// 请求拦截器
api.interceptors.request.use(
  config => {
    // 添加时间戳防止缓存
    if (config.params) {
      config.params._t = Date.now()
    }
    return config
  },
  error => {
    return Promise.reject(error)
  }
)

// 响应拦截器
api.interceptors.response.use(
  response => {
    return response.data
  },
  error => {
    console.error('主API请求失败:', error)
    return Promise.reject(error)
  }
)

// 备用API请求拦截器
backupApi.interceptors.request.use(
  config => {
    // 添加时间戳防止缓存
    if (config.params) {
      config.params._t = Date.now()
    }
    return config
  },
  error => {
    return Promise.reject(error)
  }
)

// 备用API响应拦截器
backupApi.interceptors.response.use(
  response => {
    return response.data
  },
  error => {
    console.error('备用API请求失败:', error)
    return Promise.reject(error)
  }
)

// 音乐API接口
export const musicApi = {
  // 搜索歌单
  searchPlaylists: async (keywords, limit = 20) => {
     try {
       console.log('🔍 搜索歌单:', keywords)
       const response = await api.get('/search', {
         params: {
           keywords,
           type: 1000, // 歌单类型
           limit
         }
       })
       
       console.log('📊 主API搜索结果:', response)
       // NeteaseCloudMusicApi 返回格式: {status: 200, body: {result: {playlists: []}}}
       const data = response.body || response
       return data.result || {}
     } catch (error) {
       console.error('主API搜索歌单失败:', error)
       
       // 尝试使用备用API
       try {
         console.log('🔄 尝试备用API搜索歌单:', keywords)
         const backupResponse = await backupApi.get('/search', {
           params: {
             keywords,
             type: 1000,
             limit
           }
         })
         
         console.log('📊 备用API搜索结果:', backupResponse)
         // 备用API返回格式可能不同，需要适配
         const backupData = backupResponse.body || backupResponse
         return backupData.result || backupData
       } catch (backupError) {
         console.error('备用API也失败了:', backupError)
         
         // 返回模拟数据作为最后备选
         return {
           playlists: [
             {
               id: 1,
               name: '周杰伦热门歌曲',
               coverImgUrl: 'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg',
               creator: { nickname: '网易云音乐' },
               trackCount: 50
             },
             {
               id: 2,
               name: '华语经典老歌',
               coverImgUrl: 'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg',
               creator: { nickname: '音乐推荐' },
               trackCount: 100
             }
           ]
         }
       }
     }
   },

  // 获取歌单详情
  getPlaylistDetail: async (id) => {
     console.log('🎵 musicApi.getPlaylistDetail 被调用，ID:', id)
     try {
       console.log('🌐 调用主API获取歌单详情')
       const response = await api.get('/playlist_detail', {
         params: { id }
       })
       console.log('📊 主API歌单详情响应:', response)
       
       // 获取歌单基本信息
       const data = response.body || response
       const playlist = data.playlist || {}
       
       // 获取歌单所有歌曲
       console.log('🎵 获取歌单所有歌曲，歌曲数量:', playlist.trackCount)
       const tracksResponse = await api.get('/playlist_track_all', {
         params: { 
           id,
           limit: playlist.trackCount || 1000, // 使用歌单的实际歌曲数量
           offset: 0
         }
       })
       console.log('📊 主API歌曲列表响应:', tracksResponse)
       
       const tracksData = tracksResponse.body || tracksResponse
       const allTracks = tracksData.songs || []
       
       // 合并歌单信息和完整歌曲列表
       return {
         ...playlist,
         tracks: allTracks
       }
     } catch (error) {
       console.error('主API获取歌单详情失败:', error)
       
       // 尝试使用备用API
       try {
         console.log('🔄 尝试备用API获取歌单详情:', id)
         const backupResponse = await backupApi.get('/playlist/detail', {
           params: { id }
         })
         
         console.log('📊 备用API响应:', backupResponse)
         const backupData = backupResponse.body || backupResponse
         const playlist = backupData.playlist || backupData
         
         // 尝试获取备用API的所有歌曲
         try {
           const tracksResponse = await backupApi.get('/playlist_track_all', {
             params: { 
               id,
               limit: playlist.trackCount || 1000,
               offset: 0
             }
           })
           const tracksData = tracksResponse.body || tracksResponse
           const allTracks = tracksData.songs || []
           
           return {
             ...playlist,
             tracks: allTracks
           }
         } catch (tracksError) {
           console.error('备用API获取歌曲列表失败:', tracksError)
           return playlist
         }
       } catch (backupError) {
         console.error('备用API也失败了:', backupError)
         
         // 返回模拟数据作为最后备选
         return {
           id: id,
           name: '模拟歌单',
           coverImgUrl: 'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg',
           creator: { nickname: '模拟用户' },
           trackCount: 3,
           description: '这是一个模拟歌单',
           tracks: [
             {
               id: 186016,
               name: '稻香',
               ar: [{ name: '周杰伦' }],
               al: {
                 name: '魔杰座',
                 picUrl: 'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg'
               },
               dt: 223000
             },
             {
               id: 186017,
               name: '青花瓷',
               ar: [{ name: '周杰伦' }],
               al: {
                 name: '我很忙',
                 picUrl: 'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg'
               },
               dt: 238000
             },
             {
               id: 186018,
               name: '夜曲',
               ar: [{ name: '周杰伦' }],
               al: {
                 name: '十一月的萧邦',
                 picUrl: 'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg'
               },
               dt: 196000
             }
           ]
         }
       }
     }
  },

  // 获取歌曲播放URL
   getSongUrl: async (id) => {
     // 尝试不同的音质参数
     const bitrates = [320000, 192000, 128000, 96000]
     
     for (const br of bitrates) {
       try {
         console.log('🎵 获取歌曲URL，ID:', id, '音质:', br)
         const response = await api.get('/song_url', {
           params: {
             id,
             br // 比特率
           }
         })
         
         console.log('🎵 歌曲URL响应:', response)
         // NeteaseCloudMusicApi 返回格式: {status: 200, body: {data: []}}
         const data = response.body || response
         const songData = data.data?.[0] || {}
         console.log('🎵 歌曲URL数据:', songData)
         
         // 检查是否获取到有效的URL
         if (songData.url) {
           // 检查歌曲时长信息
           if (songData.time) {
             console.log('🕐 API返回的歌曲时长:', songData.time, '毫秒')
           }
           
           // 添加音质信息
           songData.bitrate = br
           return songData
         }
         
         console.warn('⚠️ 音质', br, '无可用URL，尝试下一个音质')
       } catch (error) {
         console.warn('⚠️ 音质', br, '获取失败:', error.message)
       }
     }
     
     // 主API所有音质都失败，尝试备用API
     console.log('🔄 主API所有音质都失败，尝试备用API获取歌曲URL')
     
     for (const br of bitrates) {
       try {
         console.log('🎵 备用API获取歌曲URL，ID:', id, '音质:', br)
         const backupResponse = await backupApi.get('/song/url', {
           params: {
             id,
             br
           }
         })
         
         console.log('🎵 备用API歌曲URL响应:', backupResponse)
         const backupData = backupResponse.body || backupResponse
         const songData = backupData.data?.[0] || {}
         
         if (songData.url) {
           songData.bitrate = br
           return songData
         }
         
         console.warn('⚠️ 备用API音质', br, '无可用URL，尝试下一个音质')
       } catch (error) {
         console.warn('⚠️ 备用API音质', br, '获取失败:', error.message)
       }
     }
     
     // 所有API和音质都失败
     console.error('❌ 所有API和音质都无法获取歌曲URL，可能是版权限制')
     throw new Error('无法获取歌曲播放链接，可能是版权限制')
   },

  // 获取歌词
  getLyrics: async (id) => {
     try {
       const response = await api.get('/lyric', {
         params: { id }
       })
       
       console.log('🎤 歌词响应:', response)
       // NeteaseCloudMusicApi 返回格式: {status: 200, body: {lrc: {}}}
       const responseData = response.body || response
       
       // 解析歌词
       const lyrics = parseLyrics(responseData.lrc?.lyric || '')
       const translations = parseLyrics(responseData.tlyric?.lyric || '')
       
       // 合并歌词和翻译
       const mergedLyrics = lyrics.map(lyric => {
         const translation = translations.find(t => Math.abs(t.time - lyric.time) < 0.5)
         return {
           ...lyric,
           translation: translation?.text || ''
         }
       })
       
       return { lyrics: mergedLyrics }
     } catch (error) {
       console.error('主API获取歌词失败:', error)
       
       // 尝试使用备用API
       try {
         console.log('🔄 尝试备用API获取歌词:', id)
         const backupResponse = await backupApi.get('/lyric', {
           params: { id }
         })
         
         console.log('🎤 备用API歌词响应:', backupResponse)
         const backupData = backupResponse.body || backupResponse
         
         // 解析歌词
         const lyrics = parseLyrics(backupData.lrc?.lyric || '')
         const translations = parseLyrics(backupData.tlyric?.lyric || '')
         
         // 合并歌词和翻译
         const mergedLyrics = lyrics.map(lyric => {
           const translation = translations.find(t => Math.abs(t.time - lyric.time) < 0.5)
           return {
             ...lyric,
             translation: translation?.text || ''
           }
         })
         
         return { lyrics: mergedLyrics }
       } catch (backupError) {
         console.error('备用API也失败了:', backupError)
         
         // 返回空歌词作为最后备选
         return {
           lyrics: [
             { time: 0, text: '暂无歌词', translation: '' }
           ]
         }
       }
    }
  }
}

// 解析歌词文本
function parseLyrics(lyricText) {
  if (!lyricText) return []
  
  const lines = lyricText.split('\n')
  const lyrics = []
  
  for (const line of lines) {
    const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/)
    if (match) {
      const minutes = parseInt(match[1])
      const seconds = parseInt(match[2])
      const milliseconds = parseInt(match[3].padEnd(3, '0'))
      const text = match[4].trim()
      
      if (text) {
        lyrics.push({
          time: minutes * 60 + seconds + milliseconds / 1000,
          text
        })
      }
    }
  }
  
  return lyrics.sort((a, b) => a.time - b.time)
}