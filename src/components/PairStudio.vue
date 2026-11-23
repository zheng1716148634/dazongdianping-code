<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import {
  canvasToBlob,
  computeCoverMetrics,
  downloadBlob,
  drawImageCover,
  flattenOnWhite,
  localPanToOffset,
  screenDeltaToLocalPan,
} from '../utils/composeImage'
import { blobToFile } from '../utils/imageHandoff'
import MaterialPicker from './MaterialPicker.vue'

// 双拼画布可选比例（宽高比）
const ASPECTS = [
  { key: '3:4', label: '3:4 竖版', value: 3 / 4 },
  { key: '4:5', label: '4:5 竖版', value: 4 / 5 },
  { key: '1:1', label: '1:1 方形', value: 1 },
  { key: '9:16', label: '9:16 长图', value: 9 / 16 },
]

const EXPORT_LONGS = [1080, 1440, 2048]

const uploadRef = ref()
const materials = ref([])
const pairs = ref([])
const aspectKey = ref('3:4')
const gap = ref(0) // 0~40，按画布宽度的千分比，默认 0 无缝双拼
const exportLong = ref(1440)
const exporting = ref('')
const selectedPair = ref(-1)
const selectedSlot = ref(-1)
const dragOver = ref('')
const grabbing = ref('')
const panState = { pointerId: null, key: '', startX: 0, startY: 0, panX: 0, panY: 0 }
const rotateState = { pointerId: null, key: '', centerX: 0, centerY: 0, startAngle: 0, startRotation: 0 }

// 撤回栈：每次改动前记录一份双拼快照，误操作后可退回上一步
const HISTORY_LIMIT = 50
const history = ref([])
let pendingHistory = null
let lastRecordAt = 0

function buildSnapshot() {
  return {
    pairs: pairs.value.map((pair) => ({
      id: pair.id,
      label: pair.label,
      slots: pair.slots.map((slot) => ({
        materialId: slot.materialId,
        scale: slot.scale,
        rotation: slot.rotation || 0,
        pan: { x: slot.pan.x, y: slot.pan.y },
      })),
    })),
    selectedPair: selectedPair.value,
    selectedSlot: selectedSlot.value,
  }
}

function pushSnapshot(snapshot) {
  const last = history.value[history.value.length - 1]
  if (last && JSON.stringify(last.pairs) === JSON.stringify(snapshot.pairs)) return
  history.value.push(snapshot)
  if (history.value.length > HISTORY_LIMIT) history.value.shift()
}

function recordHistory() {
  lastRecordAt = performance.now()
  pushSnapshot(buildSnapshot())
}

// 连续操作（滚轮缩放、拖滑块）只按节奏记一次，避免撤回要退很多小步
function recordHistorySoon() {
  const now = performance.now()
  if (now - lastRecordAt < 400) return
  recordHistory()
}

function capturePendingHistory() {
  pendingHistory = buildSnapshot()
}

function commitPendingHistory() {
  if (!pendingHistory) return
  pushSnapshot(pendingHistory)
  pendingHistory = null
  lastRecordAt = performance.now()
}

function undoLast() {
  const snapshot = history.value.pop()
  if (!snapshot) return
  pendingHistory = null
  lastRecordAt = 0
  grabbing.value = ''
  panState.key = ''
  panState.pointerId = null
  rotateState.key = ''
  rotateState.pointerId = null
  dragOver.value = ''
  pairs.value = snapshot.pairs.map((pair) => ({
    ...pair,
    slots: pair.slots.map((slot) => ({
      ...slot,
      // 素材若已被删除，不能还原，按空位处理
      materialId: materialMap.value[slot.materialId] ? slot.materialId : null,
      pan: { ...slot.pan },
    })),
  }))
  const pair = pairs.value[snapshot.selectedPair]
  if (pair && pair.slots[snapshot.selectedSlot]) {
    selectedPair.value = snapshot.selectedPair
    selectedSlot.value = snapshot.selectedSlot
  } else {
    selectedPair.value = -1
    selectedSlot.value = -1
  }
  ElMessage.info('已撤回上一步')
}

