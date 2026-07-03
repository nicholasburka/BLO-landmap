import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../renderMarkdown'

describe('renderMarkdown (LLM output sanitization)', () => {
  it('renders the markdown subset the LLM emits', () => {
    const html = renderMarkdown('**Top county** is *Comanche*\n\n- one\n- two')
    expect(html).toContain('<strong>Top county</strong>')
    expect(html).toContain('<em>Comanche</em>')
    expect(html).toContain('<li>one</li>')
  })

  it('strips script tags and event handlers', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<img')
  })

  it('blocks javascript: URLs', () => {
    const html = renderMarkdown('[click](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('forces noopener/noreferrer new-tab links', () => {
    const html = renderMarkdown('[BLO](https://blacklandownership.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('drops disallowed tags but keeps their text', () => {
    const html = renderMarkdown('<iframe src="https://evil.example"></iframe>plain text')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('plain text')
  })
})
