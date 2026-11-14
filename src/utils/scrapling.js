// Scrapling 边车的浏览器端封装。
// 所有请求都走 /api/scrapling/*（Vite 中间件转发到本地 127.0.0.1:8765），
// 边车没启动时后端会回 503/SCRAPLING_OFFLINE，这里统一抛 ScraplingOfflineError，
// 调用方据此降级到原有的 Cookie 抓取通道。

const BASE = '/api/scrapling'

export class ScraplingOfflineError extends Error {
  constructor(message) {
    super(message || 'Scrapling 服务未启动')
    this.name = 'ScraplingOfflineError'
    this.offline = true
  }
}

async function call(path, { method = 'GET', body, timeout = 120000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，目标站点响应太慢或浏览器卡住了')
    throw new ScraplingOfflineError()
  } finally {
    clearTimeout(timer)
  }

  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (res.status === 503 && data?.error === 'SCRAPLING_OFFLINE') {
    throw new ScraplingOfflineError(data.message)
  }
  if (!res.ok) {
    const error = new Error(data?.message || data?.error || `请求失败 ${res.status}`)
    error.payload = data
    error.status = res.status
    throw error
  }
  return data
}

export function getHealth() {
  return call('/health', { timeout: 4000 })
}

// 让服务端弹出一个有头浏览器窗口，用户在窗口里扫码登录；
// 返回是"已开始"，真正的登录结果靠 pollLogin 轮询
export function startBrowserLogin() {
  return call('/login', { method: 'POST', timeout: 15000 })
}

export function pollLogin() {
  return call('/login/status', { timeout: 8000 })
}

export function logout() {
  return call('/logout', { method: 'POST', timeout: 8000 })
}

// mode: 'stealth' 走隐身浏览器（能过 Cloudflare、能拿实况视频），
//       'http'    走 curl_cffi 快速请求（秒回，但 JS 渲染站点可能拿不到内容）
export function fetchNote(url, { mode = 'stealth', withLive = true } = {}) {
  return call('/fetch', { method: 'POST', body: { url, mode, with_live: withLive }, timeout: 180000 })
}

// 图片/视频统一走这个代理：服务端带上正确 Referer 去 CDN 取，顺便避开跨域限制
export function mediaUrl(url) {
  return `${BASE}/media?url=${encodeURIComponent(url)}`
}
