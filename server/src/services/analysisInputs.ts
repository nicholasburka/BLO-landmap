/**
 * What an analysis ran on, and whether that has changed since (P7-6, spec §F.4c).
 *
 * P7-5 wrote the provenance record — `type`, `from`, `to`, `within`, `rows`,
 * `by`, `at` — and said what was missing: *"P7-6 adds their **versions** and
 * the stale-but-still-rendering half. Reuse here is field equality on that same
 * provenance record — no hash, no clock, no second keying scheme to undo."*
 * This file is those versions. It adds a field to that record and nothing
 * beside it: there is still one results store (the set's manifest) and one key
 * (the analysis definition plus the working set).
 *
 * **Keyed by content, never by clock.** The place report's 7-day TTL
 * (`REPORT_TTL_DAYS`) is right for a report of the live world — forty agencies
 * move underneath it. An analysis over datasets the library *holds* is a
 * different thing: it is stale only when one of those held inputs changes, and
 * a result that is still correct must not be thrown away because a week
 * passed. So nothing here expires. A verdict is always a statement about
 * bytes.
 *
 * ### What counts as a version
 *
 * Three facts about the file the run actually read, and one hint:
 *
 * | field | in the comparison? | why |
 * |---|---|---|
 * | `bytes` | **yes** | different size ⇒ different content, decided without a read |
 * | `keys` | **yes** | the columns the run read it *with*. A layer block repointed from one latitude column to another changes the answer and cannot change the byte count — the same reason `internalLayers.ts` folds its geometry keys into its own version string |
 * | `content` | **yes**, and it is the tie-break | a corrected digit — `35.060080` → `35.060081` — is a real edit that preserves every byte count. Only a hash sees it |
 * | `at` | **no** | the entry's revision stamp when the run read it. A **short circuit only**: nothing written to the entry means nothing can have changed, so the hash is not needed. A stamp that HAS moved never means stale — it means read the bytes and ask them |
 *
 * That `at` is a hint and not a verdict is the whole of "never by clock", and
 * it is load-bearing in both directions. A metadata-only edit — a retag, an
 * inspection pass, an organization filled in — rewrites `meta.json` and so
 * bumps the row's stamp (`patchEntryManifest` re-indexes with no `updatedAt`,
 * which lands "now"). If the stamp were the verdict, every retag would mark
 * every derived column on the set stale, and a reader would learn to ignore
 * the label. It must mean something every time it appears.
 *
 * ### Three verdicts, not two
 *
 * `unknown` exists because a result written before this ticket records no
 * input versions at all, and so **cannot be checked**. Calling that fresh
 * would be a claim nobody made; calling it stale would recompute work that is
 * probably fine. Saying "this cannot be checked" is the P6-34 answer — an
 * unverified value must never be indistinguishable from a verified one — and
 * it is also what a file the bucket cannot re-read gets.
 *
 * ### Two kinds of input, one machine (P7-8)
 *
 * P7-6 left this module *type-agnostic on purpose*: it takes a list of inputs
 * and knows nothing about proximity, so a new analysis gets versions, verdicts
 * and the stale label by writing `inputs` the same way. P7-8's composite index
 * took that offer — and then needed one thing P7-6 had not: a term can be a
 * **public registry layer**, which has no catalog row at all.
 *
 * So the widening here is by kind of **input**, never by kind of analysis.
 * `source` says where an input's bytes live: the library's bucket (absent,
 * which is every record written before P7-8) or the public map's own dataset
 * files. A library input is checked exactly as it was; a public one is checked
 * against the registry mirror and the file, with the same three verdicts and
 * the same sentences. Nothing about proximity changed, and a second analysis
 * type still needs no second staleness scheme.
 *
 * The public branch is reached through a **dynamic import**. This module is
 * deliberately light — one catalog read, one bucket read — and the public
 * loader hangs off `mcpTools.ts`, whose import graph is most of the MCP
 * surface. Loading it only when a stored result actually names a public layer
 * keeps every other freshness check, and every other test file, where it was.
 */

import { createHash } from 'node:crypto'
import { getCatalogEntry } from './libraryCatalog.js'
import { getFile } from './libraryBucket.js'
import { pickTabularFile } from './libraryTabular.js'

