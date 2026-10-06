/**
 * When a dataset is FROM (P7-10) — the grammar, and the derivation.
 *
 * `coverage.ts`'s sibling: a closed grammar, a pure derivation with the one
 * file read injected, never throws, and never answers when it does not know.
 * The client's copy of the GRAMMAR is `src/lib/dataDates.ts` and its header
 * carries the reasoning; `dataDates.test.ts` reads that file and fails when
 * the two drift, the same contract the field table has — and for a sharper
 * reason here, because the model writes a date on this side and the map LEGEND
 * reads it on that one.
 *
 * ## Three dates, because they conflate badly
 *
 * | | what it means | mechanism |
 * | --- | --- | --- |
 * | `covers` | the period the data DESCRIBES | **derived** (the layer block's year, or the table's own year column), else **inferred** off the source page |
 * | `published` | when the publisher put it out | **inferred** only — a release date is not in the bytes |
 * | `fetched` | when WE pulled it | **derived**, from our own fetch record. Never `updatedAt` |
 *
 * `updatedAt` says when the bytes last moved, so re-pushing a 2019 file makes
 * it look like 2026 data. There is deliberately nothing in here that reads it.
 *
 * ## Why the read order is what it is
 *
 * The manifest is asked first and the held table last, exactly as
 * `deriveCoverage` does it: a stated `dates:` block is a person's statement
 * about the whole thing, a layer block's `year` is the author's declared
 * vintage, and a table's year column is a fact about the rows that happen to
 * be in the file — which is the weakest witness of the three and the only one
 * that costs a download.
 */
import { extensionOf, isShapedKind, pickCoverageFile, splitRow } from './coverage.js'

export interface DataDates {
  covers?: string
  published?: string
  fetched?: string
}

export interface ResolvedDates {
  covers: string
  published: string
  fetched: string
}

export const DATE_FIELDS = ['covers', 'published', 'fetched'] as const
export type DateField = (typeof DATE_FIELDS)[number]

export function isDateField(field: string): field is DateField {
  return (DATE_FIELDS as readonly string[]).includes(field)
}

/* --- the grammar (mirrored from src/lib/dataDates.ts) --------------------- */

const MIN_YEAR = 1790
const MAX_YEAR = 2200

/** For READING a month in words. The server never writes one: the labels a
 *  person sees are the client's (`src/lib/dataDates.ts`), because nothing here
 *  renders prose for a reader. */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const PART = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/

function partOk(part: string): boolean {
  const m = PART.exec(part)
  if (!m) return false
  const year = Number(m[1])
  if (year < MIN_YEAR || year > MAX_YEAR) return false
  if (m[2] !== undefined) {
    const month = Number(m[2])
    if (month < 1 || month > 12) return false
  }
  if (m[3] !== undefined) {
    const day = Number(m[3])
    if (day < 1 || day > 31) return false
  }
  return true
}

function padPart(part: string): string {
  const m = PART.exec(part)
  if (!m) return ''
  return `${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}`
}

/** Is this already a canonical stamp? */
export function isDataDate(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false
  const sides = value.split('/')
  if (sides.length === 1) return partOk(value)
  if (sides.length !== 2) return false
  if (!partOk(sides[0]) || !partOk(sides[1])) return false
  return padPart(sides[0]) <= padPart(sides[1])
}

const MONTH_PREFIXES = MONTHS.map(name => name.slice(0, 3).toLowerCase())

function monthFromName(word: string): string {
  const key = word.replace(/\.$/, '').slice(0, 3).toLowerCase()
  const index = MONTH_PREFIXES.indexOf(key)
  if (index < 0) return ''
  return String(index + 1).padStart(2, '0')
}

function readPart(raw: string): string {
  const text = raw.trim()
  if (!text) return ''

  const numeric = /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/.exec(text)
  if (numeric) {
    const part = `${numeric[1]}-${numeric[2].padStart(2, '0')}${numeric[3] ? `-${numeric[3].padStart(2, '0')}` : ''}`
    return partOk(part) ? part : ''
  }
  if (/^\d{4}$/.test(text)) return partOk(text) ? text : ''

  const named = /^([A-Za-z]{3,9}\.?)\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/.exec(text)
  if (named) {
    const month = monthFromName(named[1])
    if (!month) return ''
    const part = `${named[3]}-${month}${named[2] ? `-${named[2].padStart(2, '0')}` : ''}`
    return partOk(part) ? part : ''
  }

  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9}\.?),?\s+(\d{4})$/.exec(text)
  if (dayFirst) {
    const month = monthFromName(dayFirst[2])
    if (!month) return ''
    const part = `${dayFirst[3]}-${month}-${dayFirst[1].padStart(2, '0')}`
    return partOk(part) ? part : ''
  }

  return ''
}

