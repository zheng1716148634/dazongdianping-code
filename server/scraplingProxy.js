// Scrapling 边车（python scraper/service.py）的本地反向代理。
// 前端只认 /api/scrapling/*，由这里转发到 127.0.0.1:8765，好处：
// 1. 浏览器同源，不用处理 CORS 和端口差异；
// 2. 视频要支持 Range 分段请求，必须原样透传请求头 + 流式回包；
// 3. 边车没启动时给出明确的 503/SCRAPLING_OFFLINE，前端据此降级到旧的 Cookie 代理。
// 注意：Vercel 上没有这个边车，线上会一直是 503，前端自动走兜底路径。

import { Readable } from 'node:stream'

const BASE = (process.env.SCRAPLING_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '')

// 白名单：只转发这几个接口，避免这条通道变成通用内网代理
const ALLOWED_PATHS = [/^\/health$/, /^\/fetch$/, /^\/login$/, /^\/login\/status$/, /^\/logout$/, /^\/media$/]

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
      if (chunks.reduce((n, c) => n + c.length, 0) > 4 * 1024 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function isScraplingRoute(pathname) {
  return pathname === '/api/scrapling' || pathname.startsWith('/api/scrapling/')
}

export async function handleScrapling(req, res) {
  const pathname = (req.url || '').split('?')[0]
  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  const subPath = pathname.replace(/^\/api\/scrapling/, '') || '/'

  if (!ALLOWED_PATHS.some((re) => re.test(subPath))) {
    return sendJson(res, 404, { error: 'NOT_FOUND' })
  }

  // 只把必要的头转给边车：Range 决定视频能不能拖动进度，Content-Type 决定 JSON 能不能被解析
  const headers = {}
  for (const key of ['content-type', 'range', 'accept']) {
    if (req.headers[key]) headers[key] = req.headers[key]
  }

  let body
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readBody(req)
    } catch (err) {
      return sendJson(res, 413, { error: 'BODY_TOO_LARGE', message: String(err && err.message) })
    }
  }

  let upstream
  try {
    upstream = await fetch(`${BASE}${subPath}${search}`, {
      method: req.method,
      headers,
      body: body && body.length ? body : undefined,
      redirect: 'follow',
    })
  } catch (err) {
    // 边车没起 / 端口不对：明确告诉前端可以降级，而不是抛一个看不懂的网络错误
    return sendJson(res, 503, {
      error: 'SCRAPLING_OFFLINE',
      message: `本地 Scrapling 服务未启动（${BASE}）：${String(err && err.message)}`,
    })
  }

  res.statusCode = upstream.status
  for (const key of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control']) {
    const value = upstream.headers.get(key)
    if (value) res.setHeader(key, value)
  }
  if (!upstream.body) return res.end()

  // 图片/视频直接流式回传：边车边下边发，浏览器边收边播，不在中间层攒整块 buffer
  const stream = Readable.fromWeb(upstream.body)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
