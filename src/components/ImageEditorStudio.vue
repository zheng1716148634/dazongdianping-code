<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import { canvasToBlob, downloadBlob, flattenOnWhite } from '../utils/composeImage'
import { blobToFile } from '../utils/imageHandoff'
import MaterialPicker from './MaterialPicker.vue'

// 字体在预览（DOM）与导出（canvas）用同一份 stack，保证所见即所得
const FONTS = [
  { key: 'serif', label: '宋体衬线', stack: '"Noto Serif SC","Songti SC",serif' },
  { key: 'sans', label: '黑体无衬线', stack: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif' },
  { key: 'kai', label: '楷体手写', stack: '"Kaiti SC","STKaiti","KaiTi",serif' },
  { key: 'round', label: '圆体可爱', stack: '"Yuanti SC","YouYuan","PingFang SC",sans-serif' },
]
const EMOJI_STACK = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'

const BACKGROUNDS = [
  { key: 'none', label: '纯文字' },
  { key: 'bubble', label: '气泡' },
  { key: 'tag', label: '色块' },
]

const EXPORT_LONGS = [
  { key: 0, label: '原图尺寸' },
  { key: 1080, label: '长边 1080' },
  { key: 1440, label: '长边 1440' },
  { key: 2048, label: '长边 2048' },
]

// 一键文案：自带描边/气泡样式，点一下就有现成效果
const PRESETS = [
  { text: '必吃榜 TOP1', patch: { color: '#fff8ec', stroke: true, strokeColor: '#8f2f24', shadow: true, background: 'none', fontSize: 0.13, rotation: -6 } },
  { text: '今日份快乐', patch: { color: '#2a2218', background: 'bubble', bgColor: '#fffdf6', stroke: false, shadow: true, fontSize: 0.09, rotation: -3 } },
  { text: '招牌推荐', patch: { color: '#ffffff', background: 'tag', bgColor: '#8f2f24', stroke: false, shadow: true, fontSize: 0.09, rotation: 4 } },
  { text: '打卡第 1 站', patch: { color: '#ffffff', stroke: true, strokeColor: '#1f2d3a', shadow: true, background: 'none', fontSize: 0.1, rotation: 0 } },
  { text: '人均 ¥88', patch: { color: '#2a2218', background: 'bubble', bgColor: '#ffe9a8', stroke: false, shadow: true, fontSize: 0.085, rotation: 5 } },
  { text: '周末去哪儿', patch: { color: '#fff8ec', stroke: true, strokeColor: '#2f6b4f', shadow: true, background: 'none', fontSize: 0.11, rotation: -4 } },
]

const STICKER_GROUPS = [
  { key: 'face', label: '表情', items: ['😂', '🥰', '😍', '🤤', '😎', '🥳', '😭', '😡', '🤔', '🙈', '💖', '💯', '🔥', '✨', '⭐'] },
  { key: 'hand', label: '手势', items: ['👍', '👌', '🙏', '👏', '🫰', '🤟', '✌️', '👈', '👉', '👇', '👋', '🫶', '💪', '🤝', '☝️'] },
  { key: 'food', label: '美食', items: ['🍜', '🍣', '🍕', '🍔', '🍰', '🍦', '🧋', '☕', '🍺', '🦞', '🍤', '🥟', '🍡', '🍓', '🥑'] },
  { key: 'scene', label: '氛围', items: ['🌸', '🌊', '☀️', '🌙', '🌈', '🎉', '🎈', '📷', '✈️', '🚗', '🏝️', '⛰️', '🌆', '🕯️', '🎁'] },
  // 符号走文字图层，可以改颜色、加描边
  { key: 'mark', label: '符号', asText: true, items: ['✔', '✖', '★', '☆', '♥', '➜', '➤', '❗', '❓', '!', '「', '」', '◆', '▲', '〰'] },
]

const base = ref(null)
const layers = ref([])
const selectedId = ref('')
const newText = ref('')
const stickerGroup = ref('face')
const exportLong = ref(0)
const exporting = ref('')
const pickerVisible = ref(false)
const uploadRef = ref()

const stageEl = ref()
const canvasEl = ref()
const stageBox = ref({ width: 0, height: 0 })
let stageObserver = null

const selectedLayer = computed(() => layers.value.find((layer) => layer.id === selectedId.value) || null)
const layerCount = computed(() => layers.value.length)

// 字号滑块以「占画布宽度的百分比」展示，写回时再归一化成比例值
const selectedFontSize = computed({
  get: () => (selectedLayer.value ? selectedLayer.value.fontSize * 100 : 10),
  set: (value) => {
    if (selectedLayer.value) selectedLayer.value.fontSize = clamp(value / 100, 0.02, 0.7)
  },
})

const currentAspect = computed(() =>
  base.value ? base.value.image.naturalWidth / base.value.image.naturalHeight : 3 / 4,
)

// 画布宽度由舞台实测尺寸推导：宽高都要装得下，按高度算出的宽度再和可用宽度取小
const canvasW = computed(() => {
  const aspect = currentAspect.value
  const { width, height } = stageBox.value
  if (width > 0 && height > 0) return Math.min(width, height * aspect)
  // 首帧还没量到舞台尺寸，用视口高度兜底估一个，避免图层缩成看不见
  return window.innerHeight * 0.62 * aspect
})

function canvasStyle() {
  return {
    aspectRatio: String(currentAspect.value),
    width: `${Math.floor(canvasW.value)}px`,
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (stageEl.value && typeof ResizeObserver !== 'undefined') {
    stageObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      stageBox.value = { width, height }
    })
    stageObserver.observe(stageEl.value)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  stageObserver?.disconnect()
  stageObserver = null
  if (base.value) URL.revokeObjectURL(base.value.url)
})