/** How much of the digest is kept. 16 hex characters is 64 bits: a collision
 *  between two versions of one file is not a thing that happens, and a short
 *  string stays readable in a manifest a person opens. */
const CONTENT_CHARS = 16

/**
 * One input to an analysis, and the version of it the analysis read.
 *
 * Written into the `analysis` block beside `from`/`to`/`within` — the same
 * record, one field wider. Each entry names a catalog slug rather than a file
 * key, because a slug is what the set names and what a refusal can say out
 * loud.
 */
export interface AnalysisInput {
  /** The catalog slug this input is. */
  slug: string
  /** What it was to the run: the rows measured FROM, the layer measured TO. */
  role: string
  /** The file inside the entry the run actually read, by basename. */
  file: string
  /** That file's size. In the comparison, and in the sentence a reader gets:
   *  "4,821 bytes, now 5,002" says more than the word "stale". */
  bytes: number
  /** The columns the run read it with, joined — `'lat|lng|GEOID'`. A block
   *  repointed to a different column is a changed input no byte count sees. */
  keys: string
  /** The version proper: sha256 of those bytes, first 16 hex. */
  content: string
  /** The entry's revision stamp when the run read it. A SHORT CIRCUIT, never
   *  a verdict — see the header. `''` when the writer could not know it, which
   *  is the batch tier's case: it has no catalog to ask. */
  at: string
  /**
   * Where this input's bytes live (P7-8).
   *
   * **Absent means `'library'`**, which is every record written before P7-8
   * and every proximity input ever — so no stored result changes verdict
   * because this field appeared. `'public'` means a public map layer: the
   * registry mirror says which file and column, and the file itself supplies
   * the bytes a catalog row would otherwise have.
   */
  source?: 'library' | 'public'
}

export type InputVerdict = 'fresh' | 'stale' | 'unknown'

/** One input, checked. */
export interface InputCheck {
  slug: string
  role: string
  verdict: InputVerdict
  /** Why, in a clause that can be read in a sentence. `''` when fresh. */
  reason: string
}

/** A stored result's standing, now. */
export interface Freshness {
  /**
   * The worst of its inputs: one changed input makes the whole result stale,
   * and one unreadable input makes it uncheckable. A result is only fresh when
   * every input it names is.
   */
  verdict: InputVerdict
  /** The one sentence a reader needs. `''` when fresh. */
  note: string
  inputs: InputCheck[]
}

export const FRESH: Freshness = { verdict: 'fresh', note: '', inputs: [] }

/** sha256 of some bytes, shortened. The version of a file's content. */
export function fingerprintOf(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, CONTENT_CHARS)
}

/**
 * The columns a run would read an entry with, as one comparable string.
 *
 * **One function, used by the capture and by the check**, which is the only way
 * the two sides can be sure they are comparing the same thing. A version whose
 * two halves are computed in two places is a version that eventually disagrees
 * with itself.
 *
 * It reads the entry's own layer block, which is the declaration that decides
 * which columns an analysis reads — `internalLayers.ts` folds exactly these
 * keys into its own bbox version string for exactly this reason. A block
 * repointed from `lat` to `latitude`, or at a different file, is a changed
 * input that no byte count can see.
 *
 * **Cosmetics are deliberately left out.** `color`, `width`, `name` and
 * `popupFields` change how a layer is drawn and not one number it produces, so
 * folding them in would mark every derived column on a set stale the first time
 * somebody picked a nicer blue — and a label that cries wolf is worse than no
 * label, which is the whole argument of this ticket.
 *
 * A column the run picked by name-regex rather than by declaration is NOT in
 * here, and does not need to be: a regex reads the file's own header row, so a
 * change in what it picks is a change in the file, which `content` already
 * sees.
 */
export function layerKeysOf(meta: Record<string, unknown> | undefined | null): string {
  const block = meta && typeof meta.layer === 'object' && meta.layer && !Array.isArray(meta.layer)
    ? (meta.layer as Record<string, unknown>)
    : null
  if (!block) return ''
  const at = (key: string): string => (typeof block[key] === 'string' ? (block[key] as string).trim() : '')
  // In a fixed order, so two equal blocks cannot produce two different
  // strings. Absent and empty collapse together on purpose: a block that never
  // named a label column and one whose label column was removed read the same
  // columns, and a version that distinguished them would report a change
  // nobody made.
  return ['geometry', 'file', 'latKey', 'lngKey', 'pathKey', 'geoKey', 'valueKey', 'labelKey'].map(at).join('|')
}

