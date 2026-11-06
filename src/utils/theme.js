// 四季主题：通过 :root[data-theme] 切换 styles.css 里的 CSS 变量，全局生效。
// 秋季就是默认暖纸配色，不需要 data-theme 属性；默认主题为冬季。
export const THEMES = [
  { key: 'spring', label: '春', desc: '桃杏初绽', swatch: '#c25a6d', swatch2: '#e0e8cd' },
  { key: 'summer', label: '夏', desc: '青碧荷风', swatch: '#17766b', swatch2: '#d0e6e4' },
  { key: 'autumn', label: '秋', desc: '暖纸朱印', swatch: '#8f2f24', swatch2: '#efe4d2' },
  { key: 'winter', label: '冬', desc: '雪霁靛青', swatch: '#2f5b8f', swatch2: '#e7ebf1' },
]

// v2：默认主题从秋季改为冬季时换了存储键，避免旧的「秋季」选择盖住新默认
const THEME_KEY = 'app-theme-v2'
const DEFAULT_THEME = 'winter'
const VALID = new Set(THEMES.map((t) => t.key))

function paint(key) {
  const root = document.documentElement
  if (key === 'autumn') delete root.dataset.theme
  else root.dataset.theme = key
}

export function savedTheme() {
  const key = localStorage.getItem(THEME_KEY)
  return VALID.has(key) ? key : DEFAULT_THEME
}

// 启动时调用，在应用挂载前上色，避免闪一下默认主题
export function initTheme() {
  paint(savedTheme())
}

export function setTheme(key) {
  if (!VALID.has(key)) return
  localStorage.setItem(THEME_KEY, key)
  paint(key)
}
