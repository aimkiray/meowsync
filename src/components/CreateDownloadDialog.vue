<template>
  <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
    <div class="jirai-card w-full max-w-md border border-pink-500 shadow-2xl" style="border-radius: 0;">
      <div class="p-6">
        <h3 class="text-lg font-semibold mb-4 text-pink-300">创建下载任务</h3>

        <div class="space-y-4">
          <div class="music-card p-3 jirai-card">
            <p class="text-sm font-medium text-pink-300">{{ playlist.name }}</p>
            <p class="text-xs text-purple-300 mt-1">{{ playlist.trackCount }} 首歌曲</p>
          </div>

          <div>
            <label class="block text-sm font-medium text-purple-300 mb-2">
              音频码率
            </label>
            <select
              v-model="options.bitrate"
              class="w-full bg-gray-900 border border-purple-500 text-pink-200 px-3 py-2 focus:outline-none focus:border-pink-400"
              style="border-radius: 0;"
            >
              <option :value="128000">128 kbps</option>
              <option :value="192000">192 kbps</option>
              <option :value="320000">320 kbps (推荐)</option>
            </select>
          </div>

          <div>
            <label class="block text-sm font-medium text-purple-300 mb-2">
              下载内容
            </label>
            <div class="space-y-2 text-sm text-pink-200">
              <label class="flex items-center">
                <input type="checkbox" v-model="options.downloadAudio" class="mr-2" />
                <span>音频文件</span>
              </label>
              <label class="flex items-center">
                <input type="checkbox" v-model="options.downloadLyrics" class="mr-2" />
                <span>歌词文件 (LRC)</span>
              </label>
              <label class="flex items-center">
                <input type="checkbox" v-model="options.downloadCover" class="mr-2" />
                <span>封面图片</span>
              </label>
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-purple-300 mb-2">
              并发下载数
            </label>
            <select
              v-model="options.concurrentLimit"
              class="w-full bg-gray-900 border border-purple-500 text-pink-200 px-3 py-2 focus:outline-none focus:border-pink-400"
              style="border-radius: 0;"
            >
              <option :value="1">1 (慢速)</option>
              <option :value="2">2</option>
              <option :value="3">3 (推荐)</option>
              <option :value="5">5</option>
              <option :value="10">10 (快速)</option>
            </select>
          </div>
        </div>

        <div class="flex justify-end space-x-3 mt-6">
          <button
            @click="$emit('close')"
            class="text-xs px-4 py-2 border bg-gray-800 text-gray-200 border-gray-600 hover:bg-gray-700 transition-colors"
            style="border-radius: 0;"
          >
            取消
          </button>
          <button
            @click="handleCreate"
            :disabled="!options.downloadAudio && !options.downloadLyrics && !options.downloadCover"
            class="text-xs px-4 py-2 border bg-pink-600 text-white border-pink-400 hover:bg-pink-500 transition-colors disabled:bg-gray-700 disabled:text-gray-400 disabled:border-gray-600 disabled:cursor-not-allowed"
            style="border-radius: 0;"
          >
            创建
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const props = defineProps({
  playlist: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['close', 'create']);

const options = ref({
  bitrate: 320000,
  downloadAudio: true,
  downloadLyrics: true,
  downloadCover: true,
  concurrentLimit: 3
});

function handleCreate() {
  emit('create', options.value);
}
</script>
