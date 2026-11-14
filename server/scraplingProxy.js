// Scrapling 边车（python scraper/service.py）的反向代理。
// 前端只认 /api/scrapling/*，由这里转发，好处：
// 1. 浏览器同源，不用处理 CORS 和端口差异；
// 2. 视频要支持 Range 分段请求，必须原样透传请求头 + 流式回包；
// 3. 边车没启动时给出明确的 503/SCRAPLING_OFFLINE，前端据此降级到旧的 Cookie 代理。
//
// 地址来源：SCRAPLING_URL，默认本地 127.0.0.1:8765。
// 本地 dev 走 Vite 中间件；线上（Vercel）由 api/scrapling/[...path].js 复用同一份实现，
// 那时必须把 SCRAPLING_URL 指到自建的边车（Vercel 的 Serverless 跑不了常驻 Chromium，
// 详见 scraper/DEPLOY.md）。

import { Readable } from 'node:stream'

const RAW_BASE = (process.env.SCRAPLING_URL || '').replace(/\/+$/, '')
const BASE = RAW_BASE || 'http://127.0.0.1:8765'
// 公网边车必须配 token，否则谁都能拿它当点评抓取代理
const TOKEN = (process.env.SCRAPLING_TOKEN || '').trim()
const ON_VERCEL = Boolean(process.env.VERCEL)

// 白名单：只转发这几个接口，避免这条通道变成通用内网代理
const ALLOWED_PATHS = [
  /^\/health$/,
  /^\/fetch$/,
  /^\/login$/,
  /^\/login\/status$/,
  /^\/logout$/,
  /^\/cookies$/,
  /^\/media$/,
]

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  // Vercel 的 Node 函数可能已经把 body 解析进 req.body，此时原始流是空的，
  // 再读流会一直等到超时，所以有现成的就用现成的。
  const preset = req.body
  if (preset !== undefined && preset !== null && preset !== '') {
    if (Buffer.isBuffer(preset)) return Promise.resolve(preset)
    if (typeof preset === 'string') return Promise.resolve(Buffer.from(preset))
    try {
      return Promise.resolve(Buffer.from(JSON.stringify(preset)))
    } catch {
      /* 序列化不了就走流 */
    }
  }
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

function offlineMessage(err) {
  if (ON_VERCEL && !RAW_BASE) {
    return '线上未接入抓取引擎：Vercel 跑不了常驻 Chromium，需把 scraper/ 部署到支持 Docker 的机器，再把 SCRAPLING_URL、SCRAPLING_TOKEN 配到 Vercel 环境变量（见 scraper/DEPLOY.md）'
  }
  const detail = String((err && err.message) || err)
  if (/abort|timeout|timed out/i.test(detail)) return `抓取引擎响应超时（${BASE}）`
  return `抓取引擎连不上（${BASE}）：${detail}`
}

export async function handleScrapling(req, res) {
  const pathname = (req.url || '').split('?')[0]
  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  const subPath = pathname.replace(/^\/api\/scrapling/, '') || '/'

  // 告诉前端引擎在哪：远程引擎没有桌面环境，扫码登录这条路径不适用
  res.setHeader('X-Scraper-Target', RAW_BASE ? 'remote' : 'local')

  if (!ALLOWED_PATHS.some((re) => re.test(subPath))) {
    return sendJson(res, 404, { error: 'NOT_FOUND' })
  }

  // 只把必要的头转给边车：Range 决定视频能不能拖动进度，Content-Type 决定 JSON 能不能被解析
  const headers = {}
  for (const key of ['content-type', 'range', 'accept']) {
    if (req.headers[key]) headers[key] = req.headers[key]
  }
  if (TOKEN) headers['x-scraper-token'] = TOKEN

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
      signal: AbortSignal.timeout(subPath === '/fetch' ? 180000 : 20000),
    })
  } catch (err) {
    // 边车没起 / 地址不通 / token 不对：明确告诉前端可以降级，而不是抛一个看不懂的网络错误
    return sendJson(res, 503, {
      error: 'SCRAPLING_OFFLINE',
      message: offlineMessage(err),
      target: BASE,
      configured: Boolean(RAW_BASE),
    })
  }

  // token 对不上时给一条能直接定位的提示，而不是让前端瞎猜
  if (upstream.status === 401) {
    return sendJson(res, 503, {
      error: 'SCRAPLING_OFFLINE',
      message: `抓取引擎拒绝了请求：SCRAPLING_TOKEN 与服务端 SCRAPER_TOKEN 不一致（${BASE}）`,
      target: BASE,
      configured: Boolean(RAW_BASE),
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
