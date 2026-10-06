import { describe, it, expect } from 'vitest'
import {
  coversLabel,
  dataDateLabel,
  isDataDate,
  isPeriod,
  layerDatesOf,
  normalizeDataDate,
  publishedLabel,
} from '../dataDates'

/**
 * P7-10: the grammar for a date ABOUT THE DATA.
 *
 * The server mirrors this file at `server/src/services/dataDates.ts` and
 * `dataDates.test.ts` there fails when the two grammars drift — the same
 * contract the field table has.
 */
describe('the stored grammar', () => {
  it('takes a year, a month, a day and an interval of any two of them', () => {
    expect(isDataDate('2023')).toBe(true)
    expect(isDataDate('2026-10')).toBe(true)
    expect(isDataDate('2026-10-05')).toBe(true)
    expect(isDataDate('2019/2023')).toBe(true)
    expect(isDataDate('2019-01/2023-12')).toBe(true)
    expect(isDataDate('2019-01-01/2023-12-31')).toBe(true)
  })

  it('refuses anything else rather than guessing at it', () => {
    // A reading nobody can trust is worse than the queue row (P6-19's rule,
    // which is why `2013 to 2023, all 50 states` reads as no coverage).
    expect(isDataDate('')).toBe(false)
    expect(isDataDate('recent')).toBe(false)
    expect(isDataDate('2019-2023')).toBe(false) // normalise first; `-` is a month separator
    expect(isDataDate('26-10')).toBe(false)
    expect(isDataDate('2026-13')).toBe(false)
    expect(isDataDate('2026-10-32')).toBe(false)
    expect(isDataDate('1492')).toBe(false) // outside the plausible window
    expect(isDataDate('2023/2019')).toBe(false) // an interval that runs backwards
    expect(isDataDate('2019/2020/2021')).toBe(false)
  })

  it('is sortable as a plain string, which is the reason for the shape', () => {
    const stamps = ['2026-10', '2019/2023', '2019', '2023-04-01']
    expect([...stamps].sort()).toEqual(['2019', '2019/2023', '2023-04-01', '2026-10'])
  })
})

describe('normalising the dozen spellings a date arrives in', () => {
  it('folds the dashes a person or a publisher would type', () => {
    expect(normalizeDataDate('2019-2023')).toBe('2019/2023')
    expect(normalizeDataDate('2019–2023')).toBe('2019/2023') // en dash
    expect(normalizeDataDate('2019—2023')).toBe('2019/2023') // em dash
    expect(normalizeDataDate('2019 to 2023')).toBe('2019/2023')
    expect(normalizeDataDate('2019 - 2023')).toBe('2019/2023')
  })

  it('reads the month and day spellings a page uses', () => {
    expect(normalizeDataDate('October 2026')).toBe('2026-10')
    expect(normalizeDataDate('Oct 2026')).toBe('2026-10')
    expect(normalizeDataDate('March 12, 2024')).toBe('2024-03-12')
    expect(normalizeDataDate('12 March 2024')).toBe('2024-03-12')
    expect(normalizeDataDate('2024/03/12')).toBe('2024-03-12')
  })

  it('drops a time of day, because no dataset is about an hour', () => {
    expect(normalizeDataDate('2026-10-05T18:22:04.000Z')).toBe('2026-10-05')
  })

  it('keeps an already-canonical stamp byte for byte', () => {
    expect(normalizeDataDate('2019/2023')).toBe('2019/2023')
    expect(normalizeDataDate('2023')).toBe('2023')
  })

  it('answers empty for anything it cannot read, and never a guess', () => {
    expect(normalizeDataDate('sometime in the 90s')).toBe('')
    expect(normalizeDataDate('annually')).toBe('')
    expect(normalizeDataDate('')).toBe('')
    expect(normalizeDataDate(undefined)).toBe('')
    // The one that matters: a CADENCE is not a date (`updateCadence` keeps its
    // own meaning — a promise is not a date).
    expect(normalizeDataDate('every five years')).toBe('')
  })

  it('normalises a four-digit year held as a number, which is what a layer block carries', () => {
    expect(normalizeDataDate(2023)).toBe('2023')
  })
})

describe('period versus instant — the grammar decides which reading', () => {
  it('reads a year and an interval as a period', () => {
    expect(isPeriod('2023')).toBe(true)
    expect(isPeriod('2019/2023')).toBe(true)
  })

  it('reads a month or a day as a snapshot', () => {
    expect(isPeriod('2026-10')).toBe(false)
    expect(isPeriod('2026-10-05')).toBe(false)
  })
})

describe('the words a reader sees', () => {
  it('writes an interval with an en dash and a year as itself', () => {
    expect(dataDateLabel('2019/2023')).toBe('2019–2023')
    expect(dataDateLabel('2023')).toBe('2023')
  })

  it('writes a month in words and a day in the house format', () => {
    expect(dataDateLabel('2026-10')).toBe('October 2026')
    expect(dataDateLabel('2024-03-12')).toBe('Mar 12, 2024')
  })

  it('says DATA FROM for a period and AS OF for a snapshot — Nick’s two cases', () => {
    // A research dataset is ABOUT a period; a living inventory is a snapshot
    // taken at a moment. Same field, two readings, and the value says which.
    expect(coversLabel('2019/2023')).toBe('Data from 2019–2023')
    expect(coversLabel('2023')).toBe('Data from 2023')
    expect(coversLabel('2026-10')).toBe('As of October 2026')
  })

  it('never starts with the word a source page already uses for its GROUND', () => {
    // "Covers national · county" is the geography line on a source entry
    // page (P5-56). A date line beside it starting with the same word would
    // read as a contradiction of it.
    expect(coversLabel('2019/2023').startsWith('Covers')).toBe(false)
  })

  it('says PUBLISHED for a release date, which is a different fact', () => {
    expect(publishedLabel('2024-03')).toBe('Published March 2024')
  })

  it('renders nothing at all for a stamp it cannot read', () => {
    expect(dataDateLabel('whenever')).toBe('')
    expect(coversLabel('')).toBe('')
    expect(publishedLabel('nope')).toBe('')
  })
})