const currentAspect = computed(
  () => ASPECTS.find((item) => item.key === aspectKey.value) || ASPECTS[0],
)
const materialMap = computed(() =>
  Object.fromEntries(materials.value.map((material) => [material.id, material])),
)
const totalPairs = computed(() => pairs.value.length)
const exportablePairs = computed(() => pairs.value.filter((pair) => pairHasContent(pair)).length)

const selectedZoom = computed({
  get() {
    const slot = currentSlot()
    const material = slot ? materialMap.value[slot.materialId] : null
    return slot && material ? Math.round(slot.scale * 100) : 100
  },
  set(value) {
    const slot = currentSlot()
    if (!slot) return
    recordHistorySoon()
    slot.scale = clamp(value / 100, 1, 5)
    clampPan(slot)
  },
})

const selectedRotation = computed({
  get() {
    const slot = currentSlot()
    const material = slot ? materialMap.value[slot.materialId] : null
    return slot && material ? Math.round(slot.rotation || 0) : 0
  },
  set(value) {
    const slot = currentSlot()
    if (!slot) return
    recordHistorySoon()
    slot.rotation = normalizeAngle(value)
    clampPan(slot)
  },
})

// 90° 快捷旋转：在当前角度上叠加并归一化到 -180~180
function rotateSelectedSlot(deg) {
  const slot = currentSlot()
  if (!slot || !slot.materialId) return
  recordHistory()
  slot.rotation = normalizeAngle((slot.rotation || 0) + deg)
  clampPan(slot)
}

function normalizeAngle(value) {
  const deg = Number(value)
  if (!Number.isFinite(deg)) return 0
  return (((deg + 180) % 360) + 360) % 360 - 180
}

function currentSlot() {
  const pair = pairs.value[selectedPair.value]
  return pair ? pair.slots[selectedSlot.value] : null
}

onBeforeUnmount(() => {
  materials.value.forEach((material) => URL.revokeObjectURL(material.url))
})

async function onFileChange(uploadFile) {
  const file = uploadFile.raw
  if (!file) return
  if (!file.type.startsWith('image/')) {
    ElMessage.error('请上传 PNG、JPG、WEBP 等图片')
    return
  }
  try {
    const loaded = await loadImage(file)
    materials.value.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      url: loaded.url,
      image: loaded.image,
    })
    uploadRef.value?.clearFiles()
  } catch (error) {
    ElMessage.error(error.message || '这张图片读取失败')
  }
}

function removeMaterial(id) {
  const index = materials.value.findIndex((material) => material.id === id)
  if (index < 0) return
  URL.revokeObjectURL(materials.value[index].url)
  materials.value.splice(index, 1)
  pairs.value.forEach((pair, pairIndex) => {
    pair.slots.forEach((slot, slotIndex) => {
      if (slot.materialId === id) {
        pair.slots[slotIndex] = emptySlot()
        if (pairIndex === selectedPair.value && slotIndex === selectedSlot.value) {
          selectedPair.value = -1
          selectedSlot.value = -1
        }
      }
    })
  })
}

// 一键上下双拼：按素材顺序两两分组，已有的缩放/平移按素材保留
function generatePairs() {
  if (!materials.value.length) {
    ElMessage.info('先上传图片素材')
    return
  }
  recordHistory()
  const previous = new Map()
  pairs.value.forEach((pair) => {
    pair.slots.forEach((slot) => {
      if (slot.materialId) previous.set(slot.materialId, slot)
    })
  })

  const next = []
  for (let index = 0; index < materials.value.length; index += 2) {
    const pairIndex = index / 2 + 1
    const groups = [materials.value[index], materials.value[index + 1]]
    next.push({
      id: `pair-${Date.now()}-${index}`,
      label: `双拼 ${pairIndex}`,
      slots: groups.map((material) => {
        if (!material) return emptySlot()
        const old = previous.get(material.id)
        return old
          ? {
              materialId: material.id,
              scale: old.scale,
              rotation: old.rotation || 0,
              pan: { ...old.pan },
            }
          : { materialId: material.id, scale: 1, rotation: 0, pan: { x: 0, y: 0 } }
      }),
    })
  }

  pairs.value = next
  selectedPair.value = -1
  selectedSlot.value = -1
  ElMessage.success(`已生成 ${next.length} 组上下双拼`)
}

function emptySlot() {
  return { materialId: null, scale: 1, rotation: 0, pan: { x: 0, y: 0 } }
}

