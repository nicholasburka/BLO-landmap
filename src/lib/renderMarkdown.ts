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
