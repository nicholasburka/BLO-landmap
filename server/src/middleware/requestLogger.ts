import type { Request, Response, NextFunction } from 'express'

const THEME_KEYWORDS: Record<string, string[]> = {
  housing: ['housing', 'home', 'house', 'mortgage', 'rent', 'property', 'homeownership'],
  affordable: ['affordable', 'cheap', 'low cost', 'budget', 'inexpensive'],
  income: ['income', 'wage', 'salary', 'earnings', 'pay', 'jobs', 'employment'],
  safety: ['safe', 'safety', 'crime', 'pollution', 'contamination', 'toxic', 'clean'],
  diversity: ['diverse', 'diversity', 'black community', 'black population', 'black families'],
  education: ['school', 'education', 'learning', 'college', 'university'],
  transit: ['transit', 'commute', 'transportation', 'bus', 'train', 'drive'],
  health: ['health', 'life expectancy', 'healthcare', 'medical'],
  equity: ['equity', 'poverty', 'progress', 'opportunity', 'wealth'],
}

/** Extract theme keywords from a prompt (without logging the prompt itself) */
function extractThemes(prompt: string): string[] {
  const lower = prompt.toLowerCase()
  const themes: string[] = []
  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      themes.push(theme)
    }
  }
  return themes
}

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