/**
 * Sentinels that are not dates, however much they look like one.
 *
 * Field evidence, 2026-10-06, from four federal layers downloaded while this
 * ticket was being built: HIFLD uses `-999999` for an unknown numeric, and
 * ArcGIS exports an unknown DATE as epoch 0 or as one of the spreadsheet zero
 * days. A sentinel read as a real value would put "Data from 1899" on a
 * legend, which is worse than saying nothing — P6-19's rule, found again in
 * the wild.
 *
 * Only DAY-precision values are refused. `1900` on its own is a perfectly good
 * vintage for a census table, and refusing it would be the opposite mistake.
 */
const SENTINEL_DAYS = new Set(['1899-12-30', '1899-12-31', '1900-01-01', '1970-01-01'])

/**
 * Epoch integers, which is how a date arrives from an ArcGIS service.
 *
 * Field evidence: `f=geojson` on HIFLD's transmission lines returns
 * `SOURCEDATE` and `VAL_DATE` as epoch MILLISECONDS, while other export paths
 * on the same service give ISO text — so a parser that took only the text
 * spellings would silently drop a date that exists upstream, which is the
 * worst of the failure modes available here.
 *
 * The ranges are chosen so a four-digit YEAR can never be mistaken for an
 * epoch and vice versa: a year is 1790-2200, seconds from 1e8 (1973) up, and
 * milliseconds from 1e11 (1973) up. Epoch 0 and anything negative fall outside
 * all three and read as nothing, which is also what the sentinel above wants.
 */
const EPOCH_SECONDS_MIN = 1e8
const EPOCH_MILLIS_MIN = 1e11

function fromEpoch(value: number): string {
  const millis = value >= EPOCH_MILLIS_MIN ? value : value >= EPOCH_SECONDS_MIN ? value * 1000 : NaN
  if (!Number.isFinite(millis)) return ''
  // `toISOString` is always UTC, so this is the one place a `Date` is safe:
  // the calendar day it yields does not depend on where the reader is.
  const iso = new Date(millis).toISOString().slice(0, 10)
  return SENTINEL_DAYS.has(iso) || !partOk(iso) ? '' : iso
}

/**
 * Accept generously, store canonically. Anything unreadable answers `''`
 * rather than a guess — a cadence ("every five years") is not a date, and
 * `updateCadence` keeps its own meaning for exactly that reason.
 */
export function normalizeDataDate(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    if (Number.isInteger(value) && value >= MIN_YEAR && value <= MAX_YEAR) return String(value)
    return fromEpoch(value)
  }
  if (typeof value !== 'string') return ''

  let text = value.trim().replace(/[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '')
  if (!text) return ''

  text = text
    .replace(/\s*[–—]\s*/g, '|')
    .replace(/\s+to\s+/gi, '|')
    .replace(/\s+-\s+/g, '|')
    .replace(/^(\d{4})-(\d{4})$/, '$1|$2')
    .replace(/\s*\/\s*(?=[A-Za-z])/g, '|')

  if (text.includes('|')) {
    const sides = text.split('|')
    if (sides.length !== 2) return ''
    const from = readPart(sides[0])
    const to = readPart(sides[1])
    if (!from || !to) return ''
    const stamp = `${from}/${to}`
    return isDataDate(stamp) ? stamp : ''
  }

  if (/^[\d-]+\/[\d-]+$/.test(text)) {
    const sides = text.split('/')
    if (sides.length === 2) {
      const from = readPart(sides[0])
      const to = readPart(sides[1])
      const stamp = from && to ? `${from}/${to}` : ''
      if (stamp && isDataDate(stamp)) return stamp
    }
  }

  // The same field, exported the other way: a service that hands back epoch
  // millis as TEXT must not read as nothing when the integer reads as a date.
  if (/^-?\d{9,}$/.test(text)) return fromEpoch(Number(text))

  const part = readPart(text)
  if (!part || !isDataDate(part)) return ''
  return SENTINEL_DAYS.has(part) ? '' : part
}

