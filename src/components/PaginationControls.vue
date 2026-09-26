<template>
  <div class="flex justify-center items-center space-x-1 mt-4 mb-4 p-3 backdrop-blur-md" :style="barStyle">
    <button
      @click="$emit('go-to-page', 1)"
      :disabled="currentPage === 1"
      class="pixel-button text-xs px-2 py-1 text-white font-bold flex items-center justify-center min-w-[32px]"
      :class="currentPage === 1 ? 'opacity-50 cursor-not-allowed bg-gray-600' : 'bg-purple-600 hover:bg-purple-500'"
    >
      ⇤
    </button>

    <button
      @click="$emit('prev-page')"
      :disabled="currentPage === 1"
      class="pixel-button text-xs px-2 py-1 text-white font-bold flex items-center justify-center min-w-[32px]"
      :class="currentPage === 1 ? 'opacity-50 cursor-not-allowed bg-gray-600' : 'bg-purple-600 hover:bg-purple-500'"
    >
      ←
    </button>

    <span class="text-pink-300 text-xs px-2 py-1 min-w-[48px] text-center">
      {{ currentPage }}/{{ totalPages }}
    </span>

    <button
      @click="$emit('next-page')"
      :disabled="currentPage === totalPages"
      class="pixel-button text-xs px-2 py-1 text-white font-bold flex items-center justify-center min-w-[32px]"
      :class="currentPage === totalPages ? 'opacity-50 cursor-not-allowed bg-gray-600' : 'bg-purple-600 hover:bg-purple-500'"
    >
      →
    </button>

    <button
      @click="$emit('go-to-page', totalPages)"
      :disabled="currentPage === totalPages"
      class="pixel-button text-xs px-2 py-1 text-white font-bold flex items-center justify-center min-w-[32px]"
      :class="currentPage === totalPages ? 'opacity-50 cursor-not-allowed bg-gray-600' : 'bg-purple-600 hover:bg-purple-500'"
    >
      ⇥
    </button>
  </div>
</template>

<script>
export default {
  name: 'PaginationControls',
  props: {
    currentPage: { type: Number, default: 1 },
    totalPages: { type: Number, default: 1 },
    barStyle: { type: Object, default: null }
  },
  emits: ['go-to-page', 'prev-page', 'next-page']
}
</script>
