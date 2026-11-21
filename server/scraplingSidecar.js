// dev / preview 启动时自动拉起 Scrapling 边车（python scraper/service.py），
// 服务退出时自动回收，省得每次都要另开一个终端跑 `npm run scraper`。
//
// 规则：
//  * 端口上已有活的边车 → 直接复用，不重复启动；
//  * 配了 SCRAPLING_URL（远程边车）→ 不启动本地 Python；
//  * scraper/.venv 不存在 → 只提示先跑 npm run scraper:setup，绝不拖垮 dev server。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SCRAPER_PORT || 8765)
const BASE = `http://127.0.0.1:${PORT}`

function pythonBin() {
  const rel =
    process.platform === 'win32'
      ? ['scraper', '.venv', 'Scripts', 'python.exe']
      : ['scraper', '.venv', 'bin', 'python']
  return path.join(ROOT, ...rel)
}

async function isAlive() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

export function scraplingSidecar() {
  let child = null
  let starting = false

  async function start() {
    if (child || starting) return
    starting = true
    try {
      if (process.env.SCRAPLING_URL) {
        console.log(`[scrapling] 已配置远程边车 SCRAPLING_URL，跳过本地自启`)
        return
      }
      if (await isAlive()) {
        console.log(`[scrapling] 检测到已在运行的边车（${BASE}），直接复用`)
        return
      }
      const py = pythonBin()
      if (!existsSync(py)) {
        console.warn('[scrapling] 未找到 scraper/.venv，跳过自启。先执行：npm run scraper:setup')
        return
      }
      console.log(`[scrapling] 正在启动本地边车 ${BASE} …`)
      child = spawn(py, [path.join(ROOT, 'scraper', 'service.py')], {
        cwd: ROOT,
        stdio: 'inherit',
        windowsHide: true,
      })
      child.on('exit', (code) => {
        child = null
        if (code) console.warn(`[scrapling] 边车退出（code ${code}），素材抓取会降级到 Cookie 代理`)
      })
      child.on('error', (err) => {
        child = null
        console.warn(`[scrapling] 边车启动失败：${err.message}`)
      })
    } finally {
      starting = false
    }
  }

  function stop() {
    if (!child) return
    const target = child
    child = null
    target.kill()
  }

  function attach(server) {
    start()
    server.httpServer?.once('close', stop)
  }

  process.once('exit', stop)

  return {
    name: 'scrapling-sidecar',
    apply: 'serve',
    configureServer: attach,
    configurePreviewServer: attach,
  }
}
