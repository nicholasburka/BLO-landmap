import { getFile } from './libraryBucket.js'
import { catalogGenerationNow, getCatalogEntry, onReindex } from './libraryCatalog.js'

/**
 * Operations-home configuration (P5-40).
 *
 * What the landing page features — the hub page, the pinned row, the
 * initiative panel and its numbers — is CONTENT, not code: it lives in
 * `library/kb.json` and is pushed like any other library file. That means
 * the file is edited by hand, so every field is optional and anything
 * malformed falls back to a default rather than breaking the front door.
 *
 * The file is read fresh from the bucket on first use and again after every
 * reindex (the same moment manifests are re-read), and cached in between.
 *
 * P5-88: the RESOLVED config — the file with its pinned slugs looked up in
 * the catalog — is cached too, because that lookup was the slowest thing on
 * the landing page (1.1 s: one `getCatalogEntry` per pinned slug, each one
 * scanning the archived rows). It is keyed on the catalog's generation rather
 * than on the reindex hook alone, so a retitled page still shows its new
 * title the moment it is saved — which is what resolving per request was
 * protecting, and it is now free.
 */

export const KB_CONFIG_KEY = 'library/kb.json'

/** Bounds. The landing has room for a handful of each; a runaway file
 *  should truncate, not scroll forever. */
const PINNED_MAX = 12
const FACTS_MAX = 6
const LINKS_MAX = 8
const TEXT_MAX = 200

/** Same shape as catalog slugs (see WIKI_SLUG in libraryCatalog.ts) — this
 *  value ends up in a URL path, so nothing with a slash or a dot passes. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

export interface KbFact {
  label: string
  value: string
  href?: string
}

export interface KbNextStep {
  text: string
  href: string
}

export interface KbInitiative {
  name: string
  tagline: string
  facts: KbFact[]
  nextStep: KbNextStep | null
}

export interface KbLink {
  label: string
  href: string
}

/** The validated file, before pinned slugs are resolved. */
export interface KbConfigFile {
  homeSlug: string
  pinned: string[]
  initiative: KbInitiative | null
  links: KbLink[]
}

/** A pinned entry as the landing renders it: kind badge, title, one line. */
export interface KbPinnedRef {
  slug: string
  kind: string
  title: string
  category: string
  description: string
  href: string
}

export interface KbConfig {
  homeSlug: string
  pinned: KbPinnedRef[]
  initiative: KbInitiative | null
  links: KbLink[]
}

export const KB_DEFAULTS: KbConfigFile = Object.freeze({
  homeSlug: 'home',
  pinned: [],
  initiative: null,
  links: [],
}) as KbConfigFile

/** Where an entry opens. Mirrors the client's entryHref() in src/lib/kb.ts —
 *  two lines, kept in sync by hand rather than shared through a package. */
export function entryHref(kind: string, slug: string): string {
  if (kind === 'wiki') return `/wiki/${slug}`
  if (kind === 'view') return `/views/${slug}`
  return `/library/${slug}`
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown, max = TEXT_MAX): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** An href we are willing to render as a link: a site-relative path, or an
 *  http(s) URL. Never `javascript:`, `data:`, or a protocol-relative `//host`
 *  that would silently leave the site. */
function safeHref(value: unknown): string | undefined {
  const raw = text(value, 2048)
  if (!raw) return undefined
  if (raw.startsWith('//')) return undefined
  if (raw.startsWith('/')) return raw
  if (/^https?:\/\/\S+$/i.test(raw)) return raw
  return undefined
}

function parseFacts(value: unknown): KbFact[] {
  if (!Array.isArray(value)) return []
  const facts: KbFact[] = []
  for (const raw of value) {
    const obj = asObject(raw)
    if (!obj) continue
    const label = text(obj.label, 60)
    const factValue = text(obj.value, 60)
    if (!label || !factValue) continue
    const href = safeHref(obj.href)
    facts.push({ label, value: factValue, ...(href ? { href } : {}) })
    if (facts.length >= FACTS_MAX) break
  }
  return facts
}

function parseNextStep(value: unknown): KbNextStep | null {
  const obj = asObject(value)
  if (!obj) return null
  const stepText = text(obj.text, 120)
  const href = safeHref(obj.href)
  return stepText && href ? { text: stepText, href } : null
}

