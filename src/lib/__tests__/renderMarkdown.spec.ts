import { describe, it, expect } from 'vitest'
import { renderMarkdown, renderWikiMarkdown, isInternalHref } from '../renderMarkdown'

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

  it('does NOT allow headings or tables (wiki-only tags)', () => {
    const html = renderMarkdown('# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).not.toContain('<h1')
    expect(html).not.toContain('<table')
  })
})

describe('renderWikiMarkdown (internal wiki pages)', () => {
  it('renders headings, tables, and fenced code blocks', () => {
    const html = renderWikiMarkdown(
      '# Guide\n\n## Section\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```\ncode here\n```',
    )
    expect(html).toContain('<h1')
    expect(html).toContain('<h2')
    expect(html).toContain('<table')
    expect(html).toContain('<td>1</td>')
    expect(html).toContain('<pre>')
    expect(html).toContain('code here')
  })

  it('leaves internal links plain so the SPA router can handle them', () => {
    const html = renderWikiMarkdown('[guide](/wiki/field-guide) and [data](/library/tn-heirs)')
    expect(html).toContain('href="/wiki/field-guide"')
    expect(html).toContain('href="/library/tn-heirs"')
    // no target=_blank / rel on internal links
    expect(html).not.toMatch(/href="\/wiki\/field-guide"[^>]*target/)
    expect(html).not.toMatch(/target[^>]*href="\/wiki\/field-guide"/)
  })

  it('still hardens external links with new-tab + noopener', () => {
    const html = renderWikiMarkdown('[BLO](https://blacklandownership.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('treats backslash and protocol-relative hrefs as external (P5-19 audit): browsers resolve "/\\host" off-origin', () => {
    // Raw HTML survives the sanitiser with the href intact — the classifier must not call it internal.
    const html = renderWikiMarkdown('<a href="/\\evil.example/x">looks internal</a> and <a href="//evil.example">pr</a>')
    expect(html).toMatch(/href="\/\\evil\.example\/x"[^>]*target="_blank"|target="_blank"[^>]*href="\/\\evil\.example\/x"/)
    expect(html).toMatch(/href="\/\/evil\.example"[^>]*target="_blank"|target="_blank"[^>]*href="\/\/evil\.example"/)
    expect(isInternalHref('/wiki/x')).toBe(true)
    expect(isInternalHref('/library/x?tab=data&q=a%20b')).toBe(true)
    expect(isInternalHref('/\\evil.example')).toBe(false)
    expect(isInternalHref('//evil.example')).toBe(false)
    expect(isInternalHref('https://evil.example/')).toBe(false)
    expect(isInternalHref('/%5Cevil.example')).toBe(true) // percent-encoded backslash stays a same-origin path
    expect(isInternalHref(null)).toBe(false)
  })

  it('treats protocol-relative // links as external', () => {
    const html = renderWikiMarkdown('[evil](//evil.example/path)')
    expect(html).toContain('target="_blank"')
  })

  it('strips scripts, event handlers, and javascript: URLs', () => {
    const html = renderWikiMarkdown(
      'a <script>alert(1)</script>\n\n[x](javascript:alert(1))\n\nb <img src=x onerror=alert(1)>',
    )
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<img')
  })

  it('does not leak the wiki profile into subsequent LLM renders', () => {
    renderWikiMarkdown('[guide](/wiki/field-guide)')
    const html = renderMarkdown('[home](/dashboard)\n\n# heading')
    expect(html).toMatch(/target="_blank"/) // LLM profile: every link new-tab
    expect(html).not.toContain('<h1')
  })
})

describe('renderWikiMarkdown embed placeholders (P5-17)', () => {
  it('turns a fenced view:<slug> block (info-string style) into a placeholder div', () => {
    const html = renderWikiMarkdown('before\n\n```view:tn-target-counties\n```\n\nafter')
    expect(html).toContain('data-embed="view"')
    expect(html).toContain('data-embed-slug="tn-target-counties"')
    expect(html).toContain('view:tn-target-counties') // fallback text pre-hydration
    expect(html).not.toContain('<pre')
  })

  it('turns a fenced block whose body is entry:<slug> into a placeholder div', () => {
    const html = renderWikiMarkdown('```\nentry:tn-heirs-dataset\n```')
    expect(html).toContain('data-embed="entry"')
    expect(html).toContain('data-embed-slug="tn-heirs-dataset"')
  })

  it('leaves invalid embed slugs as ordinary code blocks', () => {
    const bad = renderWikiMarkdown('```\nview:NOT A SLUG\n```')
    expect(bad).not.toContain('data-embed')
    expect(bad).toContain('<pre')
    const upper = renderWikiMarkdown('```view:Bad_Slug\n```')
    expect(upper).not.toContain('data-embed')
  })

  it('does not treat inline code as an embed', () => {
    const html = renderWikiMarkdown('embed with `view:tn-target-counties` in a page')
    expect(html).not.toContain('data-embed')
    expect(html).toContain('<code>view:tn-target-counties</code>')
  })

  it('renders ordinary fenced code blocks unchanged', () => {
    const html = renderWikiMarkdown('```js\nconst x = 1\n```')
    expect(html).not.toContain('data-embed')
    expect(html).toContain('const x = 1')
    expect(html).toContain('<pre')
  })

  it('never emits embed divs from the LLM profile', () => {
    const html = renderMarkdown('```view:tn-target-counties\n```')
    expect(html).not.toContain('data-embed')
    expect(html).not.toContain('<div')
  })

  it('strips other attributes from hand-written divs but keeps embed data attrs', () => {
    const html = renderWikiMarkdown(
      '<div data-embed="view" data-embed-slug="x" onclick="alert(1)" class="evil">view:x</div>',
    )
    expect(html).toContain('data-embed="view"')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('class=')
  })
})

describe('renderWikiMarkdown map blocks (P7-4)', () => {
  it('turns a fenced map:<slug> block into a map placeholder, both authoring styles', () => {
    const info = renderWikiMarkdown('The cluster:\n\n```map:memphis-siting\n```')
    expect(info).toContain('data-embed="map"')
    expect(info).toContain('data-embed-slug="memphis-siting"')
    expect(info).toContain('map:memphis-siting') // what a reader sees pre-hydration
    expect(info).not.toContain('<pre')

    const body = renderWikiMarkdown('```\nmap:memphis-siting\n```')
    expect(body).toContain('data-embed="map"')
    expect(body).toContain('data-embed-slug="memphis-siting"')
  })

  it('is the same placeholder shape as a card, so nothing new has to be allowed through the sanitizer', () => {
    const map = renderWikiMarkdown('```map:memphis-siting\n```')
    const card = renderWikiMarkdown('```view:memphis-siting\n```')
    expect(map.split('map:').join('view:').split('"map"').join('"view"')).toBe(card)
  })

  it('leaves an invalid slug as an ordinary code block', () => {
    expect(renderWikiMarkdown('```\nmap:NOT A SLUG\n```')).not.toContain('data-embed')
    expect(renderWikiMarkdown('```map:Bad_Slug\n```')).not.toContain('data-embed')
  })

  it('does not treat inline code or prose about a map block as one', () => {
    const html = renderWikiMarkdown('write `map:memphis-siting` to embed a map')
    expect(html).not.toContain('data-embed')
    expect(html).toContain('<code>map:memphis-siting</code>')
  })

  it('never emits a map placeholder from the LLM profile — an answer cannot mount a canvas', () => {
    const html = renderMarkdown('```map:memphis-siting\n```')
    expect(html).not.toContain('data-embed')
    expect(html).not.toContain('<div')
  })
})
