<template>
  <div id="app" class="min-h-screen lg:h-screen lg:overflow-hidden">
    <!-- 顶部导航 -->
    <TopNavigation />

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-32 md:pb-32 lg:pb-0 desktop-content">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- 左侧：歌单列表 -->
        <div class="lg:col-span-1">
          <PlaylistPanel
            :active-tab="activeTab"
            v-model:search-query="searchQuery"
            :loading="loading"
            :playlists="playlists"
            :selected-playlist="selectedPlaylist"
            :user-playlists="userPlaylists"
            :search-results="searchResults"
            :current-page="playlistCurrentPage"
            :page-size="playlistPageSize"
            @update:active-tab="activeTab = $event"
            @search="searchPlaylists"
            @search-by-id="loadPlaylistByIdAndAdd"
            @select-playlist="selectPlaylist"
            @add-playlist="addPlaylistToLibrary"
            @remove-playlist="removePlaylistFromLibrary"
            @go-to-page="goToPlaylistPage"
            @prev-page="prevPlaylistPage"
            @next-page="nextPlaylistPage"
          />
        </div>

        <!-- 中间：歌曲列表 -->
        <div class="lg:col-span-1">
          <SongList
            :songs="songs"
            :loading-songs="loadingSongs"
            :current-song="currentSong"
            :is-playing="isPlaying"
            :show-vip-songs="showVipSongs"
            :play-mode-text="getPlayModeText()"
            :current-page="currentPage"
            :page-size="pageSize"
            @play-song="playSong"
            @toggle-play-mode="togglePlayMode"
            @toggle-vip-songs="showVipSongs = !showVipSongs"
            @go-to-page="goToPage"
            @prev-page="prevPage"
            @next-page="nextPage"
          />
        </div>

        <!-- 右侧：歌词面板 -->
        <div class="lg:col-span-1">
          <LyricsPanel
            :current-song="currentSong"
            :is-playing="isPlaying"
            :lyrics="lyrics"
            :current-lyric-index="currentLyricIndex"
            :auto-follow-lyrics="autoFollowLyrics"
            :loading-lyrics="loadingLyrics"
            :song-switching="songSwitching"
            :duration-warning="durationWarning"
            @toggle-auto-follow-lyrics="toggleAutoFollowLyrics"
            @previous-song="previousSong"
            @next-song="nextSong"
          />
        </div>
      </div>

      <!-- 底部播放器 -->
      <BottomPlayer
        v-if="currentSong"
        :current-song="currentSong"
        :is-playing="isPlaying"
        :current-time="currentTime"
        :duration="duration"
        :volume="volume"
        :song-switching="songSwitching"
        @toggle-play="togglePlay"
        @previous-song="previousSong"
        @next-song="nextSong"
        @seek-to="seekTo"
        @update-volume="updateVolume"
      />
    </div>
    
    <!-- 页脚 -->
    <Footer />
  </div>
</template>

<script>
console.log('🎯 App.vue script 开始执行')
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { Howl } from 'howler'
import { musicApi } from './api/music'
import TopNavigation from './components/TopNavigation.vue'
import PlaylistPanel from './components/PlaylistPanel.vue'
import SongList from './components/SongList.vue'
import LyricsPanel from './components/LyricsPanel.vue'
import BottomPlayer from './components/BottomPlayer.vue'
import Footer from './components/Footer.vue'
console.log('📦 所有导入完成，musicApi:', musicApi)

