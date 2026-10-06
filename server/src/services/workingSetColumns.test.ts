import { describe, it, expect } from 'vitest'

/**
 * A working set's derived columns, as read (P7-2).
 *
 * Pure, like the shape it checks. What this file is judged on is the one
 * constraint that is not negotiable — **a derived column is keyed on the
 * county GEOID, because that is the only key both interfaces can read** — and
 * the rule that follows from it: a value under any other key is dropped, and a
 * column left with nothing is still listed with a count of 0 rather than
 * quietly disappearing.
 */

const {
  DERIVED_COLUMNS_MAX,
  derivedColumnKey,
  derivedKeyAsGeoId,
  readDerivedColumns,
  readDerivedValues,
  analysisKeyOf,
  resolveDerivedColumn,
  rerunOf,
} = await import('./workingSetColumns.js')

describe('readDerivedColumns', () => {
  it('reads a column P7-5 would write, in the manifest’s own order', () => {
    const columns = readDerivedColumns([
      {
        id: 'transmission-miles',
        label: 'Miles to nearest transmission line',
        unit: 'miles',
        method: 'Nearest point on EPRI transmission lines, 2024',
        computedAt: '2026-10-05T09:00:00.000Z',
        values: { '47157': 1.4 },
      },
      { id: 'brownfields-5mi', label: 'Brownfields within 5 miles', unit: 'count' },
    ])
    expect(columns.map(c => c.id)).toEqual(['transmission-miles', 'brownfields-5mi'])
    expect(columns[0].label).toBe('Miles to nearest transmission line')
    expect(columns[0].method).toBe('Nearest point on EPRI transmission lines, 2024')
  })

  it('is tolerant: a hand-edited manifest keeps opening', () => {
    expect(readDerivedColumns(undefined)).toEqual([])
    expect(readDerivedColumns('derived')).toEqual([])
    expect(readDerivedColumns([null, 42, 'x', []])).toEqual([])
    // No id means nothing can name it — not a URL, not a map.
    expect(readDerivedColumns([{ label: 'Nameless' }])).toEqual([])
    expect(readDerivedColumns([{ id: 'Not A Column!' }])).toEqual([])
  })

  it('falls back to the id when nobody labelled the column', () => {
    expect(readDerivedColumns([{ id: 'transmission-miles' }])[0].label).toBe('transmission-miles')
  })

  it('drops a duplicate id, because two columns under one name is how a table and a map come to disagree', () => {
    const columns = readDerivedColumns([
      { id: 'dist', label: 'First', values: { '47157': 1 } },
      { id: 'dist', label: 'Second', values: { '47157': 9 } },
    ])
    expect(columns).toHaveLength(1)
    expect(columns[0].label).toBe('First')
  })

  it('caps a runaway manifest', () => {
    const many = Array.from({ length: DERIVED_COLUMNS_MAX + 6 }, (_, i) => ({ id: `c${i}` }))
    expect(readDerivedColumns(many)).toHaveLength(DERIVED_COLUMNS_MAX)
  })
})

describe('readDerivedValues', () => {
  it('keys on the county GEOID, forgiving the two ways a spreadsheet mangles one', () => {
    expect(readDerivedValues({ '47157': 1.4, '1001': 2, '01001.0': 3, '28033': '4.5' })).toEqual({
      '47157': 1.4,
      '01001': 3,
      '28033': 4.5,
    })
  })

  it('drops a key that is not a county — the map draws counties, so nothing else can be joined', () => {
    expect(readDerivedValues({ '47157001100': 1, '38103': 2, 'site-14': 3, TN: 4 })).toEqual({ '38103': 2 })
  })

  it('drops a non-number rather than drawing one: null means “not computed here”', () => {
    expect(readDerivedValues({ '47157': null, '28033': 'n/a', '38103': Number.NaN, '13121': 0 })).toEqual({
      '13121': 0,
    })
  })

  it('reads nothing out of nothing', () => {
    expect(readDerivedValues(undefined)).toEqual({})
    expect(readDerivedValues([1, 2])).toEqual({})
    expect(readDerivedValues('47157')).toEqual({})
  })
})

describe('derivedKeyAsGeoId', () => {
  it('is the same rule the browser’s join uses', () => {
    expect(derivedKeyAsGeoId('47157')).toBe('47157')
    expect(derivedKeyAsGeoId(' 1001 ')).toBe('01001')
    expect(derivedKeyAsGeoId('01001.00')).toBe('01001')
    expect(derivedKeyAsGeoId('471570001')).toBeNull()
  })
})

describe('resolveDerivedColumn', () => {
  it('says how many counties carry a number, so an empty column reads as empty', () => {
    const column = resolveDerivedColumn({ id: 'dist', label: 'Distance' }, {}, 'manifest')
    expect(column.rows).toBe(0)
    expect(column.label).toBe('Distance')
    expect(column.unit).toBe('')
    expect(column.storedAt).toBe('manifest')
  })

  it('lands a file-backed column in exactly the shape an inline one lands in', () => {
    const doc = { id: 'dist', label: 'Distance', unit: 'miles', file: 'derived/dist.json' }
    const inline = resolveDerivedColumn(doc, { '47157': 1.4 }, 'manifest')
    const filed = resolveDerivedColumn(doc, { '47157': 1.4 }, 'library/working-sets/s/derived/dist.json')
    expect({ ...inline, storedAt: '' }).toEqual({ ...filed, storedAt: '' })
  })
})

