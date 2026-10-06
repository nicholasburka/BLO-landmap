import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

/**
 * P5-59: the panel that says what a link turned out to be and how it comes in.
 *
 * The rules worth a test are the boundaries: a researcher never sees the plan
 * picker or the copy button, nothing is applied without a person pressing
 * something, and a service's layers are LISTED rather than one being chosen.
 */

vi.mock('@/lib/documentPull', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/documentPull')>()
  return { ...actual, pullDocuments: vi.fn() }
})

vi.mock('@/lib/libraryCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryCatalog')>()
  return {
    ...actual,
    inspectEntryLink: vi.fn(),
    fetchSourceProposal: vi.fn(),
    setIngestPlan: vi.fn(),
    replicateEntryNow: vi.fn(),
  }
})

import {
  inspectEntryLink,
  fetchSourceProposal,
  setIngestPlan,
  replicateEntryNow,
  type CatalogEntry,
} from '@/lib/libraryCatalog'
import { pullDocuments } from '@/lib/documentPull'
import IngestPanel from '../IngestPanel.vue'

const mockedInspect = vi.mocked(inspectEntryLink)
const mockedProposal = vi.mocked(fetchSourceProposal)
const mockedPlan = vi.mocked(setIngestPlan)
const mockedReplicate = vi.mocked(replicateEntryNow)
const mockedPull = vi.mocked(pullDocuments)

function entry(meta: Record<string, unknown> = {}, over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    slug: 'a',
    kind: 'incoming',
    title: 'A dropped link',
    category: '',
    status: 'needs-cataloging',
    tags: [],
    meta: { url: 'https://services.example/rest/services/NPL/FeatureServer/0', ...meta },
    files: [],
    bytes: 0,
    ...over,
  } as CatalogEntry
}

const ARCGIS_INSPECTION = {
  kind: 'arcgis-layer' as const,
  confidence: 'high' as const,
  url: 'https://services.example/rest/services/NPL/FeatureServer/0',
  finalUrl: 'https://services.example/rest/services/NPL/FeatureServer/0',
  title: 'NPL sites',
  summary: 'ArcGIS point layer · 12 fields · Georgia extent',
  checkedAt: '2026-09-06T00:00:00.000Z',
}

const mount_ = (e: CatalogEntry, isAdmin = false) => mount(IngestPanel, { props: { entry: e, isAdmin } })

beforeEach(() => {
  mockedInspect.mockReset()
  mockedProposal.mockReset()
  mockedPlan.mockReset()
  mockedReplicate.mockReset()
  mockedPull.mockReset()
})

describe('the inspection summary', () => {
  it('shows the stored one-line description of what the link is', () => {
    const w = mount_(entry({ inspection: ARCGIS_INSPECTION }))
    expect(w.get('[data-testid="inspection-summary"]').text()).toBe('ArcGIS point layer · 12 fields · Georgia extent')
  })

  it('says plainly when nobody has looked yet, and offers to', () => {
    const w = mount_(entry())
    expect(w.get('[data-testid="inspection-summary"]').text()).toMatch(/Nobody has looked at this link yet/)
    expect(w.get('[data-testid="inspect-link"]').text()).toBe('Inspect this link')
  })

  it('re-runs the look on demand and shows what came back', async () => {
    mockedInspect.mockResolvedValue({
      inspection: ARCGIS_INSPECTION,
      summary: ARCGIS_INSPECTION.summary,
      proposal: { source: { provider: 'services.example' }, inferred: ['provider'] },
      suggestedPlan: { plan: 'fetch-on-demand', why: 'it has an endpoint we can query' },
    } as never)
    const w = mount_(entry())
    await w.get('[data-testid="inspect-link"]').trigger('click')
    await flushPromises()
    expect(mockedInspect).toHaveBeenCalledWith('a')
    expect(w.get('[data-testid="inspection-summary"]').text()).toContain('ArcGIS point layer')
    expect(w.get('[data-testid="ingest-note"]').text()).toContain('Looked at it')
    expect(w.emitted('changed')).toBeTruthy()
  })

  it('a link it could not reach says so, and says what to do', async () => {
    mockedInspect.mockResolvedValue({
      inspection: { kind: 'unreachable', confidence: 'high', url: 'x', notes: ['We could not reach that site.'], checkedAt: 'T' },
      summary: 'Could not reach it — check the link',
      proposal: { source: { provider: 'x' }, inferred: [] },
      suggestedPlan: null,
    } as never)
    const w = mount_(entry())
    await w.get('[data-testid="inspect-link"]').trigger('click')
    await flushPromises()
    const note = w.get('[data-testid="ingest-note"]')
    expect(note.text()).toMatch(/could not reach it/i)
    expect(note.classes()).toContain('error')
  })

  it('a probe failure is a sentence, never a stack trace', async () => {
    mockedInspect.mockRejectedValue(new Error('we could not look at that link (500)'))
    const w = mount_(entry())
    await w.get('[data-testid="inspect-link"]').trigger('click')
    await flushPromises()
    // A message ending in a status code is machine talk; the panel's own sentence shows instead (P5-72).
    expect(w.get('[data-testid="ingest-note"]').text()).toBe('we could not look at that link.')
  })
})

