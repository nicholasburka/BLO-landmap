import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

vi.mock('@/lib/bulkDrop', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/bulkDrop')>()
  return {
    ...actual,
    startBulkDrop: vi.fn(),
    fetchBulkStatus: vi.fn(),
    annotateAgain: vi.fn(),
    acceptFiling: vi.fn(),
  }
})

vi.mock('@/lib/libraryCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryCatalog')>()
  return { ...actual, createLinkEntry: vi.fn(), uploadLibraryFile: vi.fn() }
})

// The checklist's "add something" step is the one thing every path here has to
// report, so it is spied rather than left to write to localStorage.
vi.mock('@/lib/firstRun', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/firstRun')>()
  return { ...actual, completeFirstRunStep: vi.fn() }
})

// KbNav sits at the top of every internal page and reaches the shortlist,
// which registers a logout hook.
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: { value: { username: 'maria', role: 'internal' } } }),
  registerLogoutHook: vi.fn(),
}))

import { startBulkDrop, fetchBulkStatus, annotateAgain, acceptFiling, type BulkDropStatus, type BulkRow } from '@/lib/bulkDrop'
import { completeFirstRunStep } from '@/lib/firstRun'
import { createLinkEntry, uploadLibraryFile } from '@/lib/libraryCatalog'
import NewView from '../NewView.vue'

/**
 * P6-29: `/new` is a two-way chooser — Link or File — and on the File side ONE
 * drop zone that routes by `files.length`.
 *
 * Two rules are under test everywhere below. P6-8's, kept: a proposal is shown,
 * and only Accept (or an edited Save) writes anything. And P6-29's new one:
 * nobody is asked to classify their own files, and the page quotes the size
 * limit of the action in hand rather than both limits at once.
 */

const mockedStart = vi.mocked(startBulkDrop)
const mockedStatus = vi.mocked(fetchBulkStatus)
const mockedAgain = vi.mocked(annotateAgain)
const mockedAccept = vi.mocked(acceptFiling)
const mockedStep = vi.mocked(completeFirstRunStep)
const mockedLink = vi.mocked(createLinkEntry)
const mockedUpload = vi.mocked(uploadLibraryFile)

function row(over: Partial<BulkRow> = {}): BulkRow {
  return {
    slug: 'drop-1',
    file: 'land loss.pdf',
    state: 'suggested',
    title: 'Land loss by county',
    costCents: 1,
    suggested: {
      title: 'Land loss by county',
      summary: 'County-level acreage lost.',
      organization: 'usda',
      category: 'land',
      tags: ['land-loss'],
      shape: 'statistics',
    },
    ...over,
  }
}

function status(over: Partial<BulkDropStatus> = {}): BulkDropStatus {
  const rows = over.rows ?? [row()]
  const counts = { queued: 0, reading: 0, suggested: 0, failed: 0 }
  for (const r of rows) counts[r.state] += 1
  return {
    dropId: 'd1',
    at: '2026-09-23T10:00:00.000Z',
    rows,
    running: counts.queued > 0 || counts.reading > 0,
    counts,
    spentCents: rows.reduce((n, r) => n + r.costCents, 0),
    ...over,
  }
}

function fileOf(name: string, size = 10): File {
  const f = new File(['x'], name)
  Object.defineProperty(f, 'size', { value: size })
  return f
}

let router: Router