function materialOf(slot) {
  return slot.materialId ? materialMap.value[slot.materialId] : null
}

function pairHasContent(pair) {
  return pair.slots.some((slot) => materialOf(slot))
}

function slotKey(pairIndex, slotIndex) {
  return `${pairIndex}-${slotIndex}`
}

function selectSlot(pairIndex, slotIndex) {
  selectedPair.value = pairIndex
  selectedSlot.value = slotIndex
}

function resetSlot(pairIndex, slotIndex) {
  const slot = pairs.value[pairIndex].slots[slotIndex]
  recordHistory()
  slot.scale = 1
  slot.rotation = 0
  slot.pan.x = 0
  slot.pan.y = 0
}

function clearSlot(pairIndex, slotIndex) {
  recordHistory()
  pairs.value[pairIndex].slots[slotIndex] = emptySlot()
  if (selectedPair.value === pairIndex && selectedSlot.value === slotIndex) {
    selectedPair.value = -1
    selectedSlot.value = -1
  }
}

function removePair(pairIndex) {
  recordHistory()
  pairs.value.splice(pairIndex, 1)
  selectedPair.value = -1
  selectedSlot.value = -1
}

// 单组上下互换：整组 slot 对象对调，图片的缩放/旋转/平移随素材一起过去
function swapPair(pairIndex) {
  const pair = pairs.value[pairIndex]
  if (!pair) return
  recordHistory()
  pair.slots = [pair.slots[1], pair.slots[0]]
  // 选中的是这一组的格子时跟着换到对应位置，避免右侧面板指向另一张图
  if (selectedPair.value === pairIndex && selectedSlot.value >= 0) {
    selectedSlot.value = selectedSlot.value === 0 ? 1 : 0
  }
}

// 手动新增一组空白双拼模板，可在组内拖图/点素材填充
function addPair() {
  recordHistory()
  pairs.value.push({
    id: `pair-${Date.now()}-manual`,
    label: `双拼 ${pairs.value.length + 1}`,
    slots: [emptySlot(), emptySlot()],
  })
}

// 与导出同一套 cover 数学：fracW/fracH 都以画布宽度为单位（含旋转）
function slotMetrics(slot) {
  const material = materialOf(slot)
  if (!material) return null
  const aspect = currentAspect.value.value
  const g = gap.value / 1000
  const fracW = 1 - g
  const fracH = 0.5 / aspect - g
  const image = material.image
  const m = computeCoverMetrics({
    cellWidth: fracW,
    cellHeight: fracH,
    imgW: image.naturalWidth,
    imgH: image.naturalHeight,
    zoom: slot.scale,
    rotation: slot.rotation || 0,
  })
  return { image, cellWidth: fracW, cellHeight: fracH, ...m }
}

function slotBoxStyle(slotIndex) {
  const aspect = currentAspect.value.value
  const g = gap.value / 1000
  return {
    top: `${(slotIndex * 0.5 + (g * aspect) / 2) * 100}%`,
    left: `${(g / 2) * 100}%`,
    width: `${(1 - g) * 100}%`,
    height: `${(0.5 - g * aspect) * 100}%`,
  }
}

function slotImageStyle(slot) {
  const metrics = slotMetrics(slot)
  if (!metrics) return {}
  const { kx, ky, panX, panY, cos, sin, cellWidth, cellHeight } = metrics
  const { ox, oy } = localPanToOffset(slot.pan.x, slot.pan.y, panX, panY, cos, sin)
  const widthPct = kx * 100
  const heightPct = ky * 100
  return {
    left: `${50 + (ox / cellWidth) * 100 - widthPct / 2}%`,
    top: `${50 + (oy / cellHeight) * 100 - heightPct / 2}%`,
    width: `${widthPct}%`,
    height: `${heightPct}%`,
    transform: `rotate(${slot.rotation || 0}deg)`,
    transformOrigin: 'center center',
  }
}

function clampPan(slot) {
  const metrics = slotMetrics(slot)
  if (!metrics) return
  slot.pan.x = metrics.panX > 0 ? clamp(slot.pan.x, -1, 1) : 0
  slot.pan.y = metrics.panY > 0 ? clamp(slot.pan.y, -1, 1) : 0
}