describe('registering a source', () => {
  it('hands the proposal up to the filing form rather than saving anything', async () => {
    const proposal = {
      inspection: ARCGIS_INSPECTION,
      summary: ARCGIS_INSPECTION.summary,
      proposal: {
        title: 'EPA NPL sites',
        source: { provider: 'services.example', program: 'NPL sites' },
        inferred: ['provider', 'program', 'access'],
      },
      suggestedPlan: { plan: 'fetch-on-demand' as const, why: 'queryable' },
    }
    mockedProposal.mockResolvedValue(proposal as never)
    const w = mount_(entry({ inspection: ARCGIS_INSPECTION }))
    await w.get('[data-testid="register-source"]').trigger('click')
    await flushPromises()
    expect(mockedProposal).toHaveBeenCalledWith('a')
    expect(w.emitted('register')?.[0]?.[0]).toEqual(proposal)
    expect(w.get('[data-testid="ingest-note"]').text()).toMatch(/marked "inferred"/)
  })

  it('is not offered for a page with nothing to ingest', () => {
    const w = mount_(entry({ inspection: { ...ARCGIS_INSPECTION, kind: 'page' } }))
    expect(w.find('[data-testid="register-source"]').exists()).toBe(false)
  })

  /** P5-61: the whole point of reading a page for data is that the page can
   *  then be registered — but only when something real came out of it. */
  it('is offered for a page that turned out to describe a dataset', () => {
    const w = mount_(
      entry({
        inspection: {
          ...ARCGIS_INSPECTION,
          kind: 'page',
          links: [{ url: 'https://epd.example.gov/wells.csv', role: 'data-file', reason: 'The results file.' }],
          prose: { isDataset: true },
        },
      }),
    )
    expect(w.find('[data-testid="register-source"]').exists()).toBe(true)
  })

  it('is still not offered for a page a model was confident about but found nothing on', () => {
    const w = mount_(entry({ inspection: { ...ARCGIS_INSPECTION, kind: 'page', prose: { isDataset: true } } }))
    expect(w.find('[data-testid="register-source"]').exists()).toBe(false)
  })

  it('is not offered for an entry that is already a source', () => {
    const w = mount_(entry({ inspection: ARCGIS_INSPECTION }, { kind: 'source' }))
    expect(w.find('[data-testid="register-source"]').exists()).toBe(false)
  })
})

describe('a service and a portal list what they hold, and choose nothing', () => {
  it('lists a service layers, each with its own drop button', async () => {
    const w = mount_(
      entry({
        inspection: {
          ...ARCGIS_INSPECTION,
          kind: 'arcgis-service',
          layers: [
            { id: 0, name: 'Flood Hazard Zones', url: 'https://x/MapServer/0', geometry: 'polygon' },
            { id: 23, name: 'County or Equivalent', url: 'https://x/MapServer/23', geometry: 'polygon' },
          ],
        },
      }),
    )
    const rows = w.findAll('[data-testid="service-layers"] li')
    expect(rows).toHaveLength(2)
    expect(rows[1].text()).toContain('County or Equivalent')
    await w.findAll('[data-testid="drop-layer"]')[1].trigger('click')
    expect(w.emitted('drop-link')?.[0]?.[0]).toBe('https://x/MapServer/23')
  })

  it('lists the downloads a portal page points at', async () => {
    const w = mount_(
      entry({
        inspection: {
          ...ARCGIS_INSPECTION,
          kind: 'portal',
          links: [
            { url: 'https://data.cdc.gov/api/v3/views/x/export.csv', label: 'CSV', kind: 'file' },
            { url: 'https://data.cdc.gov/api/v3/views/x/query.json', label: 'JSON', kind: 'file' },
          ],
        },
      }),
    )
    expect(w.findAll('[data-testid="portal-links"] li')).toHaveLength(2)
    await w.findAll('[data-testid="drop-portal-link"]')[0].trigger('click')
    expect(w.emitted('drop-link')?.[0]?.[0]).toBe('https://data.cdc.gov/api/v3/views/x/export.csv')
  })
})

