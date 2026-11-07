<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'
import { downloadBlob } from '../utils/composeImage'
import { blobToFile, sendImageToReflection } from '../utils/imageHandoff'
import {
  MAX_RECORDS,
  activeId as historyActiveId,
  activeRecord,
  busy,
  clearAllRecords,
  initHeroHistory,
  lastError,
  pendingJobs,
  recoveredNotice,
  records,
  removeRecord,
  runGeneration,
  setActive as setActiveRecord,
} from '../stores/heroHistory'
import MaterialPicker from './MaterialPicker.vue'

// 默认提示词：在美食照片里加入真实自然的人物合影，人物不露脸、肢体数量可控
const DEFAULT_PROMPT = [
  '以参考图中的美食为绝对主体，完整保留食物的造型、分量、摆盘、餐具、桌面和色彩，不要改变或替换食物本身。',
  '画面中只能有一个人物：一位 20~30 岁的年轻人，背向或侧身对着食物，肩背自然前倾、低头看向食物，姿态放松，像朋友聚餐时随手抓拍的一瞬间；不要摆拍、不要正对镜头。',
  '人物不露正脸：只出现背影、后脑、肩膀和局部手臂，最多露出一小段侧脸轮廓，绝不出现清晰的五官和眼睛。',
  '严格限制手部和肢体：优先让双手不入画，垂在身侧或被身体、桌面遮挡；画面里最多只能有一双手、两条手臂、两条腿和一个头，手部只做简单的扶桌沿或握餐具动作，不强调手指细节。',
  '禁止出现多余的人、多余的手臂、多余的手、重复人物、错位或畸形的手指；每只手必须是五根手指，手指长度、关节方向和朝向必须自然正确。',
  '人体比例与空间关系真实：肩胛、肘部、手腕的关节方向和长度正确，衣物褶皱随姿态自然生成，肤色、发丝、肤质真实可信，不要塑料感、过度磨皮和 AI 感。',
  '光线为自然窗光或餐厅暖光，浅景深虚化背景，整体像手机随手拍的美食笔记照片，带有轻微颗粒感与真实色彩。',
  '除食物和这一个人物外不要添加任何文字、水印、贴纸、logo，也不要有第二个人物。',
].join('')

const SIZES = [
  { value: '1024x1024', label: '1024 × 1024（1:1 方图）' },
  { value: '1536x1024', label: '1536 × 1024（3:2 横图）' },
  { value: '1024x1536', label: '1024 × 1536（2:3 竖图）' },
]