function onSlotPointerDown(pairIndex, slotIndex, event) {
  selectSlot(pairIndex, slotIndex)
  const slot = pairs.value[pairIndex].slots[slotIndex]
  if (!slot.materialId || event.button !== 0) return
  capturePendingHistory()
  panState.pointerId = event.pointerId
  panState.key = slotKey(pairIndex, slotIndex)
  panState.startX = event.clientX
  panState.startY = event.clientY
  panState.panX = slot.pan.x
  panState.panY = slot.pan.y
  event.currentTarget.setPointerCapture(event.pointerId)
}

function onSlotPointerMove(pairIndex, slotIndex, event) {
  const key = slotKey(pairIndex, slotIndex)
  if (panState.key !== key || event.pointerId !== panState.pointerId) return
  const slot = pairs.value[pairIndex].slots[slotIndex]
  const metrics = slotMetrics(slot)
  if (!metrics) return
  const rect = event.currentTarget.getBoundingClientRect()
  // 屏幕像素位移换算到与格子同单位，再投影到图片局部坐标，拖动方向跟随旋转
  const dxUnits = ((event.clientX - panState.startX) * metrics.cellWidth) / rect.width
  const dyUnits = ((event.clientY - panState.startY) * metrics.cellHeight) / rect.height
  const { dPanX, dPanY } = screenDeltaToLocalPan(
    dxUnits,
    dyUnits,
    metrics.panX,
    metrics.panY,
    metrics.cos,
    metrics.sin,
  )
  commitPendingHistory()
  grabbing.value = key
  slot.pan.x = clamp(panState.panX + dPanX, -1, 1)
  slot.pan.y = clamp(panState.panY + dPanY, -1, 1)
}

function onSlotPointerUp(pairIndex, slotIndex, event) {
  if (panState.key !== slotKey(pairIndex, slotIndex) || event.pointerId !== panState.pointerId) return
  pendingHistory = null
  panState.key = ''
  panState.pointerId = null
  grabbing.value = ''
}

// 画布内拖拽旋转：以格子中心为轴，手柄绕中心的角度增量叠加到起始角度
function onSlotRotateDown(pairIndex, slotIndex, event) {
  event.stopPropagation()
  const slot = pairs.value[pairIndex].slots[slotIndex]
  if (!slot || !slot.materialId || event.button !== 0) return
  const rect = event.currentTarget.parentElement.getBoundingClientRect()
  capturePendingHistory()
  rotateState.pointerId = event.pointerId
  rotateState.key = slotKey(pairIndex, slotIndex)
  rotateState.centerX = rect.left + rect.width / 2
  rotateState.centerY = rect.top + rect.height / 2
  rotateState.startAngle = pointerAngle(event.clientX, event.clientY)
  rotateState.startRotation = slot.rotation || 0
  event.currentTarget.setPointerCapture(event.pointerId)
}

function onSlotRotateMove(pairIndex, slotIndex, event) {
  const key = slotKey(pairIndex, slotIndex)
  if (rotateState.key !== key || event.pointerId !== rotateState.pointerId) return
  const slot = pairs.value[pairIndex].slots[slotIndex]
  if (!slot) return
  commitPendingHistory()
  const delta = pointerAngle(event.clientX, event.clientY) - rotateState.startAngle
  let rotation = normalizeAngle(rotateState.startRotation + delta)
  // 接近 90° 整数倍时吸附，方便转正
  const snap = Math.round(rotation / 90) * 90
  if (Math.abs(rotation - snap) <= 4) rotation = normalizeAngle(snap)
  slot.rotation = rotation
  clampPan(slot)
}

function onSlotRotateUp(pairIndex, slotIndex, event) {
  if (rotateState.key !== slotKey(pairIndex, slotIndex) || event.pointerId !== rotateState.pointerId) return
  pendingHistory = null
  rotateState.key = ''
  rotateState.pointerId = null
}

function pointerAngle(clientX, clientY) {
  return (Math.atan2(clientY - rotateState.centerY, clientX - rotateState.centerX) * 180) / Math.PI
}

function onSlotWheel(pairIndex, slotIndex, event) {
  const slot = pairs.value[pairIndex].slots[slotIndex]
  if (!slot.materialId) return
  recordHistorySoon()
  const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08
  slot.scale = clamp(slot.scale * factor, 1, 5)
  clampPan(slot)
  selectSlot(pairIndex, slotIndex)
}

