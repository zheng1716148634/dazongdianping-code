// 大众点评笔记抓取代理（框架无关，Vite 中间件与 Vercel Functions 共用）：
// 1. /api/dp/fetch  POST { url, cookie } —— 带登录态抓 M 站笔记 HTML，绕开浏览器 CORS
// 2. /api/dp/image  GET  ?url=...       —— 转存点评/美团 CDN 图片，便于前端拿 blob 存 IndexedDB
// 只允许 dianping.com / meituan.net / dpfile.com 三个域，防止被当成通用代理。

const ALLOWED_HOST_RE = /(^|\.)(dianping\.com|meituan\.net|dpfile\.com|dpurl\.cn)$/i
// 点评官方短链（如 http://dpurl.cn/Vl0OUcjz），302 到真实笔记页
const SHORT_HOST_RE = /(^|\.)dpurl\.cn$/i
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

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
      if (chunks.reduce((n, c) => n + c.length, 0) > 2 * 1024 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 短链要走 manual redirect 逐跳跟 302（每跳都带上 Cookie，避免跨域丢登录态），
// 直到没有 Location 为止，返回真实笔记地址和最终响应
async function fetchFollowingShort(target, headers) {
  let current = target
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(current, { headers, redirect: 'manual' })
    const location = response.headers.get('location')
    if (!location) return { url: current, response }
    current = new URL(location, current).href
  }
  throw new Error('短链重定向层数过多')
}

export async function handleFetch(req, res) {
  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    return sendJson(res, 400, { error: 'INVALID_BODY' })
  }
  const target = String(body.url || '')
  let host
  try {
    host = new URL(target).host
  } catch {
    return sendJson(res, 400, { error: 'INVALID_URL' })
  }
  if (!ALLOWED_HOST_RE.test(host)) {
    return sendJson(res, 403, { error: 'HOST_NOT_ALLOWED' })
  }

  const cookie = String(body.cookie || '')
  if (!cookie) return sendJson(res, 200, { error: 'LOGIN_REQUIRED', message: 'no-cookie' })

  const headers = {
    'User-Agent': MOBILE_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://m.dianping.com/',
    Cookie: cookie,
  }

  try {
    let finalUrl = target
    let response
    if (SHORT_HOST_RE.test(host)) {
      const result = await fetchFollowingShort(target, headers)
      finalUrl = result.url
      response = result.response
      // 短链解析出来必须还是点评系域名，防止被引导到别处
      if (!ALLOWED_HOST_RE.test(new URL(finalUrl).host)) {
        return sendJson(res, 403, { error: 'HOST_NOT_ALLOWED', finalUrl })
      }
    } else {
      response = await fetch(target, { headers, redirect: 'follow' })
      finalUrl = response.url || target
    }
    const html = await response.text()
    // 服务端把未登录请求重定向到 login-redirect，用最终 URL 或页面特征识别
    if (/feeddetail\/login-redirect/.test(finalUrl) || /feeddetail\/login-redirect/.test(html)) {
      return sendJson(res, 200, { error: 'LOGIN_REQUIRED', finalUrl })
    }
    sendJson(res, response.ok ? 200 : 502, { html, finalUrl, status: response.status })
  } catch (err) {
    sendJson(res, 502, { error: 'FETCH_FAILED', message: String(err && err.message) })
  }
}

export async function handleImage(req, res) {
  const search = req.url.split('?')[1] || ''
  const target = new URLSearchParams(search).get('url') || ''
  let parsed
  try {
    parsed = new URL(target)
  } catch {
    return sendJson(res, 400, { error: 'INVALID_URL' })
  }
  if (!ALLOWED_HOST_RE.test(parsed.host)) {
    return sendJson(res, 403, { error: 'HOST_NOT_ALLOWED' })
  }
  try {
    const response = await fetch(parsed.href, {
      headers: {
        'User-Agent': MOBILE_UA,
        Referer: 'https://m.dianping.com/',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    })
    if (!response.ok || !response.body) {
      return sendJson(res, 502, { error: 'IMAGE_FETCH_FAILED', status: response.status })
    }
    const buffer = new Uint8Array(await response.arrayBuffer())
    res.statusCode = 200
    res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.end(buffer)
  } catch (err) {
    sendJson(res, 502, { error: 'IMAGE_FETCH_FAILED', message: String(err && err.message) })
  }
}
