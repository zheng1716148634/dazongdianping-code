// Vercel Function：/api/scrapling/* → 自建 Scrapling 边车
//
// Vercel 的 Serverless 跑不了常驻 Chromium，所以线上不托管边车，只做转发：
// 在 Vercel 项目里配 SCRAPLING_URL（例如 https://dp-scraper.onrender.com）
// 和 SCRAPLING_TOKEN（与边车的 SCRAPER_TOKEN 一致），这份函数就会把请求转过去。
// 没配 SCRAPLING_URL 时返回 503/SCRAPLING_OFFLINE，前端自动降级到 Cookie 通道。
//
// 部署边车的步骤见 scraper/DEPLOY.md。

import { handleScrapling } from '../../server/scraplingProxy.js'

export default async function handler(req, res) {
  return handleScrapling(req, res)
}
