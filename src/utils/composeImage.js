// 画布尺寸 = 原图尺寸；原图铺满画布，镜像层以水平中线为镜面叠在下半部分
export function composeReflection(image, options = {}) {
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  // 预览会传 maxWidth 做等比缩小；导出不传，scale 恒为 1，输出严格等于原图像素尺寸
  const maxWidth = options.maxWidth || sourceWidth
  const scale = Math.min(1, maxWidth / sourceWidth)
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const opacity = clampOpacity(options.opacity)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  context.clearRect(0, 0, width, height)
  // 底层：原图完整铺满整张画布
  context.drawImage(image, 0, 0, width, height)
  // 上层：以画布水平中线为镜面，把同一张图翻转后压在下半部分
  context.save()
  context.globalAlpha = opacity
  context.translate(0, height)
  context.scale(1, -1)
  context.drawImage(image, 0, 0, width, height)
  context.restore()
  return canvas
}

export function flattenOnWhite(source) {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0)
  return canvas
}

/**
 * 把图片按 cover 方式填进一个矩形区域，并严格裁剪在矩形内。
 *
 * 预览侧靠 CSS `overflow: hidden` 裁掉溢出部分，导出侧如果不 clip，
 * 放大后的图片会溢出格子盖住相邻格，成品看上去就像比例被改了。
 *
 * @param {CanvasRenderingContext2D} context
 * @param {HTMLImageElement} image
 * @param {{ x: number, y: number, width: number, height: number }} rect 目标矩形（画布像素）
 * @param {{ zoom?: number, panX?: number, panY?: number }} [options]
 *        zoom 为 1 时正好铺满（较长的那条边贴合），>1 继续放大；panX/panY 取 -1~1
 */
export function drawImageCover(context, image, rect, options = {}) {
  const { x, y, width, height } = rect
  if (!context || !image || !image.naturalWidth || width <= 0 || height <= 0) return

  const zoom = Number.isFinite(Number(options.zoom)) ? Math.max(1, Number(options.zoom)) : 1
  const panX = clampUnit(options.panX)
  const panY = clampUnit(options.panY)

  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * zoom
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  // 平移范围只允许在溢出部分内移动，panX/panY 为 ±1 时贴到边缘
  const dx = x + (width - drawWidth) / 2 + panX * Math.max(0, (drawWidth - width) / 2)
  const dy = y + (height - drawHeight) / 2 + panY * Math.max(0, (drawHeight - height) / 2)

  context.save()
  context.beginPath()
  context.rect(x, y, width, height)
  context.clip()
  context.drawImage(image, dx, dy, drawWidth, drawHeight)
  context.restore()
}

function clampUnit(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(-1, number))
}

export function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('导出失败'))
        return
      }
      resolve(blob)
    }, mimeType, quality)
  })
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function clampOpacity(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0.01
  return Math.min(1, Math.max(0, number))
}
