/**
 * Render untrusted markdown as sanitized HTML. Two profiles:
 *
 * - renderMarkdown: LLM output. Restricted subset (bold, italic, lists,
 *   links, line breaks); every anchor is forced to a hardened new tab.
 * - renderWikiMarkdown: internal wiki pages (P5-15). Adds headings, tables,
 *   and code blocks, and leaves INTERNAL links (same-origin paths like
 *   /wiki/... or /library/...) untouched so the SPA router can intercept
 *   them; external links stay hardened new-tab.
 *
 * Both parse with `marked` in GFM mode and sanitize with DOMPurify. Output
 * goes into v-html so sanitization is not optional.
 */

import { marked, Marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({
  gfm: true,
  breaks: true,
})

/**
 * Embed blocks (P5-17): a fenced code block naming a saved view or catalog
 * entry becomes an inert placeholder div that hydrateEmbeds() (wikiEmbeds.ts)
 * later replaces with a live card. Two authoring styles work:
 *
 *     ```view:tn-target-counties        ```
 *     ```                               view:tn-target-counties
 *                                       ```
 *
 * The slug must match the wiki/view slug shape — anything else stays an
 * ordinary code block. Inline code (`view:x`) is never an embed, so prose
 * ABOUT embeds renders literally. Only the wiki profile uses this renderer;
 * LLM output can never fabricate a placeholder (div isn't in LLM_TAGS).
 *
 * P7-4 adds a third keyword, `map:<view-slug>` — the same view, mounted as a
 * live canvas instead of summarised as a card. It is a third KEYWORD and not a
 * new tag or attribute on purpose: the placeholder shape is identical, so the
 * sanitizer's allowlist (`WIKI_TAGS` / `WIKI_ATTR`) does not move, and the
 * worst a forged `map:` div can do is what a forged `view:` div can — render
 * something whose slug hydration re-validates before it fetches anything.
 */
const EMBED_BLOCK = /^(view|entry|map):([a-z0-9][a-z0-9-]{0,79})$/

const wikiMarked = new Marked({ gfm: true, breaks: true })
wikiMarked.use({
  renderer: {
    code({ text, lang }) {
      const target = (lang ?? '').trim() || text.trim()
      const match = EMBED_BLOCK.exec(target)
      if (!match) return false // fall through to default code rendering
      // match[2] is regex-constrained to [a-z0-9-], safe to interpolate.
      return `<div data-embed="${match[1]}" data-embed-slug="${match[2]}">${match[1]}:${match[2]}</div>\n`
    },
  },
})

// Which profile the (synchronous) sanitize call below is running under.
// DOMPurify hooks are global, so the hook reads this flag instead of us
// registering/removing hooks per call.
let activeProfile: 'llm' | 'wiki' = 'llm'

/** Internal = a same-origin path: starts with exactly one '/'. Anything
 *  else — absolute URLs, protocol-relative '//host', missing href — is
 *  external and gets the hardened new-tab treatment. Browsers also read a
 *  leading '/\\' as protocol-relative ('/\\evil.example' → https://evil.example),
 *  so the path is resolved against a fixed origin and any backslash counts
 *  as external (P5-19 audit). Exported for the wiki click interceptor, which
 *  must agree with the sanitiser on what "internal" means. */
export function isInternalHref(href: string | null): boolean {
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return false
  try {
    return new URL(href, 'https://internal.invalid').origin === 'https://internal.invalid'
  } catch {
    return false
  }
}

// Harden links: force anchors to open in a new tab with the opener
// relationship severed, so a link can't navigate this tab or tabnab it.
// The wiki profile exempts internal paths, which the SPA router handles.
// Registered once at module level.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    if (activeProfile === 'wiki' && isInternalHref(node.getAttribute('href'))) {
      node.removeAttribute('target')
      node.removeAttribute('rel')
      return
    }
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const LLM_TAGS = [
  'p', 'br', 'strong', 'em', 'b', 'i', 'u', 'code',
  'ul', 'ol', 'li', 'blockquote', 'a', 'span', 'hr',
]

const WIKI_TAGS = [
  ...LLM_TAGS,
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'pre',
  'div', // embed placeholders (P5-17)
]

const ALLOWED_ATTR = ['href', 'title', 'target', 'rel']

// Wiki-only: the two embed data attributes, listed explicitly (ALLOW_DATA_ATTR
// stays false so arbitrary data-* is still stripped). A hand-written
// <div data-embed=…> in page markdown survives sanitization on purpose —
// hydration validates the slug and builds cards via createElement/textContent,
// so the worst a forged placeholder can do is render a card.
const WIKI_ATTR = [...ALLOWED_ATTR, 'data-embed', 'data-embed-slug']

export function renderMarkdown(source: string): string {
  const raw = marked.parse(source, { async: false }) as string
  activeProfile = 'llm'
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: LLM_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  })
}

export function renderWikiMarkdown(source: string): string {
  const raw = wikiMarked.parse(source, { async: false }) as string
  activeProfile = 'wiki'
  try {
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: WIKI_TAGS,
      ALLOWED_ATTR: WIKI_ATTR,
      ALLOW_DATA_ATTR: false,
    })
  } finally {
    activeProfile = 'llm'
  }
}
