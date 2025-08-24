<template>
  <div class="min-h-screen relative desktop-fullscreen">

    
    <!-- 顶部导航 -->
    <nav class="pt-4">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="jirai-card py-6">
        <div class="flex justify-center items-center">
          <div class="flex items-center justify-center">
            <h1 class="jirai-title flex items-center">
              MeowSync
            </h1>
          </div>
        </div>
        </div>
      </div>
    </nav>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-32 md:pb-32 lg:pb-24 desktop-content">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
        <!-- 左侧：歌单列表 -->
        <div class="lg:col-span-1">
          <div class="jirai-card p-6 max-h-96 overflow-y-auto">
            <!-- 选项卡导航 -->
            <div class="flex mb-4 sticky top-0 backdrop-blur-md z-10 -mx-6 px-6">
              <button
                @click="showAddPlaylist = false"
                class="flex-1 py-2 px-4 text-center transition-all duration-200 border-2 relative overflow-hidden group"
                :class="!showAddPlaylist ? 'bg-pink-900 border-pink-500 text-pink-100 shadow-inner' : 'bg-gray-900 border-gray-600 text-gray-300 hover:bg-pink-950 hover:border-pink-600 hover:text-pink-200 border-r-0'"
                style="border-radius: 0; box-shadow: inset 0 2px 4px rgba(0,0,0,0.3);"
              >
                <span class="relative z-10 font-bold tracking-wide text-sm uppercase">我的歌单</span>
                <div class="absolute inset-0 bg-pink-800/20 opacity-0 group-hover:opacity-100 transition-opacity duration-200"></div>
              </button>
              <button
                @click="showAddPlaylist = true"
                class="flex-1 py-2 px-4 text-center transition-all duration-200 border-2 relative overflow-hidden group"
                :class="showAddPlaylist ? 'bg-pink-900 border-pink-500 text-pink-100 shadow-inner' : 'bg-gray-900 border-gray-600 text-gray-300 hover:bg-pink-950 hover:border-pink-600 hover:text-pink-200 border-l-0'"
                style="border-radius: 0; box-shadow: inset 0 2px 4px rgba(0,0,0,0.3);"
              >
                <span class="relative z-10 font-bold tracking-wide text-sm uppercase">发现歌单</span>
                <div class="absolute inset-0 bg-pink-800/20 opacity-0 group-hover:opacity-100 transition-opacity duration-200"></div>
              </button>
            </div>
            
            <!-- 搜索框（仅在发现歌单选项卡显示） -->
            <div v-if="showAddPlaylist" class="mb-4 -mx-6 px-6">
              <div class="flex items-center space-x-1">
                <input
                  v-model="searchQuery"
                  @keyup.enter="handleSearch"
                  type="text"
                  placeholder="搜索歌单或输入ID/URL"
                  class="pixel-input flex-1 py-2 px-3"
                  style="border-radius: 0; position: relative; z-index: 1;"
                />
                <button
                  @click="handleSearch"
                  class="pixel-button py-2 px-3"
                  :disabled="!searchQuery.trim()"
                  style="border-radius: 0; flex-shrink: 0;"
                >
                  {{ extractPlaylistId(searchQuery) ? '添加' : '搜索' }}
                </button>
              </div>
            </div>
            
            <div v-if="loading" class="text-center py-8">
              <div class="pixel-loading mx-auto mb-4"></div>
              <p class="text-pink-300 flex justify-center items-center">加载中喵...</p>
            </div>
            
            <!-- 我的歌单库 -->
            <div v-else-if="!showAddPlaylist" class="space-y-3 -mx-6 px-6">
              <div v-if="userPlaylists.length === 0" class="text-center py-8">
                <p class="text-gray-600 flex justify-center items-center">还没有添加歌单喵~</p>
                <p class="text-sm text-purple-300 mt-2">点击上方"发现歌单"标签开始搜索吧！</p>
              </div>
              <div class="space-y-2" v-else>
                <div
                  v-for="playlist in userPlaylists"
                  :key="playlist.id"
                  class="music-card cursor-pointer p-4 jirai-card transition-all w-full relative group"
                  :class="{ 'border-purple-400': selectedPlaylist?.id === playlist.id }"
                >
                  <div @click="selectPlaylist(playlist)" class="flex items-center space-x-3">
                    <div class="relative">
                      <img
                        :src="playlist.coverImgUrl"
                        :alt="playlist.name"
                        class="w-12 h-12 object-cover border-2 border-pink-400"
                        style="border-radius: 0; image-rendering: pixelated;"
                      />
                    </div>
                    <div class="flex-1 min-w-0">
                      <h3 class="font-semibold text-pink-300 truncate">{{ playlist.name }}</h3>
                      <p class="text-sm text-purple-300 truncate">{{ playlist.creator?.nickname || '神秘创建者' }}</p>
                    </div>
                    <div class="text-xs text-gray-400">
                      {{ playlist.trackCount }} 首
                    </div>
                  </div>
                  <button
                    @click.stop="removePlaylistFromLibrary(playlist.id)"
                    class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-red-600 hover:bg-red-700 text-white text-xs px-2 py-1 border border-red-400"
                    style="border-radius: 0;"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            </div>
            
            <!-- 搜索结果 -->
            <div v-else class="space-y-3 -mx-6 px-6">
              <div v-if="searchResults.length === 0 && !loading" class="text-center py-8">
                <p class="text-gray-600 flex justify-center items-center">搜索歌单来添加到你的库中喵~</p>
              </div>
              <div v-else>
                <div
                  v-for="playlist in searchResults"
                  :key="playlist.id"
                  class="music-card cursor-pointer p-4 jirai-card transition-all w-full relative group"
                >
                  <div class="flex items-center space-x-3">
                    <div class="relative">
                      <img
                        :src="playlist.coverImgUrl"
                        :alt="playlist.name"
                        class="w-12 h-12 object-cover border-2 border-pink-400"
                        style="border-radius: 0; image-rendering: pixelated;"
                      />
                      <div class="absolute -top-1 -right-1 text-xs flex items-center justify-center">🌟</div>
                    </div>
                    <div class="flex-1 min-w-0">
                      <h3 class="font-semibold text-pink-300 truncate">{{ playlist.name }}</h3>
                      <p class="text-sm text-purple-300 truncate">{{ playlist.creator?.nickname || '神秘创建者' }}</p>
                    </div>
                    <div class="text-xs text-gray-400 mr-2">
                      {{ playlist.trackCount }} 首
                    </div>
                    <button
                      @click="addPlaylistToLibrary(playlist)"
                      class="bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1 border border-green-400 transition-colors"
                      style="border-radius: 0;"
                      :disabled="userPlaylists.find(p => p.id === playlist.id)"
                      :class="{ 'opacity-50 cursor-not-allowed': userPlaylists.find(p => p.id === playlist.id) }"
                    >
                      {{ userPlaylists.find(p => p.id === playlist.id) ? '✅ 已添加' : '➕ 添加' }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 中间：歌曲列表 -->
        <div class="lg:col-span-1">
          <div class="jirai-card p-6 max-h-96 overflow-y-auto">
            <h2 class="text-xl font-bold mb-4 flex items-center justify-between text-pink-300 sticky top-0 bg-black/90 z-10 py-2 px-2">
              <span class="flex items-center">歌曲列表</span>
              <div class="flex items-center space-x-2">
                <button
                  @click="togglePlayMode"
                  class="text-xs px-2 py-1 border transition-colors bg-blue-600 text-white border-blue-400 hover:bg-blue-500"
                  style="border-radius: 0;"
                  :title="getPlayModeText()"
                >
                  {{ getPlayModeText() }}
                </button>
                <button
                  @click="showVipSongs = !showVipSongs"
                  class="text-xs px-2 py-1 border transition-colors"
                  :class="showVipSongs ? 'bg-pink-500 text-white border-pink-400' : 'bg-gray-700 text-gray-300 border-gray-500 hover:bg-gray-600'"
                  style="border-radius: 0;"
                  title="切换VIP歌曲显示"
                >
                  {{ showVipSongs ? '隐藏VIP' : '显示VIP' }}
                </button>
              </div>
            </h2>
            
            <div v-if="loadingSongs" class="text-center py-8">
              <div class="pixel-loading mx-auto mb-4"></div>
              <p class="text-pink-300 flex justify-center items-center">加载歌曲中喵...</p>
            </div>
            
            <div v-else-if="songs.length === 0" class="text-center py-8">
              <p class="text-gray-600 flex justify-center items-center">请选择一个歌单喵~</p>
            </div>
            
            <div v-else>
              <div class="space-y-2 mb-4 -mx-6 px-6">
                <div
                  v-for="(song, index) in paginatedSongs"
                  :key="song.id"
                  @click="playSong(song, filteredSongs.findIndex(s => s.id === song.id))"
                  class="music-card cursor-pointer p-4 jirai-card transition-all w-full"
                  :class="{ 
                    'border-purple-400': currentSong?.id === song.id,
                    'opacity-50 grayscale': song.fee === 1 || song.privilege?.fee === 1
                  }"
                >
                <div class="flex items-center space-x-3">
                  <div class="relative">
                    <img
                      :src="song.al?.picUrl || song.album?.picUrl"
                      :alt="song.name"
                      class="w-12 h-12 object-cover border-2 border-pink-400"
                      style="border-radius: 0; image-rendering: pixelated;"
                    />
                    <div v-if="currentSong?.id === song.id && isPlaying" class="absolute inset-0 flex items-center justify-center bg-black/50">
                      <div class="text-pink-300 text-sm animate-pulse flex items-center justify-center">♡</div>
                    </div>
                  </div>
                  <div class="flex-1 min-w-0">
                    <h4 class="font-medium text-pink-300 truncate flex items-center">
                      {{ song.name }}
                      <span v-if="song.fee === 1 || song.privilege?.fee === 1" class="ml-2 text-xs bg-yellow-500 text-black px-1 rounded">VIP</span>
                    </h4>
                    <p class="text-sm text-purple-300 truncate">
                      {{ song.ar?.map(artist => artist.name).join(', ') || song.artists?.map(a => a.name).join(', ') }}
                    </p>
                  </div>
                  <div class="text-xs text-gray-400">
                    {{ formatDuration(song.dt || song.duration) }}
                  </div>
                </div>
                </div>
              </div>
              
              <!-- 歌曲统计信息 -->
              <div class="text-center mt-4 mb-2">
                <span class="text-pink-300 text-sm">
                  显示第 {{ (currentPage - 1) * pageSize + 1 }}-{{ Math.min(currentPage * pageSize, filteredSongs.length) }} 首歌曲
                </span>
              </div>
              
              <!-- 分页控件 -->
              <div v-if="totalPages > 1" class="flex justify-center items-center space-x-1 mt-4 mb-4 p-3 bg-black/90 sticky bottom-0 z-10">
                <button 
                  @click="goToPage(1)" 
                  :disabled="currentPage === 1"
                  class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
                  :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === 1 }"
                >
                  ⇤
                </button>
                
                <button 
                  @click="prevPage" 
                  :disabled="currentPage === 1"
                  class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
                  :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === 1 }"
                >
                  ←
                </button>
                
                <span class="text-pink-300 text-xs px-2 py-1 bg-black/50 min-w-[48px] text-center">
                  {{ currentPage }}/{{ totalPages }}
                </span>
                
                <button 
                  @click="nextPage" 
                  :disabled="currentPage === totalPages"
                  class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
                  :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === totalPages }"
                >
                  →
                </button>
                
                <button 
                  @click="goToPage(totalPages)" 
                  :disabled="currentPage === totalPages"
                  class="pixel-button text-xs px-2 py-1 bg-pink-600 hover:bg-pink-500 text-white font-bold flex items-center justify-center min-w-[32px]"
                  :class="{ 'opacity-50 cursor-not-allowed bg-gray-600': currentPage === totalPages }"
                >
                  ⇥
                </button>
              </div>
              
              <!-- 当只有一页时的提示 -->
              <div v-else-if="filteredSongs.length > 0" class="text-center mt-4 mb-2">
                <span class="text-pink-300 text-sm">
                  共 {{ filteredSongs.length }} 首歌曲
                  <span v-if="!showVipSongs && songs.length > filteredSongs.length" class="text-gray-400">
                    （已隐藏 {{ songs.length - filteredSongs.length }} 首VIP歌曲）
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 右侧：播放器 -->
        <div class="lg:col-span-1">
          <div ref="playerContainer" class="jirai-card p-6 max-h-96 overflow-y-auto">
            <h2 class="text-xl font-bold mb-4 flex items-center justify-between text-pink-300 sticky top-0 bg-black/90 z-10 py-2 px-2">
              <span class="flex items-center">歌词</span>
              <button 
                @click="toggleAutoFollowLyrics" 
                class="text-xs px-2 py-1 border transition-colors"
                :class="{
                  'bg-gray-700 text-gray-300 border-gray-500 hover:bg-gray-600': autoFollowLyrics,
                  'bg-pink-500 text-white border-pink-400': !autoFollowLyrics
                }"
                :title="autoFollowLyrics ? '关闭自动跟随' : '开启自动跟随'"
              >
                {{ autoFollowLyrics ? '跟随' : '手动' }}
              </button>
            </h2>
            
            <div v-if="!currentSong" class="text-center py-8">
              <p class="text-gray-600">选择一首歌开始播放喵~</p>

            </div>
            
            <div v-else class="-mx-6 px-6">
                <!-- 当前播放歌曲信息 -->
                <div class="text-center mb-6">
                <!-- 时长警告提示 -->
                <div v-if="durationWarning" class="mb-3 p-2 bg-yellow-100 border-2 border-yellow-400 text-yellow-800 text-xs">
                  ⚠️ {{ durationWarning }}
                </div>
                
                <div class="relative mx-auto w-32 h-32">
                  <img
                    :src="currentSong.al?.picUrl || currentSong.album?.picUrl"
                    :alt="currentSong.name"
                    class="w-full h-full object-cover border-4 border-pink-400"
                    :class="{ 'playing-animation': isPlaying }"
                    style="border-radius: 0; image-rendering: pixelated;"
                  />

                </div>
                <h3 class="mt-3 text-lg font-bold text-pink-300">{{ currentSong.name }}</h3>
                <p class="text-purple-300">
                  {{ currentSong.ar?.map(a => a.name).join(', ') || currentSong.artists?.map(a => a.name).join(', ') }}
                </p>
              </div>
              
              <div v-if="songSwitching" class="text-center py-8">
                <div class="pixel-loading mx-auto mb-4"></div>
                <p class="text-yellow-300 flex justify-center items-center font-bold">正在切换歌曲喵...</p>
              </div>
              
              <div v-else-if="loadingLyrics" class="text-center py-8">
                <div class="pixel-loading mx-auto mb-4"></div>
                <p class="text-pink-300 flex justify-center items-center">加载歌词中喵...</p>
              </div>
              
              <div v-else ref="lyricsContainer" class="space-y-2 jirai-lyrics">
                <div
                  v-for="(lyric, index) in lyrics"
                  :key="index"
                  :data-lyric-index="index"
                  class="text-center py-1 transition-all duration-300 lyric-line"
                  :class="{
                    'text-pink-300 font-bold text-lg glow-text': index === currentLyricIndex,
                    'text-purple-300': index !== currentLyricIndex
                  }"
                >
                  <p>{{ lyric.text }}</p>
                  <p v-if="lyric.translation" class="text-sm mt-1">
                    {{ lyric.translation }}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部播放器 -->
      <div
        v-if="currentSong"
        class="fixed bottom-0 left-0 right-0 jirai-card z-50 backdrop-blur-md"
        style="margin: 0; border-radius: 0; border-bottom: none; border-left: none; border-right: none; background: rgba(26, 26, 46, 0.95); border-top: 4px solid var(--jirai-pink);"
      >

        
        <div class="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
          <!-- 移动端布局 -->
          <div class="block md:hidden">
            <!-- 进度条 - 移动端顶部 -->
            <div class="py-2">
              <div class="flex items-center space-x-2">
                  <span class="text-xs text-pink-300 w-10 text-center">{{ formatTime(currentTime) }}</span>
                  <div class="flex-1 pixel-progress cursor-pointer" @click="seekTo">
                    <div
                      class="pixel-progress-fill transition-all duration-300"
                      :style="{ width: progressPercentage + '%' }"
                    ></div>
                  </div>
                  <span class="text-xs text-pink-300 w-10 text-center">{{ formatTime(duration) }}</span>
                </div>
            </div>
            
            <!-- 主要控制区域 -->
            <div class="flex items-center justify-between pb-3">
              <!-- 歌曲信息 -->
              <div class="flex items-center space-x-3 flex-1 min-w-0">
                <img
                  :src="currentSong.al?.picUrl"
                  :alt="currentSong.name"
                  class="w-12 h-12 object-cover flex-shrink-0 border-2 border-pink-400"
                  :class="{ 'playing-animation': isPlaying }"
                  style="border-radius: 0; image-rendering: pixelated;"
                />
                <div class="min-w-0 flex-1">
                  <h4 class="font-medium text-pink-300 truncate text-sm">{{ currentSong.name }}</h4>
                  <p class="text-xs text-purple-300 truncate">
                    {{ currentSong.ar?.map(artist => artist.name).join(', ') }}
                  </p>
                </div>
              </div>

              <!-- 播放控制 -->
              <div class="flex items-center space-x-1 flex-shrink-0">
                <button
                  @click="previousSong"
                  class="jirai-button p-1 text-sm w-8 h-8 flex items-center justify-center"
                >
                  ◀◀
                </button>
                <button
                  @click="togglePlay"
                  class="jirai-button-primary p-1 text-sm w-8 h-8 flex items-center justify-center"
                >
                  {{ isPlaying ? '■' : '▶' }}
                </button>
                <button
                  @click="nextSong"
                  class="jirai-button p-1 text-sm w-8 h-8 flex items-center justify-center"
                >
                  ▶▶
                </button>
              </div>
            </div>
          </div>

          <!-- 桌面端布局 -->
          <div class="hidden md:block py-4">
            <!-- 进度条 - 桌面端顶部 -->
            <div class="mb-4">
              <div class="flex items-center space-x-2">
                <span class="text-xs text-pink-300 w-12 text-center">{{ formatTime(currentTime) }}</span>
                <div class="flex-1 pixel-progress cursor-pointer" @click="seekTo">
                  <div
                    class="pixel-progress-fill transition-all duration-300"
                    :style="{ width: progressPercentage + '%' }"
                  ></div>
                </div>
                <span class="text-xs text-pink-300 w-12 text-center">{{ formatTime(duration) }}</span>
              </div>
            </div>
            
            <!-- 主要控制区域 -->
            <div class="flex items-center">
              <!-- 歌曲信息 -->
              <div class="flex items-center space-x-4 flex-1 min-w-0">
                <img
                  :src="currentSong.al?.picUrl"
                  :alt="currentSong.name"
                  class="w-12 h-12 object-cover border-2 border-pink-400"
                  :class="{ 'playing-animation': isPlaying }"
                  style="border-radius: 0; image-rendering: pixelated;"
                />
                <div class="min-w-0 flex-1">
                  <h4 class="font-medium text-pink-300 truncate">{{ currentSong.name }}</h4>
                  <p class="text-sm text-purple-300 truncate">
                    {{ currentSong.ar?.map(artist => artist.name).join(', ') }}
                  </p>
                </div>
              </div>

              <!-- 中央控制区域：播放控制 + 音量控制 -->
              <div class="flex items-center space-x-6">
                <!-- 播放控制 -->
                <div class="flex items-center space-x-4">
                  <button
                    @click="previousSong"
                    class="jirai-button p-3 text-xl w-12 h-12 flex items-center justify-center"
                  >
                    ◀◀
                  </button>
                  <button
                    @click="togglePlay"
                    class="jirai-button-primary p-3 text-xl w-12 h-12 flex items-center justify-center"
                  >
                    {{ isPlaying ? '■' : '▶' }}
                  </button>
                  <button
                    @click="nextSong"
                    class="jirai-button p-3 text-xl w-12 h-12 flex items-center justify-center"
                  >
                    ▶▶
                  </button>
                </div>

                <!-- 音量控制 -->
                <div class="flex items-center space-x-2">
                  <span class="text-lg text-pink-300">♪</span>
                  <input
                    v-model="volume"
                    type="range"
                    min="0"
                    max="100"
                    class="w-20 jirai-slider"
                    @input="updateVolume"
                  />
                  <span class="text-sm text-pink-300 w-8">{{ volume }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 页脚 -->
    <footer class="fixed bottom-0 left-0 right-0 bg-black/90 border-t border-pink-400/50 backdrop-blur-md z-20">
      <div class="max-w-7xl mx-auto px-4 py-3">
        <div class="flex flex-col sm:flex-row items-center justify-between space-y-2 sm:space-y-0">
          <div class="flex items-center space-x-3">
            <span class="text-pink-300 text-xs">MeowSync © 2025</span>
            <span class="text-purple-300 text-xs hidden sm:inline">Made with 💖 & Vue.js</span>
          </div>
          <div class="flex items-center space-x-2">
            <a 
              href="https://github.com/aimkiray/meowsync" 
              target="_blank" 
              rel="noopener noreferrer"
              class="text-pink-300 hover:text-pink-200 transition-colors duration-200 p-1 rounded"
              title="GitHub"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.374 0 0 5.373 0 12 0 17.302 3.438 21.8 8.207 23.387c.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
              </svg>
            </a>
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>

<script>
console.log('🎯 App.vue script 开始执行')
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { Howl } from 'howler'
import { musicApi } from './api/music'
console.log('📦 所有导入完成，musicApi:', musicApi)

export default {
  name: 'App',
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
    const showAddPlaylist = ref(false) // 控制添加歌单界面显示
    const showVipSongs = ref(false) // 控制VIP歌曲显示，默认隐藏
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
    
    let howl = null
    let lyricTimer = null

    // 计算属性
    const progressPercentage = computed(() => {
      return duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0
    })
    
    // 合并的歌单列表（用户库 + 搜索结果）
    const playlists = computed(() => {
      return userPlaylists.value
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

    // 从URL或文本中提取歌单ID
    const extractPlaylistId = (input) => {
      // 匹配网易云音乐歌单URL中的ID
      const urlMatch = input.match(/[?&]id=(\d+)/)
      if (urlMatch) {
        return urlMatch[1]
      }
      
      // 检查是否是纯数字ID
      if (/^\d+$/.test(input.trim())) {
        return input.trim()
      }
      
      return null
    }

    // 处理搜索或直接加载歌单
    const handleSearch = async () => {
      console.log('🔍 handleSearch 被调用，searchQuery:', searchQuery.value)
      if (!searchQuery.value.trim()) {
        console.log('❌ searchQuery 为空，返回')
        return
      }
      
      const playlistId = extractPlaylistId(searchQuery.value)
      console.log('🎵 提取到的歌单ID:', playlistId)
      
      if (playlistId) {
        // 直接加载歌单并添加到库中
        console.log('📋 直接加载歌单:', playlistId)
        await loadPlaylistByIdAndAdd(playlistId)
      } else {
        // 搜索歌单
        console.log('🔍 搜索歌单:', searchQuery.value)
        await searchPlaylists()
      }
    }

    // 通过ID加载歌单并添加到库中
    const loadPlaylistByIdAndAdd = async (playlistId) => {
      console.log('📋 loadPlaylistByIdAndAdd 开始，ID:', playlistId)
      loading.value = true
      try {
        console.log('🌐 调用 musicApi.getPlaylistDetail...')
        const result = await musicApi.getPlaylistDetail(playlistId)
        console.log('📊 API 返回结果:', result)
        
        if (result && (result.playlist || result.id)) {
          const playlistData = result.playlist || result
          const playlist = {
            id: playlistData.id,
            name: playlistData.name,
            coverImgUrl: playlistData.coverImgUrl,
            creator: playlistData.creator,
            trackCount: playlistData.trackCount,
            description: playlistData.description
          }
          
          // 添加到用户库
          addPlaylistToLibrary(playlist)
          
          // 切换到我的歌单视图
          showAddPlaylist.value = false
          
          // 选择这个歌单
          selectPlaylist(playlist)
          
          // 清除搜索框
          searchQuery.value = ''
          
          console.log('✅ 歌单加载并添加成功:', playlist.name)
        } else {
          console.error('❌ 无法获取歌单详情')
        }
      } catch (error) {
        console.error('❌ 加载歌单失败:', error)
      } finally {
        loading.value = false
      }
    }

    // 通过ID直接加载歌单
    const loadPlaylistById = async (playlistId) => {
      console.log('📋 loadPlaylistById 开始，ID:', playlistId)
      loading.value = true
      try {
        console.log('🌐 调用 musicApi.getPlaylistDetail...')
        const result = await musicApi.getPlaylistDetail(playlistId)
        console.log('📊 API 返回结果:', result)
        
        // 创建一个虚拟的歌单对象用于显示
        const playlist = {
          id: playlistId,
          name: result.name || `歌单 ${playlistId}`,
          coverImgUrl: result.coverImgUrl || result.tracks?.[0]?.al?.picUrl || 'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg',
          creator: result.creator || { nickname: '未知用户' },
          trackCount: result.trackCount || result.tracks?.length || 0
        }
        
        // 将歌单添加到列表并选中
        playlists.value = [playlist]
        selectedPlaylist.value = playlist
        songs.value = result.tracks || result.songs || []
        currentPage.value = 1 // 重置分页
        
        console.log(`✅ 成功加载歌单: ${playlist.name}，包含 ${songs.value.length} 首歌曲`)
      } catch (error) {
        console.error('❌ 加载歌单失败:', error)
        alert(`加载歌单失败喵~ ${error.message || '未知错误'}`)
      } finally {
        loading.value = false
      }
    }

    // 搜索歌单
    const searchPlaylists = async () => {
      console.log('🔍 searchPlaylists 开始，关键词:', searchQuery.value)
      loading.value = true
      try {
        console.log('🌐 调用 musicApi.searchPlaylists...')
        const result = await musicApi.searchPlaylists(searchQuery.value)
        console.log('📊 搜索结果:', result)
        
        if (result && result.playlists && result.playlists.length > 0) {
          searchResults.value = result.playlists
          showAddPlaylist.value = true // 显示搜索结果界面
          console.log('✅ 搜索成功，找到', result.playlists.length, '个歌单')
        } else {
          console.log('❌ 没有找到歌单')
          searchResults.value = []
          alert('没有找到相关歌单喵~，请尝试其他关键词')
        }
      } catch (error) {
        console.error('❌ 搜索歌单失败:', error)
        searchResults.value = []
      } finally {
        loading.value = false
      }
    }

    // 添加歌单到用户库
    const addPlaylistToLibrary = (playlist) => {
      // 检查是否已经添加过
      const exists = userPlaylists.value.find(p => p.id === playlist.id)
      if (!exists) {
        userPlaylists.value.push(playlist)
        console.log('✅ 歌单已添加到库:', playlist.name)
        // 保存到本地存储
        savePlaylistsToStorage()
        // 显示成功提示
        alert(`歌单「${playlist.name}」已添加到你的库中喵~`)
        // 如果是从搜索结果添加的，清除搜索框并切换到我的歌单
        if (showAddPlaylist.value) {
          searchQuery.value = ''
          showAddPlaylist.value = false
        }
      } else {
        console.log('ℹ️ 歌单已存在于库中')
        alert('这个歌单已经在你的库中了喵~')
      }
    }

    // 从用户库移除歌单
    const removePlaylistFromLibrary = (playlistId) => {
      const playlist = userPlaylists.value.find(p => p.id === playlistId)
      
      // 如果是默认歌单，记录用户删除操作
      if (playlist && playlist.isDefault) {
        const removedDefaults = getRemovedDefaultPlaylists()
        if (!removedDefaults.includes(playlistId)) {
          removedDefaults.push(playlistId)
          localStorage.setItem('meowmu_removed_defaults', JSON.stringify(removedDefaults))
          console.log('📝 记录用户删除的默认歌单:', playlistId)
        }
      }
      
      userPlaylists.value = userPlaylists.value.filter(p => p.id !== playlistId)
      console.log('🗑️ 歌单已从库中移除')
      savePlaylistsToStorage()
    }

    // 获取用户删除的默认歌单列表
    const getRemovedDefaultPlaylists = () => {
      try {
        const saved = localStorage.getItem('meowmu_removed_defaults')
        return saved ? JSON.parse(saved) : []
      } catch (error) {
        console.error('❌ 获取删除记录失败:', error)
        return []
      }
    }

    // 保存歌单到本地存储
    const savePlaylistsToStorage = () => {
      try {
        localStorage.setItem('meowmu_playlists', JSON.stringify(userPlaylists.value))
      } catch (error) {
        console.error('❌ 保存歌单到本地存储失败:', error)
      }
    }

    // 从本地存储加载歌单
    const loadPlaylistsFromStorage = () => {
      try {
        const saved = localStorage.getItem('meowmu_playlists')
        if (saved) {
          userPlaylists.value = JSON.parse(saved)
          console.log('✅ 从本地存储加载了', userPlaylists.value.length, '个歌单')
        }
      } catch (error) {
        console.error('❌ 从本地存储加载歌单失败:', error)
      }
    }

    // 选择歌单
    const selectPlaylist = async (playlist) => {
      selectedPlaylist.value = playlist
      loadingSongs.value = true
      
      try {
        const result = await musicApi.getPlaylistDetail(playlist.id)
        songs.value = result.tracks || result.songs || []
        currentPage.value = 1 // 重置分页
      } catch (error) {
        console.error('获取歌单详情失败喵~:', error)
        songs.value = []
        currentPage.value = 1 // 重置分页
      } finally {
        loadingSongs.value = false
      }
    }

    // 播放歌曲
    const playSong = async (song, index) => {
      try {
        // 显示切换提示
        songSwitching.value = true
        
        // 停止当前播放
        if (howl) {
          howl.stop()
          howl = null
        }

        currentSong.value = song
        currentSongIndex.value = index
        
        console.log('🎵 开始播放歌曲:', song.name, '预期时长:', song.dt, '毫秒')
        
        // 获取歌曲URL
        const urlResult = await musicApi.getSongUrl(song.id)
        const songUrl = urlResult.url
        
        if (!songUrl) {
          console.error('❌ 无法获取歌曲播放链接')
          alert('无法播放此歌曲喵~，可能是版权限制')
          return
        }

        console.log('🔗 获取到歌曲URL:', songUrl)
        
        // 创建新的音频实例
        howl = new Howl({
          src: [songUrl],
          html5: true,
          volume: volume.value / 100,
          onplay: () => {
            isPlaying.value = true
            updateProgress()
          },
          onpause: () => {
            isPlaying.value = false
          },
          onstop: () => {
            isPlaying.value = false
            currentTime.value = 0
          },
          onend: () => {
            handleSongEnd()
          },
          onload: () => {
            const actualDuration = howl.duration()
            duration.value = actualDuration
            console.log('🕐 音频文件实际时长:', actualDuration, '秒')
            console.log('📊 预期时长:', song.dt / 1000, '秒')
            
            // 检查时长差异
            const expectedDuration = song.dt / 1000
            const timeDifference = Math.abs(actualDuration - expectedDuration)
            if (timeDifference > 30) {
              console.warn('⚠️ 时长不匹配！实际:', actualDuration, '秒，预期:', expectedDuration, '秒')
              console.warn('⚠️ 可能获取到的是试听版本或片段')
              
              // 设置警告信息
              if (actualDuration < 60) {
                durationWarning.value = `此歌曲可能为试听版本喵~（${Math.floor(actualDuration)}秒），完整版本可能因版权限制无法播放`
              } else {
                durationWarning.value = `歌曲时长与预期不符喵~（实际${Math.floor(actualDuration)}秒，预期${Math.floor(expectedDuration)}秒）`
              }
            } else {
              // 清除警告信息
              durationWarning.value = ''
            }
          },
          onerror: (id, error) => {
            console.error('❌ 音频加载失败:', error)
            alert('音频加载失败喵~，请尝试其他歌曲')
          }
        })

        howl.play()
        
        // 获取歌词
        loadLyrics(song.id)
        
        // 隐藏切换提示
        songSwitching.value = false
        
      } catch (error) {
        console.error('❌ 播放歌曲失败:', error)
        songSwitching.value = false // 出错时也要隐藏提示
        alert('播放失败喵~: ' + error.message)
      }
    }

    // 加载歌词
    const loadLyrics = async (songId) => {
      loadingLyrics.value = true
      try {
        console.log('🎵 开始获取歌词，歌曲ID:', songId)
        const result = await musicApi.getLyrics(songId)
        
        if (result.lyrics && result.lyrics.length > 0) {
          lyrics.value = result.lyrics
          currentLyricIndex.value = 0
          console.log('✅ 成功获取歌词，共', result.lyrics.length, '行')
          
          // 开始歌词同步
          startLyricSync()
        } else {
          console.log('ℹ️ 该歌曲没有歌词')
          lyrics.value = [{ time: 0, text: '该歌曲暂无歌词喵~', translation: '' }]
          currentLyricIndex.value = 0
        }
      } catch (error) {
        console.error('❌ 获取歌词失败:', error)
        lyrics.value = [{ time: 0, text: '歌词加载失败喵~', translation: '' }]
        currentLyricIndex.value = 0
      } finally {
        loadingLyrics.value = false
      }
    }

    // 歌词同步
    const startLyricSync = () => {
      if (lyricTimer) {
        clearInterval(lyricTimer)
      }
      
      lyricTimer = setInterval(() => {
        if (lyrics.value.length > 0 && isPlaying.value) {
          const current = currentTime.value
          for (let i = 0; i < lyrics.value.length; i++) {
            if (lyrics.value[i].time <= current && 
                (i === lyrics.value.length - 1 || lyrics.value[i + 1].time > current)) {
              currentLyricIndex.value = i
              break
            }
          }
        }
      }, 100)
    }

    // 更新播放进度
    const updateProgress = () => {
      if (howl && isPlaying.value) {
        currentTime.value = howl.seek()
        requestAnimationFrame(updateProgress)
      }
    }

    // 播放控制
    const togglePlay = () => {
      if (howl) {
        if (isPlaying.value) {
          howl.pause()
        } else {
          howl.play()
        }
      }
    }

    const previousSong = () => {
      if (currentSongIndex.value > 0) {
        const prevIndex = currentSongIndex.value - 1
        const prevSong = filteredSongs.value[prevIndex]
        if (prevSong) {
          playSong(prevSong, prevIndex)
        }
      }
    }

    const nextSong = () => {
      if (currentSongIndex.value < filteredSongs.value.length - 1) {
        const nextIndex = currentSongIndex.value + 1
        const nextSong = filteredSongs.value[nextIndex]
        if (nextSong) {
          playSong(nextSong, nextIndex)
        }
      } else if (playMode.value === 'loop') {
        // 列表循环：播放第一首
        const firstSong = filteredSongs.value[0]
        if (firstSong) {
          playSong(firstSong, 0)
        }
      }
    }

    // 处理歌曲播放结束
    const handleSongEnd = () => {
      if (playMode.value === 'single') {
        // 单曲循环：重新播放当前歌曲
        if (howl) {
          howl.seek(0)
          howl.play()
        }
      } else {
        // 列表播放或列表循环
        nextSong()
      }
    }

    // 切换播放模式
    const togglePlayMode = () => {
      const modes = ['list', 'loop', 'single']
      const currentIndex = modes.indexOf(playMode.value)
      const nextIndex = (currentIndex + 1) % modes.length
      playMode.value = modes[nextIndex]
      console.log('🔄 播放模式切换为:', playMode.value)
    }

    // 获取播放模式显示文本
    const getPlayModeText = () => {
      switch (playMode.value) {
        case 'list': return '顺序播放'
        case 'loop': return '列表循环'
        case 'single': return '单曲循环'
        default: return '顺序播放'
      }
    }

    // 获取播放模式图标
    const getPlayModeIcon = () => {
      switch (playMode.value) {
        case 'list': return '▷'
        case 'loop': return '∞'
        case 'single': return '1'
        default: return '▷'
      }
    }

    // 进度条点击
    const seekTo = (event) => {
      if (howl && duration.value > 0) {
        const rect = event.target.getBoundingClientRect()
        const percent = (event.clientX - rect.left) / rect.width
        const seekTime = percent * duration.value
        howl.seek(seekTime)
        currentTime.value = seekTime
      }
    }

    // 音量控制
    const updateVolume = () => {
      if (howl) {
        howl.volume(volume.value / 100)
      }
    }

    // 格式化时间
    const formatTime = (seconds) => {
      const mins = Math.floor(seconds / 60)
      const secs = Math.floor(seconds % 60)
      return `${mins}:${secs.toString().padStart(2, '0')}`
    }

    const formatDuration = (ms) => {
      const seconds = Math.floor(ms / 1000)
      return formatTime(seconds)
    }

    // 切换歌词自动跟随
    const toggleAutoFollowLyrics = () => {
      autoFollowLyrics.value = !autoFollowLyrics.value
      console.log('🎵 歌词自动跟随:', autoFollowLyrics.value ? '开启' : '关闭')
    }

    // 监听当前歌词索引变化，实现自动滚动
    watch(currentLyricIndex, async (newIndex) => {
      if (newIndex >= 0 && playerContainer.value && autoFollowLyrics.value) {
        await nextTick()
        const container = playerContainer.value
        const currentLyricElement = container.querySelector(`[data-lyric-index="${newIndex}"]`)
        
        if (currentLyricElement && container) {
          // 计算当前歌词元素相对于播放器容器的位置
          const containerRect = container.getBoundingClientRect()
          const lyricRect = currentLyricElement.getBoundingClientRect()
          
          // 计算需要滚动的距离，使当前歌词居中显示
          const containerCenter = containerRect.height / 2
          const lyricCenter = lyricRect.top - containerRect.top + lyricRect.height / 2
          const scrollOffset = lyricCenter - containerCenter
          
          // 平滑滚动到目标位置
          container.scrollTo({
            top: container.scrollTop + scrollOffset,
            behavior: 'smooth'
          })
          
          console.log('🎵 歌词自动滚动到索引:', newIndex, '滚动容器:', container.className)
        }
      }
    })

    // 监听VIP歌曲显示状态变化，重新计算当前歌曲索引
    watch(showVipSongs, () => {
      if (currentSong.value) {
        // 重新计算当前歌曲在过滤后列表中的索引
        const newIndex = filteredSongs.value.findIndex(song => song.id === currentSong.value.id)
        if (newIndex !== -1) {
          currentSongIndex.value = newIndex
        }
        // 重置分页到第一页
        currentPage.value = 1
      }
    })

    // 加载默认歌单
    const loadDefaultPlaylists = async () => {
      const defaultPlaylistIds = ['6725496800', '12446531674']
      const removedDefaults = getRemovedDefaultPlaylists()
      
      for (const playlistId of defaultPlaylistIds) {
        // 检查用户是否已经删除过这个默认歌单
        if (removedDefaults.includes(playlistId)) {
          console.log('⏭️ 跳过用户已删除的默认歌单:', playlistId)
          continue
        }
        
        try {
          console.log('📋 加载默认歌单:', playlistId)
          const result = await musicApi.getPlaylistDetail(playlistId)
          
          if (result && (result.playlist || result.id)) {
            const playlistData = result.playlist || result
            const playlist = {
              id: playlistData.id,
              name: playlistData.name,
              coverImgUrl: playlistData.coverImgUrl,
              creator: playlistData.creator,
              trackCount: playlistData.trackCount,
              description: playlistData.description,
              isDefault: true // 标记为默认歌单
            }
            
            // 检查是否已存在（避免重复添加）
            const exists = userPlaylists.value.find(p => p.id === playlist.id)
            if (!exists) {
              userPlaylists.value.push(playlist)
              console.log('✅ 默认歌单已添加:', playlist.name)
            }
          }
        } catch (error) {
          console.error('❌ 加载默认歌单失败:', playlistId, error)
        }
      }
      
      // 保存到本地存储
      savePlaylistsToStorage()
    }

    // 组件挂载时加载歌单
    onMounted(async () => {
      console.log('🚀 组件已挂载，开始加载歌单')
      loadPlaylistsFromStorage()
      
      // 检查是否为首次访问或没有歌单
      if (userPlaylists.value.length === 0) {
        console.log('📋 首次访问，加载默认歌单')
        await loadDefaultPlaylists()
      }
    })

    return {
      searchQuery,
      loading,
      loadingSongs,
      playlists,
      userPlaylists,
      selectedPlaylist,
      songs,
      currentSong,
      lyrics,
      currentLyricIndex,
      isPlaying,
      currentTime,
      duration,
      volume,
      durationWarning,
      loadingLyrics,
      progressPercentage,
      // VIP歌曲控制
      showVipSongs,
      filteredSongs,
      // 播放模式相关
      playMode,
      // 歌词滚动相关
      autoFollowLyrics,
      songSwitching,
      lyricsContainer,
      playerContainer,
      // 分页相关
      currentPage,
      pageSize,
      totalPages,
      paginatedSongs,
      goToPage,
      prevPage,
      nextPage,
      // 函数
      handleSearch,
      loadPlaylistByIdAndAdd,
      searchPlaylists,
      selectPlaylist,
      playSong,
      togglePlay,
      previousSong,
      nextSong,
      seekTo,
      updateVolume,
      formatTime,
      formatDuration,
      addPlaylistToLibrary,
      removePlaylistFromLibrary,
      extractPlaylistId,
      showAddPlaylist,
      searchResults,
      togglePlayMode,
      getPlayModeText,
      getPlayModeIcon,
      toggleAutoFollowLyrics
    }
  }
}
</script>