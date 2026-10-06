import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  API_URL: 'http://api.test',
}))

vi.mock('../libraryCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../libraryCatalog')>()
  return { ...actual, fileCatalogEntry: vi.fn(), invalidateCatalogCache: vi.fn() }
})

import { internalFetch } from '../apiBase'
import { fileCatalogEntry } from '../libraryCatalog'
import {
  BULK_MAX_FILES,
  acceptFiling,
  annotateAgain,
  checkBulkFiles,
  estimateCents,
  fetchBulkStatus,
  filingFrom,
  folderNameOf,
  formatCents,
  hasProposal,
  startBulkDrop,
  type BulkRow,
} from '../bulkDrop'

/** P6-8: the browser half of "many documents at once". */

const mockedFetch = vi.mocked(internalFetch)
const mockedFile = vi.mocked(fileCatalogEntry)

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}
function bad(status: number, body?: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => {
      if (body === undefined) throw new Error('not json')
      return body
    },
  } as unknown as Response
}

/** A File of a given size without allocating one. */
function file(name: string, size = 10, relativePath?: string): File {
  const f = new File(['x'], name)
  Object.defineProperty(f, 'size', { value: size })
  if (relativePath) Object.defineProperty(f, 'webkitRelativePath', { value: relativePath })
  return f
}

beforeEach(() => {
  mockedFetch.mockReset()
  mockedFile.mockReset()
})

describe('what a drop will cost', () => {
  it('is a cent a file, hedged', () => {
    expect(estimateCents(12)).toBe(12)
    expect(formatCents(12)).toBe('about 12¢')
    expect(formatCents(0)).toBe('about 0¢')
    expect(formatCents(150)).toBe('about $1.50')
  })
})

describe('what may be dropped', () => {
  it('refuses an empty selection', () => {
    expect(checkBulkFiles([])).toBe('Choose a folder or some files first.')
  })

  it('refuses more files than the cap, before anything is uploaded', () => {
    const many = Array.from({ length: BULK_MAX_FILES + 1 }, (_, i) => file(`f${i}.pdf`))
    expect(checkBulkFiles(many)).toContain(`at most ${BULK_MAX_FILES}`)
  })

  it('refuses one oversize file by name', () => {
    expect(checkBulkFiles([file('huge.zip', 200 * 1024 * 1024)])).toContain('"huge.zip" is too large')
  })

  it('refuses a drop over the whole-drop cap', () => {
    const six = Array.from({ length: 6 }, (_, i) => file(`f${i}.pdf`, 90 * 1024 * 1024))
    expect(checkBulkFiles(six)).toContain('in one go')
  })

  it('passes a sane selection', () => {
    expect(checkBulkFiles([file('a.pdf'), file('b.pdf')])).toBeNull()
  })
})

describe('the folder a selection came from', () => {
  it('is read off webkitRelativePath, which never leaves the page', () => {
    expect(folderNameOf([file('a.pdf', 10, 'tele-profiles/a.pdf')])).toBe('tele-profiles')
    expect(folderNameOf([file('a.pdf')])).toBe('')
  })
})

