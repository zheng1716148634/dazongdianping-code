<script setup>
import { computed, ref, watch } from 'vue'
import { cachedNotes } from '../stores/materials'

// 素材库选择器：任何工作台都能打开，从已缓存的点评素材里挑图带入本页。
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  multiple: { type: Boolean, default: true },
})
const emit = defineEmits(['update:modelValue', 'confirm'])

const selected = ref(new Set())

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

watch(visible, (value) => {
  if (value) selected.value = new Set()
})

const totalImages = computed(() =>
  cachedNotes.value.reduce((count, note) => count + note.images.filter((img) => img.blob).length, 0),
)

function toggle(note, img) {
  if (!img.blob) return
  const key = `${note.id}|${img.url}`
  const next = new Set(selected.value)
  if (next.has(key)) next.delete(key)
  else if (props.multiple) next.add(key)
  else {
    next.clear()
    next.add(key)
  }
  selected.value = next
}

function confirmPick() {
  const items = []
  cachedNotes.value.forEach((note) => {
    note.images.forEach((img, index) => {
      if (!selected.value.has(`${note.id}|${img.url}`) || !img.blob) return
      items.push({
        blob: img.blob,
        name: `点评素材-${note.id}-${String(index + 1).padStart(2, '0')}`,
      })
    })
  })
  if (!items.length) return
  emit('confirm', items)
  visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" title="从素材库选图" width="min(680px, 94vw)">
    <p class="picker-hint">
      {{ multiple ? '可勾选多张，确认后加入本页素材' : '选择一张图片作为本页素材' }}；共 {{ totalImages }} 张可用。
    </p>

    <div v-if="cachedNotes.length" class="picker-scroll">
      <div v-for="note in cachedNotes" :key="note.id" class="picker-group">
        <div class="picker-note-title" :title="note.title">{{ note.title }}</div>
        <div class="picker-grid">
          <div
            v-for="(img, i) in note.images"
            :key="img.url + i"
            class="picker-item"
            :class="{ 'is-selected': selected.has(`${note.id}|${img.url}`), 'is-disabled': !img.blob }"
            :title="img.width ? `${img.width}×${img.height}` : '转存失败的图，不可选'"
            @click="toggle(note, img)"
          >
            <img :src="img.src" loading="lazy" alt="" />
            <span v-if="selected.has(`${note.id}|${img.url}`)" class="picker-check">✓</span>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="picker-empty">
      <p>素材库还是空的。</p>
      <p>先到「链接提取」页粘贴点评笔记链接，点「一键获取素材」。</p>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!selected.size" @click="confirmPick">
        使用{{ selected.size > 1 ? ` ${selected.size} ` : '这张' }}图
      </el-button>
    </template>
  </el-dialog>
</template>