function parseInitiative(value: unknown): KbInitiative | null {
  const obj = asObject(value)
  if (!obj) return null
  const name = text(obj.name, 120)
  // Without a name there is nothing to head the panel with, so the whole
  // block is dropped rather than rendered half-empty.
  if (!name) return null
  return {
    name,
    tagline: text(obj.tagline, 400),
    facts: parseFacts(obj.facts),
    nextStep: parseNextStep(obj.nextStep),
  }
}

function parseLinks(value: unknown): KbLink[] {
  if (!Array.isArray(value)) return []
  const links: KbLink[] = []
  for (const raw of value) {
    const obj = asObject(raw)
    if (!obj) continue
    const label = text(obj.label, 60)
    const href = safeHref(obj.href)
    if (!label || !href) continue
    links.push({ label, href })
    if (links.length >= LINKS_MAX) break
  }
  return links
}

function parsePinned(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const slugs: string[] = []
  for (const raw of value) {
    const slug = text(raw, 80)
    if (!SLUG.test(slug) || slugs.includes(slug)) continue
    slugs.push(slug)
    if (slugs.length >= PINNED_MAX) break
  }
  return slugs
}

/** Validate a parsed kb.json. Unknown keys are ignored; every field falls
 *  back to its default independently, so one bad block never costs the rest. */
export function parseKbConfig(raw: unknown): KbConfigFile {
  const obj = asObject(raw)
  if (!obj) return { ...KB_DEFAULTS }
  const homeSlug = text(obj.homeSlug, 80)
  return {
    homeSlug: SLUG.test(homeSlug) ? homeSlug : KB_DEFAULTS.homeSlug,
    pinned: parsePinned(obj.pinned),
    initiative: parseInitiative(obj.initiative),
    links: parseLinks(obj.links),
  }
}

let cached: KbConfigFile | null = null
let resolved: { generation: number; config: KbConfig } | null = null

/** Reindex is the moment the bucket becomes truth again, so the cached
 *  kb.json is dropped there and re-read on the next request. */
onReindex(() => {
  cached = null
  resolved = null
})

/** Test hook + boot reset. */
export function clearKbConfigCache(): void {
  cached = null
  resolved = null
}

/** The validated file. A missing kb.json (or an unreachable bucket) is a
 *  normal state — the landing simply shows its defaults. */
export async function loadKbConfigFile(): Promise<KbConfigFile> {
  if (cached) return cached
  let parsed: KbConfigFile
  try {
    const buf = await getFile(KB_CONFIG_KEY, { fresh: true })
    parsed = parseKbConfig(JSON.parse(buf.toString('utf8')))
  } catch {
    // No file yet, malformed JSON, or no bucket: defaults, cached so a
    // missing file doesn't mean a bucket round-trip on every page load.
    parsed = { ...KB_DEFAULTS }
  }
  cached = parsed
  return parsed
}

/** The file with its pinned slugs resolved against the catalog. Slugs that
 *  no longer exist are dropped with a warning — a pinned card that 404s is
 *  worse than one fewer card, and the warning is how the typo gets found. */
export async function getKbConfig(): Promise<KbConfig> {
  const generation = catalogGenerationNow()
  if (resolved && resolved.generation === generation) return resolved.config
  const config = await resolveKbConfig()
  // A write that landed WHILE we were resolving means this answer is already
  // a mix of before and after: hand it back, but do not remember it — the
  // next caller rebuilds from one consistent catalog.
  if (catalogGenerationNow() === generation) resolved = { generation, config }
  return config
}

/** The uncached build: read the file, look every pinned slug up. */
async function resolveKbConfig(): Promise<KbConfig> {
  const file = await loadKbConfigFile()
  const pinned: KbPinnedRef[] = []
  for (const slug of file.pinned) {
    const entry = await getCatalogEntry(slug)
    if (!entry) {
      console.warn(`[kb] pinned slug "${slug}" is not in the catalog — dropped from the landing.`)
      continue
    }
    const description = typeof entry.meta?.description === 'string' ? entry.meta.description : ''
    pinned.push({
      slug: entry.slug,
      kind: entry.kind,
      title: entry.title || entry.slug,
      category: entry.category ?? '',
      description,
      href: entryHref(entry.kind, entry.slug),
    })
  }
  return { homeSlug: file.homeSlug, pinned, initiative: file.initiative, links: file.links }
}
