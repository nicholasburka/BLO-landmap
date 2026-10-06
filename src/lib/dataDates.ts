/**
 * When a dataset is FROM (P7-10).
 *
 * Nick, 2026-10-05: *"layers — especially those displayed on the map — need
 * either a last updated (in the case of data centers) or published date (in
 * the case of research datasets that track to a particular year or
 * something)."* Those are **two different facts** and this module is the
 * grammar they are stored in:
 *
 * - **`covers`** — the period the data DESCRIBES. ACS 2019-2023 is about
 *   2019-2023 however recently we downloaded it, and being old is not a
 *   defect: it ages into being historical, never into being wrong.
 * - **`published`** — when the publisher last PUT IT OUT. This one ages into
 *   being *stale*, which is a different and worse thing — a list of data
 *   centres last published in 2019 is actively misleading, not merely dated.
 * - **`fetched`** — when WE pulled it. The only one that is about us.
 *
 * A single `date` field would make a 2019 study indistinguishable from a
 * 2019-stale inventory, which is exactly the distinction Nick was pointing at.
 *
 * ## One sortable string per date
 *
 * `YYYY` · `YYYY-MM` · `YYYY-MM-DD` · `A/B` where A and B are each of those —
 * ISO 8601-2's interval spelling, so a period is one value rather than two
 * fields that can disagree. Plain string comparison sorts them, which is why
 * the shape is left-anchored: `2019` < `2019/2023` < `2023-04-01` < `2026-10`.
 *
 * Dates arrive in a dozen spellings, so `normalizeDataDate` **accepts
 * generously and stores canonically**. The source's own spelling is kept where
 * it is worth keeping — in the provenance evidence sentence (P5-61, *the claim
 * travels with its evidence*) — rather than in a second field nothing could
 * check.
 *
 * ## The grammar decides the reading
 *
 * A year or an interval is a **period** ("Covers 2019-2023"); a month or a day
 * is a **snapshot** ("As of October 2026"). That is Nick's own split — a
 * research dataset is about a stretch of time, a living inventory is true as
 * of a moment — read off the value instead of out of a second flag.
 *
 * ## No `Date` object anywhere
 *
 * Deliberate. `new Date('2024-03-12')` is midnight UTC, so
 * `toLocaleDateString()` renders "Mar 11, 2024" anywhere west of Greenwich,
 * and a dataset's vintage must not depend on the reader's timezone. Every
 * function here is pure string work, which also keeps the month names out of
 * `Intl` and the labels identical in every locale.
 *
 * Imports nothing on purpose: `LensLegend.vue` reads this and the legend ships
 * in the PUBLIC map bundle.
 *
 * The server mirrors the grammar half at `server/src/services/dataDates.ts`
 * (which also holds the derivation); `dataDates.test.ts` there reads this file
 * and fails when the two drift — the contract the field table has.
 */

/** The three dates, as stored in a manifest's `dates` block. */
export interface DataDates {
  covers?: string
  published?: string
  fetched?: string
}

/** The same three, resolved for a reader: '' rather than absent, so a caller
 *  can tell "nobody wrote one" from "it is from no particular time". */
export interface ResolvedDates {
  covers: string
  published: string
  fetched: string
}

/**
 * The window a four-digit year has to fall in.
 *
 * 1790 is the first US census; 2200 leaves room for a projection dataset,
 * because `covers` is the period the data DESCRIBES and a sea-level-rise
 * product legitimately describes 2100. The window is not pretending to be a
 * plausibility check on the data — the regex already demands four digits — it
 * is there so `0000` and `1492` read as nothing rather than as a date.
 */
const MIN_YEAR = 1790
const MAX_YEAR = 2200

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

/** One side of an interval, or a whole stamp: strictly canonical. */
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

/** A part padded to a comparable day, so an interval's order can be checked. */
function padPart(part: string): string {
  const m = PART.exec(part)
  if (!m) return ''
  return `${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}`
}

/**
 * Is this already a canonical stamp? The strict half — a value that needs
 * normalising answers `false`, which is what makes `normalizeDataDate` the one
 * door a stored value comes through.
 */
export function isDataDate(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false
  const sides = value.split('/')
  if (sides.length === 1) return partOk(value)
  if (sides.length !== 2) return false
  if (!partOk(sides[0]) || !partOk(sides[1])) return false
  // An interval that runs backwards is a mis-read, not a date.
  return padPart(sides[0]) <= padPart(sides[1])
}

/** A period — a year, or an interval. A month or a day is a snapshot. */
export function isPeriod(value: string): boolean {
  if (!isDataDate(value)) return false
  if (value.includes('/')) return true
  return !value.includes('-')
}

const MONTH_PREFIXES = MONTHS.map(name => name.slice(0, 3).toLowerCase())

function monthFromName(word: string): string {
  const key = word.replace(/\.$/, '').slice(0, 3).toLowerCase()
  const index = MONTH_PREFIXES.indexOf(key)
  if (index < 0) return ''
  return String(index + 1).padStart(2, '0')
}

