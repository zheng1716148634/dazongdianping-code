import { ref } from 'vue'

// 跨页面传图的临时中转：美食配图 → 倒影合成，只在当前浏览器会话内有效
export const pendingImage = ref(null)

export function sendImageToReflection(url, name) {
  pendingImage.value = { url, name }
}

export function takePendingImage() {
  const item = pendingImage.value
  pendingImage.value = null
  return item
}

// 素材库的 Blob 转成 File，方便工作台复用各自的 onFileChange 流程
export function blobToFile(blob, name) {
  const ext = blob?.type === 'image/png' ? 'png' : blob?.type === 'image/webp' ? 'webp' : 'jpg'
  const safeName = name || `素材-${Date.now()}`
  return new File([blob], `${safeName}.${ext}`, { type: blob?.type || 'image/jpeg' })
}
