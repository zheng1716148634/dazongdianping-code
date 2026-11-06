// 从一段文案中提取 URL。支持 http(s) 完整链接和 www. 开头的裸域名，
// 自动剥离链接尾部的中英文标点，避免把句号、括号带进链接里。
const URL_PATTERN = /(https?:\/\/[^\s<>"'，。；！？）】」』…]+|www\.[^\s<>"'，。；！？）】」』…]+)/gi

const TRAILING_PUNCTUATION = /[)\]}>,.;:!?'"、。；：！？）】」』…]+$/u

export function extractLinks(text, { dedupe = true } = {}) {
  const lines = String(text || '').split(/\r?\n/)
  const seen = new Set()
  const items = []
  let total = 0

  lines.forEach((line, lineIndex) => {
    for (const match of line.matchAll(URL_PATTERN)) {
      const cleaned = match[0].replace(TRAILING_PUNCTUATION, '')
      if (!cleaned) continue
      total += 1
      const url = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`
      if (dedupe && seen.has(url)) continue
      seen.add(url)
      items.push({
        url,
        line: lineIndex + 1,
        context: line.trim().slice(0, 120),
      })
    }
  })

  return { items, total, duplicates: total - items.length }
}
