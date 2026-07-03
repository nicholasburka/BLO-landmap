import type { Request, Response, NextFunction } from 'express'
import { extractThemes } from '../prompt/themes.js'

/** Express middleware: log request details */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now()

  res.on('finish', () => {
    const duration = Date.now() - start
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const log = `[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms ${ip}`

    // For query endpoint, add anonymized metadata
    if (req.path === '/api/query' && req.body?.prompt) {
      const promptLength = req.body.prompt.length
      const themes = extractThemes(req.body.prompt)
      console.log(`${log} prompt_len=${promptLength} themes=[${themes.join(',')}]`)
    } else {
      console.log(log)
    }
  })

  next()
}
