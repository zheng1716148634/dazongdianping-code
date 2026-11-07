import { ref } from 'vue'
import { clearNotes, loadNotes, removeNote, requestPersistentStorage, saveNote } from '../utils/materialCache'

// 全局素材库：链接提取页写入，其他工作台（美食配图/拼图/双拼/倒影）都能读取使用。
// 图片以 Blob 存 IndexedDB，内存里持有 blob: objectURL 供各页面直接展示与消费。
export const cachedNotes = ref([])

let initPromise = null

function hydrate(note) {
  return {
    ...note,
    images: (note.images || []).map((img) => ({
      ...img,
      src: img.blob ? URL.createObjectURL(img.blob) : img.url,
    })),
  }
}

function plain(note) {
  return {
    ...note,
    images: (note.images || []).map(({ url, blob, width, height }) => ({ url, blob, width, height })),
  }
}

function revokeNote(note) {
  note?.images.forEach((img) => {
    if (img.src?.startsWith('blob:')) URL.revokeObjectURL(img.src)
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
  note.images = note.images.filter((i) => i.url !== imageUrl)
  await saveNote(plain(note))
}

export async function clearAllNotes() {
  cachedNotes.value.forEach(revokeNote)
  cachedNotes.value = []
  await clearNotes()
}
