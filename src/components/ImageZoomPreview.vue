<script setup>
// 素材图片放大预览：滚轮缩放（以鼠标为中心）、拖拽平移、双击切换 1:1 原图、
// 左右方向键/箭头切换同组图片，Esc 或点击空白处关闭。经 teleport 挂到 body，不受页面布局影响。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowLeft, ArrowRight, Close, Download, Minus, Plus, ScaleToOriginal } from '@element-plus/icons-vue'

const props = defineProps({
  // [{ src, blob?, width?, height? }] src 为完整可展示地址（blob: 或远程 url）
  images: { type: Array, default: () => [] },
  // 当前打开的图片下标，-1 表示关闭
  modelValue: { type: Number, default: -1 },
  // 下载文件名前缀
  downloadName: { type: String, default: '图片' },
})
const emit = defineEmits(['update:modelValue'])

const MAX_SCALE = 12
const MIN_SCALE = 1

const scale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const baseRatio = ref(1) // 基准展示宽 / 原始宽，用于换算缩放百分比与 1:1
const natSize = ref(null)
const dragging = ref(false)
const imgRef = ref(null)
const stageRef = ref(null)

const isOpen = computed(() => props.modelValue >= 0 && props.modelValue < props.images.length)
const current = computed(() => (isOpen.value ? props.images[props.modelValue] : null))
const hasMulti = computed(() => props.images.length > 1)
const zoomPercent = computed(() => Math.round(scale.value * baseRatio.value * 100))

const imgStyle = computed(() => ({
  transform: `translate(${offsetX.value}px, ${offsetY.value}px) scale(${scale.value})`,
}))

watch(
  () => props.modelValue,
  () => {
    scale.value = 1
    offsetX.value = 0
    offsetY.value = 0
    natSize.value = null
    baseRatio.value = 1
  },
)

// 打开期间接管键盘：Esc 关闭、左右切换
watch(isOpen, (open) => {
  if (open) window.addEventListener('keydown', onKey)
  else window.removeEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function onKey(e) {
  if (e.key === 'Escape') close()
  else if (e.key === 'ArrowLeft') step(-1)
  else if (e.key === 'ArrowRight') step(1)
}

function close() {
  emit('update:modelValue', -1)
}

function step(delta) {
  const n = props.images.length
  if (n) emit('update:modelValue', (props.modelValue + delta + n) % n)
}

function measure() {
  const el = imgRef.value
  if (!el) return
  natSize.value = { w: el.naturalWidth, h: el.naturalHeight }
  baseRatio.value = el.naturalWidth ? el.clientWidth / el.naturalWidth : 1
}

// 以某个屏幕坐标为锚点缩放，保证鼠标指着哪里，哪里不动
function zoomAt(clientX, clientY, factor) {
  const el = imgRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const cx = clientX - (rect.left + rect.width / 2)
  const cy = clientY - (rect.top + rect.height / 2)
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value * factor))
  if (next === scale.value) return
  const k = next / scale.value
  offsetX.value += cx * (1 - k)
  offsetY.value += cy * (1 - k)
  scale.value = next
}

function onWheel(e) {
  e.preventDefault()
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.18 : 1 / 1.18)
}

function onZoomButton(factor) {
  zoomAt(window.innerWidth / 2, window.innerHeight / 2, factor)
}

function toggleOriginal() {
  const el = imgRef.value
  if (!el) return
  if (scale.value > 1.01) {
    scale.value = 1
    offsetX.value = 0
    offsetY.value = 0
  } else {
    scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, baseRatio.value ? 1 / baseRatio.value : 1))
  }
}

let dragStart = null
let dragMoved = false

function onPointerDown(e) {
  if (e.button !== 0) return
  dragging.value = true
  dragMoved = false
  dragStart = { x: e.clientX, y: e.clientY, ox: offsetX.value, oy: offsetY.value }
  e.currentTarget.setPointerCapture?.(e.pointerId)
}

function onPointerMove(e) {
  if (!dragging.value || !dragStart) return
  const dx = e.clientX - dragStart.x
  const dy = e.clientY - dragStart.y
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true
  offsetX.value = dragStart.ox + dx
  offsetY.value = dragStart.oy + dy
}

function onPointerUp() {
  dragging.value = false
  dragStart = null
}

function onStageClick(e) {
  // 点击图片本身不关闭；拖拽过的收尾也不算关闭
  if (!dragMoved && e.target === stageRef.value) close()
}

function onStageDblclick() {
  toggleOriginal()
}

// 下载当前这张图：优先用已缓存的 blob，远程图先拉下来再存
const saving = ref(false)

async function downloadCurrent() {
  const img = current.value
  if (!img || saving.value) return
  saving.value = true
  let href = img.src
  let blob = img.blob || null
  let revoke = false
  if (!blob) {
    try {
      const res = await fetch(img.src)
      blob = await res.blob()
      href = URL.createObjectURL(blob)
      revoke = true
    } catch {
      ElMessage.error('图片下载失败，请检查网络后重试')
      saving.value = false
      return
    }
  }
  const type = blob?.type || ''
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = `${props.downloadName}-${String(props.modelValue + 1).padStart(2, '0')}.${ext}`
  anchor.click()
  if (revoke) setTimeout(() => URL.revokeObjectURL(href), 4000)
  ElMessage.success('已开始下载当前图片')
  saving.value = false
}
</script>

<template>
  <teleport to="body">
    <div v-if="isOpen && current" class="zoom-viewer" role="dialog" aria-label="图片放大预览">
      <div
        ref="stageRef"
        class="zv-stage"
        :class="{ 'is-dragging': dragging }"
        @click="onStageClick"
        @dblclick="onStageDblclick"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <img
          ref="imgRef"
          :key="current.src"
          :src="current.src"
          class="zv-img"
          :class="{ 'is-dragging': dragging }"
          :style="imgStyle"
          alt=""
          draggable="false"
          @load="measure"
        />
      </div>

      <div class="zv-toolbar">
        <button type="button" class="zv-btn" title="放大" @click="onZoomButton(1.25)">
          <el-icon><Plus /></el-icon>
        </button>
        <button type="button" class="zv-btn" title="缩小" @click="onZoomButton(1 / 1.25)">
          <el-icon><Minus /></el-icon>
        </button>
        <button type="button" class="zv-btn" title="按原图尺寸查看（双击同样生效）" @click="toggleOriginal">
          <el-icon><ScaleToOriginal /></el-icon>
        </button>
        <button type="button" class="zv-btn" title="下载当前图片" :disabled="saving" @click="downloadCurrent">
          <el-icon><Download /></el-icon>
        </button>
        <button type="button" class="zv-btn" title="关闭（Esc）" @click="close">
          <el-icon><Close /></el-icon>
        </button>
      </div>

      <button v-if="hasMulti" type="button" class="zv-nav zv-prev" title="上一张（←）" @click="step(-1)">
        <el-icon><ArrowLeft /></el-icon>
      </button>
      <button v-if="hasMulti" type="button" class="zv-nav zv-next" title="下一张（→）" @click="step(1)">
        <el-icon><ArrowRight /></el-icon>
      </button>

      <div class="zv-info">
        <span v-if="hasMulti">第 {{ modelValue + 1 }} / {{ images.length }} 张 · </span>
        <span v-if="natSize">{{ natSize.w }}×{{ natSize.h }} · </span>
        <span>{{ zoomPercent }}%</span>
        <span class="zv-tip">滚轮缩放 · 拖拽平移 · 双击看原图 · Esc 关闭</span>
      </div>
    </div>
  </teleport>
</template>
