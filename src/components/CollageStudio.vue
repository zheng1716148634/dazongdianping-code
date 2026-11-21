<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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

// 预设模板：cells 为画布内的矩形（x/y/w/h 均为 0~1 的比例），aspect 为画布宽高比
const TEMPLATES = [
  {
    key: 'vertical',
    name: '上下拼图',
    ratioLabel: '3:4',
    aspect: 3 / 4,
    cells: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 },
    ],
  },
  {
    key: 'horizontal',
    name: '左右拼图',
    ratioLabel: '6:5',
    aspect: 1.2,
    cells: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ],
  },
  {
    key: 'grid4',
    name: '四宫格',
    ratioLabel: '1:1',
    aspect: 1,
    cells: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  {
    key: 'feature',
    name: '一大两小',
    ratioLabel: '3:4',
    aspect: 3 / 4,
    cells: [
      { x: 0, y: 0, w: 1, h: 2 / 3 },
      { x: 0, y: 2 / 3, w: 0.5, h: 1 / 3 },
      { x: 0.5, y: 2 / 3, w: 0.5, h: 1 / 3 },
    ],
  },
  {
    key: 'grid6',
    name: '六宫格',
    ratioLabel: '2:3',
    aspect: 2 / 3,
    cells: Array.from({ length: 6 }, (_, i) => ({
      x: (i % 2) * 0.5,
      y: Math.floor(i / 2) / 3,
      w: 0.5,
      h: 1 / 3,
    })),
  },
  {
    key: 'grid9',
    name: '九宫格',
    ratioLabel: '1:1',
    aspect: 1,
    cells: Array.from({ length: 9 }, (_, i) => ({
      x: (i % 3) / 3,
      y: Math.floor(i / 3) / 3,
      w: 1 / 3,
      h: 1 / 3,
    })),
  },
]

const EXPORT_LONGS = [1080, 1440, 2048]

const uploadRef = ref()
const materials = ref([])
const templateKey = ref('grid4')
const cells = ref([])
const selectedCell = ref(-1)
const gap = ref(0) // 0~40，间距按画布宽度的千分比计算，默认 0 无缝拼图
const exportLong = ref(1440)
const exporting = ref('')
const dragOverIndex = ref(-1)
const grabbingIndex = ref(-1)
const panState = { pointerId: null, index: -1, startX: 0, startY: 0, panX: 0, panY: 0 }
const rotateState = { pointerId: null, index: -1, centerX: 0, centerY: 0, startAngle: 0, startRotation: 0 }

const currentTemplate = computed(
  () => TEMPLATES.find((template) => template.key === templateKey.value) || TEMPLATES[0],
)
const materialMap = computed(() =>
  Object.fromEntries(materials.value.map((material) => [material.id, material])),
)
const filledCount = computed(
  () => cells.value.filter((cell) => cell.materialId && materialMap.value[cell.materialId]).length,
)
const hasContent = computed(() => filledCount.value > 0)

const selectedZoom = computed({
  get() {
    const cell = cells.value[selectedCell.value]
    return cell && cell.materialId && materialMap.value[cell.materialId]
      ? Math.round(cell.scale * 100)
      : 100
  },
  set(value) {
    const cell = cells.value[selectedCell.value]
    if (!cell) return
    cell.scale = clamp(value / 100, 1, 5)
    clampPan(cell, selectedCell.value)
  },
})

const selectedRotation = computed({
  get() {
    const cell = cells.value[selectedCell.value]
    return cell && cell.materialId ? Math.round(cell.rotation || 0) : 0
  },
  set(value) {
    const cell = cells.value[selectedCell.value]
    if (!cell) return
    cell.rotation = normalizeAngle(value)
    clampPan(cell, selectedCell.value)
  },
})

// 90° 快捷旋转：在当前角度上叠加并归一化到 -180~180
function rotateSelected(deg) {
  const cell = cells.value[selectedCell.value]
  if (!cell || !cell.materialId) return
  cell.rotation = normalizeAngle((cell.rotation || 0) + deg)
  clampPan(cell, selectedCell.value)
}

function normalizeAngle(value) {
  const deg = Number(value)
  if (!Number.isFinite(deg)) return 0
  return (((deg + 180) % 360) + 360) % 360 - 180
}

function emptyCell() {
  return { materialId: null, scale: 1, rotation: 0, pan: { x: 0, y: 0 } }
}

function applyTemplate(template) {
  templateKey.value = template.key
  const previous = cells.value
  cells.value = template.cells.map((_, index) =>
    previous[index] ? { ...previous[index], pan: { ...previous[index].pan } } : emptyCell(),
  )
  if (selectedCell.value >= cells.value.length) selectedCell.value = -1
}