describe('the ingest plan', () => {
  const planned = {
    plan: 'replicate',
    mode: 'manual',
    owner: 'Nick',
    decidedBy: 'nick',
    decidedAt: '2026-09-06T00:00:00.000Z',
  }

  it('shows the plan and what happens next in plain words', () => {
    const w = mount_(entry({ ingest: planned }))
    expect(w.get('[data-testid="plan-now"]').text()).toContain('Copy into the library')
    expect(w.get('[data-testid="plan-now"]').text()).toContain('by hand')
    expect(w.get('[data-testid="plan-next"]').text()).toMatch(/pull it, clean it, push it/i)
  })

  it('marks a plan whose dataset has arrived as done', () => {
    const w = mount_(entry({ ingest: { ...planned, done: { at: 'T', dataset: 'npl-clean' } } }))
    expect(w.find('[data-testid="plan-done"]').exists()).toBe(true)
    expect(w.get('[data-testid="plan-next"]').text()).toMatch(/Done/)
  })

  it('says "no plan yet" rather than pretending one was chosen', () => {
    const w = mount_(entry())
    expect(w.get('[data-testid="plan-now"]').text()).toBe('No plan yet.')
  })

  it('is only editable by an admin; a researcher is told who decides', () => {
    const researcher = mount_(entry())
    expect(researcher.find('[data-testid="plan-picker"]').exists()).toBe(false)
    expect(researcher.get('[data-testid="plan-admin-only"]').text()).toMatch(/An admin decides the plan/)

    const admin = mount_(entry(), true)
    expect(admin.find('[data-testid="plan-picker"]').exists()).toBe(true)
    expect(admin.findAll('[data-testid="plan-picker"] button')).toHaveLength(4)
  })

  it('saves the plan an admin picks, and says which one', async () => {
    mockedPlan.mockResolvedValue({ plan: 'fetch-on-demand', decidedBy: 'nick', decidedAt: 'T' } as never)
    const w = mount_(entry(), true)
    await w.get('[data-testid="plan-fetch-on-demand"]').trigger('click')
    await flushPromises()
    expect(mockedPlan).toHaveBeenCalledWith('a', { plan: 'fetch-on-demand' })
    expect(w.get('[data-testid="ingest-note"]').text()).toBe('Plan saved: Fetch for a place.')
    expect(w.emitted('changed')).toBeTruthy()
  })

  it('marks the plan the entry already has as the chosen one', () => {
    const w = mount_(entry({ ingest: { ...planned, plan: 'index' } }), true)
    expect(w.get('[data-testid="plan-index"]').classes()).toContain('chosen')
    expect(w.get('[data-testid="plan-replicate"]').classes()).not.toContain('chosen')
  })
})

describe('copy it in now', () => {
  it('is admin-only and never shown for a page', () => {
    expect(mount_(entry({ inspection: { ...ARCGIS_INSPECTION, kind: 'file' } })).find('[data-testid="replicate-now"]').exists()).toBe(false)
    expect(mount_(entry({ inspection: { ...ARCGIS_INSPECTION, kind: 'page' } }), true).find('[data-testid="replicate-now"]').exists()).toBe(false)
    expect(mount_(entry({ inspection: { ...ARCGIS_INSPECTION, kind: 'file' } }), true).find('[data-testid="replicate-now"]').exists()).toBe(true)
    // A registered source can always be copied — the server decides whether
    // its access method can actually be pulled.
    expect(mount_(entry({}, { kind: 'source' }), true).find('[data-testid="replicate-now"]').exists()).toBe(true)
  })

  it('starts the copy and says it takes a while', async () => {
    mockedReplicate.mockResolvedValue(undefined)
    const w = mount_(entry({}, { kind: 'source' }), true)
    await w.get('[data-testid="replicate-now"]').trigger('click')
    await flushPromises()
    expect(mockedReplicate).toHaveBeenCalledWith('a')
    expect(w.get('[data-testid="ingest-note"]').text()).toMatch(/take a few minutes/i)
  })
})

