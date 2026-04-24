import { Router } from 'express'
import { queryHaiku } from '../services/haiku.js'

const router = Router()

router.post('/api/query', async (req, res) => {
  const { prompt } = req.body

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'Prompt is required' })
    return
  }

  if (prompt.length > 500) {
    res.status(400).json({ error: 'Prompt must be under 500 characters' })
    return
  }

  try {
    const clientIp = (res.locals.clientIp as string) || 'unknown'
    const result = await queryHaiku(prompt.trim(), clientIp)
    res.json(result)
  } catch (err) {
    console.error('Query error:', err)
    res.status(502).json({ error: 'Service temporarily unavailable' })
  }
})

export default router