/**
 * A bounded memo of file fingerprints.
 *
 * The key carries the version facts it is keyed on, so a changed file is
 * simply a different key and there is nothing to invalidate — the bug class
 * `clearTabularCache` exists to avoid cannot arise here. It is a memo and not
 * a cache: it exists so that a freshness check on a 190,000-row batch result
 * does not re-read fifty megabytes on every page load, which is the one place
 * the content check could cost something real.
 */
const MEMO_MAX = 200
const memo = new Map<string, string>()

function remembered(key: string, bytes: number, read: () => Promise<Buffer>): Promise<string> {
  const id = `${key}|${bytes}`
  const hit = memo.get(id)
  if (hit !== undefined) return Promise.resolve(hit)
  return read().then(body => {
    const content = fingerprintOf(body)
    memo.set(id, content)
    // A Map iterates in insertion order, so the head is the oldest.
    for (const oldest of memo.keys()) {
      if (memo.size <= MEMO_MAX) break
      memo.delete(oldest)
    }
    return content
  })
}

/** Drop the memo. For tests, which swap the whole bucket out underneath it. */
export function clearAnalysisInputMemo(): void {
  memo.clear()
}

interface EntryFile {
  key: string
  size: number
  name: string
}

/** The entry file whose basename is `file`, or null. The same addressing
 *  `pickTabularFile` uses — a basename inside the entry's own folder. */
function fileIn(files: readonly { key: string; size: number }[], file: string): EntryFile | null {
  const wanted = file.trim()
  if (!wanted) return null
  const found = files.find(f => f.key.split('/').slice(3).join('/') === wanted)
  return found ? { key: found.key, size: found.size, name: wanted } : null
}

/** The table `readDataset` would pick when nobody named one — `pickTabularFile`'s
 *  own rule, so a capture that has to fall back names the same file a re-run
 *  would read. */
function firstTable(files: readonly { key: string; size: number }[]): EntryFile | null {
  const chosen = pickTabularFile([...files]).chosen
  return chosen ? { key: chosen.key, size: chosen.size, name: chosen.name } : null
}

/**
 * Record an input as the server reads it: the file, its size, its content.
 *
 * Called at the moment an analysis runs, when the bytes are already warm —
 * `readDataset` and the layer projection have just parsed this very file, so
 * the mirror holds it and the read is local.
 */
export async function captureAnalysisInput(input: {
  slug: string
  role: string
  file: string
  /** P7-8: `'public'` records a public map layer instead of a catalog entry. */
  source?: 'library' | 'public'
}): Promise<AnalysisInput> {
  const base: AnalysisInput = {
    slug: input.slug,
    role: input.role,
    file: input.file,
    bytes: 0,
    keys: '',
    content: '',
    at: '',
  }
  if (input.source === 'public') return capturePublicInput(input.slug, input.role)
  const entry = await getCatalogEntry(input.slug)
  if (!entry) return base
  base.keys = layerKeysOf(entry.meta)
  // The caller names the file it read; when it could not, fall back to the
  // same table `readDataset` would have picked, so the recorded name is the
  // one the check will look for.
  const found = fileIn(entry.files ?? [], input.file) ?? firstTable(entry.files ?? [])
  if (!found) return { ...base, at: entry.updatedAt ?? '' }
  base.file = found.name
  // A capture that cannot read its own input records the size it knows and no
  // content, which reads back as `unknown` rather than as a false `fresh`.
  let content = ''
  try {
    content = await remembered(found.key, found.size, () => getFile(found.key))
  } catch {
    /* recorded as uncheckable */
  }
  return { ...base, bytes: found.size, content, at: entry.updatedAt ?? '' }
}

/**
 * The public-layer half of the capture and of the check (P7-8).
 *
 * Loaded on demand — see the header on why this module does not import the
 * public dataset loader statically. One accessor, so the capture and the check
 * cannot drift apart the way `layerKeysOf` exists to stop them drifting.
 */
async function publicLayers(): Promise<typeof import('./publicLayerValues.js')> {
  return import('./publicLayerValues.js')
}