describe('an entry with no link at all', () => {
  it('shows nothing rather than an empty panel', () => {
    const w = mount(IngestPanel, {
      props: { entry: entry({ url: undefined }, { kind: 'incoming' }), isAdmin: true },
    })
    expect(w.find('[data-testid="ingest-panel"]').exists()).toBe(false)
  })
})

/**
 * P5-61: the kept links, and what the panel says about the ones it dropped.
 *
 * The panel's job here is to make the pruning legible: a role you can read at
 * a glance, the reason on demand, and an honest count of what was left out —
 * because a list that silently drops forty links is a list nobody can check.
 */
describe('the links a page turned out to hold', () => {
  const PAGE = {
    ...ARCGIS_INSPECTION,
    kind: 'page' as const,
    summary: 'Web page · 2 data links',
    links: [
      {
        url: 'https://epd.example.gov/files/wells-2024.csv',
        label: 'county-level CSV file',
        kind: 'file' as const,
        role: 'data-file' as const,
        reason: 'The annual results file the page calls the full set of results.',
      },
      {
        url: 'https://epd.example.gov/developers/wells',
        label: 'API documentation',
        role: 'docs' as const,
        reason: 'Documents the query endpoint.',
      },
    ],
    candidates: 46,
    pruned: 'model' as const,
    prose: { isDataset: true },
  }

  it('shows each kept link with a role badge you can read at a glance', () => {
    const w = mount_(entry({ inspection: PAGE }))
    const rows = w.findAll('[data-testid="portal-links"] li')
    expect(rows).toHaveLength(2)
    expect(w.findAll('[data-testid="link-role"]').map(r => r.text())).toEqual(['file', 'docs'])
    expect(rows[0].text()).toContain('county-level CSV file')
  })

  it('keeps the reason out of the way until it is asked for', async () => {
    const w = mount_(entry({ inspection: PAGE }))
    expect(w.find('[data-testid="link-reason"]').exists()).toBe(false)
    // It is always available without a click, for a pointer or a screen reader.
    expect(w.findAll('[data-testid="link-why"]')[0].attributes('title')).toBe(
      'The annual results file the page calls the full set of results.',
    )

    await w.findAll('[data-testid="link-why"]')[0].trigger('click')
    expect(w.get('[data-testid="link-reason"]').text()).toBe(
      'The annual results file the page calls the full set of results.',
    )
    await w.findAll('[data-testid="link-why"]')[0].trigger('click')
    expect(w.find('[data-testid="link-reason"]').exists()).toBe(false)
  })

  it('counts what it left out rather than listing it', () => {
    const w = mount_(entry({ inspection: PAGE }))
    expect(w.get('[data-testid="links-left-out"]').text()).toBe('44 other links on the page were left out.')
    // The forty-four are counted, never rendered — that is the whole point.
    expect(w.findAll('[data-testid="portal-links"] li')).toHaveLength(2)
    expect(w.find('[data-testid="links-unranked"]').exists()).toBe(false)
  })

  it('says nothing about links left out when none were', () => {
    const w = mount_(entry({ inspection: { ...PAGE, candidates: 2 } }))
    expect(w.find('[data-testid="links-left-out"]').exists()).toBe(false)
  })

  it('says plainly when nobody read the page and the links are a guess', () => {
    const w = mount_(entry({ inspection: { ...PAGE, pruned: 'unranked' } }))
    expect(w.get('[data-testid="links-unranked"]').text()).toMatch(/Nobody read the page/)
    expect(w.get('[data-testid="links-unranked"]').text()).toMatch(/check them before using any/)
  })

  it('drops one of the kept links exactly as it always could', async () => {
    const w = mount_(entry({ inspection: PAGE }))
    await w.findAll('[data-testid="drop-portal-link"]')[0].trigger('click')
    expect(w.emitted('drop-link')?.[0]?.[0]).toBe('https://epd.example.gov/files/wells-2024.csv')
  })

  it('a portal list with no roles still renders, exactly as before', () => {
    const w = mount_(
      entry({
        inspection: {
          ...ARCGIS_INSPECTION,
          kind: 'portal',
          links: [{ url: 'https://data.cdc.gov/x/export.csv', label: 'CSV', kind: 'file' }],
        },
      }),
    )
    expect(w.findAll('[data-testid="portal-links"] li')).toHaveLength(1)
    expect(w.find('[data-testid="link-role"]').exists()).toBe(false)
    expect(w.find('[data-testid="link-why"]').exists()).toBe(false)
  })
})

