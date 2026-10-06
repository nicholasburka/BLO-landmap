/**
 * Test-only helpers for asserting that a component's mobile CSS exists
 * (P5-60).
 *
 * jsdom parses no stylesheets and computes no layout, so `getComputedStyle`
 * cannot tell us whether a rule inside `@media (max-width: 640px)` sets a
 * 44 px tap target. Reading the single-file component's own `<style>` block
 * and asserting the rule is written can: a rule deleted or a selector renamed
 * fails the test, which a hand-copied list of class names would not.
 *
 * Imported only by specs — nothing in the app pulls this in, so it never
 * reaches a bundle.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A single-file component's stylesheet — the contents of its `<style>`
 * block(s), and nothing else. The template's `{{ }}` and the script's braces
 * would confuse the brace matching below, so they are dropped here rather
 * than worked around in every helper.
 */
export function readStyles(relativePath: string): string {
  const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8')
  const blocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1])
  if (blocks.length === 0) throw new Error(`${relativePath} has no <style> block`)
  return blocks.join('\n')
}

/**
 * The body of one `@media (max-width: <px>)` block, or '' when the component
 * has no such block. Brace-matched rather than regex-matched, because the
 * block contains nested rules.
 */
export function mediaBlock(css: string, maxWidthPx: number): string {
  const marker = `@media (max-width: ${maxWidthPx}px)`
  const start = css.indexOf(marker)
  if (start === -1) return ''
  const open = css.indexOf('{', start)
  if (open === -1) return ''
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return ''
}

/**
 * The declarations of one selector's rule. The selector must match as
 * written (including any comma-separated siblings it is grouped with), so
 * `ruleFor(css, '.sort-btn')` finds `.sort-btn,\n.filter-btn { … }` too.
 * Every matching rule is returned, joined — a property set at one width and
 * overridden at another shows up once each.
 */
export function ruleFor(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rules: string[] = []
  let cursor = 0
  while (cursor < withoutComments.length) {
    const open = withoutComments.indexOf('{', cursor)
    if (open === -1) break
    const close = withoutComments.indexOf('}', open)
    if (close === -1) break
    const heads = withoutComments
      .slice(cursor, open)
      .split(',')
      .map(part => part.trim())
    if (heads.includes(selector)) rules.push(withoutComments.slice(open + 1, close).trim())
    cursor = close + 1
  }
  return rules.join(' ')
}
