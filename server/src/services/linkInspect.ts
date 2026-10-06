import Papa from 'papaparse'
import { guardedGet, PlaceFetchError, type GuardedGetOptions } from './placeHttp.js'
import { isForbiddenHostname, literalIp } from './hostGuard.js'
import { harvestLinks, type LinkCandidate, type DocumentCandidate } from './linkHarvest.js'
import {
  pruneLinks,
  cleanProse,
  correctedRole,
  isDirectoryUrl,
  looksLikeViewer,
  DROPPED_MAX,
  KEPT_LINKS_MAX,
  LINK_ROLES,
  PRUNE_TEXT_CHARS,
  type LinkRole,
  type ProseRead,
} from './linkPrune.js'
import type { AnthropicLike, AssistantFailureCode } from './assistantCall.js'
import type { LookupFn } from '../cli/fetchLink.js'

/**
 * "What is this link?" (P5-59).
 *
 * A researcher drops a URL. Before anyone decides how it comes in, the server
 * looks at it: is it an ArcGIS layer we could query per place, a Socrata
 * dataset, a file we could copy, a portal page listing files, or just a report
 * to read? Everything here is a PROBE — it reads metadata endpoints and the
 * first bytes of a body, never the dataset — and the answer is data stored on
 * the entry, never applied to it.
 *
 * Every request goes through `guardedGet`, so the P5-47/57 rules hold without
 * being restated: http(s) only, every redirect hop re-checked against the host
 * guard, a hard timeout, and a byte cap. The one thing added for a probe is
 * `truncate`: an 800 MB CSV is a FACT about the link, not a failure to report.
 *
 * The only URLs followed are the ones the researcher gave and the metadata
 * endpoints derived from them (`?f=json`, `/api/views/<id>.json`). Links found
 * ON a portal page are listed, never fetched — the person picks.
 */

// --- Shapes ------------------------------------------------------------------

export const INSPECT_KINDS = [
  'arcgis-layer',
  'arcgis-service',
  'socrata',
  'file',
  'portal',
  'page',
  'unreachable',
] as const
export type InspectKind = (typeof INSPECT_KINDS)[number]

export const INSPECT_CONFIDENCES = ['high', 'medium', 'low'] as const
export type InspectConfidence = (typeof INSPECT_CONFIDENCES)[number]

export const INSPECT_GEOMETRIES = ['point', 'line', 'polygon', 'table'] as const
export type InspectGeometry = (typeof INSPECT_GEOMETRIES)[number]

export interface InspectField {
  name: string
  type?: string
  alias?: string
  /**
   * One real value of this column, when the metadata offered one.
   *
   * P5-59: a column NAME is not enough to know what a FIPS-ish id identifies.
   * The CDC well-water set has `geo_id` = "1400000US13001950100" (a census
   * URI, useless as a filter) next to `ct_fips` = "13001950100" (an 11-digit
   * tract). One sample value tells them apart; the name never could.
   */
  sample?: string
}

export interface InspectExtent {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

export interface InspectLink {
  url: string
  label?: string
  kind?: InspectKind
  /**
   * P5-61: what this link IS, once something has read the page. Absent on the
   * typed lists a portal hands us directly (a Hub export, a CKAN resource is
   * given one from its declared format).
   */
  role?: LinkRole
  /** Why this link survived the prune and forty others did not. */
  reason?: string
}

export interface InspectLayerRef {
  id: number
  name: string
  url: string
  geometry?: InspectGeometry
}

/**
 * P5-79: what a page says about ITSELF, read from its own head.
 *
 * The deterministic floor under every dropped link. Every enrichment used to
 * be the model's job, so a page dropped while the account had no credit landed
 * titled by its hostname with nothing else on it. None of this needs a model:
 * the page carries it, we were already parsing it, and we were throwing it
 * away.
 */
export interface InspectPage {
  /** The `<title>`, cleaned: whitespace collapsed, capped, and a trailing
   *  " | Site name" dropped when that suffix is just the site saying its own
   *  name again. */
  title?: string
  /** The meta description, or — when the page has none — the first words of
   *  its readable text (nav, header and footer left out). */
  description?: string
  /** `og:site_name`, or the publisher from the page's structured data. */
  provider?: string
  /** The page we ended up on was served over http. P5-81 keeps its same-site
   *  links; P5-82 says so on the entry. */
  insecure?: boolean
}

export interface Inspection {
  kind: InspectKind
  confidence: InspectConfidence
  /** What was dropped. */
  url: string
  /** What we ended up looking at: the layer URL, the Socrata resource, the
   *  address after redirects. This is what an access method would point at. */
  finalUrl?: string
  title?: string
  provider?: string
  description?: string
  fields?: InspectField[]
  geometry?: InspectGeometry
  extent?: InspectExtent
  rowCount?: number
  formats?: string[]
  contentType?: string
  bytes?: number
  links?: InspectLink[]
  /**
   * P5-61: how many links the page offered before pruning. The entry says "N
   * other links on the page were left out", which is only honest if the count
   * is of the page and not of what we kept.
   */
  candidates?: number
  /** P5-61: `model` when a model pass chose the links above, `unranked` when
   *  it could not run and they were picked by URL shape alone. */
  pruned?: 'model' | 'unranked'
  /** P5-61: why it is unranked, so the entry can say so instead of leaving a
   *  reader to guess whether the page or the model was the problem. */
  pruneError?: string
  /** P5-75: the same reason as a code, when the MODEL was what failed — so an
   *  admin can tell "nobody set a key" from "the account is out of credit". */
  pruneErrorCode?: AssistantFailureCode
  /** P5-61: the URLs the pass did NOT keep (≤ 20), so the next reviewer can
   *  see what was left out without re-running anything. */
  dropped?: string[]
  /** P5-61: what the page's PROSE said about the dataset, each field with the
   *  sentence it came from. Feeds the source proposal, marked inferred. */
  prose?: ProseRead
  /** P5-61: the portal software behind a `portal` page, when we recognised
   *  it and read its API instead of its HTML (`ckan`). */
  platform?: string
  /**
   * P5-79: the floor — the page's own title, description and publisher, and
   * whether it was served over http. Stored for every `page` and `portal`
   * inspection, and applied to an entry that has no words of its own.
   */
  page?: InspectPage
  /** P5-80: the documents (PDF, Word, spreadsheet…) the page links to on its
   *  own site, so a person can pull the collection in as one action. */
  documents?: DocumentCandidate[]
  layers?: InspectLayerRef[]
  cadence?: string
  /** P5-61: the publisher's own keywords (CKAN `tags[]`), for `topics`. */
  topics?: string[]
  license?: string
  /** The coordinate system a GeoJSON body declared, when it declared one and
   *  it was not WGS84. Replication reprojects Web Mercator and refuses the
   *  rest rather than writing metres into a latitude column. */
  crs?: string
  /** Plain-language caveats for whoever reads this. */
  notes?: string[]
  /**
   * The one-line description, stored alongside rather than recomputed.
   *
   * The entry page and the admin queue both show it, and the only honest way
   * to say "Georgia extent" is a table of state boxes — which belongs on the
   * server, not in the browser bundle. `writeInspection` fills it in.
   */
  summary?: string
  checkedAt: string
}

export interface InspectOptions {
  fetchImpl?: typeof fetch
  lookup?: LookupFn
  timeoutMs?: number
  maxBytes?: number
  /** Pause between the tries of an export that is still being prepared.
   *  Tests set it to 0; nothing else passes it. */
  retryDelayMs?: number
  /** P5-61: the model client for the link prune. Tests pass a stub. */
  client?: AnthropicLike
  /** P5-61: whose budget the prune's tokens come out of (P5-41). */
  clientIp?: string
  /** P5-61 test seam: the prune itself. Nothing in the app passes it. */
  prune?: typeof pruneLinks
  /** P5-61: what to call this entry in the prune's log line — its slug, when
   *  the caller has one. Falls back to the URL. */
  label?: string
}

// --- Limits ------------------------------------------------------------------

/** How long one probe may take. 15 s: a state GIS server answering `?f=json`
 *  for a national layer is slow, and a person is waiting on the button. */
export function inspectTimeoutMs(): number {
  const raw = Number(process.env.INSPECT_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15_000
}

/** Most bytes a probe reads from one body. A probe reads METADATA — a page,
 *  a service description, the head of a file — never the dataset, so this is
 *  deliberately far below the fetch cap. */
export function inspectMaxBytes(): number {
  const raw = Number(process.env.INSPECT_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2 * 1024 * 1024
}

/** Bytes of a data file we look at to name its columns. The header row of a
 *  CSV and the first feature of a GeoJSON are both well inside this. */
export const INSPECT_SAMPLE_BYTES = 64 * 1024

/** Caps for what we store: the inspection lives inline in the catalog row and
 *  ships with every list response, so one enormous service cannot bloat it. */
export const INSPECT_FIELDS_MAX = 60
export const INSPECT_LINKS_MAX = 40
export const INSPECT_LAYERS_MAX = 60
export const INSPECT_NOTES_MAX = 10
/** P5-79: an entry title is a headline, not a sentence. */
export const PAGE_TITLE_MAX = 120
/** P5-79: a description is the page's opening, not the page. */
export const PAGE_DESCRIPTION_MAX = 300
/** P5-80: most documents we store off one page. */
export const INSPECT_DOCUMENTS_MAX = 30
const STRING_MAX = 2000
/** A sample value is evidence, not content: a county code is 5 characters and
 *  the longest id we care about is 20. */
const SAMPLE_MAX = 64

// --- URL shapes --------------------------------------------------------------

/** `…/FeatureServer`, `…/MapServer`, optionally with a layer index. */
const ARCGIS_RE = /\/(FeatureServer|MapServer)(?:\/(\d+))?\/?$/i
/** Socrata ids are two four-character halves ("spb7-eyx7"). */
const SOCRATA_ID = /([a-z0-9]{4}-[a-z0-9]{4})/i

const FILE_EXT_RE = /\.(csv|tsv|json|geojson|zip|xlsx|xls|pdf|kml|kmz|gpkg|gdb|txt)$/i

/** The Socrata dataset id in a URL, in any of the shapes a person pastes. */
export function socrataIdIn(url: URL): string | null {
  const path = url.pathname
  const patterns = [
    /\/resource\/([a-z0-9]{4}-[a-z0-9]{4})(?:\.[a-z]+)?$/i,
    /\/api\/views\/([a-z0-9]{4}-[a-z0-9]{4})/i,
    /\/d\/([a-z0-9]{4}-[a-z0-9]{4})/i,
    /\/dataset\/[^/]+\/([a-z0-9]{4}-[a-z0-9]{4})/i,
  ]
  for (const re of patterns) {
    const hit = re.exec(path)
    if (hit) return hit[1].toLowerCase()
  }
  return null
}

/**
 * The kind a URL looks like, from its shape alone — no request.
 *
 * Used twice: to decide which metadata endpoint to try first, and to label the
 * links found on a portal page (which we must NOT fetch just to describe).
 */
export function classifyByShape(raw: string | URL): InspectKind | null {
  let url: URL
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw
  } catch {
    return null
  }
  const arcgis = ARCGIS_RE.exec(url.pathname)
  if (arcgis) return arcgis[2] === undefined ? 'arcgis-service' : 'arcgis-layer'
  if (socrataIdIn(url)) return 'socrata'
  if (FILE_EXT_RE.test(url.pathname)) return 'file'
  return null
}

/** http(s), no credentials, no literal address, no name that only resolves
 *  inside a network. Refused here means refused BEFORE any DNS lookup. */
function safeUrl(raw: string | URL): URL | null {
  let url: URL
  try {
    url = typeof raw === 'string' ? new URL(raw.trim()) : new URL(raw.toString())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname || url.username || url.password) return null
  if (isForbiddenHostname(url.hostname) || literalIp(url.hostname)) return null
  return url
}

// --- The probe ---------------------------------------------------------------

interface ProbeResult {
  body: string
  contentType: string
  finalUrl: URL
  /** Size of the whole resource, when the server said. */
  bytes?: number
  truncated: boolean
  status: number
}

/**
 * Options every probe falls back to when the caller passed none.
 *
 * Only tests set these — a route suite can then drive the REAL inspector
 * (real manifests, real catalog rows) against a fake network, the same seam
 * `setPlaceFetchDefaults` and `setLinkFetchDefaults` give their modules.
 * Production leaves it empty and talks to the world.
 */
let inspectDefaults: InspectOptions = {}

export function setInspectDefaults(next: InspectOptions): void {
  inspectDefaults = next
}

export function resetInspectDefaults(): void {
  inspectDefaults = {}
}

function withDefaults(options: InspectOptions): InspectOptions {
  return { ...inspectDefaults, ...options }
}

function httpOptions(options: InspectOptions, extra: Partial<GuardedGetOptions> = {}): GuardedGetOptions {
  return {
    fetchImpl: options.fetchImpl,
    lookup: options.lookup,
    timeoutMs: options.timeoutMs ?? inspectTimeoutMs(),
    maxBytes: options.maxBytes ?? inspectMaxBytes(),
    ...extra,
  }
}

/** `bytes 0-65535/4211234` -> 4211234. */
function totalFromRange(range: string | undefined): number | undefined {
  const hit = /\/(\d+)\s*$/.exec(range ?? '')
  return hit ? Number(hit[1]) : undefined
}

/**
 * One guarded, ranged, truncating GET.
 *
 * The Range header asks for the probe cap rather than the 64 kB sample, so a
 * portal page whose machine-readable block sits below the fold is still read;
 * the column sniffers slice the first 64 kB out of what comes back.
 */
async function probe(url: URL, options: InspectOptions): Promise<ProbeResult> {
  const cap = options.maxBytes ?? inspectMaxBytes()
  const res = await guardedGet(
    url,
    httpOptions(options, {
      truncate: true,
      headers: { range: `bytes=0-${cap - 1}`, accept: 'text/html,application/json,text/csv,*/*' },
    }),
  )
  const total = totalFromRange(res.contentRange) ?? (res.status === 206 ? undefined : res.contentLength)
  return {
    body: res.body,
    contentType: res.contentType,
    finalUrl: res.finalUrl,
    ...(Number.isFinite(total) ? { bytes: total } : {}),
    truncated: res.truncated === true,
    status: res.status,
  }
}

/**
 * A Hub/portal export that is still being generated answers 202 with a body
 * saying so, and the real file only exists on a later call.
 *
 * Found live: the first request for an ArcGIS Hub GeoJSON export returns
 * `{"status":"ExportingData"}`; the second returns 18 MB of features. Reporting
 * "a 227-byte JSON file" for that link would be wrong in a way nobody could
 * debug from the entry page, so we wait and ask again — a bounded number of
 * times, because the caller is a person holding a button down.
 */
export const EXPORT_RETRIES = 2
export const EXPORT_RETRY_MS = 1_500

function isExportPending(res: ProbeResult): boolean {
  if (res.status !== 202) return false
  return /"status"\s*:\s*"(ExportingData|Pending|Processing)"/i.test(res.body) || /generat|prepar|process/i.test(res.body)
}

const wait = (ms: number) => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve())

async function probeJson(url: URL, options: InspectOptions): Promise<any> {
  const res = await guardedGet(url, httpOptions(options, { truncate: true }))
  try {
    return JSON.parse(res.body)
  } catch {
    return null
  }
}

// --- Small readers -----------------------------------------------------------

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, STRING_MAX)
  return trimmed || undefined
}