const QUALITIES = [
  { value: 'auto', label: '自动' },
  { value: 'high', label: '高（慢，最精细）' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低（快，省额度）' },
]

const STORE_KEY = 'hero-ai-configs'
const LEGACY_KEY = 'hero-ai-config'
const PROMPT_KEY = 'hero-ai-prompts'

const uploadRef = ref()
const reference = ref(null)
const size = ref(SIZES[0].value)
const quality = ref('auto')
const count = ref(1)
const settingsVisible = ref(false)
// 大图预览区当前展示谁：'record' = 生成记录，'reference' = 参考图。
// 生成记录是持久化的，若只按「有没有记录」判断，参考图会被永远盖住。
const previewTarget = ref('record')

const stored = loadStore()
const configs = ref(stored.list)
const activeId = ref(stored.active)

const promptStore = loadPrompts()
const prompts = ref(promptStore.list)
const activePromptId = ref(promptStore.active)
const initialPrompt = prompts.value.find((item) => item.id === activePromptId.value) || prompts.value[0]
const promptName = ref(initialPrompt?.name || '')
const promptDraft = ref(initialPrompt?.text || '')

const activeConfig = computed(
  () => configs.value.find((item) => item.id === activeId.value) || configs.value[0] || null,
)
const canGenerate = computed(
  () =>
    !!reference.value &&
    !busy.value &&
    !!promptDraft.value.trim() &&
    !!activeConfig.value?.baseUrl.trim() &&
    !!activeConfig.value?.apiKey.trim(),
)
// 预览区是否正在展示某条生成记录（记录可能已被删光，要兜底回参考图）
const previewingRecord = computed(
  () => previewTarget.value === 'record' && !!activeRecord.value,
)

// 生成记录的大图查看器：可从任意记录进入，并支持左右切换翻看全部记录
const viewerVisible = ref(false)
const viewerStartId = ref('')
const viewableRecords = computed(() => records.value.filter((item) => item.src))
const viewerIndex = computed(() => {
  const index = viewableRecords.value.findIndex((item) => item.id === viewerStartId.value)
  return index >= 0 ? index : 0
})

function openViewer(item) {
  if (!item.src) return
  viewerStartId.value = item.id
  viewerVisible.value = true
}

onMounted(() => {
  initHeroHistory().catch(() => {})
  if (recoveredNotice.value) {
    ElMessage.warning({ message: recoveredNotice.value, duration: 9000 })
    recoveredNotice.value = ''
  }
})

onBeforeUnmount(() => {
  if (reference.value) URL.revokeObjectURL(reference.value.url)
})

async function onFileChange(uploadFile) {
  const file = uploadFile.raw
  if (!file) return
  if (!file.type.startsWith('image/')) {
    ElMessage.error('请上传 PNG、JPG、WEBP 图片')
    return
  }
  try {
    const url = URL.createObjectURL(file)
    const image = await loadImage(url)
    if (reference.value) URL.revokeObjectURL(reference.value.url)
    reference.value = {
      file,
      url,
      name: file.name,
      width: image.naturalWidth,
      height: image.naturalHeight,
    }
    lastError.value = ''
    // 新参考图就位后，预览区切回参考图（即使已有生成记录也不再盖住它）
    previewTarget.value = 'reference'
    uploadRef.value?.clearFiles()
  } catch {
    ElMessage.error('这张图片读取失败，换一张试试')
  }
}

function clearReference() {
  if (reference.value) URL.revokeObjectURL(reference.value.url)
  reference.value = null
  uploadRef.value?.clearFiles()
}

// 从素材库选图（单张，作为参考图）
const pickerVisible = ref(false)
async function onPickFromLibrary(items) {
  const item = items[0]
  if (!item) return
  await onFileChange({ raw: blobToFile(item.blob, item.name) })
  pickerVisible.value = false
}

function openSettings() {
  settingsVisible.value = true
}

function setActive(item) {
  activeId.value = item.id
  persist()
}

function addConfig() {
  configs.value.push(createConfig({ name: `接口 ${configs.value.length + 1}` }))
  persist()
}

function removeConfig(item) {
  configs.value = configs.value.filter((entry) => entry.id !== item.id)
  if (!configs.value.length) {
    const fallback = createConfig({ name: '默认接口' })
    configs.value = [fallback]
    activeId.value = fallback.id
  } else if (!configs.value.some((entry) => entry.id === activeId.value)) {
    activeId.value = configs.value[0].id
  }
  persist()
}

function saveSettings() {
  persist()
  settingsVisible.value = false
  ElMessage.success('API 配置已保存在本机浏览器')
}

function persist() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        activeId: activeId.value,
        configs: configs.value.map((item) => ({
          id: item.id,
          name: item.name,
          baseUrl: item.baseUrl,
          apiKey: item.apiKey,
          model: item.model,
          models: item.models,
        })),
      }),
    )
  } catch {
    /* 存储不可用时忽略，本次仍可用 */
  }
}

