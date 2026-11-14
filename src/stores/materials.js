import { ref } from 'vue'
import { clearNotes, loadNotes, removeNote, requestPersistentStorage, saveNote } from '../utils/materialCache'

// 全局素材库：链接提取页写入，其他工作台（美食配图/拼图/双拼/倒影）都能读取使用。
// 图片以 Blob 存 IndexedDB，内存里持有 blob: objectURL 供各页面直接展示与消费。
export const cachedNotes = ref([])

let initPromise = null

// 每条图片可能是一张静图，也可能是一张「实况图」：静图 + 一段 2~3 秒的短视频。
// live.videoBlob 与 images[].blob 一样存进 IndexedDB，内存里再挂 videoSrc 供 <video> 直接用。
function hydrateImage(img) {
  const hydrated = {
    ...img,
    kind: img.kind || 'image',
    src: img.blob ? URL.createObjectURL(img.blob) : img.url,
  }
  if (img.live?.videoBlob) {
    hydrated.live = { ...img.live, videoSrc: URL.createObjectURL(img.live.videoBlob) }
  }
  return hydrated
}

function hydrate(note) {
  return {
    ...note,
    source: note.source || 'cookie',
    images: (note.images || []).map(hydrateImage),
  }
}

// 落库前把 objectURL（不能序列化）剥掉，只留能存的 Blob 和原始地址
function plainImage(img) {
  const out = { url: img.url, blob: img.blob, width: img.width, height: img.height, kind: img.kind || 'image' }
  if (img.live) {
    out.live = {
      videoUrl: img.live.videoUrl,
      videoBlob: img.live.videoBlob,
      duration: img.live.duration,
      width: img.live.width,
      height: img.live.height,
    }
  }
  return out
}

function plain(note) {
  return {
    ...note,
    images: (note.images || []).map(plainImage),
  }
}

function revokeNote(note) {
  note?.images.forEach((img) => {
    if (img.src?.startsWith('blob:')) URL.revokeObjectURL(img.src)
    if (img.live?.videoSrc?.startsWith('blob:')) URL.revokeObjectURL(img.live.videoSrc)
  })
}

export async function initMaterials() {
  if (!initPromise) {
    requestPersistentStorage()
    initPromise = loadNotes()
      .then((notes) => {
        cachedNotes.value = notes.map(hydrate)
      })
      .catch((err) => {
        initPromise = null
        throw err
      })
  }
  return initPromise
}

export async function upsertNote(note) {
  await saveNote(plain(note))
  revokeNote(cachedNotes.value.find((n) => n.id === note.id))
  cachedNotes.value = [hydrate(note), ...cachedNotes.value.filter((n) => n.id !== note.id)]
}

export async function deleteNote(noteId) {
  revokeNote(cachedNotes.value.find((n) => n.id === noteId))
  cachedNotes.value = cachedNotes.value.filter((n) => n.id !== noteId)
  await removeNote(noteId)
}

// 只改标题/文案（AI 改写回填用），保持素材库原排序
export async function updateNoteText(noteId, patch) {
  const note = cachedNotes.value.find((n) => n.id === noteId)
  if (!note) return
  if (typeof patch?.title === 'string' && patch.title.trim()) note.title = patch.title.trim()
  if (typeof patch?.content === 'string' && patch.content.trim()) note.content = patch.content.trim()
  await saveNote(plain(note))
}

export async function removeImageFromNote(noteId, imageUrl) {
  const note = cachedNotes.value.find((n) => n.id === noteId)
  if (!note) return
  const img = note.images.find((i) => i.url === imageUrl)
  if (img?.src?.startsWith('blob:')) URL.revokeObjectURL(img.src)
  if (img?.live?.videoSrc?.startsWith('blob:')) URL.revokeObjectURL(img.live.videoSrc)
  note.images = note.images.filter((i) => i.url !== imageUrl)
  await saveNote(plain(note))
}

export async function clearAllNotes() {
  cachedNotes.value.forEach(revokeNote)
  cachedNotes.value = []
  await clearNotes()
}
