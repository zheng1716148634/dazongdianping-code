import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { handleFetch, handleImage } from './server/dianping.js'
import { handleScrapling, isScraplingRoute } from './server/scraplingProxy.js'

// 本地 dev / preview 的接口层与 Vercel Functions（api/ 目录）共用同一套实现：
// /api/dp/*        —— 点评抓取代理（Node 原生 fetch + 手动 Cookie）
// /api/scrapling/* —— 转发到本地 Python 边车（Scrapling 隐身抓取 / 实况图）
function apiMiddleware() {
  const handler = async (req, res, next) => {
    const pathname = (req.url || '').split('?')[0]
    try {
      if (isScraplingRoute(pathname)) return await handleScrapling(req, res)
      if (pathname === '/api/dp/fetch' && req.method === 'POST') return await handleFetch(req, res)
      if (pathname === '/api/dp/image' && req.method === 'GET') return await handleImage(req, res)
      if (pathname.startsWith('/api/')) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        return res.end(JSON.stringify({ error: 'NOT_FOUND' }))
      }
    } catch (err) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      return res.end(JSON.stringify({ error: 'API_CRASH', message: String(err && err.message) }))
    }
    return next()
  }
  return {
    name: 'api-middleware',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}

// 文件监听黑名单。
// scraper/ 是 Python 边车，Vite 根本不需要它的热更新，但默认会递归扫整个项目根目录：
//  * scraper/.venv 有上万个文件，纯属浪费；
//  * scraper/.state/profile 是 Chromium 的资料目录，浏览器运行时会独占锁住
//    Default/Sessions/* 这类文件，chokidar 一 watch 就抛 EBUSY，这个错误没人接，
//    直接把 dev server 整个崩掉（扫码登录时必现）。
// 所以整棵 scraper/ 连同截图目录一律不进监听。注意要连目录本身一起排除，
// 只写 /scraper\// 的话目录虽不递归，但目录自身仍会被 watch。
const WATCH_IGNORED = [/[\\/](scraper|\.screenshots|__pycache__)([\\/]|$)/]

// 兜底：文件监听是「脏」IO，杀毒软件、浏览器、编辑器都可能把文件短暂锁死，
// chokidar 抛的 EBUSY 是未捕获的 error 事件，会让整个 dev server 退出。
// 这里只吞掉和 watch 相关的那几个错误码并打条提示，其它异常照常抛出。
const WATCH_NOISE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT'])
let watchWarned = false
process.on('uncaughtException', (err) => {
  const isWatchNoise = WATCH_NOISE.has(err && err.code) && /watch/i.test(String((err && err.syscall) || ''))
  if (isWatchNoise) {
    if (!watchWarned) {
      watchWarned = true
      console.warn(`[vite] 文件监听被系统占用，已跳过：${err.path || err.filename || ''}（不影响页面和接口）`)
    }
    return
  }
  // 其它异常保持原来的崩溃语义，别让兜底把真 bug 吞掉
  console.error(err)
  process.exit(1)
})

export default defineConfig({
  plugins: [vue(), apiMiddleware()],
  server: {
    port: 5173,
    open: false,
    watch: { ignored: WATCH_IGNORED },
  },
})