function createConfig(overrides = {}) {
  return {
    id: `api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: overrides.name || '新接口',
    baseUrl: overrides.baseUrl || '',
    apiKey: overrides.apiKey || '',
    model: overrides.model || 'gpt-image-1',
    models: [],
    connection: { state: 'idle', text: '' },
    testing: false,
    fetching: false,
  }
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed?.configs)
        ? parsed.configs.map(hydrateConfig).filter(Boolean)
        : []
      if (list.length) {
        const active = list.some((item) => item.id === parsed.activeId) ? parsed.activeId : list[0].id
        return { list, active }
      }
    }
  } catch {
    /* 本地数据损坏时忽略 */
  }

  // 兼容旧版只存一个接口的配置
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null')
    if (legacy && typeof legacy === 'object') {
      const item = createConfig({
        name: '默认接口',
        baseUrl: typeof legacy.baseUrl === 'string' ? legacy.baseUrl : '',
        apiKey: typeof legacy.apiKey === 'string' ? legacy.apiKey : '',
        model: typeof legacy.model === 'string' && legacy.model ? legacy.model : 'gpt-image-1',
      })
      return { list: [item], active: item.id }
    }
  } catch {
    /* 旧配置无法解析时忽略 */
  }

  const fallback = createConfig({ name: '默认接口' })
  return { list: [fallback], active: fallback.id }
}

function hydrateConfig(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : '未命名接口',
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    models: Array.isArray(raw.models) ? raw.models.filter((id) => typeof id === 'string') : [],
    connection: { state: 'idle', text: '' },
    testing: false,
    fetching: false,
  }
}

function selectPrompt(id) {
  activePromptId.value = id
  const target = prompts.value.find((item) => item.id === id)
  if (target) {
    promptName.value = target.name
    promptDraft.value = target.text
  }
  persistPrompts()
}

function savePrompt() {
  const text = promptDraft.value.trim()
  if (!text) {
    ElMessage.warning('提示词内容不能为空')
    return
  }
  const name = promptName.value.trim() || '未命名提示词'
  prompts.value = prompts.value.map((item) =>
    item.id === activePromptId.value ? { ...item, name, text } : item,
  )
  promptName.value = name
  promptDraft.value = text
  persistPrompts()
  ElMessage.success('提示词已保存到本机')
}

function savePromptAsNew() {
  const text = promptDraft.value.trim()
  if (!text) {
    ElMessage.warning('提示词内容不能为空')
    return
  }
  const item = {
    id: `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: `${promptName.value.trim() || '提示词'} 副本`,
    text,
  }
  prompts.value.push(item)
  activePromptId.value = item.id
  promptName.value = item.name
  persistPrompts()
  ElMessage.success('已另存为一套新提示词')
}

function removePrompt() {
  if (prompts.value.length <= 1) {
    ElMessage.warning('至少保留一套提示词')
    return
  }
  prompts.value = prompts.value.filter((item) => item.id !== activePromptId.value)
  const next = prompts.value[0]
  activePromptId.value = next.id
  promptName.value = next.name
  promptDraft.value = next.text
  persistPrompts()
  ElMessage.info('已删除这套提示词')
}

function persistPrompts() {
  try {
    localStorage.setItem(
      PROMPT_KEY,
      JSON.stringify({
        activeId: activePromptId.value,
        list: prompts.value.map(({ id, name, text }) => ({ id, name, text })),
      }),
    )
  } catch {
    /* 存储不可用时忽略，本次仍可用 */
  }
}

function loadPrompts() {
  try {
    const raw = localStorage.getItem(PROMPT_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed?.list)
        ? parsed.list
            .filter((item) => item && typeof item.id === 'string')
            .map((item) => ({
              id: item.id,
              name: typeof item.name === 'string' && item.name ? item.name : '未命名提示词',
              text: typeof item.text === 'string' ? item.text.trim() : '',
            }))
            .filter((item) => item.text)
        : []
      if (list.length) {
        const active = list.some((item) => item.id === parsed.activeId)
          ? parsed.activeId
          : list[0].id
        return { list, active }
      }
    }
  } catch {
    /* 本地数据损坏时忽略 */
  }
  const seed = { id: 'prompt-default', name: '美食人物合影（默认）', text: DEFAULT_PROMPT }
  return { list: [seed], active: seed.id }
}