async function mountView(): Promise<VueWrapper> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/new', component: NewView },
      { path: '/library/:slug', component: { template: '<div />' } },
      { path: '/:rest(.*)', component: { template: '<div />' } },
    ],
  })
  await router.push('/new')
  await router.isReady()
  const wrapper = mount(NewView, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

/** On the File side, the way a person gets there: one click. */
async function onFileSide(): Promise<VueWrapper> {
  const wrapper = await mountView()
  await wrapper.find('[data-testid="choose-file"]').trigger('click')
  return wrapper
}

/** Choose files the way a person does: drop them on the one zone. */
async function dropFiles(wrapper: VueWrapper, files: File[]): Promise<void> {
  await wrapper.find('[data-testid="new-drop-zone"]').trigger('drop', { dataTransfer: { files } })
  await flushPromises()
}

/** The many-documents path, from the chooser to a started drop. */
async function started(rows: BulkRow[]): Promise<VueWrapper> {
  mockedStart.mockResolvedValue(status({ rows }))
  const wrapper = await onFileSide()
  await dropFiles(wrapper, [fileOf('a.pdf'), fileOf('b.pdf')])
  await wrapper.find('[data-testid="bulk-start"]').trigger('click')
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  mockedStart.mockReset()
  mockedStatus.mockReset()
  mockedAgain.mockReset()
  mockedAccept.mockReset()
  mockedStep.mockReset()
  mockedLink.mockReset()
  mockedUpload.mockReset()
  mockedAccept.mockResolvedValue({ slug: 'drop-1' } as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the page', () => {
  it('does not introduce itself', async () => {
    const wrapper = await mountView()
    // You arrived by pressing New. The page does not repeat the button.
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Add something')
    expect(wrapper.find('[data-testid="new-lede"]').exists()).toBe(false)
  })

  it('keeps the library strip', async () => {
    const wrapper = await mountView()
    expect(wrapper.find('[data-testid="kb-nav"]').exists()).toBe(true)
  })

  it('asks the one question only the person can answer', async () => {
    const wrapper = await mountView()
    const chooser = wrapper.find('[data-testid="new-chooser"]')
    expect(chooser.attributes('role')).toBe('tablist')
    expect(wrapper.find('[data-testid="choose-link"]').text()).toBe('Link')
    expect(wrapper.find('[data-testid="choose-file"]').text()).toBe('File')
    // Nothing anywhere asks a person to count their own files.
    expect(wrapper.text()).not.toContain('Many documents')
  })
})

describe('the chooser', () => {
  it('opens on Link, with no drop zone in sight', async () => {
    const wrapper = await mountView()
    expect(wrapper.find('[data-testid="pane-link"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="link-drop-form"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pane-file"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="new-drop-zone"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="choose-link"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('[data-testid="choose-file"]').attributes('aria-selected')).toBe('false')
  })

  it('switches each way in one click, and only ever renders one side', async () => {
    const wrapper = await onFileSide()
    expect(wrapper.find('[data-testid="new-drop-zone"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pane-link"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="link-drop-form"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="choose-file"]').attributes('aria-selected')).toBe('true')

    await wrapper.find('[data-testid="choose-link"]').trigger('click')
    expect(wrapper.find('[data-testid="link-drop-form"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="new-drop-zone"]').exists()).toBe(false)
  })

  it('stays out of the URL', async () => {
    // P6-18's rule: the URL only when it costs nothing. A shared /new opens the
    // same page for everyone.
    const wrapper = await onFileSide()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/new')
    expect(wrapper.find('[data-testid="new-drop-zone"]').exists()).toBe(true)
  })
})

describe('the files decide', () => {
  it('sends one file to the form you fill in yourself', async () => {
    const wrapper = await onFileSide()
    await dropFiles(wrapper, [fileOf('land loss.pdf')])
    expect(wrapper.find('[data-testid="document-form"]').text()).toContain('land loss.pdf')
    expect(wrapper.find('[data-testid="bulk-chosen"]').exists()).toBe(false)
  })

  it('sends more than one to the pass that fills them in for you', async () => {
    const wrapper = await onFileSide()
    await dropFiles(wrapper, [fileOf('a.pdf'), fileOf('b.pdf'), fileOf('c.pdf')])
    expect(wrapper.find('[data-testid="bulk-chosen"]').text()).toContain('3 files')
    expect(wrapper.find('[data-testid="document-form"]').exists()).toBe(false)
  })

  it('re-routes a second pick and empties the side it left', async () => {
    const wrapper = await onFileSide()
    await dropFiles(wrapper, [fileOf('a.pdf'), fileOf('b.pdf'), fileOf('c.pdf')])
    expect(wrapper.find('[data-testid="bulk-chosen"]').exists()).toBe(true)

    await dropFiles(wrapper, [fileOf('only.pdf')])
    expect(wrapper.find('[data-testid="document-form"]').text()).toContain('only.pdf')
    expect(wrapper.find('[data-testid="bulk-chosen"]').exists()).toBe(false)

    await dropFiles(wrapper, [fileOf('a.pdf'), fileOf('b.pdf')])
    expect(wrapper.find('[data-testid="bulk-chosen"]').text()).toContain('2 files')
    expect(wrapper.find('[data-testid="document-form"]').exists()).toBe(false)
  })

  it('takes a pick from the file input the same way as a drop', async () => {
    const wrapper = await onFileSide()
    const input = wrapper.find('[data-testid="new-file-input"]')
    Object.defineProperty(input.element, 'files', { value: [fileOf('picked.pdf')], configurable: true })
    await input.trigger('change')
    expect(wrapper.find('[data-testid="document-form"]').text()).toContain('picked.pdf')
  })

  it('ignores an empty pick rather than clearing what is there', async () => {
    const wrapper = await onFileSide()
    await dropFiles(wrapper, [fileOf('kept.pdf')])
    await dropFiles(wrapper, [])
    expect(wrapper.find('[data-testid="document-form"]').text()).toContain('kept.pdf')
  })

  it('says what will happen to what has been picked', async () => {
    const wrapper = await onFileSide()
    // The old lede's one load-bearing sentence, now where the decision is made.
    const empty = wrapper.find('[data-testid="new-hint"]').text()
    expect(empty).toContain('Drop one thing and you describe it')
    expect(empty).toContain('until you accept it')

    await dropFiles(wrapper, [fileOf('a.pdf')])
    expect(wrapper.find('[data-testid="new-hint"]').text()).toContain('you describe it')

    await dropFiles(wrapper, [fileOf('a.pdf'), fileOf('b.pdf')])
    expect(wrapper.find('[data-testid="new-hint"]').text()).toContain('2 files')
  })
})

describe('the size limit', () => {
  it('claims nothing before anything is picked', async () => {
    const wrapper = await onFileSide()
    const note = wrapper.find('[data-testid="new-limit"]').text()
    expect(note).toContain('50 at a time')
    expect(note).not.toContain('MB')
  })

  it('quotes the single-upload limit for one file, and only that one', async () => {
    const wrapper = await onFileSide()
    await dropFiles(wrapper, [fileOf('a.pdf')])
    const note = wrapper.find('[data-testid="new-limit"]').text()
    expect(note).toContain('200 MB')
    expect(note).not.toContain('100 MB')
  })

  it('quotes the per-file pass limit for many, and only that one', async () => {
    const wrapper = await onFileSide()
    await dropFiles(wrapper, [fileOf('a.pdf'), fileOf('b.pdf')])
    const note = wrapper.find('[data-testid="new-limit"]').text()
    expect(note).toContain('100 MB')
    expect(note).toContain('50 at a time')
    expect(note).not.toContain('200 MB')
  })

  it('never has both figures on the page at once', async () => {
    // The defect this replaces: 200 MB and 100 MB, eight lines apart, for the
    // same drop zone.
    const wrapper = await onFileSide()
    for (const files of [[fileOf('a.pdf')], [fileOf('a.pdf'), fileOf('b.pdf')]]) {
      await dropFiles(wrapper, files)
      const text = wrapper.text()
      expect(text.includes('200 MB') && text.includes('100 MB')).toBe(false)
    }
  })
})

describe('before the drop starts', () => {
  it('shows what reading the files will cost', async () => {
    const wrapper = await onFileSide()
    await dropFiles(wrapper, Array.from({ length: 12 }, (_, i) => fileOf(`f${i}.pdf`)))
    expect(wrapper.find('[data-testid="bulk-estimate"]').text()).toContain('about 12¢')
    expect(wrapper.find('[data-testid="bulk-chosen"]').text()).toContain('12 files')
  })

  it('refuses a hopeless batch before uploading a byte', async () => {
    const wrapper = await onFileSide()
    await dropFiles(wrapper, [fileOf('huge.zip', 200 * 1024 * 1024), fileOf('ok.pdf')])
    expect(wrapper.find('[data-testid="bulk-refusal"]').text()).toContain('"huge.zip" is too large')
    expect(wrapper.find('[data-testid="bulk-start"]').attributes('disabled')).toBeDefined()
    expect(mockedStart).not.toHaveBeenCalled()
  })

  it('sends the collection choice when it is ticked', async () => {
    mockedStart.mockResolvedValue(status())
    const wrapper = await onFileSide()
    await dropFiles(wrapper, [fileOf('a.pdf'), fileOf('b.pdf')])
    await wrapper.find('[data-testid="keep-as-collection"]').setValue(true)
    await wrapper.find('[data-testid="bulk-start"]').trigger('click')
    await flushPromises()
    expect(mockedStart.mock.calls[0][1]).toMatchObject({ collection: true })
  })
})

describe('the progress list', () => {
  it('polls while anything is queued and stops when it is done', async () => {
    vi.useFakeTimers()
    mockedStart.mockResolvedValue(status({ rows: [row({ state: 'queued', costCents: 0 })] }))
    mockedStatus
      .mockResolvedValueOnce(status({ rows: [row({ state: 'reading', costCents: 0 })] }))
      .mockResolvedValueOnce(status({ rows: [row()] }))
    const wrapper = await onFileSide()
    await dropFiles(wrapper, [fileOf('a.pdf'), fileOf('b.pdf')])
    await wrapper.find('[data-testid="bulk-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="bulk-row-state"]').text()).toBe('Queued')

    await vi.advanceTimersByTimeAsync(1600)
    expect(wrapper.find('[data-testid="bulk-row-state"]').text()).toBe('Reading…')

    await vi.advanceTimersByTimeAsync(1600)
    expect(wrapper.find('[data-testid="bulk-row-state"]').text()).toBe('Suggested')
    expect(mockedStatus).toHaveBeenCalledTimes(2)

    // Finished means finished: no more polling, ever.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockedStatus).toHaveBeenCalledTimes(2)
  })

  it('shows the proposal greyed, badged, and unapplied', async () => {
    const wrapper = await started([row()])

    const title = wrapper.find('[data-testid="bulk-row-title"]')
    expect(title.text()).toContain('Land loss by county')
    expect(title.classes()).toContain('suggested')
    expect(wrapper.find('[data-testid="suggested-badge"]').text()).toBe('suggested')
    const fields = wrapper.find('[data-testid="bulk-row-fields"]').text()
    expect(fields).toContain('USDA')
    expect(fields).toContain('Land')
    expect(fields).toContain('Statistics by county or tract')
    expect(fields).toContain('land-loss')
    expect(mockedAccept).not.toHaveBeenCalled()
  })

  it('carries the running total', async () => {
    const wrapper = await started([row(), row({ slug: 'drop-2' })])
    expect(wrapper.find('[data-testid="bulk-total"]').text()).toContain('2 of 2 suggested')
    expect(wrapper.find('[data-testid="bulk-total"]').text()).toContain('about 2¢')
  })

  it('leaves the zone on screen so a second pile can be dropped on it', async () => {
    const wrapper = await started([row()])
    expect(wrapper.find('[data-testid="new-drop-zone"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bulk-chosen"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="new-limit"]').text()).not.toContain('MB')
  })
})

describe('accepting', () => {
  it('applies the proposal as it stands', async () => {
    const wrapper = await started([row()])
    await wrapper.find('[data-testid="accept-row"]').trigger('click')
    await flushPromises()
    // P6-8a: Accept carries the proposed publisher and shape too.
    expect(mockedAccept).toHaveBeenCalledWith('drop-1', {
      title: 'Land loss by county',
      category: 'land',
      tags: 'land-loss',
      description: 'County-level acreage lost.',
      organization: 'usda',
      shape: 'statistics',
    })
    expect(wrapper.find('[data-testid="bulk-row-filed"]').text()).toContain('Filed as')
  })

  it('opens the fields prefilled, and saves what the person typed', async () => {
    const wrapper = await started([row()])
    await wrapper.find('[data-testid="edit-row"]').trigger('click')
    const form = wrapper.find('[data-testid="bulk-row-edit"]')
    expect((form.find('input[type="text"]').element as HTMLInputElement).value).toBe('Land loss by county')
    await form.find('input[type="text"]').setValue('Land loss, 1910–2020')
    // P6-8a: the publisher and shape are prefilled from the proposal and editable.
    expect((form.find('[data-testid="filing-organization"]').element as HTMLSelectElement).value).toBe('usda')
    expect((form.find('[data-testid="filing-shape"]').element as HTMLSelectElement).value).toBe('statistics')
    await form.find('[data-testid="filing-shape"]').setValue('records')
    expect(wrapper.find('[data-testid="save-row"]').exists()).toBe(true)
    await form.trigger('submit')
    await flushPromises()
    expect(mockedAccept).toHaveBeenCalledWith('drop-1', {
      title: 'Land loss, 1910–2020',
      category: 'land',
      tags: 'land-loss',
      description: 'County-level acreage lost.',
      organization: 'usda',
      shape: 'records',
    })
  })

  it('accepts every outstanding row at once, and each one on its own', async () => {
    const wrapper = await started([row(), row({ slug: 'drop-2' }), row({ slug: 'drop-3', state: 'failed', suggested: undefined })])
    expect(wrapper.find('[data-testid="accept-all"]').text()).toContain('Accept all (2)')
    await wrapper.find('[data-testid="accept-all"]').trigger('click')
    await flushPromises()
    expect(mockedAccept).toHaveBeenCalledTimes(2)
    expect(mockedAccept.mock.calls.map(c => c[0])).toEqual(['drop-1', 'drop-2'])
    // Nothing is left to accept, so the button goes.
    expect(wrapper.find('[data-testid="accept-all"]').exists()).toBe(false)
  })
})

describe('when the model could not be asked', () => {
  async function refused(over: Partial<BulkRow> = {}): Promise<VueWrapper> {
    return started([
      row({
        state: 'failed',
        reason: 'no model pass',
        costCents: 0,
        suggested: { error: 'unavailable', reason: 'refused' },
        ...over,
      }),
    ])
  }

  it('keeps the floor and says so in words a member can act on', async () => {
    const wrapper = await refused()
    expect(wrapper.find('[data-testid="bulk-row-why"]').text()).toBe('No model pass — the model was unavailable.')
    expect(wrapper.find('[data-testid="bulk-total"]').text()).toContain('about 0¢')
    // The floor title is still what the row is called.
    expect(wrapper.find('[data-testid="bulk-row"]').text()).toContain('Land loss by county')
    expect(wrapper.find('[data-testid="accept-all"]').exists()).toBe(false)
  })

  it('offers Look again, and puts the row back in the queue', async () => {
    mockedAgain.mockResolvedValue(undefined)
    const wrapper = await refused()
    await wrapper.find('[data-testid="look-again"]').trigger('click')
    await flushPromises()
    expect(mockedAgain).toHaveBeenCalledWith('drop-1')
    expect(wrapper.find('[data-testid="bulk-row-state"]').text()).toBe('Queued')
  })

  it('says what the pass could not read, when that is the problem', async () => {
    const wrapper = await refused({ reason: 'no text could be read', suggested: undefined })
    expect(wrapper.find('[data-testid="bulk-row-why"]').text()).toBe('no text could be read')
  })
})

describe('the first-run checklist', () => {
  it('ticks "add something" when a link lands', async () => {
    mockedLink.mockResolvedValue({ kind: 'entry', title: 'A portal', status: 'filed' } as never)
    const wrapper = await mountView()
    await wrapper.find('[data-testid="link-drop-form"] input[type="url"]').setValue('https://example.gov/data')
    await wrapper.find('[data-testid="link-drop-form"]').trigger('submit')
    await flushPromises()
    expect(mockedStep).toHaveBeenCalledWith('add')
  })

  it('ticks it when one file lands', async () => {
    mockedUpload.mockResolvedValue({ slug: 'one' } as never)
    const wrapper = await onFileSide()
    await dropFiles(wrapper, [fileOf('a.pdf')])
    await wrapper.find('[data-testid="document-form"] button[title="Upload now, file later"]').trigger('click')
    await flushPromises()
    expect(mockedStep).toHaveBeenCalledWith('add')
  })

  it('ticks it when a pile of files lands', async () => {
    await started([row()])
    expect(mockedStep).toHaveBeenCalledWith('add')
  })
})

describe('on a phone (P5-60)', () => {
  it('gives the chooser two full-width 44px targets', async () => {
    const wrapper = await mountView()
    for (const id of ['choose-link', 'choose-file']) {
      expect(wrapper.find(`[data-testid="${id}"]`).classes()).toContain('touch-target')
    }
    const phone = mediaBlock(readStyles('src/views/NewView.vue'), 640)
    expect(ruleFor(phone, '.chooser')).toContain('width: 100%')
    expect(ruleFor(phone, '.chooser-btn')).toContain('flex: 1 1 0')
  })

  it('keeps the zone text above the 14px floor', async () => {
    const phone = mediaBlock(readStyles('src/views/NewView.vue'), 640)
    // 0.82rem is 13.1px at the default root size; the phone block raises it.
    expect(ruleFor(phone, '.zone-limit')).toContain('font-size: 0.875rem')
    expect(ruleFor(phone, '.zone-next')).toContain('font-size: 0.95rem')
  })
})
