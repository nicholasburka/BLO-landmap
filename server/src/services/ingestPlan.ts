import type { Inspection } from './linkInspect.js'

/**
 * How a link or a source is going to come in (P5-59).
 *
 * Nick, 2026-09-06: "either manually via me reviewing, downloading, cleaning
 * and ingesting, or there's a clear API available". The plan is that decision,
 * written down: four choices, an owner, a note, and who decided.
 *
 * A default is PROPOSED from the inspection and never set silently — an entry
 * with no plan is a real state, and it is what puts the entry in the admin's
 * "to ingest" queue. Only an admin writes one.
 */

export const INGEST_PLANS = ['index', 'fetch-on-demand', 'replicate', 'document'] as const
export type IngestPlanName = (typeof INGEST_PLANS)[number]

/** `auto` = the server can do it (Replicate now); `manual` = a person pulls,
 *  cleans and pushes. The difference is who the queue is waiting on. */
export const INGEST_MODES = ['auto', 'manual'] as const
export type IngestMode = (typeof INGEST_MODES)[number]

const OWNER_MAX = 120
const NOTE_MAX = 2000

export interface IngestDone {
  at: string
  /** The dataset entry that satisfied the plan, when there is one. */
  dataset?: string
}

export interface IngestPlan {
  plan: IngestPlanName
  mode?: IngestMode
  owner?: string
  note?: string
  decidedBy: string
  decidedAt: string
  done?: IngestDone
}

/** What each plan means, in the words the entry page and the tools use. */
export const PLAN_LABELS: Record<IngestPlanName, string> = {
  index: 'Index only',
  'fetch-on-demand': 'Fetch for a place',
  replicate: 'Copy into the library',
  document: 'Read as a document',
}

export const PLAN_NEXT_STEPS: Record<IngestPlanName, string> = {
  index:
    'We keep the pointer and nothing else. Anyone can open the link from here; nothing is downloaded and nothing appears on the map.',
  'fetch-on-demand':
    'Nobody copies this. When a report or a question needs it for one address or county, the server asks the agency then and caches the answer.',
  replicate:
    'The whole dataset is copied into the library so it can be cleaned, explored and mapped. Automatically when it is small enough, by hand when it is not.',
  document: 'This is something to read, not a table. It is filed as a document and its text is searchable.',
}

/** One sentence for the entry, the queue and the MCP tools. */
export function planSummary(plan: IngestPlanName, mode?: IngestMode): string {
  const base = PLAN_NEXT_STEPS[plan]
  if (plan !== 'replicate' || !mode) return base
  return mode === 'auto'
    ? `${base} This one is small enough for "Replicate now".`
    : `${base} This one is a manual pull: download, clean, push, reindex.`
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, max)
  return trimmed || undefined
}

/** An `ingest` block off a manifest, cleaned. Never throws. */
export function parseIngestPlan(raw: unknown): IngestPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const plan = INGEST_PLANS.find(p => p === o.plan)
  if (!plan) return null
  const out: IngestPlan = {
    plan,
    decidedBy: cleanString(o.decidedBy, OWNER_MAX) ?? 'unknown',
    decidedAt: cleanString(o.decidedAt, 64) ?? '',
  }
  const mode = INGEST_MODES.find(m => m === o.mode)
  if (mode) out.mode = mode
  const owner = cleanString(o.owner, OWNER_MAX)
  if (owner) out.owner = owner
  const note = cleanString(o.note, NOTE_MAX)
  if (note) out.note = note
  if (o.done && typeof o.done === 'object' && !Array.isArray(o.done)) {
    const done = o.done as Record<string, unknown>
    const at = cleanString(done.at, 64)
    if (at) {
      out.done = { at, ...(cleanString(done.dataset, 200) ? { dataset: cleanString(done.dataset, 200)! } : {}) }
    }
  }
  return out
}

export interface ProposedPlan {
  plan: IngestPlanName
  mode?: IngestMode
  /** Why this is the default, for the picker's hint line. */
  why: string
}

/**
 * The plan the inspection points at. A PROPOSAL — the picker starts here and
 * an admin still has to press the button.
 */