// 拉取 OpenAI 兼容的 /models 列表，同时用于「测试连接」和「获取模型」
async function requestModels(item) {
  const base = normalizeBase(item.baseUrl)
  const key = item.apiKey.trim()
  if (!base) throw new Error('先填写接口地址（含 /v1）')
  if (!key) throw new Error('先填写 API Key')

  let response
  try {
    response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    })
  } catch {
    throw new Error('无法连接：请检查地址是否可达、是否允许浏览器跨域（CORS）请求')
  }

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`API Key 无效或没有权限（HTTP ${response.status}）`)
    }
    if (response.status === 404) {
      throw new Error('地址可达，但该接口没有提供 /models 列表，可手动填写模型 ID')
    }
    const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`
    throw new Error(`接口返回错误：${detail}`)
  }

  const ids = Array.isArray(payload?.data)
    ? payload.data.map((item) => item?.id).filter((id) => typeof id === 'string')
    : []
  if (!ids.length) throw new Error('接口返回成功，但没有解析到模型列表（data[].id）')
  return ids
}

async function testConnection(item) {
  if (item.testing) return
  item.testing = true
  item.connection = { state: 'pending', text: '正在测试连接…' }
  try {
    const ids = await requestModels(item)
    item.models = ids
    const imageIds = pickImageModels(ids)
    item.connection = {
      state: 'ok',
      text: imageIds.length
        ? `连接正常，共 ${ids.length} 个模型；图片模型 ${imageIds.length} 个，如 ${imageIds.slice(0, 3).join('、')}`
        : `连接正常，共 ${ids.length} 个模型，但没找到名称含 image 的模型`,
    }
  } catch (error) {
    item.connection = { state: 'error', text: error.message }
  } finally {
    item.testing = false
  }
}

async function fetchModels(item) {
  if (item.fetching) return
  item.fetching = true
  item.connection = { state: 'pending', text: '正在获取模型列表…' }
  try {
    const ids = await requestModels(item)
    item.models = ids
    const imageIds = pickImageModels(ids)
    const current = (item.model || '').trim()
    if (!current || !ids.includes(current)) {
      item.model = imageIds[0] || ids[0]
    }
    item.connection = {
      state: 'ok',
      text: `已获取 ${ids.length} 个模型${imageIds.length ? `，图片模型 ${imageIds.length} 个` : ''}，在下拉里选一个即可`,
    }
    ElMessage.success(`已获取 ${ids.length} 个模型`)
  } catch (error) {
    item.connection = { state: 'error', text: error.message }
  } finally {
    item.fetching = false
  }
}

function pickImageModels(ids) {
  return ids.filter((id) => /image/i.test(id))
}

function generate() {
  if (busy.value) return
  if (!reference.value) {
    ElMessage.warning('先上传一张美食照片作为参考图')
    return
  }
  const item = activeConfig.value
  if (!item || !item.baseUrl.trim() || !item.apiKey.trim()) {
    ElMessage.warning('先在「API 设置」里配置一个接口')
    return
  }
  const promptText = promptDraft.value.trim()
  if (!promptText) {
    ElMessage.warning('提示词不能为空')
    return
  }

  // 交给模块级 store 执行：此后即使切走选项卡、组件被卸载，生成也会跑完并自动落库
  runGeneration({
    file: reference.value.file,
    fileName: reference.value.name,
    prompt: promptText,
    promptName: promptName.value.trim(),
    size: size.value,
    quality: quality.value,
    count: count.value,
    config: {
      baseUrl: item.baseUrl,
      apiKey: item.apiKey,
      model: item.model,
    },
    referenceName: reference.value.name,
  }).then((outcome) => {
    // 生成成功后预览区自动切到新结果；失败则保持现状
    if (outcome?.ok) previewTarget.value = 'record'
  })
}

// 点击生成记录卡片：选中并让预览区展示这条记录
function pickRecord(id) {
  setActiveRecord(id)
  previewTarget.value = 'record'
}

async function downloadItem(item) {
  if (!item) return
  const type =
    item.blob?.type ||
    (item.src.includes('image/jpeg') ? 'image/jpeg' : item.src.includes('image/webp') ? 'image/webp' : 'image/png')
  const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png'
  const filename = `美食笔记-${formatStamp(item.createdAt)}-${item.id.slice(-4)}.${extension}`
  try {
    const blob = item.blob || (await (await fetch(item.src)).blob())
    downloadBlob(blob, filename)
  } catch {
    if (item.src) window.open(item.src, '_blank')
  }
}

function downloadActive() {
  return downloadItem(activeRecord.value)
}

async function sendActiveToReflection() {
  const item = activeRecord.value
  if (!item) return
  try {
    // 转成本地 blob，避免把远端图片带进 canvas 时触发跨域污染
    const blob = item.blob || (await (await fetch(item.src)).blob())
    sendImageToReflection(URL.createObjectURL(blob), `美食AI-${formatStamp(item.createdAt)}`)
    window.location.hash = '#/reflect'
    ElMessage.success('已带到倒影合成')
  } catch {
    ElMessage.error('这张图读取失败，请先下载后再到倒影合成上传')
  }
}

async function confirmClear() {
  try {
    await ElMessageBox.confirm(
      `将删除本机保存的全部 ${records.value.length} 张生成记录，此操作不可撤销。`,
      '清空生成记录',
      { type: 'warning', confirmButtonText: '确认清空', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await clearAllRecords()
  ElMessage.success('生成记录已清空')
}

function formatTime(stamp) {
  if (!stamp) return ''
  const date = new Date(stamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatStamp(stamp) {
  const date = new Date(stamp || Date.now())
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function normalizeBase(value) {
  return value.trim().replace(/\/+$/, '')
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取这张图片'))
    image.src = src
  })
}
</script>

<template>
  <section class="page-hero">
    <header class="page-header">
      <div>
        <h1>美食AI</h1>
        <p class="lede">
          上传一张美食照片，自动为它生成「人物与美食合影」的配图：人物真实自然、可以不露脸，适合直接放进美食笔记。提示词已内置，无需填写；API 地址和 Key 只保存在你自己的浏览器里。
        </p>
      </div>
    </header>

    <section class="layout">
      <div class="stage-wrap">
        <div class="stage hero-stage">
          <div class="hero-preview">
            <el-image
              v-if="previewingRecord"
              class="hero-preview-img"
              :src="activeRecord.src"
              :preview-src-list="[activeRecord.src]"
              preview-teleported
              hide-on-click-modal
              fit="contain"
              title="点击放大预览"
            />
            <el-image
              v-else-if="reference"
              class="hero-preview-img"
              :src="reference.url"
              :preview-src-list="[reference.url]"
              preview-teleported
              hide-on-click-modal
              fit="contain"
              title="点击放大预览"
            />
            <div v-else class="empty">
              <div>
                <strong>{{ previewTarget === 'record' ? '还没有生成结果' : '还没有配图' }}</strong>
                <p>在右侧上传美食照片并填写 API 配置，点「生成配图」开始。</p>
              </div>
            </div>
            <span v-if="!previewingRecord && reference" class="preview-tag">参考图</span>
            <span v-if="previewingRecord" class="preview-tag">生成结果</span>

            <div v-if="busy" class="hero-loading">
              <span class="hero-spinner"></span>
              <span>正在生成…可以切到别的页面，结果会自动存入生成记录</span>
            </div>
          </div>
        </div>

        <div class="meta">
          <span v-if="previewingRecord">
            {{ activeRecord.model }} · {{ activeRecord.size }} · {{ formatTime(activeRecord.createdAt) }} · 共 {{ records.length }} 张记录
          </span>
          <span v-else-if="reference">
            参考图 {{ reference.name }} · {{ reference.width }} × {{ reference.height }}
          </span>
          <span v-else>等待上传</span>
          <span v-if="previewingRecord">点击下方记录切换 · 可下载当前大图</span>
          <span v-else>图生图模式 · 保留原图美食主体</span>
        </div>

        <section class="history-panel">
          <header class="history-head">
            <div class="history-heading">
              <strong>生成记录</strong>
              <span>本机保存 · 共 {{ records.length }} 张{{ records.length >= MAX_RECORDS ? ` · 最多保留 ${MAX_RECORDS} 张` : '' }}</span>
            </div>
            <div class="history-tools">
              <span v-if="busy" class="history-running">
                <i class="history-dot"></i>{{ pendingJobs.length }} 个任务生成中
              </span>
              <button v-if="records.length" type="button" class="pair-mini" @click="confirmClear">
                清空记录
              </button>
            </div>
          </header>

          <p v-if="!records.length && !busy" class="history-empty">
            还没有生成记录。每次生成的图片都会自动存在本机，切换选项卡或刷新页面都不会丢。
          </p>

          <div v-else class="history-strip">
            <div v-for="job in pendingJobs" :key="job.id" class="history-card is-pending">
              <div class="history-pending">
                <span class="hero-spinner"></span>
                <small>生成中 · {{ job.count }} 张</small>
              </div>
              <div class="history-info">
                <span>{{ job.label }}</span>
                <span>完成后自动出现</span>
              </div>
            </div>

            <article
              v-for="item in records"
              :key="item.id"
              class="history-card"
              :class="{ 'is-active': item.id === historyActiveId }"
              :title="`${formatTime(item.createdAt)} · ${item.model} · ${item.size} · 原图 ${item.referenceName || '未记录'} · 提示词 ${item.promptName || '未命名'}`"
            >
              <button type="button" class="history-pick" @click="pickRecord(item.id)">
                <img v-if="item.src" :src="item.src" alt="生成结果缩略图" loading="lazy" />
                <span v-else class="history-broken">图片已失效</span>
                <img v-if="item.refSrc" class="history-ref" :src="item.refSrc" alt="原图缩略" />
                <span
                  v-if="item.src"
                  class="history-zoom"
                  title="预览大图"
                  @click.stop="openViewer(item)"
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                    <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2" />
                    <line x1="15.5" y1="15.5" x2="21" y2="21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
                  </svg>
                </span>
              </button>
              <div class="history-info">
                <span class="history-time">{{ formatTime(item.createdAt) }}</span>
                <span class="history-meta">{{ item.model }} · {{ item.size }}</span>
              </div>
              <div class="history-card-actions">
                <button type="button" class="pair-mini" :disabled="!item.src" @click="openViewer(item)">
                  预览
                </button>
                <button type="button" class="pair-mini" @click="downloadItem(item)">下载</button>
                <button type="button" class="pair-mini danger" @click="removeRecord(item.id)">删除</button>
              </div>
            </article>
          </div>
        </section>
      </div>

      <aside class="tray">
        <h2>生成配图</h2>
        <p class="hint">先配置接口，再上传美食照片，点生成即可。</p>

        <div class="field">
          <div class="field-label"><span>API 配置</span><span>仅存本机</span></div>
          <div class="api-current">
            <div class="api-current-main">
              <span class="api-current-name">{{ activeConfig?.name || '未配置接口' }}</span>
              <span class="api-current-url">
                {{ activeConfig?.baseUrl || '还没有填写接口地址' }}
              </span>
            </div>
            <el-button size="small" @click="openSettings">设置</el-button>
          </div>
          <el-select
            v-if="configs.length > 1"
            v-model="activeId"
            placeholder="切换接口"
            style="width: 100%; margin-top: 8px"
            @change="persist"
          >
            <el-option v-for="item in configs" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
          <p class="config-note">
            可保存多个接口并在上方切换；地址需包含版本前缀（如 <code>/v1</code>），程序请求
            <code>/images/edits</code> 做图生图。
          </p>
        </div>

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
            <div class="upload-title">{{ reference ? '更换美食照片' : '点击或拖入美食照片' }}</div>
            <div class="upload-sub">PNG、JPG、WEBP · 建议主体清晰、光线自然</div>
          </el-upload>
          <el-button class="lib-btn" size="small" @click="pickerVisible = true">从素材库选图</el-button>
          <MaterialPicker v-model="pickerVisible" :multiple="false" @confirm="onPickFromLibrary" />
          <div v-if="reference" class="reference-bar">
            <span class="reference-name">{{ reference.name }}</span>
            <button type="button" class="pair-mini" @click="clearReference">移除</button>
          </div>
        </div>

        <div class="field">
          <div class="field-label"><span>提示词</span><span>本机保存 {{ prompts.length }} 套</span></div>
          <el-select v-model="activePromptId" style="width: 100%" @change="selectPrompt">
            <el-option v-for="item in prompts" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
          <el-input v-model="promptName" placeholder="提示词名称，如 窗边逆光版" class="prompt-gap" />
          <el-input
            v-model="promptDraft"
            type="textarea"
            :rows="8"
            resize="none"
            placeholder="描述你想要的画面：人物、动作、光线、禁止项…"
            class="prompt-gap"
          />
          <div class="prompt-actions">
            <el-button size="small" @click="savePrompt">保存修改</el-button>
            <el-button size="small" @click="savePromptAsNew">另存为新提示词</el-button>
            <el-button size="small" plain type="danger" @click="removePrompt">删除</el-button>
          </div>
          <p class="config-note">
            生成时使用上方文本框里的内容；切换提示词会载入所选内容，改动后点「保存修改」才会留存，点「另存为」会新增一套。
          </p>
        </div>

        <div class="field field-split">
          <div>
            <div class="field-label"><span>尺寸</span></div>
            <el-select v-model="size" style="width: 100%">
              <el-option v-for="item in SIZES" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </div>
          <div>
            <div class="field-label"><span>质量</span></div>
            <el-select v-model="quality" style="width: 100%">
              <el-option v-for="item in QUALITIES" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </div>
        </div>

        <div class="field">
          <div class="field-label"><span>生成数量</span><span>{{ count }} 张</span></div>
          <el-slider v-model="count" :min="1" :max="4" :step="1" show-stops />
        </div>

        <div class="actions actions-single">
          <el-button type="primary" :disabled="!canGenerate" :loading="busy" @click="generate">
            {{ busy ? '生成中…' : '生成配图' }}
          </el-button>
          <el-button :disabled="!previewingRecord" @click="downloadActive">下载当前图</el-button>
          <el-button :disabled="!previewingRecord" @click="sendActiveToReflection">带到倒影合成</el-button>
        </div>

        <div v-if="lastError" class="hero-error">{{ lastError }}</div>

        <div class="note">
          每次生成的图片都会自动存进下方「生成记录」（最多 {{ MAX_RECORDS }} 张），只保存在当前浏览器，不会上传到其它服务器。生成过程中可以放心切换别的页面，任务会在后台跑完并入库；
        </div>
      </aside>
    </section>

    <el-dialog v-model="settingsVisible" title="API 设置" width="760px" class="api-dialog">
      <p class="api-dialog-note">
        可以保存多个 OpenAI 兼容接口，随时切换使用；配置只保存在当前浏览器。
      </p>

      <div class="api-list">
        <section
          v-for="(item, index) in configs"
          :key="item.id"
          class="api-card"
          :class="{ 'is-active': item.id === activeId }"
        >
          <header class="api-card-head">
            <span class="api-card-index">{{ index + 1 }}</span>
            <el-input v-model="item.name" placeholder="接口名称，如 主接口 / 备用" />
            <button
              type="button"
              class="api-pick"
              :class="{ 'is-active': item.id === activeId }"
              @click="setActive(item)"
            >
              {{ item.id === activeId ? '当前使用' : '设为当前' }}
            </button>
          </header>

          <el-input v-model="item.baseUrl" placeholder="接口地址，如 https://api.xxx.com/v1" clearable>
            <template #prepend>Base URL</template>
          </el-input>
          <el-input v-model="item.apiKey" type="password" show-password placeholder="sk-..." clearable>
            <template #prepend>API Key</template>
          </el-input>

          <div class="api-row">
            <el-select
              v-model="item.model"
              filterable
              allow-create
              default-first-option
              clearable
              placeholder="模型 ID，如 gpt-image-1"
              class="api-model"
            >
              <el-option v-for="name in item.models" :key="name" :label="name" :value="name" />
            </el-select>
            <el-button size="small" :loading="item.testing" @click="testConnection(item)">测试连接</el-button>
            <el-button size="small" :loading="item.fetching" @click="fetchModels(item)">获取模型</el-button>
            <el-button size="small" plain type="danger" @click="removeConfig(item)">删除</el-button>
          </div>

          <div v-if="item.connection.text" class="config-status" :class="`is-${item.connection.state}`">
            {{ item.connection.text }}
          </div>
        </section>
      </div>

      <template #footer>
        <div class="api-dialog-footer">
          <el-button @click="addConfig">添加接口</el-button>
          <div>
            <el-button @click="settingsVisible = false">关闭</el-button>
            <el-button type="primary" @click="saveSettings">保存配置</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <!-- 生成记录全屏大图查看器：可左右切换翻看所有有效记录 -->
    <el-image-viewer
      v-if="viewerVisible && viewableRecords.length"
      :url-list="viewableRecords.map((item) => item.src)"
      :initial-index="viewerIndex"
      hide-on-click-modal
      @close="viewerVisible = false"
    />
  </section>
</template>