// ---------- 底图 ----------

async function onFileChange(uploadFile) {
  const file = uploadFile.raw
  if (!file) return
  if (!file.type.startsWith('image/')) {
    ElMessage.error('请上传 PNG、JPG、WEBP 等图片')
    return
  }
  try {
    const loaded = await loadImage(file)
    if (base.value) URL.revokeObjectURL(base.value.url)
    base.value = { name: file.name, url: loaded.url, image: loaded.image }
    uploadRef.value?.clearFiles()
  } catch (error) {
    ElMessage.error(error.message || '这张图片读取失败')
  }
}

async function onPickFromLibrary(items) {
  if (!items.length) return
  await onFileChange({ raw: blobToFile(items[0].blob, items[0].name) })
  pickerVisible.value = false
}

function clearBase() {
  if (base.value) URL.revokeObjectURL(base.value.url)
  base.value = null
  layers.value = []
  selectedId.value = ''
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => resolve({ image, url })
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取这张图片'))
    }
    image.src = url
  })
}

// ---------- 图层模型 ----------

function makeLayer(patch = {}) {
  return {
    id: `L-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'text',
    text: '文案',
    x: 0.5,
    y: 0.5,
    fontSize: 0.1,
    rotation: 0,
    fontKey: 'sans',
    bold: true,
    color: '#ffffff',
    stroke: true,
    strokeColor: '#241d12',
    strokeWidth: 0.12,
    shadow: true,
    background: 'none',
    bgColor: '#ffffff',
    ...patch,
  }
}

function offsetSpot() {
  // 连续添加时错开一点，避免完全叠在一起
  const step = (layers.value.length % 6) * 0.045
  return { x: 0.32 + step, y: 0.3 + step }
}

function addText(text, patch = {}) {
  if (!base.value) {
    ElMessage.info('先准备一张底图，再往上面加文案')
    return
  }
  const value = String(text || '').trim()
  if (!value) {
    ElMessage.info('先输入要添加的文案')
    return
  }
  const spot = offsetSpot()
  const layer = makeLayer({ text: value, ...spot, ...patch })
  layers.value.push(layer)
  selectLayer(layer.id)
  newText.value = ''
}

function addSticker(item, asText) {
  if (!base.value) {
    ElMessage.info('先准备一张底图，再往上面加表情')
    return
  }
  const spot = offsetSpot()
  const layer = asText
    ? makeLayer({ text: item, color: '#fff8ec', stroke: true, strokeColor: '#8f2f24', fontSize: 0.14, ...spot })
    : makeLayer({ type: 'sticker', text: item, fontSize: 0.16, shadow: true, stroke: false, ...spot })
  layers.value.push(layer)
  selectLayer(layer.id)
}

function selectLayer(id) {
  selectedId.value = id
}

function deselect() {
  selectedId.value = ''
}

function removeLayer(id) {
  const index = layers.value.findIndex((layer) => layer.id === id)
  if (index < 0) return
  layers.value.splice(index, 1)
  if (selectedId.value === id) selectedId.value = ''
}

function duplicateLayer() {
  const layer = selectedLayer.value
  if (!layer) return
  const { id, ...rest } = layer
  const copy = makeLayer({
    ...rest,
    x: clamp(layer.x + 0.05, 0, 1),
    y: clamp(layer.y + 0.05, 0, 1),
  })
  layers.value.push(copy)
  selectLayer(copy.id)
}

function moveLayer(step) {
  const index = layers.value.findIndex((layer) => layer.id === selectedId.value)
  const target = index + step
  if (index < 0 || target < 0 || target >= layers.value.length) return
  const [layer] = layers.value.splice(index, 1)
  layers.value.splice(target, 0, layer)
}

function clearLayers() {
  layers.value = []
  selectedId.value = ''
}

function resetTransform() {
  const layer = selectedLayer.value
  if (!layer) return
  layer.rotation = 0
  layer.fontSize = 0.1
}

function onKeydown(event) {
  const tag = event.target?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return
  const layer = selectedLayer.value
  if (!layer) return
  const step = event.shiftKey ? 0.05 : 0.01
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    removeLayer(layer.id)
  } else if (event.key === 'Escape') {
    deselect()
  } else if (event.key.startsWith('Arrow')) {
    event.preventDefault()
    if (event.key === 'ArrowLeft') layer.x = clamp(layer.x - step, 0, 1)
    if (event.key === 'ArrowRight') layer.x = clamp(layer.x + step, 0, 1)
    if (event.key === 'ArrowUp') layer.y = clamp(layer.y - step, 0, 1)
    if (event.key === 'ArrowDown') layer.y = clamp(layer.y + step, 0, 1)
  }
}

// ---------- 几何：预览与导出共用同一套测量 ----------

let measureContext = null

function getMeasureContext() {
  if (!measureContext) measureContext = document.createElement('canvas').getContext('2d')
  return measureContext
}

function fontString(layer, px) {
  const stack =
    layer.type === 'sticker' ? EMOJI_STACK : (FONTS.find((font) => font.key === layer.fontKey) || FONTS[0]).stack
  return `${layer.bold ? 700 : 400} ${px}px ${stack}`
}

/**
 * 所有尺寸都由「字号 = fontSize × 参考宽」推导，
 * 预览传预览画布宽、导出传导出画布宽，两者比例完全一致。
 */
function layerMetrics(layer, referenceWidth) {
  const px = Math.max(1, layer.fontSize * referenceWidth)
  const context = getMeasureContext()
  context.font = fontString(layer, px)
  const lines = String(layer.text ?? '').split('\n')
  const lineHeight = px * (layer.type === 'sticker' ? 1.12 : 1.28)
  let textWidth = 0
  lines.forEach((line) => {
    textWidth = Math.max(textWidth, context.measureText(line || ' ').width)
  })
  const hasBox = layer.background !== 'none'
  const padX = hasBox ? px * 0.55 : 0
  const padY = hasBox ? px * 0.3 : 0
  const boxWidth = textWidth + padX * 2
  const boxHeight = lineHeight * lines.length + padY * 2
  return {
    px,
    lines,
    lineHeight,
    padX,
    padY,
    textWidth,
    boxWidth,
    boxHeight,
    radius: Math.min(boxHeight * 0.32, px * 0.6),
    tailWidth: px * 0.55,
    tailHeight: px * 0.45,
    tailLeft: boxWidth * 0.22,
    strokePx: px * layer.strokeWidth,
    shadowOffset: px * 0.07,
    shadowBlur: px * 0.22,
  }
}

function boxStyle(layer, metrics) {
  return {
    background: layer.bgColor,
    borderRadius: `${metrics.radius}px`,
  }
}

function tailStyle(layer, metrics) {
  return {
    left: `${metrics.tailLeft}px`,
    width: `${metrics.tailWidth}px`,
    height: `${metrics.tailHeight}px`,
    background: layer.bgColor,
  }
}

function layerFrameStyle(layer) {
  const metrics = layerMetrics(layer, canvasW.value || 1)
  return {
    left: `${layer.x * 100}%`,
    top: `${layer.y * 100}%`,
    width: `${metrics.boxWidth}px`,
    height: `${metrics.boxHeight}px`,
    transform: `translate(-50%, -50%) rotate(${layer.rotation}deg)`,
    filter:
      layer.background !== 'none' && layer.shadow
        ? `drop-shadow(0 ${metrics.shadowOffset}px ${metrics.shadowBlur}px rgba(0,0,0,0.4))`
        : 'none',
  }
}

function textStyle(layer) {
  const metrics = layerMetrics(layer, canvasW.value || 1)
  const plainText = layer.background === 'none'
  return {
    font: fontString(layer, metrics.px),
    width: `${metrics.textWidth}px`,
    lineHeight: `${metrics.lineHeight}px`,
    color: layer.color,
    WebkitTextStrokeWidth: plainText && layer.stroke ? `${metrics.strokePx}px` : '0px',
    WebkitTextStrokeColor: plainText && layer.stroke ? layer.strokeColor : 'transparent',
    paintOrder: 'stroke fill',
    textShadow:
      plainText && layer.shadow ? `0 ${metrics.shadowOffset}px ${metrics.shadowBlur}px rgba(0,0,0,0.4)` : 'none',
  }
}

// ---------- 舞台交互 ----------

const drag = {
  id: '',
  mode: '',
  pointerId: null,
  startX: 0,
  startY: 0,
  baseX: 0,
  baseY: 0,
  startDistance: 1,
  startAngle: 0,
  startRotation: 0,
  startSize: 0.1,
}

function onLayerPointerDown(layer, event) {
  if (event.button !== 0) return
  selectLayer(layer.id)
  startDrag(layer, 'move', event)
}

function onHandlePointerDown(layer, mode, event) {
  if (event.button !== 0) return
  event.stopPropagation()
  selectLayer(layer.id)
  const rect = canvasEl.value.getBoundingClientRect()
  const cx = rect.left + layer.x * rect.width
  const cy = rect.top + layer.y * rect.height
  drag.startAngle = Math.atan2(event.clientY - cy, event.clientX - cx)
  drag.startDistance = Math.max(1, Math.hypot(event.clientX - cx, event.clientY - cy))
  drag.startRotation = layer.rotation
  drag.startSize = layer.fontSize
  startDrag(layer, mode, event)
}

function startDrag(layer, mode, event) {
  drag.id = layer.id
  drag.mode = mode
  drag.pointerId = event.pointerId
  drag.startX = event.clientX
  drag.startY = event.clientY
  drag.baseX = layer.x
  drag.baseY = layer.y
  event.currentTarget.setPointerCapture?.(event.pointerId)
}

function onCanvasPointerMove(event) {
  if (!drag.id || event.pointerId !== drag.pointerId) return
  const layer = layers.value.find((item) => item.id === drag.id)
  if (!layer || !canvasEl.value) return
  const rect = canvasEl.value.getBoundingClientRect()

  if (drag.mode === 'move') {
    layer.x = clamp(drag.baseX + (event.clientX - drag.startX) / rect.width, 0, 1)
    layer.y = clamp(drag.baseY + (event.clientY - drag.startY) / rect.height, 0, 1)
    return
  }

  const cx = rect.left + layer.x * rect.width
  const cy = rect.top + layer.y * rect.height
  const dx = event.clientX - cx
  const dy = event.clientY - cy

  if (drag.mode === 'resize') {
    const distance = Math.max(1, Math.hypot(dx, dy))
    layer.fontSize = clamp((drag.startSize * distance) / drag.startDistance, 0.02, 0.7)
  } else {
    let degrees = drag.startRotation + ((Math.atan2(dy, dx) - drag.startAngle) * 180) / Math.PI
    if (event.shiftKey) degrees = Math.round(degrees / 15) * 15
    layer.rotation = Math.round(normalizeAngle(degrees) * 10) / 10
  }
}

function onCanvasPointerUp(event) {
  if (drag.id && event.pointerId === drag.pointerId) {
    drag.id = ''
    drag.mode = ''
    drag.pointerId = null
  }
}

function onLayerWheel(layer, event) {
  const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08
  layer.fontSize = clamp(layer.fontSize * factor, 0.02, 0.7)
  selectLayer(layer.id)
}

function normalizeAngle(degrees) {
  let value = degrees
  while (value > 180) value -= 360
  while (value < -180) value += 360
  return value
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

// ---------- 导出 ----------

function composeEditor() {
  const image = base.value.image
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  const long = exportLong.value
  const scale = long ? long / Math.max(sourceWidth, sourceHeight) : 1
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)
  layers.value.forEach((layer) => drawLayer(context, layer, width, height))
  return canvas
}

function drawLayer(context, layer, width, height) {
  const metrics = layerMetrics(layer, width)
  const plainText = layer.background === 'none'

  context.save()
  context.translate(layer.x * width, layer.y * height)
  if (layer.rotation) context.rotate((layer.rotation * Math.PI) / 180)

  if (layer.background !== 'none') {
    const x = -metrics.boxWidth / 2
    const y = -metrics.boxHeight / 2
    applyShadow(context, layer, metrics)
    traceBox(context, x, y, metrics, layer.background === 'bubble')
    context.fillStyle = layer.bgColor
    context.fill()
    clearShadow(context)
  }

  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = fontString(layer, metrics.px)
  context.lineJoin = 'round'
  context.miterLimit = 2

  const firstLine = -metrics.boxHeight / 2 + metrics.padY + metrics.lineHeight / 2
  metrics.lines.forEach((line, index) => {
    const y = firstLine + index * metrics.lineHeight
    if (plainText && layer.shadow) applyShadow(context, layer, metrics)
    if (plainText && layer.stroke) {
      context.lineWidth = metrics.strokePx
      context.strokeStyle = layer.strokeColor
      context.strokeText(line, 0, y)
    }
    context.fillStyle = layer.color
    context.fillText(line, 0, y)
    clearShadow(context)
  })

  context.restore()
}

function applyShadow(context, layer, metrics) {
  if (!layer.shadow) return
  context.shadowColor = 'rgba(0,0,0,0.4)'
  context.shadowBlur = metrics.shadowBlur
  context.shadowOffsetY = metrics.shadowOffset
}

function clearShadow(context) {
  context.shadowColor = 'transparent'
  context.shadowBlur = 0
  context.shadowOffsetY = 0
}

// 圆角矩形 + 气泡尾巴走同一条路径，填充后不会出现描边接缝
function traceBox(context, x, y, metrics, withTail) {
  const { boxWidth: width, boxHeight: height, radius } = metrics
  const bottom = y + height
  context.beginPath()
  context.moveTo(x + radius, y)
  context.lineTo(x + width - radius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + radius)
  context.lineTo(x + width, bottom - radius)
  context.quadraticCurveTo(x + width, bottom, x + width - radius, bottom)
  if (withTail) {
    const tailX = x + metrics.tailLeft
    context.lineTo(tailX + metrics.tailWidth, bottom)
    context.lineTo(tailX + metrics.tailWidth * 0.22, bottom + metrics.tailHeight)
    context.lineTo(tailX, bottom)
  }
  context.lineTo(x + radius, bottom)
  context.quadraticCurveTo(x, bottom, x, bottom - radius)
  context.lineTo(x, y + radius)
  context.quadraticCurveTo(x, y, x + radius, y)
  context.closePath()
}

async function exportImage(format) {
  if (exporting.value || !base.value) return
  exporting.value = format
  try {
    const canvas = composeEditor()
    const output = format === 'jpg' ? flattenOnWhite(canvas) : canvas
    const blob = await canvasToBlob(output, format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92)
    const name = (base.value.name || '图片').replace(/\.[^.]+$/, '')
    downloadBlob(blob, `${name}-编辑.${format}`)
    ElMessage.success(`已导出 ${output.width} × ${output.height}`)
  } catch (error) {
    ElMessage.error(error.message || '导出失败')
  } finally {
    exporting.value = ''
  }
}
</script>

<template>
  <section class="page-editor">
    <header class="page-header">
      <div>
        <h1>图片编辑</h1>
        <p class="lede">
          先放一张底图，再往上拖文案、表情和符号。每个图层都能拖动、滚轮缩放、转把手旋转，改完直接导出成品图。
        </p>
      </div>
    </header>

    <section class="layout">
      <div class="stage-wrap">
        <div class="pair-export-bar">
          <span class="pair-export-info">
            {{ base ? `${layerCount} 个图层 · ${base.image.naturalWidth} × ${base.image.naturalHeight}` : '等待底图' }}
          </span>
          <div class="pair-export-btns">
            <el-button size="small" :disabled="!base" @click="clearLayers">清空图层</el-button>
            <el-button
              type="primary"
              size="small"
              :disabled="!base"
              :loading="exporting === 'png'"
              @click="exportImage('png')"
            >
              导出 PNG
            </el-button>
            <el-button
              size="small"
              :disabled="!base"
              :loading="exporting === 'jpg'"
              @click="exportImage('jpg')"
            >
              导出 JPG
            </el-button>
          </div>
        </div>

        <div ref="stageEl" class="stage stage-editor">
          <div
            v-if="base"
            ref="canvasEl"
            class="ed-canvas"
            :style="canvasStyle()"
            @pointerdown="deselect"
            @pointermove="onCanvasPointerMove"
            @pointerup="onCanvasPointerUp"
            @pointercancel="onCanvasPointerUp"
          >
            <img class="ed-base" :src="base.url" alt="" draggable="false" />

            <div
              v-for="layer in layers"
              :key="layer.id"
              class="ed-layer"
              :class="{ 'is-selected': selectedId === layer.id }"
              :style="layerFrameStyle(layer)"
              tabindex="0"
              @pointerdown.stop="onLayerPointerDown(layer, $event)"
              @pointermove.stop="onCanvasPointerMove"
              @pointerup.stop="onCanvasPointerUp"
              @wheel.prevent="onLayerWheel(layer, $event)"
              @dblclick="resetTransform"
            >
              <span v-if="layer.background !== 'none'" class="ed-box" :style="boxStyle(layer, layerMetrics(layer, canvasW || 1))"></span>
              <span
                v-if="layer.background === 'bubble'"
                class="ed-tail"
                :style="tailStyle(layer, layerMetrics(layer, canvasW || 1))"
              ></span>
              <span class="ed-text" :style="textStyle(layer)">{{ layer.text }}</span>

              <template v-if="selectedId === layer.id">
                <button
                  type="button"
                  class="ed-handle is-rotate"
                  aria-label="旋转"
                  @pointerdown.stop="onHandlePointerDown(layer, 'rotate', $event)"
                  @pointermove.stop="onCanvasPointerMove"
                  @pointerup.stop="onCanvasPointerUp"
                ></button>
                <button
                  type="button"
                  class="ed-handle is-resize"
                  aria-label="缩放"
                  @pointerdown.stop="onHandlePointerDown(layer, 'resize', $event)"
                  @pointermove.stop="onCanvasPointerMove"
                  @pointerup.stop="onCanvasPointerUp"
                ></button>
              </template>
            </div>
          </div>

          <div v-else class="empty">
            <div>
              <strong>还没有底图</strong>
              <p>在右侧上传一张图片，或从素材库选一张，然后就能往上面摆文案和表情了。</p>
            </div>
          </div>
        </div>

        <div class="meta">
          <span>{{ base ? '拖动图层 · 滚轮缩放 · 顶部把手旋转 · 方向键微调' : '先准备一张底图' }}</span>
          <span>导出尺寸跟随「{{ (EXPORT_LONGS.find((item) => item.key === exportLong) || EXPORT_LONGS[0]).label }}」</span>
        </div>
      </div>

      <aside class="tray">
        <h2>底图与图层</h2>

        <div class="upload-block field">
          <el-upload
            ref="uploadRef"
            drag
            :auto-upload="false"
            :show-file-list="false"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            :on-change="onFileChange"
          >
            <el-icon class="upload-icon"><UploadFilled /></el-icon>
            <div class="upload-title">{{ base ? '更换底图' : '点击或拖入底图' }}</div>
            <div class="upload-sub">图层位置按图片比例保存，换图不会丢</div>
          </el-upload>
          <div class="ed-base-btns">
            <el-button class="lib-btn" size="small" @click="pickerVisible = true">从素材库选图</el-button>
            <el-button v-if="base" size="small" @click="clearBase">移除底图</el-button>
          </div>
          <MaterialPicker v-model="pickerVisible" :multiple="false" @confirm="onPickFromLibrary" />
        </div>

        <div class="field">
          <div class="field-label"><span>加文案</span></div>
          <el-input
            v-model="newText"
            type="textarea"
            :rows="2"
            resize="none"
            placeholder="输入文字，回车或点按钮加到图上"
            @keydown.enter.exact.prevent="addText(newText)"
          />
          <el-button class="ed-add-btn" type="primary" size="small" @click="addText(newText)">添加文案</el-button>
          <div class="ed-chips">
            <button
              v-for="preset in PRESETS"
              :key="preset.text"
              type="button"
              class="ed-chip"
              @click="addText(preset.text, preset.patch)"
            >
              {{ preset.text }}
            </button>
          </div>
        </div>

        <div class="field">
          <div class="field-label"><span>表情与符号</span><span>点一下就加</span></div>
          <div class="ed-groups">
            <button
              v-for="group in STICKER_GROUPS"
              :key="group.key"
              type="button"
              class="ed-group"
              :class="{ 'is-active': stickerGroup === group.key }"
              @click="stickerGroup = group.key"
            >
              {{ group.label }}
            </button>
          </div>
          <div class="ed-stickers">
            <button
              v-for="item in (STICKER_GROUPS.find((group) => group.key === stickerGroup) || STICKER_GROUPS[0]).items"
              :key="item"
              type="button"
              class="ed-sticker"
              @click="addSticker(item, (STICKER_GROUPS.find((group) => group.key === stickerGroup) || {}).asText)"
            >
              {{ item }}
            </button>
          </div>
        </div>

        <template v-if="selectedLayer">
          <div class="field">
            <div class="field-label"><span>图层内容</span></div>
            <el-input
              v-model="selectedLayer.text"
              :type="selectedLayer.type === 'text' ? 'textarea' : 'text'"
              :rows="2"
              resize="none"
              placeholder="改内容"
            />
          </div>

          <div class="field">
            <div class="field-label"><span>字号</span><span>{{ Math.round(selectedLayer.fontSize * 100) }}%</span></div>
            <el-slider v-model="selectedFontSize" :min="2" :max="60" :step="0.5" :format-tooltip="(value) => `${value}%`" />
            <div class="ed-cell-btns">
              <el-button size="small" @click="selectedLayer.rotation = 0">转正</el-button>
              <el-button size="small" @click="duplicateLayer">复制一层</el-button>
              <el-button size="small" @click="removeLayer(selectedLayer.id)">删除</el-button>
            </div>
          </div>

          <div class="field">
            <div class="field-label"><span>旋转</span><span>{{ selectedLayer.rotation }}°</span></div>
            <el-slider v-model="selectedLayer.rotation" :min="-180" :max="180" :step="1" />
          </div>

          <template v-if="selectedLayer.type === 'text'">
            <div class="field">
              <div class="field-label"><span>字体</span></div>
              <div class="ed-row">
                <el-select v-model="selectedLayer.fontKey" style="width: 100%">
                  <el-option v-for="font in FONTS" :key="font.key" :label="font.label" :value="font.key" />
                </el-select>
                <el-switch v-model="selectedLayer.bold" size="small" active-text="粗" />
              </div>
            </div>

            <div class="field">
              <div class="field-label"><span>样式</span></div>
              <el-radio-group v-model="selectedLayer.background" size="small">
                <el-radio-button v-for="item in BACKGROUNDS" :key="item.key" :value="item.key">
                  {{ item.label }}
                </el-radio-button>
              </el-radio-group>
              <div v-if="selectedLayer.background !== 'none'" class="ed-colors">
                <span class="ed-color-label">底色</span>
                <el-color-picker v-model="selectedLayer.bgColor" size="small" />
                <span class="ed-color-label">文字</span>
                <el-color-picker v-model="selectedLayer.color" size="small" />
              </div>
            </div>

            <div v-if="selectedLayer.background === 'none'" class="field">
              <div class="field-label"><span>描边</span><span>{{ Math.round(selectedLayer.strokeWidth * 100) }}</span></div>
              <div class="ed-colors">
                <el-switch v-model="selectedLayer.stroke" size="small" />
                <el-color-picker v-model="selectedLayer.strokeColor" size="small" :disabled="!selectedLayer.stroke" />
              </div>
              <el-slider v-model="selectedLayer.strokeWidth" :min="0.04" :max="0.3" :step="0.01" :disabled="!selectedLayer.stroke" />
            </div>

            <div class="field">
              <div class="field-label"><span>投影</span></div>
              <el-switch v-model="selectedLayer.shadow" size="small" />
            </div>
          </template>

          <div class="field">
            <div class="field-label"><span>图层顺序</span></div>
            <div class="ed-cell-btns">
              <el-button size="small" @click="moveLayer(1)">上移一层</el-button>
              <el-button size="small" @click="moveLayer(-1)">下移一层</el-button>
            </div>
          </div>
        </template>

        <div class="field">
          <div class="field-label"><span>导出长边</span></div>
          <el-select v-model="exportLong" style="width: 100%">
            <el-option v-for="item in EXPORT_LONGS" :key="item.key" :label="item.label" :value="item.key" />
          </el-select>
        </div>

        <p v-if="!selectedLayer" class="hint">
          {{ layers.length ? '点选画布上的图层即可编辑它的样式。' : '还没有图层，先加一句文案或一个表情。' }}
        </p>
      </aside>
    </section>
  </section>
</template>