function onMaterialDragStart(material, event) {
  event.dataTransfer.setData('text/plain', material.id)
  event.dataTransfer.effectAllowed = 'copy'
}

function onSlotDragOver(pairIndex, slotIndex, event) {
  event.dataTransfer.dropEffect = 'copy'
  dragOver.value = slotKey(pairIndex, slotIndex)
}

function onSlotDragLeave(pairIndex, slotIndex) {
  if (dragOver.value === slotKey(pairIndex, slotIndex)) dragOver.value = ''
}

function onSlotDrop(pairIndex, slotIndex, event) {
  dragOver.value = ''
  const material = materialMap.value[event.dataTransfer.getData('text/plain')]
  if (!material) return
  recordHistory()
  pairs.value[pairIndex].slots[slotIndex] = {
    materialId: material.id,
    scale: 1,
    rotation: 0,
    pan: { x: 0, y: 0 },
  }
  selectSlot(pairIndex, slotIndex)
}

// 点击素材：优先填入选中的格子（选中格有图则替换），没选中格时才找第一个空格
function pickMaterial(material) {
  if (!pairs.value.length) {
    ElMessage.info('先点「一键上下双拼」生成双拼组')
    return
  }
  const pair = pairs.value[selectedPair.value]
  if (pair && selectedSlot.value >= 0) {
    recordHistory()
    pair.slots[selectedSlot.value] = {
      materialId: material.id,
      scale: 1,
      rotation: 0,
      pan: { x: 0, y: 0 },
    }
    return
  }
  for (let pairIndex = 0; pairIndex < pairs.value.length; pairIndex += 1) {
    const slotIndex = pairs.value[pairIndex].slots.findIndex((slot) => !slot.materialId)
    if (slotIndex >= 0) {
      recordHistory()
      pairs.value[pairIndex].slots[slotIndex] = {
        materialId: material.id,
        scale: 1,
        rotation: 0,
        pan: { x: 0, y: 0 },
      }
      selectSlot(pairIndex, slotIndex)
      return
    }
  }
  ElMessage.info('双拼格已填满，先点选要替换的格子再点素材，或把素材直接拖进格子')
}

// 单组预览：按导出参数实时合成一张图，用大图查看器放大检查导出效果
const previewVisible = ref(false)
const previewUrl = ref('')
const previewingIndex = ref(-1)

async function previewPair(pairIndex) {
  if (exporting.value || previewingIndex.value >= 0) return
  const pair = pairs.value[pairIndex]
  if (!pair || !pairHasContent(pair)) {
    ElMessage.info('这一组还没有图片')
    return
  }
  previewingIndex.value = pairIndex
  try {
    const canvas = composePair(pair)
    const blob = await canvasToBlob(canvas, 'image/png', 0.92)
    previewUrl.value = URL.createObjectURL(blob)
    previewVisible.value = true
  } catch (error) {
    ElMessage.error(error.message || '预览生成失败')
  } finally {
    previewingIndex.value = -1
  }
}

function closePreview() {
  previewVisible.value = false
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
  }
}

async function exportPair(pairIndex, format) {
  if (exporting.value) return
  const pair = pairs.value[pairIndex]
  if (!pair || !pairHasContent(pair)) {
    ElMessage.info('这一组还没有图片')
    return
  }
  exporting.value = `one-${pairIndex}-${format}`
  try {
    const canvas = composePair(pair)
    const isJpeg = format === 'jpg'
    const output = isJpeg ? flattenOnWhite(canvas) : canvas
    const blob = await canvasToBlob(output, isJpeg ? 'image/jpeg' : 'image/png', 0.92)
    downloadBlob(blob, `${pair.label.replace(/\s+/g, '')}-${format === 'jpg' ? 'jpg' : 'png'}.${format}`)
    ElMessage.success(`已导出 ${pair.label} · ${output.width} × ${output.height}`)
  } catch (error) {
    ElMessage.error(error.message || '导出失败')
  } finally {
    exporting.value = ''
  }
}