/** Tags out, entities decoded, whitespace collapsed. ArcGIS descriptions and
 *  portal blurbs are full of markup nobody wants to read in a panel. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
}

/** The bit before the first dash, colon or full stop — a service description
 *  usually starts with the name and then explains itself. */
function leadingName(text: string, fallback: string): string {
  const first = text.split(/\s+[-–—:]\s+|\.\s/)[0]?.trim() ?? ''
  return (first || text.trim() || fallback).slice(0, 160)
}

// --- ArcGIS ------------------------------------------------------------------

const ESRI_GEOMETRY: Record<string, InspectGeometry> = {
  esrigeometrypoint: 'point',
  esrigeometrymultipoint: 'point',
  esrigeometrypolyline: 'line',
  esrigeometryline: 'line',
  esrigeometrypolygon: 'polygon',
  esrigeometryenvelope: 'polygon',
}

function esriGeometry(raw: unknown): InspectGeometry | undefined {
  return typeof raw === 'string' ? ESRI_GEOMETRY[raw.toLowerCase()] : undefined
}

/** Esri field types in words a person (and the source form) can use. */
function esriFieldType(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.toLowerCase()
  if (t.includes('string')) return 'string'
  if (t.includes('date')) return 'date'
  if (/integer|double|single|smallinteger|float/.test(t)) return 'number'
  if (t.includes('oid')) return 'id'
  if (t.includes('globalid') || t.includes('guid')) return 'id'
  if (t.includes('geometry')) return 'geometry'
  return raw.replace(/^esriFieldType/, '').toLowerCase() || undefined
}

/** Web-mercator metres to degrees. A layer that reports its extent in 102100
 *  would otherwise claim to cover the whole world twenty times over. */
export function toLonLat(x: number, y: number): [number, number] {
  const lon = (x / 20037508.34) * 180
  const raw = (y / 20037508.34) * 180
  const lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((raw * Math.PI) / 180)) - Math.PI / 2)
  return [lon, lat]
}

/** The projections we can convert with arithmetic alone. Everything else — a
 *  state plane, a UTM zone — needs a real projection library, and guessing at
 *  one is how 407567 becomes a longitude. */
export const WEB_MERCATOR_WKIDS = new Set([102100, 3857, 900913, 102113, 3785])

function wkidOf(raw: Record<string, unknown>): number | null {
  const sr = raw.spatialReference
  if (!sr || typeof sr !== 'object') return null
  const s = sr as Record<string, unknown>
  const wkid = Number(s.latestWkid ?? s.wkid)
  return Number.isFinite(wkid) ? wkid : null
}

/**
 * An extent as longitude/latitude, or undefined when we cannot honestly say.
 *
 * Degrees are taken as degrees whatever the service claims; Web Mercator is
 * converted; any other projection returns nothing, because a state-plane box
 * read as degrees puts a North Carolina layer somewhere past Neptune.
 */
export function readExtent(raw: unknown): InspectExtent | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const e = raw as Record<string, unknown>
  const nums = [e.xmin, e.ymin, e.xmax, e.ymax].map(Number)
  if (!nums.every(n => Number.isFinite(n))) return undefined
  let [xmin, ymin, xmax, ymax] = nums
  const inDegrees = Math.abs(xmin) <= 180 && Math.abs(xmax) <= 180 && Math.abs(ymin) <= 90 && Math.abs(ymax) <= 90
  if (!inDegrees) {
    const wkid = wkidOf(e)
    if (wkid !== null && !WEB_MERCATOR_WKIDS.has(wkid)) return undefined
    // No spatial reference and out of degree range: Web Mercator is the only
    // projection common enough to assume, and its numbers look like these.
    ;[xmin, ymin] = toLonLat(xmin, ymin)
    ;[xmax, ymax] = toLonLat(xmax, ymax)
    if (Math.abs(xmin) > 180 || Math.abs(ymax) > 90) return undefined
  }
  const round = (n: number) => Math.round(n * 1e6) / 1e6
  return { xmin: round(xmin), ymin: round(ymin), xmax: round(xmax), ymax: round(ymax) }
}

function arcgisFields(raw: unknown): InspectField[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const fields: InspectField[] = []
  for (const item of raw.slice(0, INSPECT_FIELDS_MAX)) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const name = clean(f.name)
    if (!name) continue
    const type = esriFieldType(f.type)
    const alias = clean(f.alias)
    fields.push({ name, ...(type ? { type } : {}), ...(alias && alias !== name ? { alias } : {}) })
  }
  return fields.length ? fields : undefined
}

/**
 * Column names worth asking for a sample value of.
 *
 * Only these: a sample costs one extra request against somebody else's
 * server, and the only decision it changes is "can this column answer a
 * question about a county?" (P5-59). A plain-identifier check comes with it
 * because the name goes into `outFields`.
 */
const FIPS_NAME_RE = /fips|geo_?id/i
const PLAIN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,62}$/
const SAMPLE_FIELDS_MAX = 5

/**
 * One value of each FIPS-shaped column, from a three-row query.
 *
 * Best effort and strictly optional: a layer that refuses simply has no
 * samples, and the proposal falls back to reading the names. `resultRecordCount`
 * is 3 rather than 1 because the first row of a lot of layers is a placeholder
 * with empty ids.
 */
async function arcgisSamples(
  base: URL,
  fields: InspectField[],
  options: InspectOptions,
): Promise<Map<string, string>> {
  const wanted = fields.filter(f => FIPS_NAME_RE.test(f.name) && PLAIN_NAME_RE.test(f.name)).slice(0, SAMPLE_FIELDS_MAX)
  const out = new Map<string, string>()
  if (!wanted.length) return out
  try {
    const url = new URL(`${base.toString().replace(/\/+$/, '')}/query`)
    url.searchParams.set('where', '1=1')
    url.searchParams.set('outFields', wanted.map(f => f.name).join(','))
    url.searchParams.set('returnGeometry', 'false')
    url.searchParams.set('resultRecordCount', '3')
    url.searchParams.set('f', 'json')
    const body = await probeJson(url, options)
    const features: any[] = Array.isArray(body?.features) ? body.features : []
    for (const field of wanted) {
      for (const feature of features) {
        const value = clean(String((feature?.attributes ?? feature?.properties ?? {})[field.name] ?? ''))
        if (value) {
          out.set(field.name, value.slice(0, SAMPLE_MAX))
          break
        }
      }
    }
  } catch {
    /* no samples: the names are all the proposal gets, exactly as before */
  }
  return out
}

/**
 * The organisation a service names as its own, from its attribution text.
 *
 * ArcGIS layers carry no "publisher" field, so without this the proposal falls
 * back to the hostname and a North Carolina parcels layer is published by
 * "services.nconemap.gov" (P5-59, found live). The first clause of the first
 * sentence of `copyrightText` is the owner in nearly every service that fills
 * it in at all; anything longer, or that reads as a licence rather than a
 * name, is left alone — the hostname is at least a fact.
 */
const ORG_WORD_RE =
  /\b(agency|department|dept|division|bureau|office|center|centre|institute|university|college|commission|council|authority|administration|survey|service|services|society|association|foundation|trust|ministry|county|counties|city|state|district|board|government|governments|epa|usda|usgs|noaa|fema|dnr|dot|gis|inc|llc)\b/i
const BOILERPLATE_RE =
  /\b(all rights reserved|no warranty|copyright|for reference only|not for navigation|disclaimer|terms of use|public domain|unknown|none|n\/a)\b|©/i
const ORG_MAX = 60

export function organisationIn(raw: unknown): string | undefined {
  const text = clean(stripTags(String(raw ?? '')))
  if (!text) return undefined
  const sentence = text.split(/[.!?](?:\s|$)|\n/)[0] ?? ''
  const phrase = (sentence.split(/[;,]/)[0] ?? '').trim().replace(/[.\s]+$/, '')
  if (!phrase || phrase.length > ORG_MAX) return undefined
  if (BOILERPLATE_RE.test(phrase)) return undefined
  // A name, not a sentence about the data: it has to contain a word an
  // organisation is actually called by.
  return ORG_WORD_RE.test(phrase) ? phrase : undefined
}

/**
 * Best-effort row count, from the layer's own count query.
 *
 * It has to be asked for: a page of features tells you nothing about the size
 * of the table (a `resultRecordCount=5` request against a 5,533-row match
 * legitimately answers with 3 — ArcGIS pages on its own terms).
 */
