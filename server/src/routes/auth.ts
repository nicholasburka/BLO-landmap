import { Router } from 'express'
import { createToken } from '../middleware/auth.js'

const router = Router()

router.post('/api/auth', (req, res) => {
  const { password } = req.body

  if (!password || password !== process.env.BETA_PASSWORD) {
    res.status(401).json({ error: 'Invalid password' })
    return
  }

  const token = createToken()
  res.json({ token })
})

export default router