/** A public map layer as an analysis input: the registry says which file and
 *  column, the file says its size and content. There is no `at` — a static
 *  dataset file has no revision stamp, so the short circuit simply never
 *  fires and the content check always decides. */
async function capturePublicInput(layerId: string, role: string): Promise<AnalysisInput> {
  const base: AnalysisInput = {
    slug: layerId,
    role,
    file: '',
    bytes: 0,
    keys: '',
    content: '',
    at: '',
    source: 'public',
  }
  const mod = await publicLayers()
  const record = mod.publicLayerRecord(layerId)
  if (!record) return base
  const print = await mod.publicLayerFingerprint(layerId)
  return {
    ...base,
    file: record.dataPath,
    keys: mod.publicLayerKeys(layerId),
    ...(print ? { bytes: print.bytes, content: print.content } : {}),
  }
}

/** One public-layer input, against the registry and the file right now. The
 *  same four decisions in the same order as `checkOne`, minus the clock
 *  short circuit it has nothing to consult. */
async function checkPublicInput(input: AnalysisInput): Promise<InputCheck> {
  const named = `“${input.slug}”`
  const said = (verdict: InputVerdict, reason: string): InputCheck => ({
    slug: input.slug,
    role: input.role,
    verdict,
    reason,
  })
  const mod = await publicLayers()
  if (!mod.publicLayerRecord(input.slug)) {
    return said('stale', `${named} is no longer a layer on the public map`)
  }
  if (!input.content) {
    return said('unknown', `${named} was not recorded when this ran, so it cannot be checked`)
  }
  if (mod.publicLayerKeys(input.slug) !== input.keys) {
    return said('stale', `${named} is now read from a different file or column than this index used`)
  }
  const size = await mod.publicLayerBytes(input.slug)
  if (size !== null && size !== input.bytes) {
    return said('stale', `${named} has changed since this ran — ${bytesClause(input.bytes, size)}`)
  }
  const print = await mod.publicLayerFingerprint(input.slug)
  if (!print) {
    return said('unknown', `${named} could not be re-read, so this cannot be checked`)
  }
  if (print.bytes !== input.bytes) {
    return said('stale', `${named} has changed since this ran — ${bytesClause(input.bytes, print.bytes)}`)
  }
  if (print.content !== input.content) {
    return said(
      'stale',
      `${named} has been rewritten since this ran — the same ${print.bytes.toLocaleString()} bytes, different content`,
    )
  }
  return said('fresh', '')
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * The inputs a stored record names, read tolerantly.
 *
 * A manifest can be hand-edited and hand-pushed (`readWorkingSet`'s rule), so
 * an entry missing a field is kept and reads as whatever that field's absence
 * means — never dropped, because an input silently dropped from the list is an
 * input nothing will ever check.
 */
export function readAnalysisInputs(value: unknown): AnalysisInput[] {
  if (!Array.isArray(value)) return []
  const out: AnalysisInput[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const slug = str(row.slug, 80)
    if (!slug) continue
    out.push({
      slug,
      role: str(row.role, 20),
      file: str(row.file),
      bytes: num(row.bytes),
      keys: str(row.keys, 400),
      content: str(row.content, 64),
      at: str(row.at, 40),
      // Only the one spelling counts. Anything else — absent, misspelt,
      // hand-edited — is a library input, which is what every record written
      // before P7-8 is.
      ...(row.source === 'public' ? { source: 'public' as const } : {}),
    })
  }
  return out
}

/** `4,821 bytes, now 5,002` — the two numbers side by side, which is how
 *  `staleNote` in the explorer already says a saved view has moved. */
function bytesClause(was: number, now: number): string {
  return `${was.toLocaleString()} bytes, now ${now.toLocaleString()}`
}

/** One input, against what the library holds right now. */
async function checkOne(input: AnalysisInput): Promise<InputCheck> {
  if (input.source === 'public') return checkPublicInput(input)
  const named = `“${input.slug}”`
  const entry = await getCatalogEntry(input.slug)
  if (!entry) {
    // P6-23: a member archived out from under a result is reported, never
    // folded into a tidier answer.
    return { slug: input.slug, role: input.role, verdict: 'stale', reason: `${named} is no longer in the library` }
  }

  // Nothing recorded to compare against. Not a failure and not a pass — see
  // the header on why `unknown` is a third verdict rather than a default.
  if (!input.content) {
    return {
      slug: input.slug,
      role: input.role,
      verdict: 'unknown',
      reason: `${named} was not recorded when this ran, so it cannot be checked`,
    }
  }

  const found = fileIn(entry.files ?? [], input.file)
  if (!found) {
    return {
      slug: input.slug,
      role: input.role,
      verdict: 'stale',
      reason: `${named} no longer holds the file this read, ${input.file}`,
    }
  }

  // Decided without a read, and before the bytes, because this is the change
  // the bytes cannot see: the same file, read with different columns.
  const keys = layerKeysOf(entry.meta)
  if (keys !== input.keys) {
    return {
      slug: input.slug,
      role: input.role,
      verdict: 'stale',
      reason: `${named} is now read from different columns than this measured`,
    }
  }

  // Decided without a read: a different size is a different file.
  if (found.size !== input.bytes) {
    return {
      slug: input.slug,
      role: input.role,
      verdict: 'stale',
      reason: `${named} has changed since this ran — ${bytesClause(input.bytes, found.size)}`,
    }
  }

  // The short circuit, and the only place the clock is consulted at all:
  // nothing has been written to this entry since the run, so its bytes cannot
  // have moved. A stamp that HAS moved falls through to the content check
  // rather than becoming a verdict of its own.
  if (input.at && entry.updatedAt && input.at === entry.updatedAt) {
    return { slug: input.slug, role: input.role, verdict: 'fresh', reason: '' }
  }

  let content: string
  try {
    content = await remembered(found.key, found.size, () => getFile(found.key))
  } catch {
    return {
      slug: input.slug,
      role: input.role,
      verdict: 'unknown',
      reason: `${named} could not be re-read, so this cannot be checked`,
    }
  }
  if (content !== input.content) {
    return {
      slug: input.slug,
      role: input.role,
      verdict: 'stale',
      // Same size, different bytes: the edit a byte count cannot see, which is
      // the whole reason the content hash is in the record.
      reason: `${named} has been rewritten since this ran — the same ${found.size.toLocaleString()} bytes, different content`,
    }
  }
  return { slug: input.slug, role: input.role, verdict: 'fresh', reason: '' }
}

/** Fresh unless proven otherwise, and stale beats unknown: a result with one
 *  changed input and one uncheckable input is stale, because the changed one
 *  is already a reason to re-run. */
function worstOf(checks: readonly InputCheck[]): InputVerdict {
  if (checks.some(c => c.verdict === 'stale')) return 'stale'
  if (checks.some(c => c.verdict === 'unknown')) return 'unknown'
  return 'fresh'
}

/**
 * Whether a stored result still stands.
 *
 * A result with no inputs recorded is `unknown` with a sentence saying so, and
 * **still renders** — which is the acceptance criterion. Nothing here deletes,
 * hides or recomputes anything; it only says what is true about the numbers
 * somebody may already be quoting.
 */
export async function checkAnalysisInputs(value: unknown): Promise<Freshness> {
  const inputs = readAnalysisInputs(value)
  if (!inputs.length) {
    return {
      verdict: 'unknown',
      note: 'This was computed before its inputs were recorded, so whether it still stands cannot be checked.',
      inputs: [],
    }
  }
  const checks: InputCheck[] = []
  for (const input of inputs) checks.push(await checkOne(input))
  const verdict = worstOf(checks)
  return { verdict, note: freshnessNote(verdict, checks), inputs: checks }
}

/**
 * The sentence a reader sees.
 *
 * Every reason that applies, joined — never "one input changed" with the rest
 * swallowed, because which input changed is the thing that says what to go and
 * look at. Fresh says nothing at all: a label on every column would make the
 * label meaningless on the one column that needs it.
 */
export function freshnessNote(verdict: InputVerdict, checks: readonly InputCheck[]): string {
  if (verdict === 'fresh') return ''
  const reasons = checks.filter(c => c.verdict === verdict).map(c => c.reason)
  if (!reasons.length) return ''
  const joined = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join('; ')}; and ${reasons[reasons.length - 1]}`
  return verdict === 'stale' ? `${joined}, so this number may have drifted.` : `${joined}.`
}