describe('layerDatesOf — a layer announces when its data is from', () => {
  it('reads the dates block when the layer carries one', () => {
    expect(layerDatesOf({ dates: { covers: '2019/2023', published: '2024-03' } })).toEqual({
      covers: '2019/2023',
      published: '2024-03',
      fetched: '',
    })
  })

  it("falls back to the layer's declared year, which is what the 26 registry layers carry", () => {
    // The registry has declared a `year` per layer since long before this
    // ticket; a declared vintage IS the period the data describes, so nothing
    // forks and every public layer gets a legend date with no data entry.
    expect(layerDatesOf({ year: 2023 })).toEqual({ covers: '2023', published: '', fetched: '' })
    expect(layerDatesOf({ year: '2019-2023' })).toEqual({ covers: '2019/2023', published: '', fetched: '' })
  })

  it('prefers the block over the year when both are there', () => {
    expect(layerDatesOf({ year: 2023, dates: { covers: '2026-10' } }).covers).toBe('2026-10')
  })

  it('does not fall back to the year for a block that is deliberately silent', () => {
    // A composite index (P7-8) carries a published date and no period: what
    // it describes is its inputs' business. Falling back would have it claim
    // to cover the year somebody pressed the button.
    expect(layerDatesOf({ year: 2026, dates: { published: '2026-03-04' } })).toEqual({
      covers: '',
      published: '2026-03-04',
      fetched: '',
    })
  })

  it('answers empty for a layer that says nothing — an untagged layer is not a defect', () => {
    expect(layerDatesOf({})).toEqual({ covers: '', published: '', fetched: '' })
    expect(layerDatesOf({ year: '' })).toEqual({ covers: '', published: '', fetched: '' })
  })

  it('never reads an updatedAt as a date about the data', () => {
    // `updatedAt` says when WE last wrote the bytes. Re-pushing a 2019 file
    // would make it read as 2026 data, which is the misreading this ticket
    // exists to stop.
    expect(layerDatesOf({ updatedAt: '2026-10-05T00:00:00.000Z' } as never)).toEqual({
      covers: '',
      published: '',
      fetched: '',
    })
  })
})

/**
 * Field evidence, 2026-10-06. Four federal layers downloaded while this ticket
 * was being built, two of which carry exactly the two dates this field pair
 * distinguishes — independently of us:
 *
 * - **HIFLD transmission lines** (94,619 polylines): `SOURCEDATE` and
 *   `VAL_DATE`, beside `VAL_METHOD`. The publisher separates "when the data is
 *   from" from "when it was checked", and records the mechanism — which is
 *   derive-vs-infer provenance, arrived at by somebody else.
 * - **EPA Superfund NPL boundaries** (2,114 polygons):
 *   `ORIGINAL_CREATION_DATE` and `LAST_CHANGE_DATE`. Published and
 *   last-updated, in those words.
 *
 * Both of the parsing notes that came with it are the subject of this block.
 */
describe('dates as federal data actually ships them', () => {
  it('reads an epoch-millisecond integer, which is what an ArcGIS export gives', () => {
    // The failure mode this exists to stop is the quiet one: a date that is
    // there upstream and reads as absent here.
    expect(normalizeDataDate(1710201600000)).toBe('2024-03-12')
    expect(normalizeDataDate(1_767_225_600_000)).toBe('2026-01-01')
  })

  it('reads epoch SECONDS too, because the same service gives either', () => {
    expect(normalizeDataDate(1710201600)).toBe('2024-03-12')
  })

  it('reads an epoch handed over as text, which is the other export path', () => {
    expect(normalizeDataDate('1710201600000')).toBe('2024-03-12')
  })

  it('still reads a four-digit year as a YEAR and never as an epoch', () => {
    // The ranges are chosen so these can never collide: a year is 1790-2200,
    // an epoch starts at 1e8.
    expect(normalizeDataDate(2024)).toBe('2024')
    expect(normalizeDataDate('2024')).toBe('2024')
  })

  it('treats the null-ish sentinels as absent rather than as a date in 1899', () => {
    // HIFLD writes -999999 for an unknown numeric; ArcGIS writes an unknown
    // DATE as epoch 0 or a spreadsheet zero day. Any of them read as a real
    // value would put "Data from 1899" on a legend.
    expect(normalizeDataDate(-999999)).toBe('')
    expect(normalizeDataDate(0)).toBe('')
    expect(normalizeDataDate('1899-12-30')).toBe('')
    expect(normalizeDataDate('1899-12-31')).toBe('')
    expect(normalizeDataDate('1900-01-01')).toBe('')
    expect(normalizeDataDate('1970-01-01')).toBe('')
    expect(normalizeDataDate(-86400000)).toBe('')
  })

  it('keeps a YEAR that happens to be a sentinel year, because that one is real', () => {
    // A census table covering 1900 is a census table covering 1900. Only the
    // day-precision sentinels are refused.
    expect(normalizeDataDate('1900')).toBe('1900')
    expect(normalizeDataDate('1899/1900')).toBe('1899/1900')
  })
})