/* --- the derivation ------------------------------------------------------- */

export interface DatesInput {
  kind: string
  meta: Record<string, unknown> | undefined | null
  /** Basenames inside the entry folder ("sites.csv"), not bucket keys. */
  files?: string[]
  slug?: string
}

export type DatesFileReader = (fileName: string) => Promise<string | null>

/** Where each answer came from, in a phrase — so a reading can be checked
 *  without re-running the derivation that produced it. */
export type DatesEvidence = Partial<Record<DateField, string>>

export interface DatesReading {
  dates: DataDates
  from: DatesEvidence
}

function block(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * A person's own `dates:` block, normalised. Wins over everything, as
 * everywhere else.
 *
 * A value nobody can read is DROPPED with one warning, exactly as an unusable
 * `shape:` or `coverage:` is (P6-2, P6-19): a typo in a manifest must not
 * become a date on the map, and it must not be invisible either.
 */
function stated(meta: Record<string, unknown>, slug?: string): ResolvedDates {
  const dates = block(meta.dates)
  const out = { covers: '', published: '', fetched: '' } as ResolvedDates
  for (const field of DATE_FIELDS) {
    const raw = dates[field]
    const value = normalizeDataDate(raw)
    if (!value && raw !== undefined && raw !== null && raw !== '') {
      console.warn(`[library] dates.${field} "${String(raw)}" on "${slug ?? ''}" is not a date I can read — ignoring it.`)
    }
    out[field] = value
  }
  return out
}

/**
 * When we pulled it, from the records we already keep.
 *
 * Three real records in the live library, in order of how specific they are
 * about the DATA rather than about the entry: a replicated dataset's lineage,
 * a dropped link's own fetch, and the newest slice of a source's API. A
 * `fetch` record that did not fetch — queued, failed, later — says nothing
 * about when we hold bytes from.
 */
function fetchedFromRecords(meta: Record<string, unknown>): { value: string; from: string } {
  const lineage = block(meta.lineage)
  const fromLineage = normalizeDataDate(lineage.fetchedAt)
  if (fromLineage) return { value: fromLineage, from: '`lineage.fetchedAt` — when we copied it' }

  const fetch = block(meta.fetch)
  if (fetch.status === 'fetched') {
    const at = normalizeDataDate(fetch.at)
    if (at) return { value: at, from: '`fetch.at` — when the link’s file came down' }
  }

  const slices = block(block(meta.source).replication).slices
  if (Array.isArray(slices)) {
    let newest = ''
    for (const slice of slices) {
      const at = normalizeDataDate(block(slice).fetchedAt)
      if (at > newest) newest = at
    }
    if (newest) return { value: newest, from: 'the newest `source.replication` slice' }
  }
  return { value: '', from: '' }
}

const YEAR_COLUMNS = new Set(['year', 'datayear', 'surveyyear', 'referenceyear', 'vintage'])

function columnKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '')
}

/**
 * The period a held table declares about ITSELF.
 *
 * The allowlist is the whole defence and it is deliberately exact: a column
 * merely CONTAINING "year" is usually a fact about each row — `year_built` is
 * about a house, `years_in_operation` about a business — and a derivation that
 * read one would declare a housing table to be "about 1890-2015". One
 * unreadable value refuses the whole column, because a column that is half
 * years and half prose is not a declaration of anything (P6-19's rule:
 * inventing an answer is worse than declining to name one).
 */
export function readYearColumn(fileName: string, text: string): string {
  const values = yearColumnValues(fileName, text)
  if (!values) return ''
  const years: number[] = []
  for (const raw of values) {
    const value = String(raw).trim()
    if (!value) continue
    if (!/^\d{4}$/.test(value)) return ''
    const year = Number(value)
    if (year < MIN_YEAR || year > MAX_YEAR) return ''
    years.push(year)
  }
  if (!years.length) return ''
  const from = Math.min(...years)
  const to = Math.max(...years)
  return from === to ? String(from) : `${from}/${to}`
}