async function arcgisCount(base: URL, options: InspectOptions): Promise<number | undefined> {
  try {
    const url = new URL(`${base.toString().replace(/\/+$/, '')}/query`)
    url.searchParams.set('where', '1=1')
    url.searchParams.set('returnCountOnly', 'true')
    url.searchParams.set('f', 'json')
    const body = await probeJson(url, options)
    const count = Number(body?.count)
    return Number.isFinite(count) && count >= 0 ? count : undefined
  } catch {
    return undefined
  }
}

/** The layer's extent in degrees, asked for in degrees.
 *
 *  Used when the layer's own `extent` is in a projection we will not convert
 *  (NC OneMap publishes its parcels extent in EPSG:2264, state plane feet).
 *  ArcGIS will reproject on the way out, so the right move is to ask rather
 *  than to guess. Best effort: a service that refuses simply has no extent. */
async function arcgisExtent(base: URL, options: InspectOptions): Promise<InspectExtent | undefined> {
  try {
    const url = new URL(`${base.toString().replace(/\/+$/, '')}/query`)
    url.searchParams.set('where', '1=1')
    url.searchParams.set('returnExtentOnly', 'true')
    url.searchParams.set('outSR', '4326')
    url.searchParams.set('f', 'json')
    const body = await probeJson(url, options)
    return readExtent(body?.extent ?? body?.fullExtent)
  } catch {
    return undefined
  }
}

// --- Socrata -----------------------------------------------------------------

const SOCRATA_POINT_TYPES = new Set(['point', 'location', 'multipoint', 'multipolygon', 'polygon', 'line', 'multiline'])

/** The "how often is this updated?" free text Socrata portals keep in their
 *  own custom fields, under a name each portal chooses for itself. */
function socrataCadence(view: any): string | undefined {
  const groups = view?.metadata?.custom_fields
  if (!groups || typeof groups !== 'object') return undefined
  for (const group of Object.values(groups as Record<string, unknown>)) {
    if (!group || typeof group !== 'object') continue
    for (const [key, value] of Object.entries(group as Record<string, unknown>)) {
      if (/update|frequency|cadence|refresh/i.test(key)) {
        const text = clean(value)
        if (text) return text
      }
    }
  }
  return undefined
}

// --- HTML --------------------------------------------------------------------

interface LdDataset {
  title?: string
  description?: string
  provider?: string
  license?: string
  cadence?: string
  links: InspectLink[]
}

/** Every `application/ld+json` block on the page, flattened through `@graph`. */
function ldJsonNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    try {
      const parsed = JSON.parse(match[1])
      const list = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const graph = (item as Record<string, unknown>)['@graph']
        if (Array.isArray(graph)) {
          for (const g of graph) if (g && typeof g === 'object') nodes.push(g as Record<string, unknown>)
        }
        nodes.push(item as Record<string, unknown>)
      }
    } catch {
      // A page with broken structured data is still a page.
    }
  }
  return nodes
}

function typeIncludes(node: Record<string, unknown>, wanted: string): boolean {
  const raw = node['@type']
  const list = Array.isArray(raw) ? raw : [raw]
  return list.some(t => typeof t === 'string' && t.toLowerCase() === wanted)
}

function ldString(value: unknown): string | undefined {
  if (typeof value === 'string') return clean(value)
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return clean(o.name) ?? clean(o.url) ?? clean(o['@id'])
  }
  return undefined
}

function readLdDataset(html: string, base: URL): LdDataset | null {
  const node = ldJsonNodes(html).find(n => typeIncludes(n, 'dataset'))
  if (!node) return null
  const links: InspectLink[] = []
  const distributions = Array.isArray(node.distribution) ? node.distribution : []
  for (const dist of distributions) {
    if (!dist || typeof dist !== 'object') continue
    const d = dist as Record<string, unknown>
    const raw = clean(d.contentUrl) ?? clean(d.downloadURL) ?? clean(d.url)
    if (!raw) continue
    const resolved = safeUrl(new URL(raw, base).toString())
    if (!resolved) continue
    const format = clean(d.encodingFormat) ?? clean(d.format) ?? clean(d.fileFormat)
    const label = clean(d.name) ?? format
    const kind = classifyByShape(resolved)
    // P5-61, found live: data.gov publishes schema.org, so these are a TYPED
    // list and the model pass never runs on them — they still need a role.
    const role = roleForLink(format, resolved.toString(), label)
    links.push({
      url: resolved.toString(),
      ...(label ? { label } : {}),
      ...(kind ? { kind } : {}),
      role,
      reason: `Listed in the page’s structured data as a ${format ?? 'distribution'} of this dataset.`,
    })
  }
  return {
    title: ldString(node.name),
    description: ldString(node.description),
    provider: ldString(node.publisher) ?? ldString(node.creator) ?? ldString(node.sourceOrganization),
    license: ldString(node.license),
    cadence: ldString(node.accrualPeriodicity),
    links,
  }
}

/** Anchors on the page that point at something ingestable. Nav, logins and
 *  "about" pages are dropped: a portal listing is a list of DATA. */
function dataAnchors(html: string, base: URL): InspectLink[] {
  const links: InspectLink[] = []
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) && links.length < INSPECT_LINKS_MAX * 2) {
    let resolved: URL | null
    try {
      resolved = safeUrl(new URL(match[1], base).toString())
    } catch {
      continue
    }
    if (!resolved) continue
    const kind = classifyByShape(resolved)
    if (!kind) continue
    const label = stripTags(match[2]).slice(0, 120)
    links.push({ url: resolved.toString(), ...(label ? { label } : {}), kind, role: roleForLink(label, resolved.toString(), label) })
  }
  return links
}

/** One `<meta>` value, in either attribute order.
 *
 *  The quote is CAPTURED and matched rather than guessed: an apostrophe inside
 *  a double-quoted attribute — `content="heirs' property"`, which is most of
 *  what this codebase reads about — used to end the value half way through. */
