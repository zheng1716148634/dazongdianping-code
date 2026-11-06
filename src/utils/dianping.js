// 大众点评笔记（feeddetail）链接识别与页面解析。
// 页面是 Qwik SSR：登录态下笔记正文和图片都在首屏 HTML 里（DOM + qwik/json 状态），
// 所以解析策略是「正则扫图片 URL 保顺序 + DOM 收集文案 + JSON 字符串兜底」。

const IMAGE_HOST = /(?:[\w-]+\.)*(?:meituan\.net|dpfile\.com|dianping\.com)/i
const IMAGE_URL_RE = /(?:https?:)?\/\/[^\s"'<>()\\]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\]*)?/gi
// 头像、图标、角标这类素材不是笔记图，按路径特征过滤
const JUNK_IMAGE_RE = /avatar|logo|icon|emoji|\/star|badge|\.svg|default_|\/adcreative|\/weather|blank|grey/i
const AVATAR_SIZE_RE = /(?:^|[^\d])(?:80|100|120|132|180)x(?:80|100|120|132|180)(?:[^\d]|$)/

export function isDianpingUrl(url) {
  try {
    return /(^|\.)dianping\.com$/i.test(new URL(url).host)
  } catch {
    return false
  }
}

// 从链接里取笔记 id：m.dianping.com/feeddetail/123456
export function extractFeedId(url) {
  const match = String(url || '').match(/feeddetail\/(\d+)/)
  return match ? match[1] : ''
}

function decodeEscapes(raw) {
  return raw
    .replace(/\\u002[Ff]/g, '/')
    .replace(/\\u003[Aa]/g, ':')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
}

// 按出现顺序收集页面里的图片，去掉头像/图标
export function extractImages(html) {
  const scanned = decodeEscapes(String(html || ''))
  const seen = new Set()
  const images = []
  for (const match of scanned.matchAll(IMAGE_URL_RE)) {
    const raw = match[0]
    const url = raw.startsWith('http') ? raw : `https:${raw}`
    if (!IMAGE_HOST.test(url)) continue
    if (JUNK_IMAGE_RE.test(url)) continue
    if (AVATAR_SIZE_RE.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    images.push(url)
  }
  return images
}

function containsCJK(text) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)
}

