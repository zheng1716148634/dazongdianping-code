import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  clearRecords,
  deleteRecord,
  deleteRecords,
  loadRecords,
  putRecords,
} from '../utils/historyCache'
import { requestPersistentStorage } from '../utils/materialCache'

// 美食AI的生成记录与后台生成任务。
// 关键点：这里的 ref 是模块级单例，不挂在某个组件实例上。
// 因此切换选项卡、组件被卸载，甚至生成过程中离开页面，任务都会继续跑完并落库。

export const MAX_RECORDS = 120
const PENDING_KEY = 'hero-pending-generation'
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const REFERENCE_MAX_BYTES = 20 * 1024 * 1024

export const records = ref([]) // 运行时记录：[{ ...raw, src, refSrc }]
export const activeId = ref('')
export const pendingJobs = ref([])
export const lastError = ref('')
export const recoveredNotice = ref('')

export const busy = computed(() => pendingJobs.value.length > 0)
export const activeRecord = computed(
  () => records.value.find((item) => item.id === activeId.value) || null,
)

let initPromise = null

function hydrate(raw) {
  return {
    ...raw,
    src: raw.blob ? URL.createObjectURL(raw.blob) : raw.remoteUrl || '',
    refSrc: raw.refBlob ? URL.createObjectURL(raw.refBlob) : '',
  }
}

function plain(item) {
  return {
    id: item.id,
    batchId: item.batchId || '',
    blob: item.blob || null,
    refBlob: item.refBlob || null,
    remoteUrl: item.remoteUrl || '',
    prompt: item.prompt || '',
    promptName: item.promptName || '',
    size: item.size || '',
    quality: item.quality || '',
    model: item.model || '',
    referenceName: item.referenceName || '',
    createdAt: item.createdAt || 0,
  }
}

function revoke(item) {
  if (item?.src?.startsWith('blob:')) URL.revokeObjectURL(item.src)
  if (item?.refSrc?.startsWith('blob:')) URL.revokeObjectURL(item.refSrc)
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

// 生成中的任务写一份轻量标记，页面被刷新时能提示「上次可能有任务没跑完」
function syncPendingStorage() {
  try {
    const list = pendingJobs.value.map(({ id, startedAt, label, count }) => ({
      id,
      startedAt,
      label,
      count,
    }))
    if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list))
    else localStorage.removeItem(PENDING_KEY)
  } catch {
    /* 存储不可用不影响生成 */
  }
}

export function initHeroHistory() {
  if (!initPromise) {
    requestPersistentStorage()
    initPromise = loadRecords()
      .then((rows) => {
        records.value = rows.map(hydrate)
        activeId.value = records.value[0]?.id || ''
      })
      .catch(() => {
        initPromise = null
        records.value = []
        lastError.value = '生成记录读取失败，本次会话仍可正常生成'
      })

    // 上次会话有未跑完的任务：接口请求无法在刷新后恢复，给出明确提示避免「白等」
    try {
      const raw = localStorage.getItem(PENDING_KEY)
      if (raw) {
        const list = JSON.parse(raw)
        if (Array.isArray(list) && list.length) {
          recoveredNotice.value = `检测到上次有 ${list.length} 个生成任务未跑完（页面被刷新或关闭）。这类请求无法恢复，接口可能已扣额度；如果记录里没有对应结果，请重新生成一次。`
        }
        localStorage.removeItem(PENDING_KEY)
      }
    } catch {
      /* 忽略损坏的标记 */
    }
  }
  return initPromise
}

export function setActive(id) {
  if (records.value.some((item) => item.id === id)) activeId.value = id
}

async function addCreated(list) {
  const created = list.map(hydrate)
  const merged = [...created, ...records.value]
  const kept = merged.slice(0, MAX_RECORDS)
  const dropped = merged.slice(MAX_RECORDS)
  try {
    await putRecords(kept.map(plain))
    if (dropped.length) await deleteRecords(dropped.map((item) => item.id))
  } catch {
    ElMessage.warning('生成记录写入本机失败，本次结果只在当前页面有效')
  }
  records.value = kept
  activeId.value = kept[0]?.id || ''
  if (dropped.length) setTimeout(() => dropped.forEach(revoke), 0)
}

export async function removeRecord(id) {
  const target = records.value.find((item) => item.id === id)
  if (!target) return
  records.value = records.value.filter((item) => item.id !== id)
  if (activeId.value === id) activeId.value = records.value[0]?.id || ''
  // 等 DOM 切走这张图后再释放，避免正在预览的图突然空白
  setTimeout(() => revoke(target), 0)
  try {
    await deleteRecord(id)
  } catch {
    /* 忽略：内存里已移除 */
  }
}

export async function clearAllRecords() {
  const removed = records.value.slice()
  records.value = []
  activeId.value = ''
  setTimeout(() => removed.forEach(revoke), 0)
  try {
    await clearRecords()
  } catch {
    ElMessage.warning('本机记录清空失败，请稍后重试')
  }
}

// ---------- 后台生成：不依赖组件生命周期 ----------

