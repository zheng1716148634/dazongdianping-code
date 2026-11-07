<script setup>
import { computed, onActivated, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import {
  canvasToBlob,
  composeReflection,
  downloadBlob,
  flattenOnWhite,
} from '../utils/composeImage'
import { blobToFile, takePendingImage } from '../utils/imageHandoff'
import MaterialPicker from './MaterialPicker.vue'

const DEFAULT_OPACITY = 1

const uploadRef = ref()
const sourceImage = ref(null)
const sourceUrl = ref('')
const fileBase = ref('image')
const opacity = ref(DEFAULT_OPACITY)
const exporting = ref('')

const sizeText = computed(() => {
  if (!sourceImage.value) return '等待上传'
  const width = sourceImage.value.naturalWidth
  const height = sourceImage.value.naturalHeight
  return `原图 ${width} × ${height}　→　导出 ${width} × ${height}（同尺寸，无留白）`
})

onBeforeUnmount(() => {
  revoke(sourceUrl.value)
})

// 从「美食配图」直接带过来的图片，进页面就自动载入。
// 页面现在被 KeepAlive 缓存，除首次挂载外，每次重新进入也要消费一次中转图。
// takePendingImage 取走即清空，挂载 + 激活各调一次不会重复载入。
async function consumePendingImage() {
  const pending = takePendingImage()
  if (!pending) return
  try {
    const image = await loadImageFromUrl(pending.url)
    revoke(sourceUrl.value)
    sourceUrl.value = pending.url
    sourceImage.value = image
    fileBase.value = pending.name || 'image'
    ElMessage.success('已载入美食配图，可直接合成倒影')
  } catch {
    URL.revokeObjectURL(pending.url)
    ElMessage.error('这张图片读取失败，请重新上传')
  }
}

onMounted(consumePendingImage)
onActivated(consumePendingImage)

async function onFileChange(uploadFile) {
  const file = uploadFile.raw
  if (!file) return
  if (!file.type.startsWith('image/')) {
    ElMessage.error('请上传 PNG、JPG、WEBP 等图片')
    return
  }

  try {
    const loaded = await loadImage(file)
    revoke(sourceUrl.value)
    sourceUrl.value = loaded.url
    sourceImage.value = loaded.image
    fileBase.value = stripExtension(file.name) || 'image'
    uploadRef.value?.clearFiles()
  } catch (error) {
    ElMessage.error(error.message || '这张图片读取失败')
  }
}

async function exportImage(format) {
  if (!sourceImage.value || exporting.value) return
  exporting.value = format

  try {
    // 不传 maxWidth：按原图像素尺寸 1:1 合成，画布与原图等大
    const composed = composeReflection(sourceImage.value, {
      opacity: opacity.value / 100,
    })
    const isJpeg = format === 'jpg'
    const output = isJpeg ? flattenOnWhite(composed) : composed
    const blob = await canvasToBlob(
      output,
      isJpeg ? 'image/jpeg' : 'image/png',
      0.92,
    )
    downloadBlob(blob, `${fileBase.value}-reflection.${format}`)
    ElMessage.success(
      `${isJpeg ? 'JPG' : 'PNG'} 已导出 · ${output.width} × ${output.height}`,
    )
  } catch (error) {
    ElMessage.error(error.message || '导出失败')
  } finally {
    exporting.value = ''
  }
}

function resetAll() {
  revoke(sourceUrl.value)
  sourceImage.value = null
  sourceUrl.value = ''
  fileBase.value = 'image'
  opacity.value = DEFAULT_OPACITY
}

function loadImage(file) {
  const url = URL.createObjectURL(file)
  return loadImageFromUrl(url).then(
    (image) => ({ image, url }),
    (error) => {
      URL.revokeObjectURL(url)
      throw error
    },
  )
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取这张图片'))
    image.src = url
  })
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, '')
}

function revoke(url) {
  if (url) URL.revokeObjectURL(url)
}

// 从素材库选图（单张，作为倒影原图）
const pickerVisible = ref(false)
async function onPickFromLibrary(items) {
  const item = items[0]
  if (!item) return
  await onFileChange({ raw: blobToFile(item.blob, item.name) })
  pickerVisible.value = false
}
</script>

<template>
  <section class="page-reflect">
    <header class="page-header">
      <div>
        <h1>倒影合成</h1>
        <p class="lede">左边看原图，右边看上下翻转的镜像层。导出时镜像按强度叠回画面，画布仍与原图等大。</p>
      </div>
    </header>

    <section class="layout">
      <div class="stage-wrap">
        <div class="stage">
          <div v-if="sourceUrl" class="compare">
            <figure class="compare-item">
              <div class="compare-frame">
                <img :src="sourceUrl" alt="原图" />
              </div>
              <figcaption class="compare-caption">
                原图 · {{ sourceImage.naturalWidth }} × {{ sourceImage.naturalHeight }}
              </figcaption>
            </figure>
            <figure class="compare-item">
              <div class="compare-frame">
                <img
                  :src="sourceUrl"
                  class="mirror"
                  :style="{ opacity: opacity / 100 }"
                  alt="镜像层"
                />
              </div>
              <figcaption class="compare-caption">镜像层 · {{ opacity }}%</figcaption>
            </figure>
          </div>
          <div v-else class="empty">
            <div>
              <strong>还没有图片</strong>
              <p>从右侧上传后，这里会左边显示原图、右边显示镜像层。</p>
            </div>
          </div>
        </div>
        <div class="meta">
          <span>{{ sizeText }}</span>
          <span v-if="sourceImage">右侧镜像层实时跟随强度，导出与它一致</span>
        </div>
      </div>

      <aside class="tray">
        <h2>校样</h2>
        <p class="hint">
          镜像层是原图上下翻转。导出时以水平中线为镜面压在下半部分，不撑高画布；「美食配图」生成的结果可直接带到这里。
        </p>

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
            <div class="upload-title">点击或拖入图片</div>
            <div class="upload-sub">PNG、JPG、WEBP、GIF</div>
          </el-upload>
          <el-button class="lib-btn" size="small" @click="pickerVisible = true">从素材库选图</el-button>
          <MaterialPicker v-model="pickerVisible" :multiple="false" @confirm="onPickFromLibrary" />
        </div>

        <div class="field">
          <div class="field-label">
            <span>镜像叠加强度</span>
            <span>{{ opacity }}%</span>
          </div>
          <el-slider v-model="opacity" :min="1" :max="100" :step="1" :disabled="!sourceImage" />
        </div>

        <div class="actions">
          <el-button
            type="primary"
            :disabled="!sourceImage"
            :loading="exporting === 'png'"
            @click="exportImage('png')"
          >
            导出 PNG
          </el-button>
          <el-button
            :disabled="!sourceImage"
            :loading="exporting === 'jpg'"
            @click="exportImage('jpg')"
          >
            导出 JPG
          </el-button>
          <el-button :disabled="!sourceImage" @click="resetAll">清空</el-button>
        </div>
      </aside>
    </section>
  </section>
</template>
