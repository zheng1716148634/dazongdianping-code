import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { handleFetch, handleImage } from './server/dianping.js'

// 本地 dev / preview 的接口层与 Vercel Functions（api/ 目录）共用同一套实现：
// /api/dp/*  —— 点评抓取代理
function apiMiddleware() {
  const handler = async (req, res, next) => {
    const pathname = (req.url || '').split('?')[0]
    try {
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

export default defineConfig({
  plugins: [vue(), apiMiddleware()],
  server: {
    port: 5173,
    open: false,
  },
})
