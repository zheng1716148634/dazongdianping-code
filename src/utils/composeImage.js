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
 * 计算「旋转后仍能铺满格子」的 cover 尺寸与可平移余量，预览与导出共用同一套数学。
 *
 * 图片绕格子中心旋转 θ 后，要保证格子四个角都不露白，图片绘制尺寸必须放大到
 * 能覆盖「旋转后的格子包围盒」，于是得到旋转感知的 cover 缩放；同时平移被限制在
 * 图片自身的局部坐标系里（余量 P/Q），这样无论怎么拖都不会露出空白角。
 *
 * 所有长度都用同一单位（与传入的 cellWidth/cellHeight 一致即可）。
 *
 * @param {{ cellWidth: number, cellHeight: number, imgW: number, imgH: number,
 *           zoom?: number, rotation?: number }} params rotation 为角度制
 * @returns {{ drawW: number, drawH: number, kx: number, ky: number,
 *             panX: number, panY: number, cos: number, sin: number }}
 *         kx/ky 为绘制尺寸相对格子宽/高的倍数；panX/panY 为局部坐标可平移的半余量
 */
export function computeCoverMetrics({ cellWidth, cellHeight, imgW, imgH, zoom = 1, rotation = 0 }) {
  const rad = (Number(rotation) || 0) * (Math.PI / 180)
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const ac = Math.abs(cos)
  const as = Math.abs(sin)
  // 旋转后的格子在图片局部坐标里的两条半轴投影
  const projX = (cellWidth * ac + cellHeight * as) / 2
  const projY = (cellWidth * as + cellHeight * ac) / 2
  const cover = Math.max(projX / imgW, projY / imgH)
  const scale = cover * Math.max(1, Number(zoom) || 1)
  const drawW = imgW * scale
  const drawH = imgH * scale
  return {
    drawW,
    drawH,
    kx: drawW / cellWidth,
    ky: drawH / cellHeight,
    panX: Math.max(0, drawW / 2 - projX),
    panY: Math.max(0, drawH / 2 - projY),
    cos,
    sin,
  }
}

/**
 * 把局部坐标系的归一化平移（-1~1）换算成屏幕坐标下的中心偏移。
 * panX/panY 为归一化值，余量 panLimitX/panLimitY 来自 computeCoverMetrics。
 */
export function localPanToOffset(panX, panY, panLimitX, panLimitY, cos, sin) {
  const lx = clampUnit(panX) * panLimitX
  const ly = clampUnit(panY) * panLimitY
  return { ox: lx * cos - ly * sin, oy: lx * sin + ly * cos }
}

/**
 * 把屏幕坐标下的拖拽位移（与格子同单位）换算成局部坐标系的归一化平移增量。
 * 这样拖动方向会跟随图片旋转后的方向，且始终落在不露白的安全区内。
 */
export function screenDeltaToLocalPan(dxUnits, dyUnits, panLimitX, panLimitY, cos, sin) {
  const lx = dxUnits * cos + dyUnits * sin
  const ly = -dxUnits * sin + dyUnits * cos
  return {
    dPanX: panLimitX > 0 ? lx / panLimitX : 0,
    dPanY: panLimitY > 0 ? ly / panLimitY : 0,
  }
}

/**
 * 把图片按 cover 方式填进一个矩形区域，并严格裁剪在矩形内，支持旋转。
 *
 * 预览侧靠 CSS `overflow: hidden` 裁掉溢出部分，导出侧如果不 clip，
 * 放大后的图片会溢出格子盖住相邻格，成品看上去就像比例被改了。
 *
 * @param {CanvasRenderingContext2D} context
 * @param {HTMLImageElement} image
 * @param {{ x: number, y: number, width: number, height: number }} rect 目标矩形（画布像素）
 * @param {{ zoom?: number, panX?: number, panY?: number, rotation?: number }} [options]
 *        zoom 为 1 时正好铺满（较长的那条边贴合），>1 继续放大；
 *        panX/panY 取 -1~1，为图片局部坐标系内的归一化平移；rotation 为角度制
 */
export function drawImageCover(context, image, rect, options = {}) {
  const { x, y, width, height } = rect
  if (!context || !image || !image.naturalWidth || width <= 0 || height <= 0) return

  const zoom = Number.isFinite(Number(options.zoom)) ? Number(options.zoom) : 1
  const rotation = Number.isFinite(Number(options.rotation)) ? Number(options.rotation) : 0

  const m = computeCoverMetrics({
    cellWidth: width,
    cellHeight: height,
    imgW: image.naturalWidth,
    imgH: image.naturalHeight,
    zoom,
    rotation,
  })
  const { ox, oy } = localPanToOffset(options.panX, options.panY, m.panX, m.panY, m.cos, m.sin)

  context.save()
  context.beginPath()
  context.rect(x, y, width, height)
  context.clip()
  context.translate(x + width / 2 + ox, y + height / 2 + oy)
  if (rotation) context.rotate((rotation * Math.PI) / 180)
  context.drawImage(image, -m.drawW / 2, -m.drawH / 2, m.drawW, m.drawH)
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