export async function runGeneration(options) {
  const {
    file,
    fileName,
    prompt,
    promptName = '',
    size,
    quality,
    count = 1,
    config,
    referenceName = '',
  } = options

  const modelName = (config.model || '').trim() || 'gpt-image-1'
  const job = {
    id: newId('job'),
    startedAt: Date.now(),
    label: `${modelName} · ${size}`,
    count,
  }
  pendingJobs.value = [...pendingJobs.value, job]
  syncPendingStorage()
  lastError.value = ''

  try {
    const prepared = await prepareReference(file)
    const form = new FormData()
    form.append('model', modelName)
    form.append('image', prepared, fileName || 'reference.png')
    form.append('prompt', prompt)
    form.append('size', size)
    form.append('quality', quality)
    if (count > 1) form.append('n', String(count))

    const data = await requestEdits(form, config)
    const entries = Array.isArray(data?.data) ? data.data : []
    const batchId = newId('batch')
    const refBlob = await makeThumb(prepared)
    const stamp = Date.now()
    const created = []

    for (let index = 0; index < entries.length; index += 1) {
      const material = await materialize(entries[index])
      if (!material.blob && !material.remoteUrl) continue
      // 输出统一裁成 3:4，保证不管接口返回什么尺寸，记录里的图都是 3:4
      const cropped = await cropToThreeFour(material.blob)
      created.push(
        plain({
          id: newId('img'),
          batchId,
          blob: cropped?.blob || material.blob,
          remoteUrl: material.remoteUrl,
          refBlob,
          prompt,
          promptName,
          size: cropped ? `${cropped.width}x${cropped.height}` : size,
          quality,
          model: modelName,
          referenceName,
          createdAt: stamp + index,
        }),
      )
    }

    if (!created.length) throw new Error('接口没有返回图片，请检查模型或参数')
    await addCreated(created)
    ElMessage.success(`生成完成 ${created.length} 张，已存入生成记录`)
    return { ok: true, count: created.length }
  } catch (error) {
    const message = error?.message || '生成失败'
    lastError.value = message
    ElMessage.error(`生成失败：${message}`)
    return { ok: false, error: message }
  } finally {
    pendingJobs.value = pendingJobs.value.filter((item) => item.id !== job.id)
    syncPendingStorage()
  }
}

// 接口返回的 b64_json / url 统一转成本地 Blob；远端链接也留一份，方便回看来源
async function materialize(entry) {
  const raw = typeof entry?.b64_json === 'string' ? entry.b64_json : ''
  const url = typeof entry?.url === 'string' ? entry.url : ''
  const source = raw ? (/^data:/.test(raw) ? raw : `data:image/png;base64,${raw}`) : url
  if (!source) return { blob: null, remoteUrl: '' }
  try {
    const response = await fetch(source)
    if (!response.ok) throw new Error('image fetch failed')
    return { blob: await response.blob(), remoteUrl: url }
  } catch {
    if (raw) {
      // 个别环境不允许 fetch(data:)，退回 atob 逐字节还原
      const payload = /^data:[^,]*;base64,(.*)$/s.exec(source)?.[1] ?? raw
      try {
        const binary = atob(payload)
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
        const mime = /^data:(image\/[^;]+)/.exec(source)?.[1] || 'image/png'
        return { blob: new Blob([bytes], { type: mime }), remoteUrl: '' }
      } catch {
        /* 落到下面的兜底 */
      }
    }
    return { blob: null, remoteUrl: url }
  }
}

// 输出统一裁成 3:4：保持短边不变，居中去掉多余的一边
async function cropToThreeFour(blob) {
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  try {
    const image = await loadImage(url)
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (!width || !height) return null

    const target = 3 / 4
    let cropWidth = width
    let cropHeight = height
    if (width / height > target) cropWidth = Math.round(height * target)
    else cropHeight = Math.round(width / target)
    if (cropWidth >= width && cropHeight >= height) return { blob, width, height }

    const canvas = document.createElement('canvas')
    canvas.width = cropWidth
    canvas.height = cropHeight
    canvas
      .getContext('2d')
      .drawImage(
        image,
        Math.round((width - cropWidth) / 2),
        Math.round((height - cropHeight) / 2),
        cropWidth,
        cropHeight,
        0,
        0,
        cropWidth,
        cropHeight,
      )
    const output = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!output) return null
    return { blob: output, width: cropWidth, height: cropHeight }
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

// 参考图缩略图：让每条记录能看出「是哪张原图生成的」，压缩到 200px 内
async function makeThumb(file) {
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    const maxSide = 200
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72))
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

// 非 PNG/JPG/WEBP 或过大的参考图统一转成 2048 内的 PNG
async function prepareReference(file) {
  if (ACCEPTED_TYPES.includes(file.type) && file.size <= REFERENCE_MAX_BYTES) return file
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    const maxSide = 2048
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((output) => {
        if (output) resolve(output)
        else reject(new Error('参考图转换失败'))
      }, 'image/png')
    })
    return new File([blob], 'reference.png', { type: 'image/png' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function requestEdits(form, config) {
  const endpoint = `${normalizeBase(config.baseUrl)}/images/edits`
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey.trim()}` },
      body: form,
    })
  } catch {
    throw new Error(
      '无法连接接口：请检查 API 地址是否正确、服务是否可访问，以及该接口是否允许浏览器跨域（CORS）请求',
    )
  }

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const detail =
      payload?.error?.message || payload?.message || payload?.error?.code || `HTTP ${response.status}`
    throw new Error(`接口返回错误：${detail}`)
  }
  if (!payload) throw new Error('接口返回内容无法解析，请确认地址指向 OpenAI 兼容的 /v1 接口')
  return payload
}

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取这张图片'))
    image.src = src
  })
}