/**
 * P5-61 round two: what the panel says when the pass did NOT run, and what it
 * shows of the links it threw away. Both came out of the lead's live check —
 * an entry that said "unranked" with no reason left nobody able to tell a
 * broken model from a page with nothing on it.
 */
describe('when the model pass could not read the page', () => {
  const UNRANKED = {
    ...ARCGIS_INSPECTION,
    kind: 'page' as const,
    links: [
      { url: 'https://www2.census.gov/geo/tiger/TIGER2025/', label: 'FTP Archive', role: 'directory' as const, reason: 'Picked by the shape of its URL — nobody read the page.' },
    ],
    candidates: 13,
    pruned: 'unranked' as const,
    pruneError: 'the answer was cut off at the 3000-token cap (raise LIBRARY_PRUNE_MAX_TOKENS)',
    dropped: ['https://www.census.gov/about.html', 'https://www.census.gov/newsroom.html'],
  }

  it('says why it is unranked instead of leaving a reader to guess', () => {
    const w = mount_(entry({ inspection: UNRANKED }))
    expect(w.get('[data-testid="links-unranked"]').text()).toMatch(/Nobody read the page/)
    expect(w.get('[data-testid="prune-error"]').text()).toBe(
      'Reason: the answer was cut off at the 3000-token cap (raise LIBRARY_PRUNE_MAX_TOKENS).',
    )
  })

  it('says nothing about a reason when the pass worked', () => {
    const w = mount_(entry({ inspection: { ...UNRANKED, pruned: 'model', pruneError: undefined } }))
    expect(w.find('[data-testid="prune-error"]').exists()).toBe(false)
    expect(w.find('[data-testid="links-unranked"]').exists()).toBe(false)
  })

  // P5-75: when the model itself failed, an admin sees what to fix; a member
  // sees the plain reason and nothing about keys or billing.
  it('tells an admin why the model failed, and a member only that it did', () => {
    const failed = { ...UNRANKED, pruneError: 'the API key was refused', pruneErrorCode: 'refused' as const }
    expect(mount_(entry({ inspection: failed }), true).get('[data-testid="prune-error"]').text()).toBe(
      'Reason: The model refused the key — check billing or the key.',
    )
    expect(mount_(entry({ inspection: failed })).get('[data-testid="prune-error"]').text()).toBe(
      'Reason: the API key was refused.',
    )
  })

  it('names a folder of files in words rather than as a role id', () => {
    const w = mount_(entry({ inspection: UNRANKED }))
    expect(w.get('[data-testid="link-role"]').text()).toBe('folder of files')
  })

  it('keeps the dropped links out of the way until a reviewer asks', async () => {
    const w = mount_(entry({ inspection: UNRANKED }))
    expect(w.find('[data-testid="dropped-links"]').exists()).toBe(false)

    await w.get('[data-testid="show-dropped"]').trigger('click')
    const shown = w.findAll('[data-testid="dropped-links"] li').map(li => li.text())
    expect(shown).toEqual(['https://www.census.gov/about.html', 'https://www.census.gov/newsroom.html'])

    await w.get('[data-testid="show-dropped"]').trigger('click')
    expect(w.find('[data-testid="dropped-links"]').exists()).toBe(false)
  })

  it('offers nothing to show when the pass recorded no dropped links', () => {
    const w = mount_(entry({ inspection: { ...UNRANKED, dropped: undefined } }))
    expect(w.get('[data-testid="links-left-out"]').text()).toContain('12 other links')
    expect(w.find('[data-testid="show-dropped"]').exists()).toBe(false)
  })
})

/**
 * P5-80: the documents on the page, offered as one collection.
 *
 * The rules worth a test are the ones that keep it a person's choice: nothing
 * ticked by default, only the ticked URLs sent, and every file's outcome shown
 * rather than a single "done".
 */