export default {
  name: 'App',
  components: {
    TopNavigation,
    PlaylistPanel,
    SongList,
    LyricsPanel,
    BottomPlayer,
    Footer
  },
  setup() {
    // 响应式数据
    const searchQuery = ref('')
    const loading = ref(false)
    const loadingSongs = ref(false)
    const searchResults = ref([]) // 搜索结果
    const userPlaylists = ref([]) // 用户添加的歌单
    const selectedPlaylist = ref(null)
    const songs = ref([])
    const currentSong = ref(null)
    const currentSongIndex = ref(0)
    const activeTab = ref('my') // 控制选项卡：'my' 或 'discover'
    const showVipSongs = ref(true) // 控制VIP歌曲显示，默认显示
    const playMode = ref('list') // 播放模式：'list'(列表播放), 'loop'(列表循环), 'single'(单曲循环)
    const lyrics = ref([])
    const currentLyricIndex = ref(0)
    const autoFollowLyrics = ref(true) // 歌词自动跟随，默认开启
    const songSwitching = ref(false) // 歌曲切换提示
    const isPlaying = ref(false)
    const currentTime = ref(0)
    const duration = ref(0)
    const volume = ref(80)
    const durationWarning = ref('')
    const loadingLyrics = ref(false)
    
    // 歌词滚动相关
    const lyricsContainer = ref(null)
    const playerContainer = ref(null)
    
    // 分页相关数据
    const currentPage = ref(1)
    const pageSize = ref(10)
    
    // 歌单分页相关数据
    const playlistCurrentPage = ref(1)
    const playlistPageSize = ref(10)
    
    let howl = null
    let lyricTimer = null

    // 计算属性
    const progressPercentage = computed(() => {
      return duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0
    })
    
    // 合并的歌单列表（用户库 + 搜索结果）
    const playlists = computed(() => {
      if (activeTab.value === 'my') {
        return userPlaylists.value
      } else {
        return searchResults.value
      }
    })
    
    // 过滤后的歌曲列表（根据VIP显示设置）
    const filteredSongs = computed(() => {
      if (showVipSongs.value) {
        return songs.value // 显示所有歌曲
      } else {
        return songs.value.filter(song => !(song.fee === 1 || song.privilege?.fee === 1)) // 隐藏VIP歌曲
      }
    })
    
    // 分页计算属性
    const totalPages = computed(() => {
      return Math.ceil(filteredSongs.value.length / pageSize.value)
    })
    
    const paginatedSongs = computed(() => {
      const start = (currentPage.value - 1) * pageSize.value
      const end = start + pageSize.value
      return filteredSongs.value.slice(start, end)
    })

    // 分页控制函数
    const goToPage = (page) => {
      if (page >= 1 && page <= totalPages.value) {
        currentPage.value = page
      }
    }
    
    const prevPage = () => {
      if (currentPage.value > 1) {
        currentPage.value--
      }
    }
    
    const nextPage = () => {
      if (currentPage.value < totalPages.value) {
        currentPage.value++
      }
    }

    // 歌单分页控制函数
    const goToPlaylistPage = (page) => {
      const maxPages = activeTab.value === 'my' 
        ? Math.ceil(userPlaylists.value.length / playlistPageSize.value)
        : Math.ceil(searchResults.value.length / playlistPageSize.value)
      if (page >= 1 && page <= maxPages) {
        playlistCurrentPage.value = page
      }
    }
    
    const prevPlaylistPage = () => {
      if (playlistCurrentPage.value > 1) {
        playlistCurrentPage.value--
      }
    }
    
    const nextPlaylistPage = () => {
      const maxPages = activeTab.value === 'my' 
        ? Math.ceil(userPlaylists.value.length / playlistPageSize.value)
        : Math.ceil(searchResults.value.length / playlistPageSize.value)
      if (playlistCurrentPage.value < maxPages) {
        playlistCurrentPage.value++
      }
    }

    // 歌单处理函数
    const extractPlaylistId = (input) => {
      if (!input) return null
      
      // 直接的数字ID
      if (/^\d+$/.test(input.trim())) {
        return input.trim()
      }
      
      // 网易云音乐分享链接
      const shareMatch = input.match(/id=(\d+)/)
      if (shareMatch) {
        return shareMatch[1]
      }
      
      // 网易云音乐网页链接
      const webMatch = input.match(/playlist\/(\d+)/)
      if (webMatch) {
        return webMatch[1]
      }
      
      return null
    }

    const handleSearch = async () => {
      const query = searchQuery.value.trim()
      if (!query) return
      
      const playlistId = extractPlaylistId(query)
      if (playlistId) {
        await loadPlaylistByIdAndAdd(playlistId)
      } else {
        await searchPlaylists(query)
      }
    }

    const loadPlaylistByIdAndAdd = async (id) => {
      try {
        loading.value = true
        console.log('🔍 通过ID加载歌单:', id)
        
        // 检查是否已存在（确保ID类型一致）
        const exists = userPlaylists.value.find(p => String(p.id) === String(id))
        if (exists) {
          console.log('ℹ️ 歌单已存在于库中:', exists.name)
          searchQuery.value = ''
          return
        }
        
        const playlist = await musicApi.getPlaylistDetail(id)
        if (playlist) {
          console.log('✅ 歌单加载成功:', playlist.name)
          await addPlaylistToLibrary(playlist)
          console.log('✅ 歌单已添加到库中')
          
          // 清空搜索框
          searchQuery.value = ''
        }
      } catch (error) {
        console.error('❌ 加载歌单失败:', error)
      } finally {
        loading.value = false
      }
    }

    const loadPlaylistById = async (id) => {
      try {
        console.log('🔍 加载歌单详情:', id)
        const playlist = await musicApi.getPlaylistDetail(id)
        return playlist
      } catch (error) {
        console.error('❌ 加载歌单详情失败:', error)
        return null
      }
    }

    const searchPlaylists = async (query) => {
      try {
        loading.value = true
        console.log('🔍 搜索歌单:', query)
        
        const results = await musicApi.searchPlaylists(query)
        searchResults.value = results.playlists || []
        
        console.log('✅ 搜索完成，找到', searchResults.value.length, '个歌单')
      } catch (error) {
        console.error('❌ 搜索歌单失败:', error)
        searchResults.value = []
      } finally {
        loading.value = false
      }
    }

    const addPlaylistToLibrary = async (playlist) => {
      try {
        // 检查是否已存在（确保ID类型一致）
        const exists = userPlaylists.value.find(p => String(p.id) === String(playlist.id))
        if (exists) {
          console.log('ℹ️ 歌单已存在:', exists.name)
          return
        }
        
        // 确保歌单包含完整的tracks数据
        let fullPlaylist = playlist
        if (!playlist.tracks || playlist.tracks.length === 0) {
          console.log('🔄 歌单缺少tracks数据，从服务器获取完整信息...')
          try {
            fullPlaylist = await musicApi.getPlaylistDetail(playlist.id)
            console.log('✅ 获取完整歌单数据成功，歌曲数量:', fullPlaylist.tracks?.length || 0)
          } catch (error) {
            console.error('❌ 获取完整歌单数据失败，使用原始数据:', error)
            fullPlaylist = playlist
          }
        }
        
        userPlaylists.value.push(fullPlaylist)
        savePlaylistsToStorage()
        console.log('✅ 歌单已添加:', fullPlaylist.name)
      } catch (error) {
        console.error('❌ 添加歌单失败:', error)
      }
    }

    const removePlaylistFromLibrary = (playlistId) => {
      const index = userPlaylists.value.findIndex(p => p.id === playlistId)
      if (index > -1) {
        const playlist = userPlaylists.value[index]
        userPlaylists.value.splice(index, 1)
        
        // 如果是默认歌单，记录到已移除列表中
        if (playlist.isDefault) {
          const removedIds = getRemovedDefaultPlaylists()
          if (!removedIds.includes(playlistId)) {
            removedIds.push(playlistId)
            localStorage.setItem('removedDefaultPlaylists', JSON.stringify(removedIds))
          }
        }
        
        savePlaylistsToStorage()
        console.log('✅ 歌单已移除:', playlist.name)
        
        // 如果移除的是当前选中的歌单，清空选择
        if (selectedPlaylist.value?.id === playlistId) {
          selectedPlaylist.value = null
          songs.value = []
        }
      }
    }

    // 本地存储操作
    const getRemovedDefaultPlaylists = () => {
      const removed = localStorage.getItem('removedDefaultPlaylists')
      return removed ? JSON.parse(removed) : []
    }

    const savePlaylistsToStorage = () => {
      // 保存所有歌单，包括默认歌单
      localStorage.setItem('userPlaylists', JSON.stringify(userPlaylists.value))
    }

    const loadPlaylistsFromStorage = () => {
      const saved = localStorage.getItem('userPlaylists')
      if (saved) {
        const savedPlaylists = JSON.parse(saved)
        userPlaylists.value.push(...savedPlaylists)
        console.log('✅ 从本地存储加载歌单:', savedPlaylists.length, '个')
      }
    }

    // 歌单选择
    const selectPlaylist = async (playlist) => {
      if (selectedPlaylist.value?.id === playlist.id) return
      
      try {
        loadingSongs.value = true
        selectedPlaylist.value = playlist
        currentPage.value = 1 // 重置分页
        
        console.log('🎵 加载歌单歌曲:', playlist.name)
        
        // 强制从服务器重新获取最新的歌单信息和歌曲数据
        console.log('🔄 从服务器获取最新歌单数据...')
        const fullPlaylist = await musicApi.getPlaylistDetail(playlist.id)
        songs.value = fullPlaylist.tracks || []
        console.log('✅ 获取最新歌曲完成，共', songs.value.length, '首')
        
        // 更新本地歌单库中的数据
        const playlistIndex = userPlaylists.value.findIndex(p => p.id === playlist.id)
        if (playlistIndex !== -1) {
          userPlaylists.value[playlistIndex] = { ...userPlaylists.value[playlistIndex], ...fullPlaylist }
          savePlaylistsToStorage()
          console.log('✅ 已更新本地歌单数据')
        }
      } catch (error) {
        console.error('❌ 加载歌曲失败:', error)
        songs.value = []
      } finally {
        loadingSongs.value = false
      }
    }

    // 歌曲播放逻辑
    const playSong = async (song, index) => {
      try {
        console.log('🎵 播放歌曲:', song.name)
        
        // 设置歌曲切换状态
        songSwitching.value = true
        durationWarning.value = ''
        
        // 停止当前播放
        if (howl) {
          howl.stop()
          howl.unload()
        }
        
        // 清除歌词定时器
        if (lyricTimer) {
          clearInterval(lyricTimer)
          lyricTimer = null
        }
        
        currentSong.value = song
        currentSongIndex.value = index
        isPlaying.value = false
        currentTime.value = 0
        duration.value = 0
        
        // 获取歌曲播放URL
        const songUrlData = await musicApi.getSongUrl(song.id)
        if (!songUrlData || !songUrlData.url) {
          console.error('❌ 无法获取歌曲播放链接')
          songSwitching.value = false
          return
        }
        
        console.log('🔗 歌曲URL获取成功:', songUrlData.url)
        
        // 创建Howler实例
        howl = new Howl({
          src: [songUrlData.url],
          html5: true,
          preload: true,
          onload: () => {
            console.log('✅ 歌曲加载完成')
            duration.value = howl.duration()
            
            // 检查时长
            const expectedDuration = (song.dt || song.duration) / 1000
            const actualDuration = howl.duration()
            
            if (Math.abs(expectedDuration - actualDuration) > 5) {
              durationWarning.value = `时长不匹配：预期 ${formatTime(expectedDuration)}，实际 ${formatTime(actualDuration)}`
            }
            
            songSwitching.value = false
            howl.play()
          },
          onplay: () => {
            console.log('▶️ 开始播放')
            isPlaying.value = true
            updateProgress()
          },
          onpause: () => {
            console.log('⏸️ 暂停播放')
            isPlaying.value = false
          },
          onstop: () => {
            console.log('⏹️ 停止播放')
            isPlaying.value = false
            currentTime.value = 0
          },
          onend: () => {
            console.log('🔚 播放结束')
            handleSongEnd()
          },
          onloaderror: (id, error) => {
            console.error('❌ 歌曲加载错误:', error)
            songSwitching.value = false
          },
          onplayerror: (id, error) => {
            console.error('❌ 播放错误:', error)
            songSwitching.value = false
          }
        })
        
        // 设置音量
        howl.volume(volume.value / 100)
        
        // 加载歌词
        await loadLyrics(song.id)
        
      } catch (error) {
        console.error('❌ 播放歌曲失败:', error)
        songSwitching.value = false
      }
    }

    // 歌词加载和同步
    const loadLyrics = async (songId) => {
      try {
        loadingLyrics.value = true
        console.log('📝 加载歌词:', songId)
        
        const lyricsData = await musicApi.getLyrics(songId)
        lyrics.value = lyricsData?.lyrics || []
        currentLyricIndex.value = 0
        
        console.log('✅ 歌词加载完成，共', lyrics.value.length, '行')
        
        // 开始歌词同步
        if (lyrics.value.length > 0) {
          startLyricSync()
        }
      } catch (error) {
        console.error('❌ 加载歌词失败:', error)
        lyrics.value = []
      } finally {
        loadingLyrics.value = false
      }
    }

    const startLyricSync = () => {
      if (lyricTimer) {
        clearInterval(lyricTimer)
      }
      
      lyricTimer = setInterval(() => {
        if (!howl || !isPlaying.value || lyrics.value.length === 0) return
        
        const currentTimeSeconds = howl.seek()
        
        // 找到当前时间对应的歌词行
        let newIndex = 0
        for (let i = lyrics.value.length - 1; i >= 0; i--) {
          if (currentTimeSeconds >= lyrics.value[i].time) {
            newIndex = i
            break
          }
        }
        
        if (newIndex !== currentLyricIndex.value) {
          currentLyricIndex.value = newIndex
        }
      }, 100)
    }

    // 播放进度更新
    const updateProgress = () => {
      if (howl && isPlaying.value) {
        currentTime.value = howl.seek()
        requestAnimationFrame(updateProgress)
      }
    }

    // 播放控制
    const togglePlay = () => {
      if (!howl) return
      
      if (isPlaying.value) {
        howl.pause()
      } else {
        howl.play()
      }
    }

    const previousSong = () => {
      if (filteredSongs.value.length === 0) return
      
      let newIndex
      if (playMode.value === 'single') {
        // 单曲循环模式下，重新播放当前歌曲
        newIndex = currentSongIndex.value
      } else {
        // 列表播放和列表循环模式
        newIndex = currentSongIndex.value - 1
        if (newIndex < 0) {
          if (playMode.value === 'loop') {
            newIndex = filteredSongs.value.length - 1
          } else {
            return // 列表播放模式下，到达第一首就停止
          }
        }
      }
      
      const song = filteredSongs.value[newIndex]
      if (song) {
        playSong(song, newIndex)
      }
    }

    const nextSong = () => {
      if (filteredSongs.value.length === 0) return
      
      let newIndex
      if (playMode.value === 'single') {
        // 单曲循环模式下，重新播放当前歌曲
        newIndex = currentSongIndex.value
      } else {
        // 列表播放和列表循环模式
        newIndex = currentSongIndex.value + 1
        if (newIndex >= filteredSongs.value.length) {
          if (playMode.value === 'loop') {
            newIndex = 0
          } else {
            return // 列表播放模式下，到达最后一首就停止
          }
        }
      }
      
      const song = filteredSongs.value[newIndex]
      if (song) {
        playSong(song, newIndex)
      }
    }

    const handleSongEnd = () => {
      if (playMode.value === 'single') {
        // 单曲循环：重新播放当前歌曲
        if (howl) {
          howl.seek(0)
          howl.play()
        }
      } else {
        // 列表播放和列表循环：播放下一首
        nextSong()
      }
    }

    // 播放模式切换
    const togglePlayMode = () => {
      const modes = ['list', 'loop', 'single']
      const currentIndex = modes.indexOf(playMode.value)
      const nextIndex = (currentIndex + 1) % modes.length
      playMode.value = modes[nextIndex]
      console.log('🔄 播放模式切换为:', getPlayModeText())
    }

    const getPlayModeText = () => {
      switch (playMode.value) {
        case 'list': return '列表播放'
        case 'loop': return '列表循环'
        case 'single': return '单曲循环'
        default: return '列表播放'
      }
    }

    const getPlayModeIcon = () => {
      switch (playMode.value) {
        case 'list': return '📋'
        case 'loop': return '🔁'
        case 'single': return '🔂'
        default: return '📋'
      }
    }

    // 进度条点击跳转
    const seekTo = (event) => {
      if (!howl || !duration.value) return
      
      const rect = event.currentTarget.getBoundingClientRect()
      const clickX = event.clientX - rect.left
      const percentage = clickX / rect.width
      const seekTime = percentage * duration.value
      
      howl.seek(seekTime)
      currentTime.value = seekTime
    }

    // 音量控制
    const updateVolume = (newVolume) => {
      const volumeValue = parseInt(newVolume)
      volume.value = volumeValue
      
      if (howl) {
        howl.volume(volumeValue / 100)
      }
    }

    // 时间格式化
    const formatTime = (seconds) => {
      if (!seconds || isNaN(seconds)) return '0:00'
      
      const mins = Math.floor(seconds / 60)
      const secs = Math.floor(seconds % 60)
      return `${mins}:${secs.toString().padStart(2, '0')}`
    }

    const formatDuration = (ms) => {
      if (!ms) return '0:00'
      return formatTime(ms / 1000)
    }

    // 歌词自动跟随切换
    const toggleAutoFollowLyrics = () => {
      autoFollowLyrics.value = !autoFollowLyrics.value
      console.log('🎯 歌词自动跟随:', autoFollowLyrics.value ? '开启' : '关闭')
    }

    // 监听歌词索引变化，自动滚动
    watch(currentLyricIndex, (newIndex) => {
      if (!autoFollowLyrics.value || !lyricsContainer.value) return
      
      nextTick(() => {
        const lyricElement = lyricsContainer.value.querySelector(`[data-lyric-index="${newIndex}"]`)
        if (lyricElement) {
          lyricElement.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
          })
        }
      })
    })

    // 监听VIP歌曲显示状态变化，重置分页
    watch(showVipSongs, () => {
      currentPage.value = 1
    })

    // 监听选项卡切换，重置歌单分页
    watch(activeTab, () => {
      playlistCurrentPage.value = 1
    })

    // 从URL参数获取歌单ID列表
    const getPlaylistIdsFromUrl = () => {
      const urlParams = new URLSearchParams(window.location.search)
      const playlistParam = urlParams.get('playlists') || urlParams.get('playlist')
      
      if (!playlistParam) {
        // 如果没有URL参数，返回空数组
        return []
      }
      
      // 支持多种格式：
      // ?playlist=123456 (单个歌单)
      // ?playlists=123456,789012 (多个歌单，逗号分隔)
      // ?playlists=123456|789012 (多个歌单，竖线分隔)
      const ids = playlistParam.split(/[,|]/).map(id => id.trim()).filter(id => /^\d+$/.test(id))
      
      console.log('🔗 从URL获取歌单ID:', ids)
      return ids
    }

    // 检查是否为首次访问
    const isFirstVisit = () => {
      const saved = localStorage.getItem('userPlaylists')
      const hasVisited = localStorage.getItem('hasVisited')
      return !saved && !hasVisited
    }

    // URL歌单加载
    const loadDefaultPlaylists = async () => {
      try {
        console.log('🎵 检查是否需要加载URL歌单...')
        
        // 获取URL参数中的歌单ID
        const urlPlaylistIds = getPlaylistIdsFromUrl()
        
        // 如果没有URL参数，跳过加载
        if (urlPlaylistIds.length === 0) {
          console.log('✅ 无URL歌单参数，跳过加载')
          // 标记已访问
          localStorage.setItem('hasVisited', 'true')
          return
        }
        
        console.log('🔗 检测到URL歌单参数，加载指定歌单:', urlPlaylistIds)
        const defaultPlaylistIds = urlPlaylistIds
        
        const removedIds = getRemovedDefaultPlaylists()
        
        // 过滤掉已移除的歌单ID和已存在的歌单ID
        const validIds = defaultPlaylistIds.filter(id => {
          if (removedIds.includes(id)) {
            console.log('⏭️ 跳过已移除的默认歌单:', id)
            return false
          }
          
          // 检查是否已存在相同ID的歌单（确保ID类型一致）
          const exists = userPlaylists.value.find(p => String(p.id) === String(id))
          if (exists) {
            console.log('⏭️ 跳过已存在的歌单:', id, exists.name)
            return false
          }
          
          return true
        })
        
        if (validIds.length === 0) {
          console.log('✅ 所有默认歌单都已被用户删除，跳过加载')
          // 标记已访问
          localStorage.setItem('hasVisited', 'true')
          return
        }
        
        console.log('🌐 加载歌单:', validIds)
        
        // 并行加载所有歌单
        const playlistPromises = validIds.map(async (id) => {
          try {
            const playlist = await loadPlaylistById(id)
            if (playlist) {
              playlist.isDefault = true
              console.log('✅ 默认歌单加载成功:', playlist.name)
              return playlist
            }
          } catch (error) {
            console.error('❌ 加载默认歌单失败:', id, error)
            return null
          }
        })
        
        // 等待所有歌单加载完成
        const playlists = await Promise.all(playlistPromises)
        
        // 将成功加载的歌单添加到用户歌单列表
        playlists.forEach(playlist => {
          if (playlist) {
            userPlaylists.value.push(playlist)
          }
        })
        
        // 保存到本地存储
        if (playlists.some(p => p)) {
          savePlaylistsToStorage()
        }
        
        // 标记已访问
        localStorage.setItem('hasVisited', 'true')
        
        console.log('✅ URL歌单加载完成')
      } catch (error) {
        console.error('❌ 加载URL歌单失败:', error)
      }
    }

    // 组件挂载
    onMounted(async () => {
      console.log('🚀 App组件挂载完成')
      
      // 加载保存的歌单
      loadPlaylistsFromStorage()
      
      // 加载默认歌单
      await loadDefaultPlaylists()
      
      console.log('✅ 初始化完成，用户歌单数量:', userPlaylists.value.length)
    })

    return {
      // 响应式数据
      searchQuery,
      loading,
      loadingSongs,
      searchResults,
      userPlaylists,
      selectedPlaylist,
      songs,
      currentSong,
      currentSongIndex,
      activeTab,
      showVipSongs,
      playMode,
      lyrics,
      currentLyricIndex,
      autoFollowLyrics,
      songSwitching,
      isPlaying,
      currentTime,
      duration,
      volume,
      durationWarning,
      loadingLyrics,
      lyricsContainer,
      playerContainer,
      currentPage,
      pageSize,
      playlistCurrentPage,
      playlistPageSize,
      
      // 计算属性
      progressPercentage,
      playlists,
      filteredSongs,
      totalPages,
      paginatedSongs,
      
      // 方法
      goToPage,
      prevPage,
      nextPage,
      goToPlaylistPage,
      prevPlaylistPage,
      nextPlaylistPage,
      extractPlaylistId,
      handleSearch,
      loadPlaylistByIdAndAdd,
      loadPlaylistById,
      searchPlaylists,
      addPlaylistToLibrary,
      removePlaylistFromLibrary,
      getRemovedDefaultPlaylists,
      savePlaylistsToStorage,
      loadPlaylistsFromStorage,
      selectPlaylist,
      playSong,
      loadLyrics,
      startLyricSync,
      updateProgress,
      togglePlay,
      previousSong,
      nextSong,
      handleSongEnd,
      togglePlayMode,
      getPlayModeText,
      getPlayModeIcon,
      seekTo,
      updateVolume,
      formatTime,
      formatDuration,
      toggleAutoFollowLyrics,
      loadDefaultPlaylists
    }
  }
}
</script>