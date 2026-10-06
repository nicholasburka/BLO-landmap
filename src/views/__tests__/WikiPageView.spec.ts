import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'

vi.mock('@/lib/wikiEmbeds', () => ({ hydrateEmbeds: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/libraryCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryCatalog')>()
  return { ...actual, fetchCatalog: vi.fn().mockResolvedValue([]) }
})
vi.mock('@/lib/wiki', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/wiki')>()
  return { ...actual, fetchWikiPage: vi.fn(), saveWikiPage: vi.fn() }
})

import { fetchWikiPage, saveWikiPage, WikiConflictError } from '@/lib/wiki'
import { hydrateEmbeds } from '@/lib/wikiEmbeds'
import WikiPageView from '../WikiPageView.vue'

const mockedHydrate = vi.mocked(hydrateEmbeds)
const mockedFetch = vi.mocked(fetchWikiPage)
const mockedSave = vi.mocked(saveWikiPage)

const PAGE = {
  slug: 'tn-strategy',
  title: 'TN Strategy',
  markdown: '# TN Strategy\n\nWhere we focus.',
  updatedAt: '2026-09-05T10:00:00.000Z',
}

let router: Router
async function mountAt(path: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/wiki/:slug', component: WikiPageView },
      { path: '/docs', component: { template: '<div />' } },
      { path: '/', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const w = mount(WikiPageView, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return w
}

async function startEditing(w: VueWrapper<any>) {
  await w.get('[data-testid="edit-page"]').trigger('click')
  await flushPromises()
}

async function type(w: VueWrapper<any>, markdown: string) {
  await w.get('[data-testid="editor-textarea"]').setValue(markdown)
}

async function save(w: VueWrapper<any>) {
  await w.get('[data-testid="save-page"]').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  mockedFetch.mockReset()
  mockedSave.mockReset()
  mockedFetch.mockResolvedValue({ ...PAGE })
  mockedSave.mockResolvedValue({
    slug: 'tn-strategy',
    title: 'TN Strategy',
    created: false,
    updatedAt: '2026-09-05T12:00:00.000Z',
  })
})

describe('WikiPageView editing (P5-49)', () => {
  it('opens the page editor on Edit, prefilled with the page markdown', async () => {
    const w = await mountAt('/wiki/tn-strategy')
    expect(w.get('.wiki-content').html()).toContain('Where we focus.')
    await startEditing(w)
    const source = w.get('[data-testid="editor-textarea"]').element as HTMLTextAreaElement
    expect(source.value).toBe(PAGE.markdown)
    // The toolbar is the point of the upgrade — it must be there.
    expect(w.find('[data-testid="tb-bold"]').exists()).toBe(true)
  })

  it('sends the loaded updatedAt as the conflict baseline and clears the draft on save', async () => {
    const w = await mountAt('/wiki/tn-strategy')
    await startEditing(w)
    await type(w, '# TN Strategy\n\nRevised.')
    localStorage.setItem('blo:draft:tn-strategy', '# TN Strategy\n\nRevised.')
    await save(w)

    expect(mockedSave).toHaveBeenCalledWith('tn-strategy', '# TN Strategy\n\nRevised.', {
      ifUnmodifiedSince: '2026-09-05T10:00:00.000Z',
    })
    expect(localStorage.getItem('blo:draft:tn-strategy')).toBeNull()
    expect(w.get('.save-note').text()).toBe('Saved.')
  })

  it('uses the save response as the new baseline, so a second save does not conflict with the first', async () => {
    const w = await mountAt('/wiki/tn-strategy')
    await startEditing(w)
    await type(w, '# TN Strategy\n\nOne.')
    await save(w)
    await startEditing(w)
    await type(w, '# TN Strategy\n\nTwo.')
    await save(w)
    expect(mockedSave).toHaveBeenLastCalledWith('tn-strategy', '# TN Strategy\n\nTwo.', {
      ifUnmodifiedSince: '2026-09-05T12:00:00.000Z',
    })
  })

  it('shows the conflict notice, naming who changed it, without losing the text', async () => {
    mockedSave.mockRejectedValueOnce(new WikiConflictError('maria', '2026-09-05T11:00:00.000Z'))
    const w = await mountAt('/wiki/tn-strategy')
    await startEditing(w)
    await type(w, '# TN Strategy\n\nMine.')
    await save(w)

    expect(w.get('[data-testid="conflict-notice"]').text()).toContain(
      'This page changed while you were editing (by maria). Reload to see the latest, or save anyway (overwrites).',
    )
    const source = w.get('[data-testid="editor-textarea"]').element as HTMLTextAreaElement
    expect(source.value).toBe('# TN Strategy\n\nMine.')
  })

  it('"Save anyway" retries without the baseline and overwrites', async () => {
    mockedSave.mockRejectedValueOnce(new WikiConflictError('maria', '2026-09-05T11:00:00.000Z'))
    const w = await mountAt('/wiki/tn-strategy')
    await startEditing(w)
    await type(w, '# TN Strategy\n\nMine.')
    await save(w)
    await w.get('[data-testid="conflict-overwrite"]').trigger('click')
    await flushPromises()

    expect(mockedSave).toHaveBeenLastCalledWith('tn-strategy', '# TN Strategy\n\nMine.', {})
    expect(w.find('[data-testid="conflict-notice"]').exists()).toBe(false)
    expect(w.get('.save-note').text()).toBe('Saved.')
  })

  it('"Reload" fetches the latest and keeps the draft as the safety net', async () => {
    mockedSave.mockRejectedValueOnce(new WikiConflictError('maria', '2026-09-05T11:00:00.000Z'))
    const w = await mountAt('/wiki/tn-strategy')
    await startEditing(w)
    await type(w, '# TN Strategy\n\nMine.')
    localStorage.setItem('blo:draft:tn-strategy', '# TN Strategy\n\nMine.')
    await save(w)

    mockedFetch.mockResolvedValue({ ...PAGE, markdown: '# TN Strategy\n\nHers.', updatedAt: '2026-09-05T11:00:00.000Z' })
    await w.get('[data-testid="conflict-reload"]').trigger('click')
    await flushPromises()

    expect(w.get('.wiki-content').html()).toContain('Hers.')
    expect(localStorage.getItem('blo:draft:tn-strategy')).toBe('# TN Strategy\n\nMine.')
  })

  it('a page that does not exist yet opens straight into the editor with the title prefilled', async () => {
    mockedFetch.mockResolvedValue(null)
    mockedSave.mockResolvedValue({ slug: 'new-page', title: 'New Page', created: true, updatedAt: 'x' })
    const w = await mountAt('/wiki/new-page?title=New%20Page')
    const source = w.get('[data-testid="editor-textarea"]').element as HTMLTextAreaElement
    expect(source.value).toBe('# New Page\n\n')
    expect(w.get('[data-testid="save-page"]').text()).toBe('Create page')
    // Nothing exists server-side yet, so there is no baseline to send.
    await save(w)
    expect(mockedSave).toHaveBeenCalledWith('new-page', '# New Page\n\n', {})
    expect(w.get('.save-note').text()).toBe('Page created.')
  })

  it('reports an ordinary save failure without offering to overwrite', async () => {
    mockedSave.mockRejectedValue(new Error('This page is too large: wiki pages are limited to 1 MB of markdown'))
    const w = await mountAt('/wiki/tn-strategy')
    await startEditing(w)
    await save(w)
    expect(w.get('.save-note.error').text()).toMatch(/1 MB/)
    expect(w.find('[data-testid="conflict-notice"]').exists()).toBe(false)
  })

  it('never puts a status code in front of a writer (P5-72)', async () => {
    mockedSave.mockRejectedValue(new Error('Failed to save wiki page (503)'))
    const w = await mountAt('/wiki/tn-strategy')
    await startEditing(w)
    await save(w)
    expect(w.get('.save-note.error').text()).toBe('This page could not be saved. Try again in a moment.')
  })
})

describe('WikiPageView — the page reads as one page (P5-73)', () => {
  it('calls the way back to the index what the index calls itself', async () => {
    const w = await mountAt('/wiki/tn-strategy')
    expect(w.get('.back-link').text()).toBe('← Pages')
  })

  it('drops the body\'s opening heading when it only repeats the title', async () => {
    const w = await mountAt('/wiki/tn-strategy')
    expect(w.get('.title-row h1').text()).toBe('TN Strategy')
    expect(w.get('.wiki-content').findAll('h1')).toHaveLength(0)
    expect(w.get('.wiki-content').text()).toContain('Where we focus.')
  })

  it('keeps an opening heading that says something else', async () => {
    mockedFetch.mockResolvedValue({ ...PAGE, markdown: '# Background\n\nWhere we focus.' })
    const w = await mountAt('/wiki/tn-strategy')
    expect(w.get('.wiki-content').findAll('h1').map(h => h.text())).toEqual(['Background'])
  })

  it('says what went wrong in words when the page will not load', async () => {
    mockedFetch.mockRejectedValue(new Error('Unauthorized'))
    const w = await mountAt('/wiki/tn-strategy')
    expect(w.get('.state-note.error').text()).toBe('This page did not load. Try again in a moment.')
  })
})

describe('a map block in a page (P7-4)', () => {
  it('lends hydration the page\'s own router, so what a block mounts can navigate', async () => {
    mockedFetch.mockResolvedValue({ ...PAGE, markdown: '# TN Strategy\n\n```map:tn-target-counties\n```' })
    const w = await mountAt('/wiki/tn-strategy')

    expect(mockedHydrate).toHaveBeenCalled()
    const [node, options] = mockedHydrate.mock.calls.at(-1)!
    expect((node as HTMLElement).className).toContain('wiki-content')
    expect(options?.router).toBe(router)
    // This IS the page, so a block here draws: nothing says otherwise.
    expect(options?.liveMaps).toBeUndefined()
    w.unmount()
  })

  it('renders the map placeholder the hydrator looks for', async () => {
    mockedFetch.mockResolvedValue({ ...PAGE, markdown: '# TN Strategy\n\n```map:tn-target-counties\n```' })
    const w = await mountAt('/wiki/tn-strategy')
    const placeholder = w.find('[data-embed="map"]')
    expect(placeholder.exists()).toBe(true)
    expect(placeholder.attributes('data-embed-slug')).toBe('tn-target-counties')
    w.unmount()
  })
})