describe('documents on this page', () => {
  const JONES = 'https://land.example.org/files/jones-farm.pdf'
  const SMITH = 'https://land.example.org/files/smith-woodlot.pdf'
  const withDocuments = () =>
    entry({
      inspection: {
        ...ARCGIS_INSPECTION,
        kind: 'page',
        documents: [
          { url: JONES, label: 'The Jones farm, 2024' },
          { url: SMITH, label: 'Smith woodlot' },
        ],
      },
    })

  it('is absent when the page had none', () => {
    expect(mount_(entry({ inspection: ARCGIS_INSPECTION })).find('[data-testid="documents-block"]').exists()).toBe(false)
  })

  it('lists them with a count, ticks none of them, and says where they will go', () => {
    const w = mount_(withDocuments())
    expect(w.get('[data-testid="documents-block"]').text()).toContain('Documents on this page · 2')
    const boxes = w.findAll('[data-testid="document-check"]')
    expect(boxes).toHaveLength(2)
    expect(boxes.every(b => (b.element as HTMLInputElement).checked)).toBe(false)
    expect(w.get('[data-testid="documents-block"]').text()).toContain('The Jones farm, 2024')
    expect(w.get('[data-testid="documents-note"]').text()).toMatch(/appear under Files/i)
    // Nothing to pull in yet, so the button is not pressable.
    expect(w.get('[data-testid="pull-documents"]').attributes('disabled')).toBeDefined()
  })

  it('selects all and none', async () => {
    const w = mount_(withDocuments())
    await w.get('[data-testid="choose-all-documents"]').trigger('click')
    expect(w.findAll('[data-testid="document-check"]').every(b => (b.element as HTMLInputElement).checked)).toBe(true)
    expect(w.get('[data-testid="pull-documents"]').text()).toContain('(2)')

    await w.get('[data-testid="choose-no-documents"]').trigger('click')
    expect(w.findAll('[data-testid="document-check"]').some(b => (b.element as HTMLInputElement).checked)).toBe(false)
  })

  it('pulls in only what was ticked, and shows what happened to each', async () => {
    mockedPull.mockResolvedValue([
      { url: JONES, status: 'stored', file: 'the-jones-farm-2024.pdf' },
      { url: SMITH, status: 'unreachable', error: 'could not reach the site' },
    ])
    const w = mount_(withDocuments())
    await w.get('[data-testid="choose-all-documents"]').trigger('click')
    await w.get('[data-testid="pull-documents"]').trigger('click')
    await flushPromises()

    expect(mockedPull).toHaveBeenCalledWith('a', [JONES, SMITH])
    const rows = w.findAll('[data-testid="pull-result"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('the-jones-farm-2024.pdf')
    expect(rows[0].text()).toContain('pulled in')
    expect(rows[1].text()).toContain('could not be reached')
    expect(w.get('[data-testid="ingest-note"]').text()).toMatch(/Pulled in 1 of 2/)
    // The entry reloads so the Files tab shows what landed.
    expect(w.emitted('changed')).toBeTruthy()
    // What worked is unticked; what did not is still ticked for another go.
    const boxes = w.findAll('[data-testid="document-check"]')
    expect((boxes[0].element as HTMLInputElement).checked).toBe(false)
    expect((boxes[1].element as HTMLInputElement).checked).toBe(true)
  })

  it('sends only the ticked one when only one is ticked', async () => {
    mockedPull.mockResolvedValue([{ url: SMITH, status: 'stored', file: 'smith-woodlot.pdf' }])
    const w = mount_(withDocuments())
    await w.findAll('[data-testid="document-check"]')[1].setValue(true)
    await w.get('[data-testid="pull-documents"]').trigger('click')
    await flushPromises()
    expect(mockedPull).toHaveBeenCalledWith('a', [SMITH])
  })

  it('says so plainly when the pull itself failed, and keeps the ticks', async () => {
    mockedPull.mockRejectedValue(new Error('the library is not available right now.'))
    const w = mount_(withDocuments())
    await w.get('[data-testid="choose-all-documents"]').trigger('click')
    await w.get('[data-testid="pull-documents"]').trigger('click')
    await flushPromises()

    const note = w.get('[data-testid="ingest-note"]')
    expect(note.text()).toBe('the library is not available right now.')
    expect(note.classes()).toContain('error')
    expect(w.findAll('[data-testid="document-check"]').every(b => (b.element as HTMLInputElement).checked)).toBe(true)
    expect(w.emitted('changed')).toBeFalsy()
  })
})
