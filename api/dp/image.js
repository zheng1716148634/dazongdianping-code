// Vercel Function：GET /api/dp/image?url=...
import { handleImage } from '../../server/dianping.js'

export default async function handler(req, res) {
  return handleImage(req, res)
}