/** Every spelling of ONE side, folded to a canonical part. '' when unreadable. */
function readPart(raw: string): string {
  const text = raw.trim()
  if (!text) return ''

  // Already canonical, or canonical with 1-digit month/day and `/` separators
  // (`2024/03/12`, `2024-3-9`).
  const numeric = /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/.exec(text)
  if (numeric) {
    const part = `${numeric[1]}-${numeric[2].padStart(2, '0')}${numeric[3] ? `-${numeric[3].padStart(2, '0')}` : ''}`
    return partOk(part) ? part : ''
  }
  if (/^\d{4}$/.test(text)) return partOk(text) ? text : ''

  // "October 2026", "Oct. 2026", "March 12, 2024"
  const named = /^([A-Za-z]{3,9}\.?)\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/.exec(text)
  if (named) {
    const month = monthFromName(named[1])
    if (!month) return ''
    const part = `${named[3]}-${month}${named[2] ? `-${named[2].padStart(2, '0')}` : ''}`
    return partOk(part) ? part : ''
  }

  // "12 March 2024"
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
 * Accept generously, store canonically.
 *
 * Takes a number (a layer block's `year: 2023`), a canonical stamp, or the
 * spellings a publisher's page and a person's manifest actually use — the
 * dashes (`-`, en, em), the word `to`, a month in words either way round, and
 * an ISO instant whose time of day is dropped because no dataset is about an
 * hour. **Anything it cannot read answers `''`** rather than a guess: a
 * cadence ("every five years") is not a date, and the queue row is better than
 * a reading nobody can trust (P6-19's rule, for its reason).
 */
export function normalizeDataDate(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    if (Number.isInteger(value) && value >= MIN_YEAR && value <= MAX_YEAR) return String(value)
    return fromEpoch(value)
  }
  if (typeof value !== 'string') return ''

  // A time of day, on either side. `2026-10-05T18:22:04.000Z` is a fetch
  // stamp; what it says about the data is the day.
  let text = value.trim().replace(/[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '')
  if (!text) return ''

  // The interval separators, folded to one. A bare hyphen only separates when
  // it sits between two four-digit years — otherwise it is the month
  // separator in `2024-03-12`.
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

  // A canonical interval arrives with its own separator and no spaces.
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

/** The date in the fewest words that are still unambiguous. '' when unreadable. */
export function dataDateLabel(value: string): string {
  if (!isDataDate(value)) return ''
  if (value.includes('/')) {
    const [from, to] = value.split('/')
    return `${dataDateLabel(from)}–${dataDateLabel(to)}`
  }
  const m = PART.exec(value)
  if (!m) return ''
  if (!m[2]) return m[1]
  const month = MONTHS[Number(m[2]) - 1]
  if (!m[3]) return `${month} ${m[1]}`
  return `${month.slice(0, 3)} ${Number(m[3])}, ${m[1]}`
}

/**
 * What a reader sees for `covers`, and the one place the period/snapshot split
 * turns into words: **"Data from 2019-2023"** for a research dataset that is
 * about a stretch of time, **"As of October 2026"** for a living inventory
 * that was true at a moment. Nick's two cases, one field, and the value
 * decides which sentence it gets.
 *
 * Not "Covers …", which it said first: a source entry page has carried a
 * **"Covers national · county"** line since P5-56, and that one is about WHERE
 * the data applies. Two lines starting with the same word, one about ground
 * and one about time, on the same page — found by reading the page rather than
 * by a test, and the field keeps its own name (`covers`, labelled "Period
 * covered" in the queue) while the sentence a reader sees avoids the clash.
 */
export function coversLabel(value: string): string {
  const words = dataDateLabel(value)
  if (!words) return ''
  return isPeriod(value) ? `Data from ${words}` : `As of ${words}`
}

/** What a reader sees for `published` — never folded in with `covers`,
 *  because "when it came out" and "what it is about" are years apart on a
 *  2024 release of 2010 census tracts. */
export function publishedLabel(value: string): string {
  const words = dataDateLabel(value)
  return words ? `Published ${words}` : ''
}

/** What a reader sees for `fetched` — the only one that is about us. */
export function fetchedLabel(value: string): string {
  const words = dataDateLabel(value)
  return words ? `Fetched ${words}` : ''
}

/**
 * The dates a LAYER announces, however it carries them.
 *
 * Two layer shapes reach the registry and both answer here. An internal
 * library layer carries the entry's own `dates` block across the wire; the 26
 * public registry layers have each declared a `year` since long before this
 * ticket, and **a declared vintage IS the period the data describes** — so
 * nothing forks, no registry entry is edited, and every public layer gets a
 * legend date for free.
 *
 * `updatedAt` is deliberately not a candidate. It says when the bytes last
 * moved, so re-pushing a 2019 file would make it read as 2026 data — the
 * misreading the whole ticket exists to stop. (`toLayerDefinition` has always
 * dropped it before the registry, so the legend could not read it even by
 * accident.)
 */
export function layerDatesOf(layer: { year?: number | string; dates?: DataDates | null }): ResolvedDates {
  const block = layer.dates ?? {}
  // The year is a FALLBACK for a layer that carries no block at all, not a
  // default for a block that is silent about its period. A composite index
  // (P7-8) carries `{ published }` and no `covers` on purpose — what it
  // describes is its inputs' business — and falling back here would have it
  // claim to cover the year somebody pressed the button.
  const hasBlock = !!block.covers || !!block.published || !!block.fetched
  return {
    covers: normalizeDataDate(block.covers) || (hasBlock ? '' : normalizeDataDate(layer.year)),
    published: normalizeDataDate(block.published),
    fetched: normalizeDataDate(block.fetched),
  }
}

/** The dates on a catalog row, as a reader's three strings. */
export function resolveDates(dates: DataDates | null | undefined): ResolvedDates {
  const block = dates ?? {}
  return {
    covers: normalizeDataDate(block.covers),
    published: normalizeDataDate(block.published),
    fetched: normalizeDataDate(block.fetched),
  }
}