/** Every value of the first allowlisted year column, or null when there is
 *  no such column. (Null and [] are different answers: no column at all, as
 *  against a column with nothing in it.) */
function yearColumnValues(fileName: string, text: string): unknown[] | null {
  const ext = extensionOf(fileName)
  if (ext === 'json' || ext === 'geojson') return jsonYearValues(text)
  const delimiter = ext === 'tsv' ? '\t' : ','
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const header = splitRow(lines[0] ?? '', delimiter).map(cell => cell.replace(/^"(.*)"$/s, '$1').trim())
  const index = header.findIndex(column => YEAR_COLUMNS.has(columnKey(column)))
  if (index === -1) return null
  const out: unknown[] = []
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue
    out.push(splitRow(lines[i], delimiter)[index] ?? '')
  }
  return out
}

function jsonYearValues(text: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const rows: Record<string, unknown>[] = []
  if (Array.isArray(parsed)) {
    for (const row of parsed) if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row as Record<string, unknown>)
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { features?: unknown }).features)) {
    for (const feature of (parsed as { features: unknown[] }).features) {
      const properties = block(block(feature).properties)
      if (Object.keys(properties).length) rows.push(properties)
    }
  }
  if (!rows.length) return null
  const key = Object.keys(rows[0]).find(column => YEAR_COLUMNS.has(columnKey(column)))
  if (!key) return null
  return rows.map(row => row[key])
}

/**
 * Everything the manifest alone can answer — no file read, so it is the same
 * fold `storedCoverage` and `storedOrganization` do on the spot at read time.
 * Only the held table's own year column needs the reindex, because only it
 * needs the file.
 */
export function readDatesFromManifest(input: DatesInput): DatesReading {
  if (!isShapedKind(input.kind)) return { dates: {}, from: {} }
  const meta = input.meta ?? {}
  const hand = stated(meta, input.slug)
  const dates: DataDates = {}
  const from: DatesEvidence = {}

  if (hand.covers) {
    dates.covers = hand.covers
    from.covers = 'the manifest’s `dates:` block'
  } else {
    const year = normalizeDataDate(block(meta.layer).year)
    if (year) {
      dates.covers = year
      from.covers = 'the layer block’s `year`'
    }
  }

  // Nothing derives a release date. Stated or inferred, never worked out.
  if (hand.published) {
    dates.published = hand.published
    from.published = 'the manifest’s `dates:` block'
  }

  if (hand.fetched) {
    dates.fetched = hand.fetched
    from.fetched = 'the manifest’s `dates:` block'
  } else {
    const record = fetchedFromRecords(meta)
    if (record.value) {
      dates.fetched = record.value
      from.fetched = record.from
    }
  }
  return { dates, from }
}

/** The manifest-only fold, as three plain strings — what `fieldValueOf` asks. */
export function datesFromManifest(input: DatesInput): ResolvedDates {
  const { dates } = readDatesFromManifest(input)
  return { covers: dates.covers ?? '', published: dates.published ?? '', fetched: dates.fetched ?? '' }
}

/**
 * The full derivation, reading the entry's table when the manifest cannot say.
 *
 * Never throws: a file that will not download or will not parse leaves the
 * entry with no `covers`, which is the honest answer and the one that puts it
 * on the needs-a-look row.
 */
export async function deriveDates(input: DatesInput, readFile?: DatesFileReader): Promise<DataDates> {
  return (await readDates(input, readFile)).dates
}

/** The same derivation, with the phrase naming what each answer was read off. */
export async function readDates(input: DatesInput, readFile?: DatesFileReader): Promise<DatesReading> {
  const reading = readDatesFromManifest(input)
  if (!isShapedKind(input.kind) || reading.dates.covers) return reading
  const file = pickCoverageFile(input.files)
  if (!file || !readFile) return reading
  let text: string | null = null
  try {
    text = await readFile(file)
  } catch (err: any) {
    console.warn(`[library] could not read "${file}" to work out when "${input.slug ?? ''}" is from: ${err?.message || err}`)
  }
  if (text === null) return reading
  const covers = readYearColumn(file, text)
  if (!covers) return reading
  return {
    dates: { ...reading.dates, covers },
    from: { ...reading.from, covers: `${file} (its \`year\` column)` },
  }
}