describe('starting a drop', () => {
  it('posts every file, and the collection choice with it', async () => {
    mockedFetch.mockResolvedValue(ok({ dropId: 'd1', rows: [], counts: {}, running: true }))
    await startBulkDrop([file('a.pdf'), file('b.pdf')], { collection: true, collectionTitle: ' Profiles ' })

    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/library/bulk')
    expect(init?.method).toBe('POST')
    const form = init?.body as FormData
    expect(form.getAll('files')).toHaveLength(2)
    expect(form.get('collection')).toBe('1')
    expect(form.get('collectionTitle')).toBe('Profiles')
  })

  it('leaves the collection fields out when it is one entry per file', async () => {
    mockedFetch.mockResolvedValue(ok({ dropId: 'd1', rows: [] }))
    await startBulkDrop([file('a.pdf')])
    const form = (mockedFetch.mock.calls[0][1]?.body ?? null) as FormData
    expect(form.get('collection')).toBeNull()
    expect(form.get('collectionTitle')).toBeNull()
  })

  it('refuses a hopeless drop without asking the server', async () => {
    await expect(startBulkDrop([])).rejects.toThrow('Choose a folder or some files first.')
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('surfaces the server’s own words when it refuses', async () => {
    mockedFetch.mockResolvedValue(bad(413, { error: 'That drop is too large: at most 500 MB in one go.' }))
    await expect(startBulkDrop([file('a.pdf')])).rejects.toThrow('That drop is too large: at most 500 MB in one go.')
  })
})

describe('the status route', () => {
  it('reads one drop back', async () => {
    mockedFetch.mockResolvedValue(ok({ dropId: 'd1', rows: [], running: false, spentCents: 3 }))
    const status = await fetchBulkStatus('d 1')
    expect(status.spentCents).toBe(3)
    expect(mockedFetch.mock.calls[0][0]).toBe('/api/library/bulk/d%201')
  })
})

describe('look again', () => {
  it('posts to the entry’s own annotate route', async () => {
    mockedFetch.mockResolvedValue(ok({ slug: 'x', state: 'queued' }))
    await annotateAgain('a slug')
    expect(mockedFetch.mock.calls[0][0]).toBe('/api/library/entries/a%20slug/annotate')
    expect(mockedFetch.mock.calls[0][1]?.method).toBe('POST')
  })

  it('says what went wrong when it cannot start', async () => {
    mockedFetch.mockResolvedValue(bad(503, { error: "We've hit today's usage cap. Please try again tomorrow." }))
    await expect(annotateAgain('x')).rejects.toThrow("We've hit today's usage cap. Please try again tomorrow.")
  })
})

describe('a proposal', () => {
  const row = (suggested: BulkRow['suggested']): BulkRow =>
    ({ slug: 's', file: 'a.pdf', state: 'suggested', title: 'a', costCents: 1, suggested }) as BulkRow

  it('counts only when there is something in it', () => {
    expect(hasProposal(row({ title: 'A title' }))).toBe(true)
    expect(hasProposal(row({ error: 'unavailable', reason: 'refused' }))).toBe(false)
    expect(hasProposal(row(undefined))).toBe(false)
    expect(hasProposal(row({ at: 'now', model: 'm' }))).toBe(false)
  })

  it('becomes the filing form’s starting values', () => {
    expect(filingFrom({ title: 'T', summary: 'S', category: 'land', tags: ['a', 'b'] })).toEqual({
      title: 'T',
      category: 'land',
      tags: 'a, b',
      description: 'S',
    })
    expect(filingFrom(undefined)).toEqual({ title: '', category: '', tags: '', description: '' })
  })

  it('carries the proposed organization and shape (P6-8a), and nothing when the proposal had none', () => {
    expect(filingFrom({ title: 'T', organization: 'regrid', shape: 'areas' })).toEqual({
      title: 'T',
      category: '',
      tags: '',
      description: '',
      organization: 'regrid',
      shape: 'areas',
    })
    expect(filingFrom({ title: 'T', organization: '', shape: '' })).toStrictEqual({
      title: 'T',
      category: '',
      tags: '',
      description: '',
    })
  })
})

describe('accepting', () => {
  it('is the ordinary filing call — nothing here writes its own way', async () => {
    mockedFile.mockResolvedValue({ slug: 's' } as never)
    await acceptFiling('s', { title: ' A title ', category: 'land', tags: 'a, b , ', description: ' S ' })
    expect(mockedFile).toHaveBeenCalledWith('s', {
      title: 'A title',
      category: 'land',
      tags: ['a', 'b'],
      description: 'S',
    })
  })

  it('leaves the title alone when the person emptied it', async () => {
    mockedFile.mockResolvedValue({ slug: 's' } as never)
    await acceptFiling('s', { title: '   ', category: '', tags: '', description: '' })
    expect(mockedFile).toHaveBeenCalledWith('s', { category: '', tags: [], description: '' })
  })

  it('sends the organization and shape the person accepted, and omits them when unset (P6-8a)', async () => {
    mockedFile.mockResolvedValue({ slug: 's' } as never)
    await acceptFiling('s', { title: 'T', category: 'land', tags: '', description: '', organization: 'regrid', shape: 'areas' })
    expect(mockedFile).toHaveBeenLastCalledWith('s', {
      title: 'T',
      category: 'land',
      tags: [],
      description: '',
      organization: 'regrid',
      shape: 'areas',
    })
    await acceptFiling('s', { title: 'T', category: 'land', tags: '', description: '', organization: '', shape: '' })
    expect(mockedFile).toHaveBeenLastCalledWith('s', { title: 'T', category: 'land', tags: [], description: '' })
  })
})