// 兜底：从内嵌 JSON（qwik/json 状态）里捞最长的中文长句当正文
function pickTextFromJson(html) {
  const scripts = [...String(html || '').matchAll(/<script[^>]*type="qwik\/json"[^>]*>([\s\S]*?)<\/script>/gi)]
  const source = scripts.length ? scripts.map((m) => m[1]).join('\n') : String(html || '')
  let best = ''
  for (const match of source.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const text = decodeEscapes(match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
    const cleaned = text.trim()
    if (cleaned.length < 20 || cleaned.length > 3000) continue
    if (!containsCJK(cleaned)) continue
    if (/^https?:\/\//.test(cleaned) || /[<>{}]/.test(cleaned)) continue
    if (cleaned.length > best.length) best = cleaned
  }
  return best
}

// ---------- 店铺卡片 ----------

function formatCount(value) {
  const n = Number(String(value).replace(/万$/, ''))
  if (!Number.isFinite(n)) return ''
  if (n < 10000 && /万$/.test(String(value))) return String(value)
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万`
  return String(n)
}

const PRICE_RE = /(?:¥|￥)\s*\d+(?:\.\d+)?(?:\s*\/\s*[人位])?/
const FAV_RE = /(?:收藏|粉丝|赞)[\s:：]*([\d.]+\s*万?)/
const FAV_REV_RE = /([\d.]+\s*万)\s*(?:收藏|粉丝)/
const RATING_RE = /(?:评分|得分|口碑)\s*[:：]?\s*([0-5](?:\.\d+)?)/
const RATING_TAIL_RE = /([0-5](?:\.\d+)?)\s*分/
// 弱评分：没有「评分/分」提示时，认领第一个独立出现的 0~5 小数（排除「3.8万」这类）
const RATING_WEAK_RE = /(?<![0-9.])([0-5](?:\.\d+)?)(?![0-9万])/

// 从一段（可能所有字符合并在一起）的文本里认领店铺字段（导出便于测试）
export function shopFromText(text, url = '') {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  if (!compact || compact.length > 200) return null
  const priceM = compact.match(PRICE_RE)
  const favM = compact.match(FAV_RE) || compact.match(FAV_REV_RE)
  const ratingM = compact.match(RATING_RE) || compact.match(RATING_TAIL_RE) || compact.match(RATING_WEAK_RE)

  // 店名：砍掉价格/收藏/评分之后，剩下的开头中文段；
  // 没有任何价格/评分/数字时，整段就是店名
  const cuts = [priceM, favM, ratingM].filter(Boolean).map((m) => m.index)
  const nameEnd = cuts.length ? Math.min(...cuts) : compact.search(/[0-9０-９]/)
  let name = nameEnd > 0 ? compact.slice(0, nameEnd).trim() : nameEnd === -1 ? compact : ''
  if (!/[\u4e00-\u9fff]/.test(name) || name.length > 40) name = ''

  return {
    name,
    favorites: favM ? formatCount(favM[1].replace(/\s/g, '')) : '',
    tags: [],
    address: '',
    url,
  }
}

// 把一组独立文本片段（元素级叶子文本）逐个认领成店铺字段（导出便于测试）
// 评分、人均只用于识别排除（避免混进店名/标签），不再输出
export function classifyShopTokens(tokens, url = '') {
  const shop = { name: '', favorites: '', tags: [], address: '', url }
  const cjk = (t) => /[\u4e00-\u9fff]/.test(t)
  const rest = []
  for (const raw of tokens) {
    const token = String(raw).replace(/\s+/g, ' ').trim()
    if (!token) continue
    if (PRICE_RE.test(token)) continue
    const favM = token.match(FAV_RE) || token.match(FAV_REV_RE)
    if (!shop.favorites && favM) {
      shop.favorites = formatCount(favM[1].replace(/\s/g, ''))
      continue
    }
    if (/^[0-5](?:\.\d+)?$/.test(token)) continue
    rest.push(token)
  }
  // 店名：带括号/间隔号的最长中文片段优先，其次最长的中文片段
  const nameCandidates = rest.filter((t) => cjk(t) && t.length >= 3 && !/^\d+$/.test(t))
  const withBracket = nameCandidates.filter((t) => /[（(·]/.test(t) && t.length >= 4)
  shop.name =
    withBracket.sort((a, b) => b.length - a.length)[0] ||
    nameCandidates.sort((a, b) => b.length - a.length)[0] ||
    ''
  // 标签：去掉店名后剩下的短中文片段
  shop.tags = rest
    .filter((t) => t !== shop.name && !nameCandidates.includes(t) && cjk(t) && t.length >= 2 && t.length <= 8)
    .slice(0, 6)
  return shop
}

// 兜底：从内嵌 JSON（qwik/json 状态）里按常见字段名捞店铺信息；
// 找得到 shopInfo 对象就只在它附近找，避免误伤页面其他字段
function shopFromJson(html) {
  const source = decodeEscapes(String(html || ''))
  let scope = source
  const scoped = source.match(/"(?:shopInfo|shopDetail|shopCard|shop)"\s*:\s*\{/)
  if (scoped) scope = source.slice(scoped.index, scoped.index + 4000)

  const strField = (keys) => {
    for (const key of keys) {
      const m = scope.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,120})"`))
      if (m) {
        const value = decodeEscapes(m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))).trim()
        if (value) return value
      }
    }
    return ''
  }
  const numField = (keys) => {
    for (const key of keys) {
      const m = scope.match(new RegExp(`"${key}"\\s*:\\s*"?([0-9]+(?:\\.[0-9]+)?)"?`))
      if (m) return m[1]
    }
    return ''
  }
  const name = strField(['shopName', 'shopTitle', 'shopname', 'branchName'])
  const favorites = formatCount(numField(['favCount', 'favorCount', 'collectCount', 'starCount', 'favNum', 'collectNum']))
  const address = strField(['address', 'shopAddress', 'addressDesc'])
  const tags = [
    strField(['regionName', 'regionDesc', 'businessArea']),
    strField(['cateName', 'categoryName', 'catName', 'cateName1', 'cateName2']),
  ].filter(Boolean)
  const shopId = numField(['shopId', 'shopid'])
  const url = strField(['shopUrl', 'shopHref']) || (shopId ? `https://m.dianping.com/shop/${shopId}` : '')
  return { name, favorites, tags, address, url }
}