// 批量导出：逐个下载，浏览器如提示「允许多文件下载」请选择允许
async function exportAll(format) {
  if (exporting.value) return
  const targets = pairs.value.filter((pair) => pairHasContent(pair))
  if (!targets.length) {
    ElMessage.info('还没有可导出的双拼，先点「一键上下双拼」')
    return
  }
  exporting.value = `all-${format}`
  try {
    let count = 0
    for (let index = 0; index < pairs.value.length; index += 1) {
      const pair = pairs.value[index]
      if (!pairHasContent(pair)) continue
      const canvas = composePair(pair)
      const isJpeg = format === 'jpg'
      const output = isJpeg ? flattenOnWhite(canvas) : canvas
      const blob = await canvasToBlob(output, isJpeg ? 'image/jpeg' : 'image/png', 0.92)
      const order = String(index + 1).padStart(2, '0')
      downloadBlob(blob, `双拼-${order}.${format}`)
      count += 1
      await new Promise((resolve) => setTimeout(resolve, 320))
    }
    ElMessage.success(`已批量导出 ${count} 张 ${format.toUpperCase()}，若浏览器拦截请允许本站多文件下载`)
  } catch (error) {
    ElMessage.error(error.message || '批量导出失败')
  } finally {
    exporting.value = ''
  }
}

// 按导出长边重建整组双拼，逐格 cover + 缩放 + 平移
function composePair(pair) {
  const aspect = currentAspect.value.value
  const long = exportLong.value
  const width = aspect >= 1 ? long : Math.round(long * aspect)
  const height = aspect >= 1 ? Math.round(long / aspect) : long
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  const gapPx = (gap.value / 1000) * width

  pair.slots.forEach((slot, slotIndex) => {
    const material = materialOf(slot)
    if (!material) return
    // 每格严格裁剪，避免放大后的图片溢出到另一格
    drawImageCover(
      context,
      material.image,
      {
        x: gapPx / 2,
        y: slotIndex * (height * 0.5) + gapPx / 2,
        width: width - gapPx,
        height: height * 0.5 - gapPx,
      },
      { zoom: slot.scale, panX: slot.pan.x, panY: slot.pan.y, rotation: slot.rotation || 0 },
    )
  })

  return canvas
}

