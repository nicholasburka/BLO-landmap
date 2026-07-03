/**
 * Coarse theme detection from a user prompt. Used for anonymized usage
 * metadata — we record which topics people ask about, never the prompt text.
 */

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

/** Extract theme keywords from a prompt (without retaining the prompt itself). */
export function extractThemes(prompt: string): string[] {
  const lower = (prompt || '').toLowerCase()
  const themes: string[] = []
  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      themes.push(theme)
    }
  }
  return themes
}

/** Pull the most recent user text out of an Anthropic message history so the
 *  chat path can report themes the same way the query path does. */
export function themesFromMessages(messages: unknown): string[] {
  if (!Array.isArray(messages)) return []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown }
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string') return extractThemes(m.content)
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join(' ')
      if (text) return extractThemes(text)
    }
  }
  return []
}