/**
 * P5-61: did this page turn out to be about a dataset we could actually get?
 *
 * Two signals, both required. The model's `isDataset` on its own is a claim
 * about somebody else's prose; a kept link or a described access route is the
 * thing that claim would have to be true of.
 */
export function describesDataset(inspection: Inspection | null | undefined): boolean {
  if (!inspection?.prose?.isDataset) return false
  return !!inspection.links?.length || !!inspection.prose.accessNotes?.length
}

export function proposeIngestPlan(inspection: Inspection | null | undefined): ProposedPlan | null {
  if (!inspection) return null
  switch (inspection.kind) {
    case 'arcgis-layer':
    case 'socrata':
      return { plan: 'fetch-on-demand', why: 'it has an endpoint we can query for one place at a time' }
    case 'arcgis-service':
      return { plan: 'fetch-on-demand', why: 'its layers can be queried once one of them is registered' }
    case 'file':
      return { plan: 'replicate', mode: 'auto', why: 'it is a single file we can copy' }
    case 'portal':
      return { plan: 'index', why: 'it is a catalogue page — the plan belongs on whatever it links to' }
    case 'page':
      // P5-61: a prose page that turned out to describe a dataset is not a
      // document any more — it is a pointer at data, and the plan for a
      // pointer is `index`. The evidence has to be BOTH the model's verdict
      // and something real to point at, so a confident model with no links
      // cannot promote an article.
      return describesDataset(inspection)
        ? { plan: 'index', why: 'the page describes a dataset and links to it — keep the pointer and register the source' }
        : { plan: 'document', why: 'it is something to read, not a table' }
    default:
      // Unreachable: proposing anything would be pretending we know what it is.
      return null
  }
}

// --- "It arrived" ------------------------------------------------------------

interface LineageBearing {
  slug: string
  kind: string
  meta: Record<string, unknown>
}

/** `lineage.from` on an entry, when it has one. */
export function lineageFrom(meta: Record<string, unknown> | undefined): string | null {
  const lineage = meta?.lineage
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage)) return null
  const from = (lineage as Record<string, unknown>).from
  return typeof from === 'string' && from.trim() ? from.trim() : null
}

/** What a dataset copied from this entry would name as its origin. */
export function lineageKeysFor(entry: { slug: string; meta: Record<string, unknown> }): string[] {
  const keys = [`source:${entry.slug}`]
  const url = entry.meta?.url
  if (typeof url === 'string' && url.trim()) keys.push(url.trim())
  return keys
}

/**
 * Flip every `replicate` plan whose dataset has turned up.
 *
 * Nick's manual path is pull, clean, push, reindex — so the moment the plan is
 * satisfied is a reindex, and the evidence is a dataset whose `lineage.from`
 * names this entry. Computed rather than stored: it is derived from two
 * manifests we already read, and recomputing it means a dataset that is later
 * deleted correctly reopens the plan.
 *
 * Mutates `meta` on the entries it changes and returns how many it touched.
 */
export function markReplicatedPlans(entries: Iterable<LineageBearing>, now: string = new Date().toISOString()): number {
  const all = [...entries]
  const byOrigin = new Map<string, { slug: string; at: string }>()
  for (const entry of all) {
    if (entry.kind !== 'dataset') continue
    const from = lineageFrom(entry.meta)
    if (!from) continue
    const lineage = entry.meta.lineage as Record<string, unknown>
    const at = typeof lineage.fetchedAt === 'string' ? lineage.fetchedAt : now
    // First one wins: a second copy of the same source does not re-date the plan.
    if (!byOrigin.has(from)) byOrigin.set(from, { slug: entry.slug, at })
  }
  if (!byOrigin.size) return 0

  let changed = 0
  for (const entry of all) {
    const ingest = parseIngestPlan(entry.meta.ingest)
    if (!ingest || ingest.plan !== 'replicate' || ingest.done) continue
    const hit = lineageKeysFor(entry).map(key => byOrigin.get(key)).find(Boolean)
    if (!hit) continue
    entry.meta = { ...entry.meta, ingest: { ...ingest, done: { at: hit.at, dataset: hit.slug } } satisfies IngestPlan }
    changed++
  }
  return changed
}