function resetAll() {
  materials.value.forEach((material) => URL.revokeObjectURL(material.url))
  materials.value = []
  pairs.value = []
  selectedPair.value = -1
  selectedSlot.value = -1
  gap.value = 0
  history.value = []
  pendingHistory = null
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

// 从素材库选图（可多张，依次加入）
const pickerVisible = ref(false)
async function onPickFromLibrary(items) {
  for (const item of items) {
    await onFileChange({ raw: blobToFile(item.blob, item.name) })
  }
  pickerVisible.value = false
}
</script>

<template>
  <section class="page-pair">
    <header class="page-header">
      <div>
        <h1>批量拼接</h1>
        <p class="lede">
          一次上传多张素材，一键按顺序两两上下拼成一组。每组里的上、下格都能拖动、滚轮缩放、旋转调整，挑出图片最好的一面后再单张或批量导出。
        </p>
      </div>
    </header>

    <section class="layout">
      <div class="stage-wrap">
        <div class="pair-export-bar">
          <span class="pair-export-info">
            {{ totalPairs ? `共 ${totalPairs} 组 · 可导出 ${exportablePairs} 组` : '等待上传' }}
          </span>
          <div class="pair-export-btns">
            <el-button
              class="pair-undo-btn"
              size="small"
              :disabled="!history.length"
              @click="undoLast"
            >
              撤回上一步
            </el-button>
            <el-button size="small" @click="addPair">新增模板</el-button>
            <el-button
              type="primary"
              size="small"
              :disabled="!exportablePairs"
              :loading="exporting === 'all-png'"
              @click="exportAll('png')"
            >
              批量导出 PNG
            </el-button>
            <el-button
              size="small"
              :disabled="!exportablePairs"
              :loading="exporting === 'all-jpg'"
              @click="exportAll('jpg')"
            >
              批量导出 JPG
            </el-button>
          </div>
        </div>

        <div class="pair-stage">
          <div v-if="pairs.length" class="pair-list">
            <article v-for="(pair, pairIndex) in pairs" :key="pair.id" class="pair-card">
              <div class="pair-card-head">
                <span class="pair-card-title">{{ pair.label }}</span>
                <span class="pair-card-actions">
                  <button
                    type="button"
                    class="pair-mini"
                    title="上下互换这两张图"
                    :disabled="!pairHasContent(pair)"
                    @click="swapPair(pairIndex)"
                  >
                    互换
                  </button>
                  <button
                    type="button"
                    class="pair-mini"
                    :disabled="!!exporting || previewingIndex === pairIndex"
                    @click="previewPair(pairIndex)"
                  >
                    {{ previewingIndex === pairIndex ? '生成中…' : '预览' }}
                  </button>
                  <button
                    type="button"
                    class="pair-mini"
                    :disabled="!!exporting"
                    @click="exportPair(pairIndex, 'png')"
                  >
                    导出
                  </button>
                  <button type="button" class="pair-mini" @click="removePair(pairIndex)">移除</button>
                </span>
              </div>

              <div class="pair-canvas" :style="{ aspectRatio: String(currentAspect.value) }">
                <div
                  v-for="(slot, slotIndex) in pair.slots"
                  :key="slotIndex"
                  class="pair-slot"
                  :class="{
                    'is-filled': materialOf(slot),
                    'is-selected': selectedPair === pairIndex && selectedSlot === slotIndex,
                    'is-dragover': dragOver === slotKey(pairIndex, slotIndex),
                    'is-grabbing': grabbing === slotKey(pairIndex, slotIndex),
                  }"
                  :style="slotBoxStyle(slotIndex)"
                  tabindex="0"
                  @click="selectSlot(pairIndex, slotIndex)"
                  @dblclick="resetSlot(pairIndex, slotIndex)"
                  @pointerdown="onSlotPointerDown(pairIndex, slotIndex, $event)"
                  @pointermove="onSlotPointerMove(pairIndex, slotIndex, $event)"
                  @pointerup="onSlotPointerUp(pairIndex, slotIndex, $event)"
                  @pointercancel="onSlotPointerUp(pairIndex, slotIndex, $event)"
                  @wheel.prevent="onSlotWheel(pairIndex, slotIndex, $event)"
                  @dragover.prevent="onSlotDragOver(pairIndex, slotIndex, $event)"
                  @dragleave="onSlotDragLeave(pairIndex, slotIndex)"
                  @drop.prevent="onSlotDrop(pairIndex, slotIndex, $event)"
                >
                  <img
                    v-if="materialOf(slot)"
                    :src="materialOf(slot).url"
                    :style="slotImageStyle(slot)"
                    alt=""
                    draggable="false"
                  />
                  <span v-else class="pair-empty">{{ slotIndex === 0 ? '上格' : '下格' }} · 拖入图片</span>
                  <button
                    v-if="selectedPair === pairIndex && selectedSlot === slotIndex && materialOf(slot)"
                    type="button"
                    class="rotate-handle"
                    title="按住拖拽旋转图片"
                    aria-label="拖拽旋转"
                    @pointerdown.stop.prevent="onSlotRotateDown(pairIndex, slotIndex, $event)"
                    @pointermove="onSlotRotateMove(pairIndex, slotIndex, $event)"
                    @pointerup="onSlotRotateUp(pairIndex, slotIndex, $event)"
                    @pointercancel="onSlotRotateUp(pairIndex, slotIndex, $event)"
                    @click.stop
                    @dblclick.stop
                  ></button>
                </div>
              </div>
            </article>
          </div>

          <div v-else class="empty">
            <div>
              <strong>{{ materials.length ? '素材准备好了' : '还没有双拼' }}</strong>
              <p>
                {{ materials.length
                  ? `已上传 ${materials.length} 张素材，点右侧「一键上下双拼」自动两两成组。`
                  : '先在右侧上传图片，再一键生成上下双拼。' }}
              </p>
            </div>
          </div>
        </div>

        <div class="meta">
          <span>
            {{ totalPairs ? `共 ${totalPairs} 组 · 可导出 ${exportablePairs} 组` : '等待上传' }} · 比例
            {{ currentAspect.label }}
          </span>
          <span v-if="totalPairs">点选格子后滚轮缩放 · 拖动平移 · 拖格子右上角手柄旋转 · 双击复位</span>
        </div>
      </div>

      <aside class="tray">
        <h2>素材与双拼</h2>
        <p class="hint">上传后会按素材顺序从第 1 张开始，每两张拼成一组；奇数时会留一个空格位。</p>

        <div class="upload-block field">
          <el-upload
            ref="uploadRef"
            drag
            multiple
            :auto-upload="false"
            :show-file-list="false"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            :on-change="onFileChange"
          >
            <el-icon class="upload-icon"><UploadFilled /></el-icon>
            <div class="upload-title">点击或拖入图片素材</div>
            <div class="upload-sub">支持多张 · PNG、JPG、WEBP、GIF</div>
          </el-upload>
          <el-button class="lib-btn" size="small" @click="pickerVisible = true">从素材库选图</el-button>
          <MaterialPicker v-model="pickerVisible" multiple @confirm="onPickFromLibrary" />
        </div>

        <div v-if="materials.length" class="field">
          <div class="field-label"><span>素材库</span><span>{{ materials.length }} 张</span></div>
          <div class="material-grid">
            <div
              v-for="material in materials"
              :key="material.id"
              class="material-thumb"
              :title="material.name"
              draggable="true"
              @click="pickMaterial(material)"
              @dragstart="onMaterialDragStart(material, $event)"
            >
              <img :src="material.url" alt="" draggable="false" />
              <button
                type="button"
                class="material-remove"
                aria-label="删除素材"
                @click.stop="removeMaterial(material.id)"
              >
                ×
              </button>
            </div>
          </div>
        </div>

        <div class="actions actions-pair">
          <el-button type="primary" :disabled="!materials.length" @click="generatePairs">
            {{ pairs.length ? '重新一键上下双拼' : '一键上下双拼' }}
          </el-button>
        </div>

        <div class="field">
          <div class="field-label"><span>画布比例</span><span>上下两格</span></div>
          <el-select v-model="aspectKey" style="width: 100%">
            <el-option v-for="item in ASPECTS" :key="item.key" :label="item.label" :value="item.key" />
          </el-select>
        </div>

        <div class="field">
          <div class="field-label"><span>格子间距</span><span>{{ gap }}</span></div>
          <el-slider v-model="gap" :min="0" :max="40" :step="1" />
        </div>

        <div v-if="currentSlot() && materialOf(currentSlot())" class="field">
          <div class="field-label">
            <span>第 {{ selectedSlot + 1 }} 格（{{ selectedSlot === 0 ? '上' : '下' }}）缩放</span>
            <span>{{ selectedZoom }}%</span>
          </div>
          <el-slider v-model="selectedZoom" :min="100" :max="500" :step="5" />
          <div class="field-label">
            <span>第 {{ selectedSlot + 1 }} 格（{{ selectedSlot === 0 ? '上' : '下' }}）旋转</span>
            <span>{{ selectedRotation }}°</span>
          </div>
          <el-slider v-model="selectedRotation" :min="-180" :max="180" :step="1" />
          <div class="cell-actions">
            <el-button size="small" @click="rotateSelectedSlot(-90)">左转 90°</el-button>
            <el-button size="small" @click="rotateSelectedSlot(90)">右转 90°</el-button>
            <el-button size="small" @click="rotateSelectedSlot(180)">翻转 180°</el-button>
          </div>
          <div class="cell-actions">
            <el-button size="small" @click="resetSlot(selectedPair, selectedSlot)">复位本格</el-button>
            <el-button size="small" @click="clearSlot(selectedPair, selectedSlot)">清空此格</el-button>
          </div>
        </div>

        <div class="field">
          <div class="field-label"><span>导出长边</span><span>{{ exportLong }} px</span></div>
          <el-select v-model="exportLong" style="width: 100%">
            <el-option v-for="size in EXPORT_LONGS" :key="size" :label="`${size} 像素`" :value="size" />
          </el-select>
        </div>

        <div class="actions">
          <el-button :disabled="!materials.length && !pairs.length" @click="resetAll">清空</el-button>
        </div>

      
      </aside>
    </section>

    <!-- 导出效果预览：与实际导出同一套合成逻辑，可缩放旋转查看 -->
    <el-image-viewer
      v-if="previewVisible && previewUrl"
      :url-list="[previewUrl]"
      :z-index="3000"
      @close="closePreview"
    />
  </section>
</template>
