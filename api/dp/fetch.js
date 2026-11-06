// Vercel Function：POST /api/dp/fetch
import { handleFetch } from '../../server/dianping.js'

export default async function handler(req, res) {
  return handleFetch(req, res)
}