function metaContent(html: string, name: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*?content=(["'])([\\s\\S]*?)\\1`, 'i')
  const hit = re.exec(html)
  if (hit) return clean(decodeEntities(hit[2]))
  const reversed = new RegExp(`<meta[^>]+content=(["'])([\\s\\S]*?)\\1[^>]*?(?:name|property)=["']${name}["']`, 'i')
  const back = reversed.exec(html)
  return back ? clean(decodeEntities(back[2])) : undefined
}

/** Hosts whose pages are catalogues by definition. */
const PORTAL_HOST_RE = /(^|\.)hub\.arcgis\.com$|(^|\.)data\.gov$|(^|\.)opendata\.|^opendata\.|(^|\.)socrata\.com$/i

// --- CKAN --------------------------------------------------------------------

/**
 * CKAN portals answer for themselves, so we stop scraping them (P5-61).
 *
 * data.gov and most state open-data portals run CKAN, and every CKAN dataset
 * page has an API behind it that returns the same record as structured data:
 * the title, the notes, the publishing organisation, the licence, the tags,
 * and — the part that matters — `resources[]`, each with a name, a format and
 * a URL. Those ARE the data links, declared by the publisher, so they need no
 * model pass and no guessing from anchor text.
 *
 * The HTML scrape stays as the fallback: a page that looks like CKAN and
 * whose API refuses is still a page we can read anchors off.
 */

/** `/dataset/<slug>` — CKAN's canonical dataset path. */
const CKAN_DATASET_RE = /\/dataset\/([a-z0-9][a-z0-9._-]{0,120})\/?$/i

/** CKAN's own pages live under the same prefix and are not datasets. */
const CKAN_RESERVED = new Set(['new', 'edit', 'activity', 'groups', 'about', 'search'])

export function ckanSlugIn(url: URL): string | null {
  const hit = CKAN_DATASET_RE.exec(url.pathname)
  if (!hit) return null
  const slug = decodeURIComponent(hit[1])
  return CKAN_RESERVED.has(slug.toLowerCase()) ? null : slug
}

/** A declared format — CKAN's `format`, schema.org's `encodingFormat`, a
 *  portal's link label — in the role vocabulary the prune uses. */
const ROLE_BY_FORMAT: Record<string, LinkRole> = {
  csv: 'data-file',
  tsv: 'data-file',
  xlsx: 'data-file',
  xls: 'data-file',
  zip: 'data-file',
  geojson: 'data-file',
  json: 'data-file',
  xml: 'data-file',
  kml: 'data-file',
  kmz: 'data-file',
  shp: 'data-file',
  shapefile: 'data-file',
  parquet: 'data-file',
  'esri rest': 'service-layer',
  arcgis_geoservices_rest_api: 'service-layer',
  wms: 'service-layer',
  wfs: 'service-layer',
  api: 'api',
  'socrata csv': 'api',
  pdf: 'docs',
  doc: 'docs',
  docx: 'docs',
  html: 'landing',
  // schema.org and rel=alternate spell them as media types; the lookup strips
  // the `application/` or `text/` prefix before it gets here.
  'geo+json': 'data-file',
  'vnd.geo+json': 'data-file',
  'vnd.ms-excel': 'data-file',
  'vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'data-file',
  'x-zip-compressed': 'data-file',
  'vnd.google-earth.kml+xml': 'data-file',
  plain: 'data-file',
}

/**
 * A role for a link NOBODY pruned: a CKAN resource, a schema.org
 * distribution, a Hub export, an anchor off a portal page.
 *
 * Found live: data.gov pages carry schema.org JSON-LD, so their distributions
 * are a TYPED list and the model pass is skipped — and the entry showed three
 * downloads with no role at all (`[?]`). A declared format and a URL shape are
 * enough to say what each one is, and a typed list deserves the same badges as
 * a pruned one.
 *
 * An ArcGIS URL is a service layer whatever the portal typed; after that the
 * declared format wins over the URL shape, because a Socrata
 * `rows.csv?accessType=DOWNLOAD` is a FILE served by a Socrata host and
 * calling it an API would send an adapter at the wrong endpoint.
 */
export function roleForLink(format: string | undefined, url: string, label?: string): LinkRole {
  const shape = classifyByShape(url)
  if (shape === 'arcgis-layer' || shape === 'arcgis-service') return 'service-layer'
  const declared = ROLE_BY_FORMAT[(format ?? '').trim().toLowerCase().replace(/^application\/|^text\//, '')]
  // P5-62: a portal that declares `format: "API"` on a link to its developer
  // page has told us what it WISHES the link were. The same correction the
  // model's answers get: `api` only for an address a program could call.
  if (declared) return correctedRole(declared, { url, ...(label ? { label } : {}) })
  // A dataset's own page on a Socrata portal is where a person lands, not the
  // endpoint a program calls.
  if (/\/d\/[a-z0-9]{4}-[a-z0-9]{4}|\/about_data\/?$/i.test(new URL(url).pathname)) return 'landing'
  if (shape === 'socrata') return 'api'
  if (shape === 'file') return 'data-file'
  if (isDirectoryUrl(url)) return 'directory'
  if (looksLikeViewer(url, label ?? '')) return 'viewer'
  return 'landing'
}

/** The "how often" CKAN portals bury in `extras[]` under a name each one
 *  chooses for itself. */
function ckanCadence(pkg: Record<string, unknown>): string | undefined {
  const extras = Array.isArray(pkg.extras) ? pkg.extras : []
  for (const item of extras) {
    if (!item || typeof item !== 'object') continue
    const extra = item as Record<string, unknown>
    const key = clean(extra.key) ?? ''
    if (/frequency|periodicity|cadence|update/i.test(key)) {
      const value = clean(extra.value)
      if (value) return value
    }
  }
  return clean(pkg.frequency) ?? clean(pkg.accrual_periodicity)
}

function ckanTopics(pkg: Record<string, unknown>): string[] | undefined {
  const raw = Array.isArray(pkg.tags) ? pkg.tags : []
  const out: string[] = []
  for (const item of raw.slice(0, 40)) {
    const name = typeof item === 'string' ? clean(item) : clean((item as Record<string, unknown>)?.name)
    if (name && !out.includes(name)) out.push(name)
    if (out.length >= 20) break
  }
  return out.length ? out : undefined
}

/**
 * Read a CKAN dataset page through its API. Null when this is not one — the
 * caller then scrapes the HTML exactly as it did before.
 */
/**
 * The package record behind a `/dataset/<slug>` page, by either route.
 *
 * `package_show?id=<slug>` is the direct one and answers for most portals.
 * Found live on 2026-09-06: data.gov answers it **404 `{"message":"Not
 * Found"}`** for a dataset whose page renders perfectly — the site's own
 * `name` and the URL's slug have drifted apart. `package_search?fq=name:<slug>`
 * finds it anyway, so it is tried before we give up and scrape the HTML.
 */
async function ckanPackage(origin: string, slug: string, options: InspectOptions): Promise<Record<string, unknown> | null> {
  const show = new URL(`${origin}/api/3/action/package_show`)
  show.searchParams.set('id', slug)
  try {
    const body: any = await probeJson(show, options)
    if (body && typeof body === 'object' && body.success === true) {
      const pkg = body.result
      if (pkg && typeof pkg === 'object' && !Array.isArray(pkg)) return pkg as Record<string, unknown>
    }
  } catch {
    // A refusal, a site that is not CKAN at all: the search still gets a turn.
  }
  const search = new URL(`${origin}/api/3/action/package_search`)
  search.searchParams.set('fq', `name:${slug}`)
  search.searchParams.set('rows', '1')
  try {
    const body: any = await probeJson(search, options)
    if (!body || typeof body !== 'object' || body.success !== true) return null
    const first = Array.isArray(body.result?.results) ? body.result.results[0] : undefined
    if (!first || typeof first !== 'object' || Array.isArray(first)) return null
    // A search matches loosely; only the dataset whose name IS this slug is
    // the page we are looking at.
    const name = clean((first as Record<string, unknown>).name)
    return name && name.toLowerCase() === slug.toLowerCase() ? (first as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function inspectCkan(url: URL, options: InspectOptions, notes: string[]): Promise<Partial<Inspection> | null> {
  const slug = ckanSlugIn(url)
  if (!slug) return null
  const record = await ckanPackage(url.origin, slug, options)
  if (!record) return null

  const links: InspectLink[] = []
  const formats = new Set<string>()
  const resources = Array.isArray(record.resources) ? record.resources : []
  for (const item of resources) {
    if (links.length >= KEPT_LINKS_MAX) break
    if (!item || typeof item !== 'object') continue
    const resource = item as Record<string, unknown>
    const href = safeUrl(clean(resource.url) ?? '')
    if (!href || href.protocol !== 'https:') continue
    const format = clean(resource.format)
    const label = clean(resource.name) ?? format ?? basename(href)
    const description = clean(resource.description)
    const kind = classifyByShape(href)
    if (format) formats.add(format.toLowerCase())
    links.push({
      url: href.toString(),
      ...(label ? { label } : {}),
      ...(kind ? { kind } : {}),
      role: roleForLink(format, href.toString(), label),
      // The publisher's own words about the resource, not a model's guess.
      reason: description
        ? description.slice(0, 200)
        : `Listed by the portal as a ${format ?? 'resource'} of this dataset.`,
    })
  }

  const organisation = record.organization as Record<string, unknown> | undefined
  const provider = clean(organisation?.title) ?? clean(organisation?.name) ?? clean(record.author) ?? clean(record.maintainer)
  const description = clean(stripTags(String(record.notes ?? '')))
  const cadence = ckanCadence(record)
  const license = clean(record.license_title) ?? clean(record.license_id)
  const topics = ckanTopics(record)
  if (!links.length) notes.push('The portal lists this dataset but offers no https download we recognise.')

  return {
    kind: 'portal',
    confidence: links.length ? 'high' : 'medium',
    url: url.toString(),
    finalUrl: url.toString(),
    platform: 'ckan',
    ...(clean(record.title) ? { title: clean(record.title) } : {}),
    ...(provider ? { provider } : {}),
    ...(description ? { description } : {}),
    // No `candidates`/`pruned`: nothing was harvested and nothing was thrown
    // away — the publisher declared these, so there is no "left out" to
    // report and no ranking to caveat.
    ...(links.length ? { links } : {}),
    ...(formats.size ? { formats: [...formats].slice(0, 8) } : {}),
    ...(cadence ? { cadence } : {}),
    ...(topics ? { topics } : {}),
    ...(license ? { license } : {}),
    ...(notes.length ? { notes: notes.slice(0, INSPECT_NOTES_MAX) } : {}),
  }
}

/** The last path segment of a URL, for a resource with no name. */
function basename(url: URL): string | undefined {
  const parts = url.pathname.split('/').filter(Boolean)
  return parts[parts.length - 1] || undefined
}

// --- Column sniffers ---------------------------------------------------------

/** Column names from the head of a delimited file. */
export function csvColumns(sample: string, delimiter?: string): InspectField[] | undefined {
  const parsed = Papa.parse<string[]>(sample, { preview: 1, skipEmptyLines: true, ...(delimiter ? { delimiter } : {}) })
  const header = parsed.data?.[0]
  if (!Array.isArray(header)) return undefined
  const fields = header
    .map(name => (typeof name === 'string' ? name.trim() : ''))
    .filter(Boolean)
    .slice(0, INSPECT_FIELDS_MAX)
    .map(name => ({ name }))
  return fields.length ? fields : undefined
}

/** The object that starts at `from` in `text`, by brace matching. A truncated
 *  sample never parses as a whole, but its first feature usually does. */
function objectAt(text: string, from: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return null
}

/** Property names and the geometry type from the head of a GeoJSON (or from a
 *  plain array of records). Defensive: the sample is usually cut mid-file. */
export function jsonColumns(sample: string): { fields?: InspectField[]; geometry?: InspectGeometry } {
  const out: { fields?: InspectField[]; geometry?: InspectGeometry } = {}
  // A `crs` member is `{"type":"name","properties":{"name":"EPSG:3857"}}` — it
  // has a `properties` object of its own, so the search for the FEATURE's
  // properties starts after `"features"` whenever the file has one.
  const featuresAt = sample.search(/"features"\s*:\s*\[/)
  const from = featuresAt === -1 ? 0 : featuresAt
  const geomAt = sample.indexOf('"geometry"', from)
  if (geomAt !== -1) {
    const type = /"type"\s*:\s*"([A-Za-z]+)"/.exec(sample.slice(geomAt, geomAt + 400))?.[1]?.toLowerCase()
    if (type) {
      if (type.includes('point')) out.geometry = 'point'
      else if (type.includes('linestring')) out.geometry = 'line'
      else if (type.includes('polygon')) out.geometry = 'polygon'
    }
  }
  const propsRe = /"properties"\s*:\s*\{/g
  propsRe.lastIndex = from
  const propsAt = propsRe.exec(sample)?.index ?? -1
  const start = propsAt === -1 ? sample.indexOf('{', sample.indexOf('[') + 1) : sample.indexOf('{', propsAt)
  if (start !== -1) {
    const chunk = objectAt(sample, start)
    if (chunk) {
      try {
        const parsed = JSON.parse(chunk)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const names = Object.keys(parsed).slice(0, INSPECT_FIELDS_MAX)
          if (names.length) out.fields = names.map(name => ({ name }))
        }
      } catch {
        // Cut mid-object: no columns rather than a wrong guess.
      }
    }
  }
  return out
}

// --- Formats -----------------------------------------------------------------

const FORMAT_BY_CONTENT_TYPE: Record<string, string> = {
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'application/geo+json': 'geojson',
  'application/vnd.geo+json': 'geojson',
  'application/json': 'json',
  'text/json': 'json',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/pdf': 'pdf',
  'application/vnd.google-earth.kml+xml': 'kml',
  'application/geopackage+sqlite3': 'gpkg',
}

/** Content types that mean "some bytes" and nothing more: a portal serving an
 *  export this way is telling us to look at the bytes ourselves. */
const OPAQUE_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'text/plain', ''])

/** A final path segment that names a format: Hub's export URLs end `/geojson`
 *  rather than `.geojson`. */
const FORMAT_SEGMENT = new Set(['csv', 'tsv', 'json', 'geojson', 'zip', 'xlsx', 'kml', 'shapefile'])

function formatFor(contentType: string, url: URL): string | undefined {
  const byType = FORMAT_BY_CONTENT_TYPE[contentType]
  if (byType) return byType
  const ext = FILE_EXT_RE.exec(url.pathname)?.[1]?.toLowerCase()
  if (ext) return ext === 'txt' ? 'text' : ext
  const segment = url.pathname.replace(/\/+$/, '').split('/').pop()?.toLowerCase()
  if (segment && FORMAT_SEGMENT.has(segment)) return segment === 'shapefile' ? 'zip' : segment
  return undefined
}

/**
 * The format from the BYTES, for the many servers that will not say.
 *
 * Found live: an ArcGIS Hub GeoJSON export arrives as
 * `content-type: application/octet-stream`. Trusting the header there would
 * file 18 MB of features as "an unknown download".
 */
export function sniffFormat(sample: string): string | undefined {
  const head = sample.slice(0, 4096).trimStart()
  if (!head) return undefined
  if (head.startsWith('PK\u0003\u0004') || head.startsWith('PK')) return 'zip'
  if (head.startsWith('%PDF')) return 'pdf'
  if (head.startsWith('{') || head.startsWith('[')) {
    return /"type"\s*:\s*"(FeatureCollection|Feature)"/.test(sample.slice(0, 64 * 1024)) ? 'geojson' : 'json'
  }
  if (head.startsWith('<')) return undefined // html/xml: handled before we get here
  // A header row: commas or tabs, no angle brackets, and more than one column.
  const firstLine = head.split(/\r?\n/)[0] ?? ''
  if (firstLine.includes('\t') && firstLine.split('\t').length > 1) return 'tsv'
  if (firstLine.includes(',') && firstLine.split(',').length > 1 && !firstLine.includes('<')) return 'csv'
  return undefined
}

/** The `crs` member a GeoJSON may carry. Only reported when it is NOT WGS84 —
 *  4326 is the format's default and saying so would just be noise. */
export function declaredCrs(sample: string): string | undefined {
  const hit = /"crs"\s*:\s*\{[^{}]*"properties"\s*:\s*\{[^{}]*"name"\s*:\s*"([^"]+)"/.exec(sample.slice(0, 8192))
  const name = hit?.[1]
  if (!name) return undefined
  return /(^|:)(4326|CRS84)$/i.test(name) ? undefined : name
}

function isHtml(contentType: string, body: string): boolean {
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return true
  return !contentType && /^\s*<(!doctype html|html)\b/i.test(body)
}

// --- Extent labels -----------------------------------------------------------

/**
 * Approximate bounding boxes, west/south/east/north. Good to a fraction of a
 * degree, which is all a LABEL needs — nothing is filtered or joined on these,
 * they only turn an extent into the words "Georgia" or "national".
 */
const STATE_EXTENTS: [string, number, number, number, number][] = [
  ['Alabama', -88.5, 30.2, -84.9, 35.0],
  ['Alaska', -168.1, 54.6, -129.9, 71.4],
  ['Arizona', -114.8, 31.3, -109.0, 37.0],
  ['Arkansas', -94.6, 33.0, -89.6, 36.5],
  ['California', -124.4, 32.5, -114.1, 42.0],
  ['Colorado', -109.1, 37.0, -102.0, 41.0],
  ['Connecticut', -73.7, 40.9, -71.8, 42.1],
  ['Delaware', -75.8, 38.4, -75.0, 39.8],
  ['District of Columbia', -77.12, 38.79, -76.91, 39.0],
  ['Florida', -87.6, 24.4, -80.0, 31.0],
  ['Georgia', -85.6, 30.3, -80.8, 35.0],
  ['Hawaii', -160.3, 18.9, -154.8, 22.3],
  ['Idaho', -117.2, 42.0, -111.0, 49.0],
  ['Illinois', -91.5, 36.9, -87.0, 42.5],
  ['Indiana', -88.1, 37.8, -84.8, 41.8],
  ['Iowa', -96.6, 40.4, -90.1, 43.5],
  ['Kansas', -102.1, 37.0, -94.6, 40.0],
  ['Kentucky', -89.6, 36.5, -81.9, 39.1],
  ['Louisiana', -94.0, 28.9, -88.8, 33.0],
  ['Maine', -71.1, 43.1, -66.9, 47.5],
  ['Maryland', -79.5, 37.9, -75.0, 39.7],
  ['Massachusetts', -73.5, 41.2, -69.9, 42.9],
  ['Michigan', -90.4, 41.7, -82.4, 48.3],
  ['Minnesota', -97.2, 43.5, -89.5, 49.4],
  ['Mississippi', -91.7, 30.2, -88.1, 35.0],
  ['Missouri', -95.8, 36.0, -89.1, 40.6],
  ['Montana', -116.1, 44.4, -104.0, 49.0],
  ['Nebraska', -104.1, 40.0, -95.3, 43.0],
  ['Nevada', -120.0, 35.0, -114.0, 42.0],
  ['New Hampshire', -72.6, 42.7, -70.6, 45.3],
  ['New Jersey', -75.6, 38.9, -73.9, 41.4],
  ['New Mexico', -109.1, 31.3, -103.0, 37.0],
  ['New York', -79.8, 40.5, -71.9, 45.0],
  ['North Carolina', -84.3, 33.8, -75.5, 36.6],
  ['North Dakota', -104.1, 45.9, -96.6, 49.0],
  ['Ohio', -84.8, 38.4, -80.5, 42.0],
  ['Oklahoma', -103.0, 33.6, -94.4, 37.0],
  ['Oregon', -124.6, 42.0, -116.5, 46.3],
  ['Pennsylvania', -80.5, 39.7, -74.7, 42.3],
  ['Puerto Rico', -67.3, 17.9, -65.2, 18.6],
  ['Rhode Island', -71.9, 41.1, -71.1, 42.0],
  ['South Carolina', -83.4, 32.0, -78.5, 35.2],
  ['South Dakota', -104.1, 42.5, -96.4, 45.9],
  ['Tennessee', -90.3, 35.0, -81.6, 36.7],
  ['Texas', -106.6, 25.8, -93.5, 36.5],
  ['Utah', -114.1, 37.0, -109.0, 42.0],
  ['Vermont', -73.4, 42.7, -71.5, 45.0],
  ['Virginia', -83.7, 36.5, -75.2, 39.5],
  ['Washington', -124.8, 45.5, -116.9, 49.0],
  ['West Virginia', -82.6, 37.2, -77.7, 40.6],
  ['Wisconsin', -92.9, 42.5, -86.8, 47.1],
  ['Wyoming', -111.1, 41.0, -104.1, 45.0],
]

function area(w: number, s: number, e: number, n: number): number {
  return Math.max(0, e - w) * Math.max(0, n - s)
}

/**
 * An extent in words: "national" when it spans the lower 48, a state's name
 * when it is close enough to that state's box, "regional" otherwise.
 *
 * Deliberately fuzzy — this is the difference between a panel that says
 * "Georgia extent" and one that says four decimal numbers.
 */
export function extentLabel(extent: InspectExtent | undefined): string | null {
  if (!extent) return null
  const { xmin, ymin, xmax, ymax } = extent
  if (xmin <= -115 && xmax >= -75 && ymin <= 28 && ymax >= 45) return 'national'
  let best: { name: string; score: number } | null = null
  for (const [name, w, s, e, n] of STATE_EXTENTS) {
    const overlap = area(Math.max(w, xmin), Math.max(s, ymin), Math.min(e, xmax), Math.min(n, ymax))
    if (overlap <= 0) continue
    const union = area(w, s, e, n) + area(xmin, ymin, xmax, ymax) - overlap
    const score = union > 0 ? overlap / union : 0
    if (!best || score > best.score) best = { name, score }
  }
  // Half the combined box has to be shared before we put a state's name on it.
  return best && best.score >= 0.5 ? best.name : 'regional'
}

// --- The inspection ----------------------------------------------------------

const KIND_WORDS: Record<InspectKind, string> = {
  'arcgis-layer': 'ArcGIS layer',
  'arcgis-service': 'ArcGIS service',
  socrata: 'Socrata dataset',
  file: 'file',
  portal: 'data portal page',
  page: 'web page',
  unreachable: 'unreachable',
}

/** Why a probe failed, in words for the person who dropped the link. */
function failureNote(err: unknown): string {
  if (err instanceof PlaceFetchError) {
    switch (err.code) {
      case 'not-public':
        return 'That is not a public address, so we did not call it.'
      case 'bad-scheme':
        return 'That link does not point at a web page.'
      case 'http-error':
        return 'The site refused the request.'
      case 'too-many-redirects':
        return 'The link kept redirecting somewhere else.'
      case 'timeout':
        return 'We could not reach the site in time.'
      case 'too-large':
        return 'The answer was too big to look at.'
      default:
        return 'We could not reach that site.'
    }
  }
  return 'We could not reach that site.'
}

function unreachable(url: string, notes: string[]): Inspection {
  return { kind: 'unreachable', confidence: 'high', url, notes: notes.slice(0, INSPECT_NOTES_MAX), checkedAt: new Date().toISOString() }
}

/**
 * Look at one URL and say what it is.
 *
 * Never throws: a link that cannot be reached is an ANSWER ("unreachable"),
 * because the queue runs this on every drop and a refused host must not cost
 * the drop its fetch.
 */
export async function inspectUrl(raw: string | URL, rawOptions: InspectOptions = {}): Promise<Inspection> {
  const options = withDefaults(rawOptions)
  const asText = typeof raw === 'string' ? raw.trim() : raw.toString()
  const url = safeUrl(raw)
  if (!url) {
    return unreachable(asText, ['That is not a public http(s) link we can look at.'])
  }
  const notes: string[] = []
  const checkedAt = () => new Date().toISOString()

  // (a) ArcGIS, by URL shape: the service answers for itself at `?f=json`.
  const arcgis = ARCGIS_RE.exec(url.pathname)
  if (arcgis) {
    const found = await inspectArcgis(url, arcgis[2], options, notes)
    if (found) return found
  }

  // (b) Socrata, by the 4-4 id in any of its URL shapes.
  const socrataId = socrataIdIn(url)
  if (socrataId) {
    const found = await inspectSocrata(url, socrataId, options, notes)
    if (found) return found
  }

  // (c)/(d) Everything else: one ranged read tells us the content type, the
  // size, and — for the formats we can read — the column names. An export the
  // portal is still building answers 202 and is asked for again.
  let res: ProbeResult
  const retryMs = options.retryDelayMs ?? EXPORT_RETRY_MS
  try {
    res = await probe(url, options)
    for (let attempt = 0; attempt < EXPORT_RETRIES && isExportPending(res); attempt++) {
      await wait(retryMs * (attempt + 1))
      res = await probe(url, options)
    }
  } catch (err) {
    return unreachable(url.toString(), [...notes, failureNote(err)])
  }
  if (isExportPending(res)) {
    return {
      kind: 'file',
      confidence: 'low',
      url: url.toString(),
      finalUrl: res.finalUrl.toString(),
      notes: [...notes, 'The portal was still preparing the export — try again in a minute.'].slice(0, INSPECT_NOTES_MAX),
      checkedAt: checkedAt(),
    }
  }

  const base = {
    url: url.toString(),
    finalUrl: res.finalUrl.toString(),
    ...(res.contentType ? { contentType: res.contentType } : {}),
    ...(res.bytes !== undefined ? { bytes: res.bytes } : {}),
    checkedAt: checkedAt(),
  }

  if (isHtml(res.contentType, res.body)) {
    // P5-79: the floor, read once from the page's own head and carried by
    // every branch below. A page's title and description do not depend on a
    // model pass, so neither should an entry's.
    const ld = readLdDataset(res.body, res.finalUrl)
    const floor = readPageBlock(res.body, res.finalUrl, ld)
    const page = floor ? { page: floor } : {}

    // P5-61: a CKAN portal answers for itself. `/dataset/<slug>` plus an API
    // that confirms it means the publisher's own resource list, which beats
    // anything we could scrape or prune out of the HTML.
    const ckan = await inspectCkan(url, options, notes)
    if (ckan) return { ...base, ...ckan, ...page, checkedAt: checkedAt() } as Inspection

    const read = readPage(res, url, notes, ld)
    // An ArcGIS Hub dataset page renders its downloads in the browser, so the
    // HTML we can see carries a title and nothing else. Hub publishes the same
    // record as JSON; asking for that is the difference between "portal with
    // three downloads" and "page with nothing on it".
    if (!read.links?.length) {
      const hub = await inspectHubDataset(url, options)
      if (hub) {
        const { typedLinks: _typed, ...rest } = read
        return { ...base, ...rest, ...hub, ...page, title: hub.title ?? rest.title, checkedAt: checkedAt() } as Inspection
      }
    }
    // P5-61: everything else — a prose page, a portal we do not recognise —
    // gets its links harvested and pruned.
    const harvested = await harvestAndPrune(res, read, options)
    if (harvested.prune) {
      // The pruned answer REPLACES the raw anchor list, including when it kept
      // nothing: "none of these forty links is the data" is the most useful
      // thing this pass can say about a navigation page, and leaving the
      // anchors in would undo it.
      delete read.links
      Object.assign(read, harvested.prune)
    }
    // P5-80: the page's own documents are a separate list from its data links
    // and survive the prune — nothing about a model pass decides whether a
    // page offers thirty landowner profiles as PDFs.
    if (harvested.documents?.length) read.documents = harvested.documents
    const { typedLinks: _typedLinks, ...rest } = read
    return { ...base, ...rest, ...page, checkedAt: checkedAt() }
  }

  const sample = res.body.slice(0, INSPECT_SAMPLE_BYTES)
  // The header is the first word, but not the last: a portal that serves a
  // GeoJSON export as octet-stream is describing its plumbing, not the file.
  const declared = formatFor(res.contentType, res.finalUrl) ?? formatFor(res.contentType, url)
  const sniffed = sniffFormat(sample)
  const format = OPAQUE_TYPES.has(res.contentType) ? (sniffed ?? declared) : (declared ?? sniffed)
  const file: Inspection = {
    ...base,
    kind: 'file',
    confidence: format ? 'high' : 'low',
    ...(format ? { formats: [format] } : {}),
  }
  if (declared && sniffed && declared !== sniffed && sniffed !== 'json') {
    notes.push(`The site called this ${declared}, but the file reads as ${sniffed}.`)
  }
  if (format === 'csv' || format === 'tsv') {
    const fields = csvColumns(sample, format === 'tsv' ? '\t' : undefined)
    if (fields) file.fields = fields
    file.geometry = 'table'
  } else if (format === 'geojson' || format === 'json') {
    const read = jsonColumns(sample)
    if (read.fields) file.fields = read.fields
    file.geometry = read.geometry ?? 'table'
    // A .json that carries features is GeoJSON however it is served.
    if (read.geometry && format === 'json') file.formats = ['geojson']
    const crs = declaredCrs(sample)
    if (crs) {
      file.crs = crs
      notes.push(`Coordinates are in ${crs}, not latitude and longitude — they have to be reprojected before this can be mapped.`)
    }
  } else if (format === 'zip') {
    notes.push('A zip — probably a shapefile. Someone has to open it before we know its columns.')
  } else if (format === 'xlsx' || format === 'xls') {
    notes.push('A spreadsheet. Its columns are inside the workbook, so someone has to open it.')
  } else if (format === 'pdf') {
    notes.push('A PDF — a document rather than a table.')
  } else if (!format) {
    notes.push('The site did not say what kind of file this is.')
  }
  if (res.truncated) notes.push('Only the first part of the file was read — a probe never downloads the data.')
  if (notes.length) file.notes = notes.slice(0, INSPECT_NOTES_MAX)
  return file
}

async function inspectArcgis(
  url: URL,
  layerId: string | undefined,
  options: InspectOptions,
  notes: string[],
): Promise<Inspection | null> {
  const base = new URL(url.toString())
  base.search = ''
  base.hash = ''
  const metaUrl = new URL(base.toString())
  metaUrl.searchParams.set('f', 'json')

  let body: any
  try {
    body = await probeJson(metaUrl, options)
  } catch (err) {
    // A FeatureServer path that will not answer is not an ArcGIS layer as far
    // as we are concerned; the generic probe gets its turn.
    notes.push(failureNote(err))
    return null
  }
  if (!body || typeof body !== 'object') {
    notes.push('That ArcGIS address did not answer with service metadata.')
    return null
  }
  if (body.error) {
    const message = clean(body.error?.message) ?? 'the service refused the request'
    notes.push(`ArcGIS said: ${message}.`)
    return null
  }

  const checkedAt = new Date().toISOString()
  const pathName = base.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
  const serviceName = pathName[pathName.length - (layerId === undefined ? 2 : 3)] ?? base.hostname

  if (layerId === undefined) {
    const layersRaw = Array.isArray(body.layers) ? body.layers : []
    const layers: InspectLayerRef[] = []
    for (const item of layersRaw.slice(0, INSPECT_LAYERS_MAX)) {
      if (!item || typeof item !== 'object') continue
      const l = item as Record<string, unknown>
      const id = Number(l.id)
      const name = clean(l.name)
      if (!Number.isFinite(id) || !name) continue
      const geometry = esriGeometry(l.geometryType)
      layers.push({
        id,
        name,
        url: `${base.toString().replace(/\/+$/, '')}/${id}`,
        ...(geometry ? { geometry } : {}),
      })
    }
    if (!layers.length && !body.serviceDescription && !body.currentVersion) return null
    const description = clean(stripTags(String(body.serviceDescription ?? '')))
    // Who publishes it, when the service says so in words (P5-59).
    const owner = organisationIn(body.copyrightText) ?? organisationIn(body.serviceDescription)
    const tables = Array.isArray(body.tables) ? body.tables.length : 0
    if (tables) notes.push(`It also has ${tables} table${tables === 1 ? '' : 's'} with no map geometry.`)
    if (!layers.length) notes.push('This service lists no layers we can read.')
    return {
      kind: 'arcgis-service',
      confidence: layers.length ? 'high' : 'medium',
      url: url.toString(),
      finalUrl: base.toString(),
      title: description ? leadingName(description, serviceName) : serviceName,
      ...(owner ? { provider: owner } : {}),
      ...(description ? { description } : {}),
      ...(clean(body.copyrightText) ? { license: clean(stripTags(String(body.copyrightText))) } : {}),
      ...(layers.length ? { layers } : {}),
      ...(notes.length ? { notes: notes.slice(0, INSPECT_NOTES_MAX) } : {}),
      checkedAt,
    }
  }

  const fields = arcgisFields(body.fields)
  const geometry = esriGeometry(body.geometryType) ?? 'table'
  if (!fields && !body.name) {
    notes.push('That ArcGIS address answered, but not with a layer we can read.')
    return null
  }
  const description = clean(stripTags(String(body.description ?? '')))
  const license = clean(stripTags(String(body.copyrightText ?? body.licenseInfo ?? '')))
  // One value of each FIPS-shaped column, so the proposal can tell a county
  // key from a tract key instead of guessing from the name (P5-59).
  if (fields) {
    const samples = await arcgisSamples(base, fields, options)
    for (const field of fields) {
      const sample = samples.get(field.name)
      if (sample) field.sample = sample
    }
  }
  const provider = organisationIn(body.copyrightText) ?? organisationIn(body.description)
  const rowCount = await arcgisCount(base, options)
  // The layer's own extent when it is already in degrees (or Web Mercator);
  // otherwise ask the layer to reproject it for us rather than drop it.
  let extent = readExtent(body.extent)
  if (!extent && body.extent) {
    extent = await arcgisExtent(base, options)
    if (!extent) notes.push('The service reports its extent in a projection we do not convert, so coverage is unknown.')
  }
  return {
    kind: 'arcgis-layer',
    confidence: 'high',
    url: url.toString(),
    finalUrl: base.toString(),
    title: clean(body.name) ?? serviceName,
    ...(provider ? { provider } : {}),
    ...(description ? { description } : {}),
    ...(fields ? { fields } : {}),
    geometry,
    ...(extent ? { extent } : {}),
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(license ? { license } : {}),
    ...(notes.length ? { notes: notes.slice(0, INSPECT_NOTES_MAX) } : {}),
    checkedAt: new Date().toISOString(),
  }
}

async function inspectSocrata(
  url: URL,
  id: string,
  options: InspectOptions,
  notes: string[],
): Promise<Inspection | null> {
  const metaUrl = new URL(`https://${url.host}/api/views/${id}.json`)
  let view: any
  try {
    view = await probeJson(metaUrl, options)
  } catch (err) {
    // A 4-4 id in a path is a weak signal — plenty of sites have one by
    // accident. A views API that does not answer means this is not Socrata.
    notes.push(failureNote(err))
    return null
  }
  if (!view || typeof view !== 'object' || !Array.isArray(view.columns)) {
    notes.push('That looked like a Socrata id, but the portal has no dataset by that name.')
    return null
  }

  const fields: InspectField[] = []
  let geometry: InspectGeometry = 'table'
  let rowCount: number | undefined
  for (const item of view.columns.slice(0, INSPECT_FIELDS_MAX)) {
    if (!item || typeof item !== 'object') continue
    const col = item as Record<string, unknown>
    const name = clean(col.fieldName) ?? clean(col.name)
    if (!name) continue
    const type = clean(col.dataTypeName)
    const alias = clean(col.name)
    if (type && SOCRATA_POINT_TYPES.has(type.toLowerCase())) {
      geometry = type.toLowerCase().includes('polygon') ? 'polygon' : type.toLowerCase().includes('line') ? 'line' : 'point'
    }
    const cached = col.cachedContents as Record<string, unknown> | undefined
    let sample: string | undefined
    if (cached) {
      const total = Number(cached.non_null ?? 0) + Number(cached.null ?? 0)
      if (Number.isFinite(total) && total > (rowCount ?? 0)) rowCount = total
      // Socrata ships the commonest values with the metadata, so one real
      // value of every column is free — and it is what tells a county key
      // from a tract key (P5-59).
      const top = Array.isArray(cached.top) ? (cached.top[0] as Record<string, unknown> | undefined) : undefined
      const item = top && typeof top === 'object' ? top.item : undefined
      if (typeof item === 'string' || typeof item === 'number') sample = clean(String(item))?.slice(0, SAMPLE_MAX)
    }
    fields.push({
      name,
      ...(type ? { type } : {}),
      ...(alias && alias !== name ? { alias } : {}),
      ...(sample ? { sample } : {}),
    })
  }

  const license = clean(view.license?.name) ?? clean(view.licenseId)
  return {
    kind: 'socrata',
    confidence: 'high',
    url: url.toString(),
    // The resource endpoint: what an adapter would actually call.
    finalUrl: `https://${url.host}/resource/${id}.json`,
    title: clean(view.name),
    ...(clean(view.attribution) ? { provider: clean(view.attribution) } : {}),
    ...(clean(view.description) ? { description: clean(view.description) } : {}),
    ...(fields.length ? { fields } : {}),
    geometry,
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(socrataCadence(view) ? { cadence: socrataCadence(view) } : {}),
    ...(license ? { license } : {}),
    ...(notes.length ? { notes: notes.slice(0, INSPECT_NOTES_MAX) } : {}),
    checkedAt: new Date().toISOString(),
  }
}

/** `hub.arcgis.com/datasets/fws::some-slug` -> `fws::some-slug`. Hub's own
 *  sites (an agency's `opendata.*`) use the same `/datasets/<slug>` path. */
export function hubDatasetIdIn(url: URL): string | null {
  const hit = /\/datasets\/([^/?#]+)/i.exec(url.pathname)
  if (!hit) return null
  const id = decodeURIComponent(hit[1]).replace(/\.(html?|json)$/i, '')
  // A Hub id is either `<org>::<slug>`, a 32-hex item id, or `<item>_<layer>`.
  return /^[\w.-]+::[\w.-]+$|^[0-9a-f]{32}(_\d+)?$/i.test(id) ? id : null
}

/** Hub export URLs are built from the item id and the layer index. */
function hubDownloads(itemId: string, layer: string | undefined): InspectLink[] {
  const suffix = layer === undefined ? '' : `?layers=${layer}`
  const reason = 'An export the portal builds from the feature service on demand.'
  return [
    { url: `https://hub.arcgis.com/api/download/v1/items/${itemId}/csv${suffix}`, label: 'CSV', kind: 'file' as const, role: 'data-file' as const, reason },
    { url: `https://hub.arcgis.com/api/download/v1/items/${itemId}/geojson${suffix}`, label: 'GeoJSON', kind: 'file' as const, role: 'data-file' as const, reason },
  ]
}

/**
 * The machine-readable half of an ArcGIS Hub dataset page.
 *
 * Hub pages are single-page apps: the HTML a probe can read carries a `<title>`
 * and Open Graph tags, and every download link is drawn by JavaScript we do not
 * run. Hub serves the same record at `/api/v3/datasets/<id>`, which names the
 * underlying service and the item the exports hang off. Best effort — a page
 * that is not really Hub simply stays a page.
 */
async function inspectHubDataset(url: URL, options: InspectOptions): Promise<Partial<Inspection> | null> {
  const id = hubDatasetIdIn(url)
  if (!id) return null
  let body: any
  try {
    body = await probeJson(new URL(`https://hub.arcgis.com/api/v3/datasets/${encodeURIComponent(id)}`), options)
  } catch {
    return null
  }
  const record = Array.isArray(body?.data) ? body.data[0] : body?.data
  const attributes = record?.attributes
  if (!attributes || typeof attributes !== 'object') return null
  const a = attributes as Record<string, unknown>

  const links: InspectLink[] = []
  const serviceUrl = clean(a.url) ?? clean(a.serviceUrl)
  if (serviceUrl) {
    const safe = safeUrl(serviceUrl)
    if (safe) {
      const kind = classifyByShape(safe)
      links.push({
        url: safe.toString(),
        label: 'Feature service',
        ...(kind ? { kind } : {}),
        role: roleForLink(undefined, safe.toString()),
        reason: 'The service the portal builds its exports from.',
      })
    }
  }
  const recordId = clean(record?.id) ?? ''
  const itemMatch = /^([0-9a-f]{32})(?:_(\d+))?$/i.exec(recordId)
  if (itemMatch) links.push(...hubDownloads(itemMatch[1], itemMatch[2]))

  const rowCount = Number(a.recordCount)
  const license = clean(a.licenseInfo) ?? clean(a.license)
  const provider = clean(a.orgName) ?? clean((a.publisher as Record<string, unknown> | undefined)?.name) ?? clean(a.owner)
  return {
    kind: 'portal',
    confidence: links.length ? 'high' : 'medium',
    url: url.toString(),
    finalUrl: url.toString(),
    ...(clean(a.name) ? { title: clean(a.name) } : {}),
    ...(provider ? { provider } : {}),
    ...(clean(a.description) ? { description: stripTags(String(a.description)).slice(0, STRING_MAX) } : {}),
    ...(Number.isFinite(rowCount) && rowCount >= 0 ? { rowCount } : {}),
    ...(license ? { license: stripTags(license) } : {}),
    ...(links.length ? { links } : {}),
    notes: ['This page draws its downloads in the browser, so the links below come from the portal\u2019s own catalogue record.'],
  }
}

type PageRead = Partial<Inspection> & { kind: InspectKind; confidence: InspectConfidence; typedLinks: boolean }

/** What one harvest of a page yields: the pruned link list that REPLACES the
 *  page's anchors (null when there was no prune to run), and the documents the
 *  page offers, which are the page's own and replace nothing. */
interface HarvestRead {
  prune: Partial<Inspection> | null
  documents?: DocumentCandidate[]
}

/**
 * Harvest the page's links, then let a model pass prune them (P5-61).
 *
 * The order is the point. Harvesting is free and generous — 80 candidates off
 * an agency page with one CSV among forty navigation links — and NONE of it
 * is stored. What gets stored is what the prune keeps, with the reason it was
 * kept, because the alternative Nick named is "spamming a link tree instead
 * of actually extracting the valuable data query urls".
 *
 * Best effort in every direction: a page with no candidates, a model that
 * cannot be reached, an answer that does not parse — all of them leave the
 * inspection exactly as it was, minus the links it never had.
 */
async function harvestAndPrune(
  res: ProbeResult,
  page: PageRead,
  options: InspectOptions,
): Promise<HarvestRead> {
  const { candidates, total, documents } = harvestLinks(res.body, res.finalUrl)
  // P5-80: the documents are the page's, not the prune's — they are kept
  // whatever the model does, and whatever the publisher declared.
  const found = documents.length ? { documents: documents.slice(0, INSPECT_DOCUMENTS_MAX) } : {}
  // A publisher's own typed distribution list is already the answer.
  if (page.typedLinks) return { prune: null, ...found }
  if (!candidates.length) return { prune: { candidates: 0 }, ...found }

  const label = options.label || res.finalUrl.toString()
  const prune = pruner(options)
  if (!prune) {
    // No pass available (a test that injected none): the ticket's fallback,
    // said out loud — in the log and on the entry.
    const { unrankedLinks } = await import('./linkPrune.js')
    const links = unrankedLinks(candidates)
    const reason = 'no model pass was available'
    console.warn(`[link-prune] ${label}: ${reason}`)
    return {
      prune: {
        ...(links.length ? { links } : {}),
        candidates: total,
        pruned: 'unranked' as const,
        pruneError: reason,
        ...(droppedUrls(candidates, links) ? { dropped: droppedUrls(candidates, links) } : {}),
      },
      ...found,
    }
  }

  const result = await prune(
    {
      url: res.finalUrl.toString(),
      ...(page.title ? { title: page.title } : {}),
      text: pageText(res.body),
      candidates,
    },
    { client: options.client, clientIp: options.clientIp, label },
  )
  return {
    prune: {
      ...(result.links.length ? { links: result.links } : {}),
      // The count is of the PAGE, not of the slice we handed the model: the
      // entry says "N other links were left out" and that has to be true.
      candidates: total,
      pruned: result.pruned,
      ...(result.pruneError ? { pruneError: result.pruneError } : {}),
      ...(result.pruneErrorCode ? { pruneErrorCode: result.pruneErrorCode } : {}),
      ...(result.dropped?.length ? { dropped: result.dropped } : {}),
      ...(result.prose ? { prose: result.prose } : {}),
    },
    ...found,
  }
}

/** The candidates that did not survive, URL only and capped — enough for the
 *  next reviewer to audit the pass, not enough to be a link tree. */
function droppedUrls(candidates: LinkCandidate[], kept: { url: string }[]): string[] | undefined {
  const keptUrls = new Set(kept.map(l => l.url))
  const rest = candidates.filter(c => !keptUrls.has(c.url)).map(c => c.url).slice(0, DROPPED_MAX)
  return rest.length ? rest : undefined
}

/**
 * Which prune to run, or null for none.
 *
 * Under a test runner an un-injected model pass would reach Anthropic — the
 * same rule (and the same reason) as the fetch queue's `seamMissing`. A suite
 * that wants the model path passes a stub client or its own `prune`.
 */
function pruner(options: InspectOptions): typeof pruneLinks | null {
  if (options.prune) return options.prune
  if (process.env.VITEST && !options.client) return null
  return pruneLinks
}

/** The page as words: scripts, styles and markup gone. What the model reads. */
export function pageText(html: string): string {
  const stripped = html
    // The head is metadata, not prose: its <title> would otherwise open every page's text.
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    // "Skip to main content" and its kind: in-page anchors are chrome, not prose.
    .replace(/<a\b[^>]*href=["']#[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, ' ')
  return stripTags(stripped).slice(0, PRUNE_TEXT_CHARS)
}

// --- The floor: what the page says about itself (P5-79) ----------------------

/** The `<title>` element's own text, markup and entities gone. */
function titleTagOf(html: string): string | undefined {
  const tag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  return tag ? clean(stripTags(tag)) : undefined
}

/** The separators a CMS puts between a page's name and its site's. */
const TITLE_SEPARATORS = [' | ', ' — ', ' – ', ' - ', ' · ', ' :: ']

/** Longest tail we will treat as a site name. Past this it is a sentence. */
const TITLE_SUFFIX_MAX = 60

/** A name with only its letters and digits left, so "Land Loss Prevention
 *  Project", "land-loss-prevention-project" and "LandLossPreventionProject"
 *  are one name. */
function foldName(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** The names this page might sign itself with: its publisher, its host, and
 *  its host without the TLD — engaginglandowners.org also answers to
 *  "Engaging Landowners". */
function siteNames(provider: string | undefined, finalUrl: URL): string[] {
  const host = finalUrl.hostname.replace(/^www\./i, '')
  return [provider, host, host.split('.').slice(0, -1).join('.')].map(foldName).filter(Boolean)
}

/** Cut to `max` on a word boundary, with an ellipsis when it cut. */
function trimTo(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * The page's title as an entry would want it.
 *
 * "Heirs' property — Land Loss Prevention Project" on the Land Loss Prevention
 * Project's own site is a title with the site's name stapled to it; the entry
 * already knows whose site it is. The suffix only goes when it IS the site's
 * name — "Wells — 2024 results" keeps its second half.
 */
export function cleanPageTitle(raw: string, provider: string | undefined, finalUrl: URL): string | undefined {
  const title = stripTags(raw)
  if (!title) return undefined
  const names = siteNames(provider, finalUrl)
  for (const separator of TITLE_SEPARATORS) {
    const at = title.lastIndexOf(separator)
    if (at <= 0) continue
    const head = title.slice(0, at).trim()
    const tail = title.slice(at + separator.length).trim()
    if (!head || !tail || tail.length > TITLE_SUFFIX_MAX) continue
    // The tail is the site name, or a repeat of words the head already
    // carries ("TELE - Tools for X | Tools for X"): either way it says nothing.
    if (names.includes(foldName(tail)) || foldName(head).includes(foldName(tail))) return trimTo(head, PAGE_TITLE_MAX)
  }
  return trimTo(title, PAGE_TITLE_MAX)
}

/**
 * What the page says it is about: its meta description when it has one, and
 * otherwise its own opening words. `pageText` already drops the scripts, the
 * styles and the navigation, which is exactly the difference between a
 * description and a list of menu items.
 */
function pageDescriptionOf(html: string, fromLd?: string, rawTitle?: string): string | undefined {
  const declared = fromLd ?? metaContent(html, 'description') ?? metaContent(html, 'og:description')
  const text = clean(declared) ?? clean(withoutLeadingTitle(pageText(html), rawTitle))
  return text ? trimTo(text, PAGE_DESCRIPTION_MAX) : undefined
}

/** A page's body usually opens by repeating its own title; a description that
 *  starts with the title says nothing the title line does not. */
function withoutLeadingTitle(text: string, rawTitle: string | undefined): string {
  const title = clean(rawTitle ? stripTags(rawTitle) : undefined)
  if (!title) return text
  // A page can repeat its title more than once (a breadcrumb, then the h1).
  let out = text
  for (let i = 0; i < 3; i++) {
    const head = out.slice(0, title.length)
    if (foldName(head) !== foldName(title)) break
    out = out.slice(title.length).replace(/^[\s|:–—-]+/, '')
  }
  return out
}

/**
 * The floor for one page: title, description, publisher, and whether it came
 * over http. Read once per inspection and carried by every page branch —
 * a CKAN record, an ArcGIS Hub page and a plain report all get it.
 */
export function readPageBlock(html: string, finalUrl: URL, ld?: LdDataset | null): InspectPage | undefined {
  const provider = clean(ld?.provider) ?? metaContent(html, 'og:site_name')
  const raw = clean(ld?.title) ?? titleTagOf(html)
  const title = raw ? cleanPageTitle(raw, provider, finalUrl) : undefined
  const description = pageDescriptionOf(html, ld?.description, raw)
  const page: InspectPage = {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(provider ? { provider } : {}),
    ...(finalUrl.protocol === 'http:' ? { insecure: true } : {}),
  }
  return Object.keys(page).length ? page : undefined
}



function readPage(res: ProbeResult, url: URL, notes: string[], ld: LdDataset | null): PageRead {
  const html = res.body
  const anchors = dataAnchors(html, res.finalUrl)

  const seen = new Set<string>()
  const links: InspectLink[] = []
  for (const link of [...(ld?.links ?? []), ...anchors]) {
    if (seen.has(link.url) || link.url === url.toString()) continue
    seen.add(link.url)
    links.push(link)
    if (links.length >= INSPECT_LINKS_MAX) break
  }

  const title = ld?.title ?? titleTagOf(html)
  const provider = ld?.provider ?? metaContent(html, 'og:site_name')
  const description = ld?.description ?? metaContent(html, 'description') ?? metaContent(html, 'og:description')

  const looksLikePortal =
    !!ld ||
    PORTAL_HOST_RE.test(url.hostname) ||
    (/\/datasets?\//i.test(url.pathname) && links.length > 0)

  if (looksLikePortal && !links.length) {
    notes.push('This looks like a catalogue page, but it lists no downloads we recognise.')
  }
  if (res.truncated) notes.push('Only the first part of the page was read.')

  return {
    kind: looksLikePortal ? 'portal' : 'page',
    confidence: ld ? 'high' : looksLikePortal ? 'medium' : 'medium',
    // P5-61: the publisher's own `distribution[]` is a typed list — those
    // links need no pruning and must not be replaced by a guess at them.
    typedLinks: !!ld?.links.length,
    ...(title ? { title } : {}),
    ...(provider ? { provider } : {}),
    ...(description ? { description } : {}),
    ...(ld?.license ? { license: ld.license } : {}),
    ...(ld?.cadence ? { cadence: ld.cadence } : {}),
    ...(links.length ? { links } : {}),
    ...(notes.length ? { notes: notes.slice(0, INSPECT_NOTES_MAX) } : {}),
  }
}

// --- Reading one back --------------------------------------------------------

function cleanFieldList(raw: unknown, max: number): InspectField[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: InspectField[] = []
  for (const item of raw.slice(0, max)) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const name = clean(f.name)
    if (!name) continue
    out.push({
      name,
      ...(clean(f.type) ? { type: clean(f.type) } : {}),
      ...(clean(f.alias) ? { alias: clean(f.alias) } : {}),
      ...(clean(f.sample) ? { sample: clean(f.sample)!.slice(0, SAMPLE_MAX) } : {}),
    })
  }
  return out.length ? out : undefined
}

/**
 * An `inspection` block off a manifest, cleaned. Never throws: a hand-edited
 * or half-written block loses the fields it got wrong, not the whole entry.
 */
/**
 * P5-79 read-back: the floor, cleaned like every other stored field. A
 * hand-edited block loses the parts it got wrong, not the whole entry.
 */
function cleanPageBlock(raw: unknown): InspectPage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const title = clean(o.title)
  const description = clean(o.description)
  const provider = clean(o.provider)
  const page: InspectPage = {
    ...(title ? { title: trimTo(title, PAGE_TITLE_MAX) } : {}),
    ...(description ? { description: trimTo(description, PAGE_DESCRIPTION_MAX) } : {}),
    ...(provider ? { provider } : {}),
    ...(o.insecure === true ? { insecure: true } : {}),
  }
  return Object.keys(page).length ? page : undefined
}

/** P5-80 read-back: the page's documents — a url and a label are both
 *  required (a checkbox with no words on it is not an offer), the list and
 *  every string capped. */
function cleanDocuments(raw: unknown): DocumentCandidate[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: DocumentCandidate[] = []
  for (const item of raw.slice(0, INSPECT_DOCUMENTS_MAX)) {
    if (!item || typeof item !== 'object') continue
    const d = item as Record<string, unknown>
    const url = clean(d.url)
    const label = clean(d.label)
    if (!url || !label || !/^https?:\/\//i.test(url)) continue
    const context = clean(d.context)
    out.push({
      url,
      label: label.slice(0, DOCUMENT_LABEL_MAX),
      ...(context ? { context: context.slice(0, DOCUMENT_CONTEXT_MAX) } : {}),
    })
  }
  return out.length ? out : undefined
}

/** P5-80: the same caps the harvester works to, restated for what we STORE —
 *  a read-back trusts nothing, including that the harvester wrote it. */
const DOCUMENT_LABEL_MAX = 120
const DOCUMENT_CONTEXT_MAX = 200

/** P5-75's four codes, written out here rather than imported: a value import
 *  from `assistantCall` would close a cycle through `askKb`, which imports this
 *  module. The TYPE still comes from the one definition. */
const PRUNE_ERROR_CODES: AssistantFailureCode[] = ['no-key', 'refused', 'rate-limited', 'model-error']

export function parseInspection(raw: unknown): Inspection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const kind = INSPECT_KINDS.find(k => k === o.kind)
  const url = clean(o.url)
  const checkedAt = clean(o.checkedAt)
  if (!kind || !url || !checkedAt) return null

  const confidence = INSPECT_CONFIDENCES.find(c => c === o.confidence) ?? 'low'
  const out: Inspection = { kind, confidence, url, checkedAt }

  for (const key of ['finalUrl', 'title', 'provider', 'description', 'contentType', 'cadence', 'license', 'crs', 'summary', 'platform'] as const) {
    const value = clean(o[key])
    if (value) out[key] = value
  }
  const fields = cleanFieldList(o.fields, INSPECT_FIELDS_MAX)
  if (fields) out.fields = fields
  const geometry = INSPECT_GEOMETRIES.find(g => g === o.geometry)
  if (geometry) out.geometry = geometry
  const extent = readExtent(o.extent)
  if (extent) out.extent = extent
  for (const key of ['rowCount', 'bytes'] as const) {
    const n = Number(o[key])
    if (Number.isFinite(n) && n >= 0) out[key] = n
  }
  if (Array.isArray(o.formats)) {
    const formats = o.formats.filter((f): f is string => typeof f === 'string' && !!f.trim()).slice(0, 8)
    if (formats.length) out.formats = formats
  }
  if (Array.isArray(o.links)) {
    const links: InspectLink[] = []
    for (const item of o.links.slice(0, INSPECT_LINKS_MAX)) {
      if (!item || typeof item !== 'object') continue
      const l = item as Record<string, unknown>
      const href = clean(l.url)
      if (!href) continue
      const linkKind = INSPECT_KINDS.find(k => k === l.kind)
      // P5-61: the role and the reason a prune kept this one, when it was
      // pruned. Both are optional — a typed portal list carries neither.
      const role = LINK_ROLES.find(r => r === l.role)
      const reason = clean(l.reason)
      links.push({
        url: href,
        ...(clean(l.label) ? { label: clean(l.label) } : {}),
        ...(linkKind ? { kind: linkKind } : {}),
        ...(role ? { role } : {}),
        ...(reason ? { reason: reason.slice(0, 200) } : {}),
      })
    }
    if (links.length) out.links = links
  }
  const candidates = Number(o.candidates)
  if (Number.isFinite(candidates) && candidates >= 0) out.candidates = Math.floor(candidates)
  if (o.pruned === 'model' || o.pruned === 'unranked') out.pruned = o.pruned
  const pruneError = clean(o.pruneError)
  if (pruneError) out.pruneError = pruneError.slice(0, 200)
  // Read back from stored JSON, so it is checked against the four codes rather
  // than trusted — the same rule every other field here follows.
  if (PRUNE_ERROR_CODES.some(code => code === o.pruneErrorCode)) {
    out.pruneErrorCode = o.pruneErrorCode as AssistantFailureCode
  }
  if (Array.isArray(o.dropped)) {
    const dropped = o.dropped
      .filter((u): u is string => typeof u === 'string' && /^https:\/\//i.test(u.trim()))
      .map(u => u.trim())
      .slice(0, DROPPED_MAX)
    if (dropped.length) out.dropped = dropped
  }
  const prose = cleanProse(o.prose)
  if (prose) out.prose = prose
  const page = cleanPageBlock(o.page)
  if (page) out.page = page
  const documents = cleanDocuments(o.documents)
  if (documents) out.documents = documents
  if (Array.isArray(o.topics)) {
    const topics = o.topics.filter((t): t is string => typeof t === 'string' && !!t.trim()).slice(0, 20)
    if (topics.length) out.topics = topics
  }
  if (Array.isArray(o.layers)) {
    const layers: InspectLayerRef[] = []
    for (const item of o.layers.slice(0, INSPECT_LAYERS_MAX)) {
      if (!item || typeof item !== 'object') continue
      const l = item as Record<string, unknown>
      const id = Number(l.id)
      const name = clean(l.name)
      const href = clean(l.url)
      if (!Number.isFinite(id) || !name || !href) continue
      const geom = INSPECT_GEOMETRIES.find(g => g === l.geometry)
      layers.push({ id, name, url: href, ...(geom ? { geometry: geom } : {}) })
    }
    if (layers.length) out.layers = layers
  }
  if (Array.isArray(o.notes)) {
    const notes = o.notes.filter((n): n is string => typeof n === 'string' && !!n.trim()).slice(0, INSPECT_NOTES_MAX)
    if (notes.length) out.notes = notes
  }
  return out
}

// --- Saying it in words ------------------------------------------------------

function prettyBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`
  return `${bytes} bytes`
}

/** One line for the entry header and the "to ingest" queue: what it is, how
 *  wide, and where it covers. */
export function inspectionSummary(inspection: Inspection): string {
  if (inspection.kind === 'unreachable') return 'Could not reach it — check the link'
  const parts: string[] = []
  const fieldCount = inspection.fields?.length ?? 0
  switch (inspection.kind) {
    case 'arcgis-layer':
      parts.push(inspection.geometry && inspection.geometry !== 'table' ? `ArcGIS ${inspection.geometry} layer` : 'ArcGIS table')
      break
    case 'arcgis-service':
      parts.push('ArcGIS service')
      if (inspection.layers?.length) parts.push(`${inspection.layers.length} layers`)
      break
    case 'socrata':
      parts.push('Socrata dataset')
      break
    case 'file':
      parts.push(`${(inspection.formats?.[0] ?? 'unknown').toUpperCase()} file`)
      break
    case 'portal':
      parts.push('Data portal page')
      if (inspection.links?.length) parts.push(`${inspection.links.length} data links`)
      break
    case 'page':
      // P5-61: a prose page whose links were pruned to real data is not
      // "nothing to ingest" any more, and must not keep saying so.
      if (inspection.links?.length) {
        parts.push('Web page')
        parts.push(`${inspection.links.length} data link${inspection.links.length === 1 ? '' : 's'}`)
      } else {
        parts.push('Web page — nothing to ingest')
      }
      break
  }
  if (fieldCount) parts.push(`${fieldCount} fields`)
  if (inspection.rowCount !== undefined) parts.push(`${inspection.rowCount.toLocaleString('en-US')} rows`)
  if (inspection.bytes !== undefined && inspection.kind === 'file') parts.push(prettyBytes(inspection.bytes))
  const where = extentLabel(inspection.extent)
  if (where) parts.push(`${where} extent`)
  return parts.join(' · ')
}

/**
 * The inspection as prose for the filing model (P5-47).
 *
 * An ArcGIS layer or a Socrata dataset has no document to read, so this text
 * IS the document: the same suggester then proposes a title, a category, tags
 * and a summary from the service's own words.
 */
export function inspectionText(inspection: Inspection): string {
  const lines: string[] = [`This is a ${KIND_WORDS[inspection.kind]} at ${inspection.finalUrl ?? inspection.url}.`]
  if (inspection.title) lines.push(`Name: ${inspection.title}`)
  if (inspection.provider) lines.push(`Published by: ${inspection.provider}`)
  if (inspection.description) lines.push(`Description: ${inspection.description}`)
  if (inspection.geometry) lines.push(`Shape of a row: ${inspection.geometry}`)
  const where = extentLabel(inspection.extent)
  if (where) lines.push(`Covers: ${where}`)
  if (inspection.rowCount !== undefined) lines.push(`Rows: ${inspection.rowCount}`)
  if (inspection.cadence) lines.push(`Updated: ${inspection.cadence}`)
  if (inspection.license) lines.push(`Terms: ${inspection.license}`)
  if (inspection.formats?.length) lines.push(`Formats: ${inspection.formats.join(', ')}`)
  if (inspection.fields?.length) {
    lines.push(`Columns (${inspection.fields.length}): ${inspection.fields.map(f => f.alias ?? f.name).join(', ')}`)
  }
  if (inspection.layers?.length) {
    lines.push(`Layers: ${inspection.layers.map(l => l.name).join(', ')}`)
  }
  if (inspection.topics?.length) lines.push(`Keywords: ${inspection.topics.join(', ')}`)
  if (inspection.links?.length) {
    // P5-61: with the role and the reason, so the filing model reads "the
    // 2023 county file" rather than a bare list of hostnames.
    const described = inspection.links.map(l => {
      const name = l.label ?? l.url
      const role = l.role ? ` (${l.role})` : ''
      return l.reason ? `${name}${role} — ${l.reason}` : `${name}${role}`
    })
    lines.push(`Data links on the page: ${described.join('; ')}`)
    if (inspection.candidates !== undefined && inspection.candidates > inspection.links.length) {
      lines.push(`Other links on the page, left out: ${inspection.candidates - inspection.links.length}`)
    }
  }
  const prose = inspection.prose
  if (prose) {
    for (const [key, label] of [
      ['provider', 'Publisher, from the page'],
      ['program', 'Programme, from the page'],
      ['updateCadence', 'Updated, from the page'],
      ['license', 'Terms, from the page'],
      ['coverage', 'Coverage, from the page'],
      ['geography', 'What one row is, from the page'],
    ] as const) {
      if (prose[key]) lines.push(`${label}: ${prose[key]}`)
    }
    // P5-63: the page reader already chose a subject from the taxonomy, so the
    // filing pass starts from it rather than from a blank field — the two used
    // to answer the same question in different vocabularies.
    if (prose.topic) lines.push(`Subject, from the page: ${prose.topic}`)
    if (prose.tags?.length) lines.push(`Tags, from the page: ${prose.tags.join(', ')}`)
    for (const note of prose.accessNotes ?? []) {
      lines.push(`How to get it (${note.kind}): ${note.text}${note.url ? ` — ${note.url}` : ''}`)
    }
  }
  if (inspection.notes?.length) lines.push(`Notes: ${inspection.notes.join(' ')}`)
  return lines.join('\n')
}