// 主路径：在 DOM 里找店铺卡片。点评页面结构多变，候选来源放宽到
// 「带 shop 链接的元素 + class 含 shop 的元素」，取认领字段最多的那份
function shopFromDom(doc) {
  const candidates = new Set()
  doc.querySelectorAll('a[href*="shop"], [class*="shop" i]').forEach((el) => {
    // 整页级的大容器跳过，只认卡片粒度的元素
    if (el.textContent.replace(/\s/g, '').length > 300) return
    candidates.add(el)
  })

  let best = null
  let bestScore = 0
  for (const el of candidates) {
    const anchorEl = el.matches('a') ? el : el.querySelector('a[href*="shop"]')
    const rawHref = anchorEl?.getAttribute('href') || ''
    const url = /^https?:/i.test(rawHref) ? rawHref : rawHref ? `https://m.dianping.com${rawHref}` : ''
    // 叶子级文本片段：span/p/b/i/div 里不含子元素的，天然保留边界
    const tokens = [...el.querySelectorAll('span, p, b, i, div')]
      .filter((n) => !n.children.length)
      .map((n) => n.textContent)
    tokens.push(el.textContent)
    const classified = classifyShopTokens(tokens, url)
    const merged = classified.name ? classified : shopFromText(el.textContent, url) || classified
    const score = ['name', 'favorites', 'address'].filter((k) => merged[k]).length + merged.tags.length
    if (score > bestScore) {
      best = merged
      bestScore = score
    }
  }
  return best
}

export function parseFeedHtml(html) {
  if (/feeddetail\/login-redirect/.test(String(html || ''))) {
    return { loginRequired: true }
  }

  const images = extractImages(html)

  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html')
  doc.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove())

  const meta = (selector, attr = 'content') => doc.querySelector(selector)?.getAttribute(attr)?.trim() || ''
  const title =
    doc.querySelector('h1')?.textContent.trim() ||
    meta('meta[property="og:title"]') ||
    meta('meta[name="description"]').slice(0, 40) ||
    ''

  const paragraphs = [...doc.querySelectorAll('p')]
    .map((el) => el.textContent.replace(/\s+/g, ' ').trim())
    .filter((text) => text.length >= 2)
  let content = paragraphs.join('\n')

  // DOM 里没拿到像样的正文时，退回 JSON 状态兜底
  if (content.replace(/\s/g, '').length < 15) {
    const fallback = pickTextFromJson(html)
    if (fallback) content = fallback
  }

  // 店铺信息：DOM 卡片为主，缺的字段用 JSON 状态补齐（评分/人均已按需求去掉）
  const domShop = shopFromDom(doc)
  const jsonShop = shopFromJson(html)
  const shop = {
    name: domShop?.name || jsonShop.name,
    favorites: domShop?.favorites || jsonShop.favorites,
    tags: domShop?.tags?.length ? domShop.tags : jsonShop.tags,
    address: domShop?.address || jsonShop.address,
    url: domShop?.url || jsonShop.url,
  }
  const hasShop = shop.name || shop.favorites || shop.tags.length || shop.address

  return { title, content: content.trim(), images, shop: hasShop ? shop : null, loginRequired: false }
}

// 把笔记页 URL 规范化成要抓的地址（保留参数，shareid 等可能参与风控）
export function normalizeNoteUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.href
  } catch {
    return url
  }
}