applyTemplate(currentTemplate.value)

onBeforeUnmount(() => {
  materials.value.forEach((material) => URL.revokeObjectURL(material.url))
  stageObserver?.disconnect()
  stageObserver = null
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

async function removeMaterial(id) {
  const index = materials.value.findIndex((material) => material.id === id)
  if (index < 0) return
  const target = materials.value[index]
  try {
    await ElMessageBox.confirm(
      `确定删除素材「${target.name}」吗？删除后无法恢复。`,
      '删除素材',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  URL.revokeObjectURL(target.url)
  materials.value.splice(index, 1)
  cells.value.forEach((cell) => {
    if (cell.materialId === id) {
      cell.materialId = null
      cell.scale = 1
      cell.rotation = 0
      cell.pan.x = 0
      cell.pan.y = 0
    }
  })
}

// 点击素材：优先填入第一个空格；填满后若选中格有图则替换选中格
function pickMaterial(material) {
  let index = cells.value.findIndex((cell) => !cell.materialId)
  if (index < 0) {
    index = selectedCell.value >= 0 && selectedCell.value < cells.value.length
      ? selectedCell.value
      : -1
  }
  if (index < 0) {
    ElMessage.info('宫格已填满，把素材拖到要替换的格子上，或换一个更多格子的模板')
    return
  }
  assignToCell(index, material)
}

function assignToCell(index, material) {
  const cell = cells.value[index]
  cell.materialId = material.id
  cell.scale = 1
  cell.rotation = 0
  cell.pan.x = 0
  cell.pan.y = 0
  selectedCell.value = index
}

function onMaterialDragStart(material, event) {
  event.dataTransfer.setData('text/plain', material.id)
  event.dataTransfer.effectAllowed = 'copy'
}

function onCellDragOver(index, event) {
  event.dataTransfer.dropEffect = 'copy'
  dragOverIndex.value = index
}

function onCellDragLeave(index) {
  if (dragOverIndex.value === index) dragOverIndex.value = -1
}

function onCellDrop(index, event) {
  dragOverIndex.value = -1
  const id = event.dataTransfer.getData('text/plain')
  const material = materialMap.value[id]
  if (material) assignToCell(index, material)
}

function selectCell(index) {
  selectedCell.value = index
}

async function clearCell(index) {
  try {
    await ElMessageBox.confirm('确定清空这个格子里的素材吗？', '清空此格', {
      type: 'warning',
      confirmButtonText: '确认清空',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  const cell = cells.value[index]
  cell.materialId = null
  cell.scale = 1
  cell.rotation = 0
  cell.pan.x = 0
  cell.pan.y = 0
}

function resetCellView(index) {
  const cell = cells.value[index]
  cell.scale = 1
  cell.rotation = 0
  cell.pan.x = 0
  cell.pan.y = 0
}

function materialOf(cell) {
  return cell.materialId ? materialMap.value[cell.materialId] : null
}

// 与导出同一套 cover 缩放数学，保证预览即所得（含旋转）
function cellMetrics(cell, index) {
  const material = materialOf(cell)
  if (!material) return null
  const template = currentTemplate.value
  const rect = template.cells[index]
  const gapPx = gap.value / 1000
  const cellWidth = rect.w - gapPx
  const cellHeight = rect.h / template.aspect - gapPx
  const img = material.image
  const m = computeCoverMetrics({
    cellWidth,
    cellHeight,
    imgW: img.naturalWidth,
    imgH: img.naturalHeight,
    zoom: cell.scale,
    rotation: cell.rotation || 0,
  })
  return { img, cellWidth, cellHeight, ...m }
}

function clampPan(cell, index) {
  const metrics = cellMetrics(cell, index)
  if (!metrics) return
  cell.pan.x = metrics.panX > 0 ? clamp(cell.pan.x, -1, 1) : 0
  cell.pan.y = metrics.panY > 0 ? clamp(cell.pan.y, -1, 1) : 0
}

function cellBoxStyle(index) {
  const template = currentTemplate.value
  const rect = template.cells[index]
  const gapPx = gap.value / 1000
  return {
    left: `${(rect.x + gapPx / 2) * 100}%`,
    top: `${(rect.y + (gapPx * template.aspect) / 2) * 100}%`,
    width: `${(rect.w - gapPx) * 100}%`,
    height: `${(rect.h - gapPx * template.aspect) * 100}%`,
  }
}

function cellImageStyle(cell, index) {
  const metrics = cellMetrics(cell, index)
  if (!metrics) return {}
  const { kx, ky, panX, panY, cos, sin, cellWidth, cellHeight } = metrics
  const { ox, oy } = localPanToOffset(cell.pan.x, cell.pan.y, panX, panY, cos, sin)
  const widthPct = kx * 100
  const heightPct = ky * 100
  return {
    left: `${50 + (ox / cellWidth) * 100 - widthPct / 2}%`,
    top: `${50 + (oy / cellHeight) * 100 - heightPct / 2}%`,
    width: `${widthPct}%`,
    height: `${heightPct}%`,
    transform: `rotate(${cell.rotation || 0}deg)`,
    transformOrigin: 'center center',
  }
}

// 画布尺寸跟随舞台的可用空间等比缩放，不再用固定的 vh 值把页面顶出屏幕
const stageRef = ref(null)
const stageBox = ref({ width: 0, height: 0 })
let stageObserver = null

onMounted(() => {
  const el = stageRef.value
  if (!el || typeof ResizeObserver === 'undefined') return
  stageObserver = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect
    stageBox.value = { width, height }
  })
  stageObserver.observe(el)
})

function canvasStyle() {
  const template = currentTemplate.value
  const availW = stageBox.value.width
  const availH = stageBox.value.height
  // 宽高都要装得下：按高度算出的宽度再和可用宽度取小
  const fitByHeight = availH > 0 ? availH * template.aspect : 0
  const fitted = availW > 0 && fitByHeight > 0 ? Math.min(availW, fitByHeight) : 0
  return {
    aspectRatio: String(template.aspect),
    // 首帧还没量到尺寸时先用一个保守的 vh 兜底
    width: fitted > 0 ? `${Math.floor(fitted)}px` : `min(100%, ${(64 * template.aspect).toFixed(1)}vh)`,
  }
}

function tplCellStyle(rect) {
  return {
    left: `calc(${rect.x * 100}% + 2px)`,
    top: `calc(${rect.y * 100}% + 2px)`,
    width: `calc(${rect.w * 100}% - 4px)`,
    height: `calc(${rect.h * 100}% - 4px)`,
  }
}

function onCellPointerDown(index, event) {
  selectedCell.value = index
  const cell = cells.value[index]
  if (!cell.materialId || event.button !== 0) return
  panState.pointerId = event.pointerId
  panState.index = index
  panState.startX = event.clientX
  panState.startY = event.clientY
  panState.panX = cell.pan.x
  panState.panY = cell.pan.y
  event.currentTarget.setPointerCapture(event.pointerId)
}

function onCellPointerMove(index, event) {
  if (panState.index !== index || event.pointerId !== panState.pointerId) return
  const cell = cells.value[index]
  const metrics = cellMetrics(cell, index)
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
  grabbingIndex.value = index
  cell.pan.x = clamp(panState.panX + dPanX, -1, 1)
  cell.pan.y = clamp(panState.panY + dPanY, -1, 1)
}

function onCellPointerUp(index, event) {
  if (panState.index !== index || event.pointerId !== panState.pointerId) return
  panState.index = -1
  panState.pointerId = null
  grabbingIndex.value = -1
}

// 画布内拖拽旋转：以格子中心为轴，手柄绕中心的角度增量叠加到起始角度
function onCellRotateDown(index, event) {
  event.stopPropagation()
  const cell = cells.value[index]
  if (!cell || !cell.materialId || event.button !== 0) return
  const rect = event.currentTarget.parentElement.getBoundingClientRect()
  rotateState.pointerId = event.pointerId
  rotateState.index = index
  rotateState.centerX = rect.left + rect.width / 2
  rotateState.centerY = rect.top + rect.height / 2
  rotateState.startAngle = pointerAngle(event.clientX, event.clientY)
  rotateState.startRotation = cell.rotation || 0
  event.currentTarget.setPointerCapture(event.pointerId)
}

function onCellRotateMove(index, event) {
  if (rotateState.index !== index || event.pointerId !== rotateState.pointerId) return
  const cell = cells.value[index]
  if (!cell) return
  const delta = pointerAngle(event.clientX, event.clientY) - rotateState.startAngle
  let rotation = normalizeAngle(rotateState.startRotation + delta)
  // 接近 90° 整数倍时吸附，方便转正
  const snap = Math.round(rotation / 90) * 90
  if (Math.abs(rotation - snap) <= 4) rotation = normalizeAngle(snap)
  cell.rotation = rotation
  clampPan(cell, index)
}

function onCellRotateUp(index, event) {
  if (rotateState.index !== index || event.pointerId !== rotateState.pointerId) return
  rotateState.index = -1
  rotateState.pointerId = null
}

function pointerAngle(clientX, clientY) {
  return (Math.atan2(clientY - rotateState.centerY, clientX - rotateState.centerX) * 180) / Math.PI
}

function onCellWheel(index, event) {
  const cell = cells.value[index]
  if (!cell.materialId) return
  const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08
  cell.scale = clamp(cell.scale * factor, 1, 5)
  clampPan(cell, index)
  selectedCell.value = index
}

async function exportImage(format) {
  if (!hasContent.value || exporting.value) return
  exporting.value = format
  try {
    const composed = composeCollage()
    const isJpeg = format === 'jpg'
    const output = isJpeg ? flattenOnWhite(composed) : composed
    const blob = await canvasToBlob(output, isJpeg ? 'image/jpeg' : 'image/png', 0.92)
    downloadBlob(blob, `collage-${currentTemplate.value.key}.${format}`)
    ElMessage.success(
      `${isJpeg ? 'JPG' : 'PNG'} 已导出 · ${output.width} × ${output.height}`,
    )
  } catch (error) {
    ElMessage.error(error.message || '导出失败')
  } finally {
    exporting.value = ''
  }
}

// 按导出长边像素重建整个拼图，逐格用与预览一致的 cover + 缩放 + 平移绘制
function composeCollage() {
  const template = currentTemplate.value
  const long = exportLong.value
  const width = template.aspect >= 1 ? long : Math.round(long * template.aspect)
  const height = template.aspect >= 1 ? Math.round(long / template.aspect) : long
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  const gapPx = (gap.value / 1000) * width

  template.cells.forEach((rect, index) => {
    const cell = cells.value[index]
    const material = materialOf(cell)
    if (!material) return
    // 与预览同一套 cover 数学：间距按画布宽度换算，格子外的部分裁掉
    drawImageCover(
      context,
      material.image,
      {
        x: rect.x * width + gapPx / 2,
        y: rect.y * height + gapPx / 2,
        width: rect.w * width - gapPx,
        height: rect.h * height - gapPx,
      },
      { zoom: cell.scale, panX: cell.pan.x, panY: cell.pan.y, rotation: cell.rotation || 0 },
    )
  })
  return canvas
}

async function resetAll() {
  try {
    await ElMessageBox.confirm('确定清空当前拼图的全部素材与排版吗？此操作不可撤销。', '清空', {
      type: 'warning',
      confirmButtonText: '确认清空',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  materials.value.forEach((material) => URL.revokeObjectURL(material.url))
  materials.value = []
  // 先清空格子再套模板，避免残留已释放的 materialId
  cells.value = []
  selectedCell.value = -1
  gap.value = 0
  applyTemplate(currentTemplate.value)
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

// 从素材库选图（可多张，依次加入画布）
const pickerVisible = ref(false)
async function onPickFromLibrary(items) {
  for (const item of items) {
    await onFileChange({ raw: blobToFile(item.blob, item.name) })
  }
  pickerVisible.value = false
}
</script>

<template>
  <section class="page-collage">
    <header class="page-header">
      <div>
        <h1>单图拼接</h1>
        <p class="lede">
          先上传素材，再挑一个宫格模板，把图片点击或拖进格子里。格内可拖动、滚轮缩放、旋转调整，选出图片最好的一面后导出。
        </p>
      </div>
    </header>

    <section class="layout">
      <div class="stage-wrap">
        <div class="pair-export-bar">
          <span class="pair-export-info">
            已填 {{ filledCount }}/{{ cells.length }} 格 · 模板 {{ currentTemplate.name }} · 画布 {{ currentTemplate.ratioLabel }}
          </span>
          <div class="pair-export-btns">
            <el-button
              type="primary"
              size="small"
              :disabled="!hasContent"
              :loading="exporting === 'png'"
              @click="exportImage('png')"
            >
              导出 PNG
            </el-button>
            <el-button
              size="small"
              :disabled="!hasContent"
              :loading="exporting === 'jpg'"
              @click="exportImage('jpg')"
            >
              导出 JPG
            </el-button>
          </div>
        </div>

        <div ref="stageRef" class="stage stage-collage">
          <div class="collage-canvas" :style="canvasStyle()">
            <div
              v-for="(cell, index) in cells"
              :key="index"
              class="collage-cell"
              :class="{
                'is-filled': materialOf(cell),
                'is-selected': selectedCell === index,
                'is-dragover': dragOverIndex === index,
              }"
              :style="cellBoxStyle(index)"
              tabindex="0"
              @click="selectCell(index)"
              @dblclick="resetCellView(index)"
              @pointerdown="onCellPointerDown(index, $event)"
              @pointermove="onCellPointerMove(index, $event)"
              @pointerup="onCellPointerUp(index, $event)"
              @pointercancel="onCellPointerUp(index, $event)"
              @wheel.prevent="onCellWheel(index, $event)"
              @dragover.prevent="onCellDragOver(index, $event)"
              @dragleave="onCellDragLeave(index)"
              @drop.prevent="onCellDrop(index, $event)"
            >
              <img
                v-if="materialOf(cell)"
                :src="materialOf(cell).url"
                :style="cellImageStyle(cell, index)"
                alt=""
                draggable="false"
              />
              <span v-else class="cell-empty">点击或拖入图片</span>
              <span class="cell-index">{{ index + 1 }}</span>
              <button
                v-if="selectedCell === index && materialOf(cell)"
                type="button"
                class="rotate-handle"
                title="按住拖拽旋转图片"
                aria-label="拖拽旋转"
                @pointerdown.stop.prevent="onCellRotateDown(index, $event)"
                @pointermove="onCellRotateMove(index, $event)"
                @pointerup="onCellRotateUp(index, $event)"
                @pointercancel="onCellRotateUp(index, $event)"
                @click.stop
                @dblclick.stop
              ></button>
            </div>
          </div>
        </div>
        <div class="meta">
          <span>
            模板 {{ currentTemplate.name }} · 画布 {{ currentTemplate.ratioLabel }} ·
            已填 {{ filledCount }}/{{ cells.length }} 格
          </span>
          <span v-if="hasContent">滚轮缩放 · 拖动平移 · 拖格子右下角手柄旋转 · 双击复位本格</span>
        </div>
      </div>

      <aside class="tray">
        <h2>素材与排版</h2>
        <p class="hint">上传多张素材备用，点击素材填入格子，或直接拖到指定格子里。</p>

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

        <div class="field">
          <div class="field-label"><span>宫格模板</span><span>点击切换</span></div>
          <div class="tpl-grid">
            <button
              v-for="template in TEMPLATES"
              :key="template.key"
              type="button"
              class="tpl-item"
              :class="{ 'is-active': template.key === templateKey }"
              @click="applyTemplate(template)"
            >
              <span class="tpl-box" :style="{ aspectRatio: String(template.aspect) }">
                <span
                  v-for="(rect, rectIndex) in template.cells"
                  :key="rectIndex"
                  :style="tplCellStyle(rect)"
                ></span>
              </span>
              {{ template.name }}
            </button>
          </div>
        </div>

        <div class="field">
          <div class="field-label"><span>格子间距</span><span>{{ gap }}</span></div>
          <el-slider v-model="gap" :min="0" :max="40" :step="1" />
        </div>

        <div v-if="selectedCell >= 0 && materialOf(cells[selectedCell])" class="field">
          <div class="field-label">
            <span>第 {{ selectedCell + 1 }} 格缩放</span>
            <span>{{ selectedZoom }}%</span>
          </div>
          <el-slider v-model="selectedZoom" :min="100" :max="500" :step="5" />
          <div class="field-label">
            <span>第 {{ selectedCell + 1 }} 格旋转</span>
            <span>{{ selectedRotation }}°</span>
          </div>
          <el-slider v-model="selectedRotation" :min="-180" :max="180" :step="1" />
          <div class="cell-actions">
            <el-button size="small" @click="rotateSelected(-90)">左转 90°</el-button>
            <el-button size="small" @click="rotateSelected(90)">右转 90°</el-button>
            <el-button size="small" @click="rotateSelected(180)">翻转 180°</el-button>
          </div>
          <div class="cell-actions">
            <el-button size="small" @click="resetCellView(selectedCell)">复位本格</el-button>
            <el-button size="small" @click="clearCell(selectedCell)">清空此格</el-button>
          </div>
        </div>

        <div class="field">
          <div class="field-label"><span>导出长边</span><span>{{ exportLong }} px</span></div>
          <el-select v-model="exportLong" style="width: 100%">
            <el-option
              v-for="size in EXPORT_LONGS"
              :key="size"
              :label="`${size} 像素`"
              :value="size"
            />
          </el-select>
        </div>

        <div class="actions">
          <el-button :disabled="!materials.length && !hasContent" @click="resetAll">清空</el-button>
        </div>
      </aside>
    </section>
  </section>
</template>