describe('derivedColumnKey', () => {
  it('resolves a file beside the set’s own manifest', () => {
    expect(derivedColumnKey('memphis', 'derived/dist.json')).toBe(
      'library/working-sets/memphis/derived/dist.json',
    )
  })

  it('refuses to leave the set’s directory — a column must not serve somebody else’s document', () => {
    expect(derivedColumnKey('memphis', '../../documents/the-workbook/book.txt')).toBeNull()
    expect(derivedColumnKey('memphis', '/etc/passwd')).toBeNull()
    expect(derivedColumnKey('memphis', 'derived//dist.json')).toBeNull()
    expect(derivedColumnKey('memphis', '')).toBeNull()
  })
})

// --- P7-8: rerunOf, widened past proximity -----------------------------------

describe('rerunOf', () => {
  const PROXIMITY = {
    type: 'proximity',
    from: 'redevelopment-sites',
    to: 'internal-transmission',
    within: 10,
    at: '2026-10-06T05:59:03.647Z',
  }
  const COMPOSITE = {
    type: 'composite',
    terms: [
      { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
      { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' },
    ],
    at: '2026-10-06T06:00:00.000Z',
  }

  it('reads a proximity record exactly as P7-6 did', () => {
    expect(rerunOf(PROXIMITY)).toEqual({
      type: 'proximity',
      from: 'redevelopment-sites',
      to: 'internal-transmission',
      within: 10,
    })
    // No radius and a radius stay two different questions.
    expect(rerunOf({ ...PROXIMITY, within: undefined })).toMatchObject({ within: null })
  })

  it('reads a composite record as its formula', () => {
    expect(rerunOf(COMPOSITE)).toEqual({ type: 'composite', terms: COMPOSITE.terms })
  })

  it('offers nothing for a formula that is not one, rather than guessing', () => {
    // A button that cannot say what it would re-run is worse than no button.
    expect(rerunOf({ ...COMPOSITE, terms: [COMPOSITE.terms[0]] })).toBeNull()
    expect(rerunOf({ ...COMPOSITE, terms: 'internal-votes,poverty_by_race' })).toBeNull()
    // A missing direction is NOT defaulted: the writer refuses to guess one,
    // so the reader must not invent one either.
    expect(rerunOf({ ...COMPOSITE, terms: [{ layer: 'a', weight: 1 }, COMPOSITE.terms[1]] })).toBeNull()
    expect(rerunOf({ ...COMPOSITE, terms: [{ layer: 'a', weight: 0, direction: 'higher_better' }, COMPOSITE.terms[1]] })).toBeNull()
    expect(rerunOf({ ...COMPOSITE, terms: [{ layer: '', weight: 1, direction: 'higher_better' }, COMPOSITE.terms[1]] })).toBeNull()
    expect(rerunOf(undefined)).toBeNull()
  })
})

describe('analysisKeyOf', () => {
  it('makes a proximity run’s two columns one freshness check', () => {
    const analysis = { type: 'proximity', from: 'a', to: 'internal-b', within: 5, at: 'T' }
    expect(analysisKeyOf(analysis)).toBe(analysisKeyOf({ ...analysis }))
    expect(analysisKeyOf(analysis)).not.toBe(analysisKeyOf({ ...analysis, within: 10 }))
  })

  it('keeps two indices written in the same millisecond apart', () => {
    // The P7-6 spelling was `at|from|to`, and a composite has neither — so
    // every index sharing a timestamp collapsed onto one key and took the
    // first one's verdict.
    const one = { type: 'composite', at: 'T', terms: [{ layer: 'a', weight: 1, direction: 'higher_better' }, { layer: 'b', weight: 1, direction: 'higher_better' }] }
    const two = { type: 'composite', at: 'T', terms: [{ layer: 'a', weight: 1, direction: 'higher_better' }, { layer: 'c', weight: 1, direction: 'higher_better' }] }
    expect(analysisKeyOf(one)).not.toBe(analysisKeyOf(two))
  })

  it('is empty when there is nothing stable to key on, so nothing is deduped by accident', () => {
    expect(analysisKeyOf(undefined)).toBe('')
    expect(analysisKeyOf({ type: 'composite', terms: [] })).toBe('')
    expect(analysisKeyOf({ type: 'proximity', from: 'a', to: 'b' })).toBe('')
  })
})

describe('a column that is a layer (P7-8)', () => {
  const composite = {
    id: 'political-efficacy',
    label: 'Political efficacy',
    unit: 'index',
    analysis: {
      type: 'composite',
      terms: [
        { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
        { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' },
      ],
      at: 'T',
    },
  }

  it('names the layer it draws as, when the set is known', () => {
    expect(resolveDerivedColumn(composite, { '47157': 61 }, 'manifest', undefined, 'efficacy').layerId).toBe(
      'internal-efficacy~political-efficacy',
    )
  })

  it('claims no layer when the caller cannot name the set', () => {
    expect(resolveDerivedColumn(composite, {}, 'manifest').layerId).toBe('')
  })

  it('claims no layer for a measurement, because nothing says which end is good', () => {
    const proximity = {
      id: 'miles-to-transmission',
      unit: 'miles',
      analysis: { type: 'proximity', from: 'a', to: 'internal-b', within: null, at: 'T' },
    }
    expect(resolveDerivedColumn(proximity, { '47157': 1.2 }, 'manifest', undefined, 'efficacy').layerId).toBe('')
  })
})
