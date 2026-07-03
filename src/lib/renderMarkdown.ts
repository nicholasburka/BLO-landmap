/**
 * Render untrusted markdown (LLM output) as sanitized HTML.
 *
 * The LLM emits a restricted markdown subset: bold, italic, lists,
 * occasional links, line breaks. We parse with `marked` in GFM mode
 * and sanitize with DOMPurify to strip anything dangerous regardless
 * of what the model tries to inject. Output goes into v-html so
 * sanitization is not optional.
 */

import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({
  gfm: true,
  breaks: true,
})

// Harden LLM-emitted links: force every anchor to open in a new tab
// with the opener relationship severed, so a link can't navigate this
// tab or tabnab it. Registered once at module level.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

export function renderMarkdown(source: string): string {
  const raw = marked.parse(source, { async: false }) as string
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'b', 'i', 'u', 'code',
      'ul', 'ol', 'li', 'blockquote', 'a', 'span', 'hr',
    ],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  })
}
