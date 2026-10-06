import { classifyByShape, stripTags, type InspectKind } from './linkInspect.js'
import { isForbiddenHostname, literalIp } from './hostGuard.js'

/**
 * Every link on a page that could conceivably be data (P5-61).
 *
 * The inspector already reads pages that describe themselves — a Socrata
 * views record, an ArcGIS `?f=json`, a Hub catalogue entry. The page a
 * researcher actually finds is prose: a program description with one CSV
 * buried in it, or an "API" sentence pointing at a docs page. This module is
 * the FIRST half of getting that data out: collect everything that might be
 * it, cheaply and without judgement.
 *
 * Nothing here is stored. Harvesting on its own is exactly the link-tree spam
 * Nick refused ("otherwise we end up spamming a link tree instead of actually
 * extracting the valuable data query urls") — `linkPrune.ts` is what decides
 * which of these survive, and only those are written to the entry.
 *
 * Pure: one HTML string in, candidates out. NO REQUESTS — a candidate is
 * classified by the shape of its URL alone, so collecting 80 of them costs
 * the agency nothing.
 */

/** Where a candidate was found. The model is told this: "the anchor said
 *  Download" and "it appeared in the page's structured data" are different
 *  strengths of evidence. */
export const HARVEST_SOURCES = ['anchor', 'anchor-text', 'directory', 'alternate', 'json-ld', 'meta', 'dcat'] as const
export type HarvestSource = (typeof HARVEST_SOURCES)[number]

export interface LinkCandidate {
  url: string
  /** The anchor's own words, when it had any. */
  label?: string
  /** The sentence around the link, so the model can tell "download the 2023
   *  file" from "download our newsletter". */
  context?: string
  /** From the URL shape alone — never a request. */
  kind?: InspectKind
  via: HarvestSource
}

/**
 * A document ON the page, rather than a link that might be data (P5-80).
 *
 * The harvester keeps a PDF only when its link text says "download", so a page
 * of thirty landowner profiles labelled by content had thirty invisible files
 * and the only way in was thirty separate drops. These are collected by shape
 * alone — same site, a document extension — and pulled in as one collection
 * when a person asks for them.
 */
export interface DocumentCandidate {
  url: string
  /** The anchor's own words, falling back to the file's name. */
  label: string
  /** The sentence around the link, exactly as a data candidate gets one. */
  context?: string
}

export interface Harvest {
  candidates: LinkCandidate[]
  /** P5-80: documents on this page, in page order, deduped and capped. */
  documents: DocumentCandidate[]
  /** How many we found before the cap. Stored as a number on the entry so a
   *  reader can see the pruning happened ("40 other links were left out"). */
  total: number
  /** P5-81: the page ITSELF arrived over http, so its own site's http links
   *  were kept. The entry says so rather than papering over it. */
  insecure: boolean
}

/**
 * Most candidates we hand the model. 80 links is a big agency page; past
 * that a page is a directory, and a directory's hundredth link is not this
 * dataset's download.
 */
export const HARVEST_MAX = 80

/**
 * Most documents offered from one page. Thirty landowner profiles is the page
 * this was written for; past that a page is a library, and a library's
 * hundredth file is not something anyone meant to pull in at once.
 */
export const DOCUMENTS_MAX = 30

/** Longest surrounding sentence we keep per candidate. */
export const CONTEXT_MAX = 200
const LABEL_MAX = 120

/** Extensions that ARE data, whatever the page calls them. */
const DATA_EXT_RE = /\.(csv|tsv|xlsx|xls|zip|geojson|json|kml|kmz|shp|gdb|parquet)(?:$|[?#])/i

/** Extensions that are a DOCUMENT — something a person reads (P5-80). Matched
 *  against the path alone, so `?download=1` (how half of these are served)
 *  changes nothing. A spreadsheet is on both lists: it is data to a program
 *  and a document to a reader, and both offers are honest. */
const DOCUMENT_EXT_RE = /\.(pdf|docx|doc|rtf|pptx|xlsx|xls)$/i

/** URL shapes that mean "this is served to a program, not to a reader". */
const DATA_PATH_RE = /\/(FeatureServer|MapServer)(\/|$)|\/api\/|\/download|\/export|\/resource\//i

/** A Socrata dataset id anywhere in the path ("spb7-eyx7"). */
const SOCRATA_PATH_RE = /\/[a-z0-9]{4}-[a-z0-9]{4}(?:$|[./?#])/i

/** What a link has to SAY to be worth a look when its URL says nothing. */
const DATA_TEXT_RE = /\b(download|export|api|data|dataset|geojson|csv|shapefile|bulk)\b/i

/**
 * Words that mean "the files are through here".
 *
 * Found live on the Census TIGER page: the ONLY route to the shapefiles is a
 * single anchor reading "FTP Archive" pointing at
 * `//www2.census.gov/geo/tiger/TIGER2025/`. Nothing in that URL is a data
 * shape and nothing in those two words is a data word, so it was never
 * harvested at all — and the most important link on the page was invisible.
 */
const DIRECTORY_TEXT_RE = /\b(ftp|archive|file transfer|web interface|directory|browse|index of|file listing|all files)\b/i

/** A path that ends in a data directory: `/geo/tiger/TIGER2025/`. Narrow on
 *  purpose — "ends with a slash" alone is half the internet. */
const DIRECTORY_PATH_RE = /\/(tiger|shapefiles?|geo|gis|data|downloads?|dist|files|pub|ftp|archive|releases?)\//i

/** `<link rel="alternate">` types that are data rather than a feed of posts.
 *  Generic `xml` is deliberately absent: on a `rel=alternate` it is an RSS or
 *  Atom feed nine times in ten, and a feed of news items is not data. */
const ALTERNATE_TYPE_RE = /(csv|geo\+json|geojson|json|excel|spreadsheet|zip|kml)/i
const FEED_TYPE_RE = /(rss|atom)/i

/** DCAT: a site that publishes `/data.json` is telling us where its whole
 *  catalogue is. Worth one candidate, never a crawl. */
const DCAT_RE = /\/data\.json(?:$|[?#])/i

/** `citation_pdf_url` and friends: a scholarly page naming its own artefact. */
const CITATION_META_RE =
  /<meta[^>]+name=["'](citation_pdf_url|citation_xml_url|citation_fulltext_html_url|dc\.identifier)["'][^>]*content=["']([^"']+)["']/gi

// --- Small readers -----------------------------------------------------------

/**
 * The site a hostname belongs to (P5-80/81).
 *
 * Approximated without a public-suffix list: the last two labels, or three
 * when the last is a country code and the one before it acts as a suffix
 * under it (`gov.uk`, `ny.us`). Narrow on purpose — this decides which http
 * links survive on an http page and which documents may be pulled in, and an
 * approximation that erred the other way would let one site's page vouch for
 * another site's files.
 */
const SUFFIX_LABEL_RE = /^(?:co|com|net|org|edu|gov|mil|ac|gob|gouv|k12|or|ne|go)$/

export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const tld = labels[labels.length - 1]
  const second = labels[labels.length - 2]
  const multiPart = tld.length === 2 && (second.length === 2 || SUFFIX_LABEL_RE.test(second))
  return labels.slice(multiPart ? -3 : -2).join('.')
}

/** Two hostnames on the same site: `www.x.gov` and `files.x.gov`, never
 *  `x.gov` and `y.gov`. */
export function sameSite(a: string, b: string): boolean {
  const domain = registrableDomain(a)
  return domain !== '' && domain === registrableDomain(b)
}

/**
 * https only — with one exception — no credentials, nothing that only
 * resolves inside a network, no fragment (two anchors to the same page are
 * one candidate).
 *
 * P5-81, the exception: when the PAGE ITSELF arrived over http, every relative
 * link on it resolves to http, so the https-only rule left an agency that has
 * not moved to TLS — or one whose certificate merely expired — with zero
 * candidates before any model saw the page. Its OWN site's http links are kept
 * and the harvest says the page is insecure. Links to other hosts still
 * require https: an insecure page is a fact about that agency, not a licence
 * to follow plain http anywhere else.
 */
function candidateUrl(raw: string, base: URL): string | null {
  let url: URL
  try {
    url = new URL(raw.trim(), base)
  } catch {
    return null
  }
  // http is never upgraded: an agency that serves data over plain http is a
  // fact a person should see, not one we should paper over.
  if (url.protocol !== 'https:') {
    const sameSiteOnAnInsecurePage =
      base.protocol === 'http:' && url.protocol === 'http:' && sameSite(url.hostname, base.hostname)
    if (!sameSiteOnAnInsecurePage) return null
  }
  if (!url.hostname || url.username || url.password) return null
  if (isForbiddenHostname(url.hostname) || literalIp(url.hostname)) return null
  url.hash = ''
  return url.toString()
}

function looksLikeData(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const path = parsed.pathname + parsed.search
  return DATA_EXT_RE.test(path) || DATA_PATH_RE.test(path) || SOCRATA_PATH_RE.test(parsed.pathname)
}

/** A folder of data files rather than one of them. */
export function looksLikeDirectory(url: string, label: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const isFolder = parsed.pathname.endsWith('/') && DIRECTORY_PATH_RE.test(parsed.pathname)
  return isFolder || DIRECTORY_TEXT_RE.test(label)
}

/** A document on the page we are reading: same site, and an address that ends
 *  in a document extension (P5-80). */
function looksLikeDocument(url: string, base: URL): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return DOCUMENT_EXT_RE.test(parsed.pathname) && sameSite(parsed.hostname, base.hostname)
}

/** The file's own name, for a link whose anchor said nothing (an icon, an
 *  image). "…/2024-Landowner-Profile.pdf" → "2024-Landowner-Profile.pdf". */
function documentName(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(last) || 'document'
  } catch {
    return last || 'document'
  }
}

/**
 * The sentence a link sits in.
 *
 * Text either side of the anchor, tags stripped, cut at sentence boundaries.
 * This is the difference between a model that can say "the 2023 file the
 * paragraph calls the current release" and one guessing from a file name.
 */
export function contextAround(html: string, at: number, length: number): string | undefined {
  const before = stripTags(html.slice(Math.max(0, at - 600), at))
  const after = stripTags(html.slice(at + length, at + length + 400))
  const text = `${before} ${after}`.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  // Prefer whole sentences around the link over an arbitrary cut.
  const tail = before.split(/(?<=[.!?])\s+/).slice(-1)[0] ?? ''
  const head = after.split(/(?<=[.!?])\s+/)[0] ?? ''
  const sentence = `${tail} ${head}`.replace(/\s+/g, ' ').trim()
  return (sentence || text).slice(0, CONTEXT_MAX)
}

/**
 * De-duplicates, counts and caps. `total` counts every DISTINCT candidate
 * found, including the ones past the cap: "40 other links were left out" has
 * to be true of the page, not of the slice we kept.
 */
class Collector {
  private readonly seen = new Set<string>()
  readonly found: LinkCandidate[] = []
  total = 0

  /** The page's own address, which is never one of its data links. */
  constructor(private readonly self: string) {}

  add(candidate: Omit<LinkCandidate, 'kind'>): void {
    if (candidate.url === this.self) return
    if (this.seen.has(candidate.url)) return
    this.seen.add(candidate.url)
    this.total++
    if (this.found.length >= HARVEST_MAX) return
    const kind = classifyByShape(candidate.url)
    this.found.push({ ...candidate, ...(kind ? { kind } : {}) })
  }
}

/** The documents, deduped by address and capped, in the order the page lists
 *  them — which on a page of profiles is the order a person reads them in. */
class DocumentCollector {
  private readonly seen = new Set<string>()
  readonly found: DocumentCandidate[] = []

  add(url: string, label: string, context?: string): void {
    if (this.found.length >= DOCUMENTS_MAX || this.seen.has(url)) return
    this.seen.add(url)
    this.found.push({ url, label: label.trim() || documentName(url), ...(context ? { context } : {}) })
  }
}

// --- JSON-LD -----------------------------------------------------------------

/** Every `application/ld+json` block, flattened through `@graph`. */
function ldNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    try {
      const parsed = JSON.parse(match[1])
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!item || typeof item !== 'object') continue
        const graph = (item as Record<string, unknown>)['@graph']
        if (Array.isArray(graph)) for (const g of graph) if (g && typeof g === 'object') nodes.push(g as Record<string, unknown>)
        nodes.push(item as Record<string, unknown>)
      }
    } catch {
      // A page with broken structured data is still a page.
    }
  }
  return nodes
}

function isDatasetNode(node: Record<string, unknown>): boolean {
  const raw = node['@type']
  return (Array.isArray(raw) ? raw : [raw]).some(t => typeof t === 'string' && t.toLowerCase() === 'dataset')
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return asText(o.name) ?? asText(o.url) ?? asText(o['@id'])
  }
  return undefined
}

/** `distribution[].contentUrl` on a schema.org Dataset — the publisher's own
 *  machine-readable statement of where the data is. */
function harvestJsonLd(html: string, base: URL, into: Collector): void {
  for (const node of ldNodes(html)) {
    if (!isDatasetNode(node)) continue
    const distributions = Array.isArray(node.distribution) ? node.distribution : []
    for (const dist of distributions) {
      if (!dist || typeof dist !== 'object') continue
      const d = dist as Record<string, unknown>
      const raw = asText(d.contentUrl) ?? asText(d.downloadURL) ?? asText(d.url) ?? asText(d.accessURL)
      if (!raw) continue
      const url = candidateUrl(raw, base)
      if (!url) continue
      const format = asText(d.encodingFormat) ?? asText(d.format) ?? asText(d.fileFormat)
      const label = asText(d.name) ?? format
      const description = asText(d.description)
      into.add({
        url,
        ...(label ? { label: label.slice(0, LABEL_MAX) } : {}),
        context: [format ? `Format: ${format}.` : '', description ?? '', 'Listed in the page’s structured data as a distribution of this dataset.']
          .filter(Boolean)
          .join(' ')
          .slice(0, CONTEXT_MAX),
        via: 'json-ld',
      })
    }
  }
}

// --- The harvest -------------------------------------------------------------

/**
 * Candidates from one page's HTML, resolved against the address we ended up
 * at (not the one that was typed — a redirect moves what "/data.csv" means).
 */
export function harvestLinks(html: string, base: URL): Harvest {
  // P5-62, from the eval: a page linking to ITSELF is not a link off the page.
  // Socrata's "Skip to main content" anchor and EPA's own entry in its side
  // navigation both resolve to the page being inspected, and the model kept
  // them — reasonably, since nothing in the candidate list said "you are
  // already here". Cheaper and clearer to never offer them.
  const self = new URL(base.toString())
  self.hash = ''
  const into = new Collector(self.toString())
  const documents = new DocumentCollector()

  // (a) Structured data first: a publisher that filled in schema.org told us
  //     exactly which files are the dataset, and those deserve the top slots.
  harvestJsonLd(html, base, into)

  // (b) `<link rel="alternate">` to a data type — the page's own "same thing,
  //     machine-readable" pointer.
  const altRe = /<link\b[^>]*>/gi
  let tag: RegExpExecArray | null
  while ((tag = altRe.exec(html))) {
    const rel = /\brel=["']([^"']+)["']/i.exec(tag[0])?.[1] ?? ''
    if (!/\balternate\b/i.test(rel)) continue
    const type = /\btype=["']([^"']+)["']/i.exec(tag[0])?.[1] ?? ''
    const href = /\bhref=["']([^"']+)["']/i.exec(tag[0])?.[1] ?? ''
    if (!href || !ALTERNATE_TYPE_RE.test(type) || FEED_TYPE_RE.test(type)) continue
    const url = candidateUrl(href, base)
    if (!url) continue
    const title = /\btitle=["']([^"']+)["']/i.exec(tag[0])?.[1]
    into.add({
      url,
      ...(title ? { label: title.slice(0, LABEL_MAX) } : { label: type }),
      context: `The page offers this as an alternate representation of type ${type}.`.slice(0, CONTEXT_MAX),
      via: 'alternate',
    })
  }

  // (c) DCAT: `/data.json` is the site's whole catalogue, not this dataset —
  //     a candidate the model will usually drop, and should be allowed to.
  for (const link of [...html.matchAll(/href=["']([^"']*\/data\.json[^"']*)["']/gi)]) {
    if (!DCAT_RE.test(link[1])) continue
    const url = candidateUrl(link[1], base)
    if (url) into.add({ url, label: 'data.json', context: 'The site’s DCAT catalogue of every dataset it publishes.', via: 'dcat' })
  }

  // (d) Anchors: by URL shape first, then by what the link says. Both are
  //     collected — the model is what decides, and giving it a "Download"
  //     link whose URL says nothing is the whole point of this ticket.
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let anchor: RegExpExecArray | null
  while ((anchor = anchorRe.exec(html))) {
    const url = candidateUrl(anchor[1], base)
    if (!url) continue
    const label = stripTags(anchor[2]).slice(0, LABEL_MAX)
    const byShape = looksLikeData(url)
    const byText = DATA_TEXT_RE.test(label)
    // A directory of data files is a data endpoint one click further away —
    // on some agency pages it is the ONLY route to the data.
    const byFolder = !byShape && looksLikeDirectory(url, label)
    // P5-80: a document on this page. Collected beside the data candidates
    // rather than instead of them — a PDF labelled "download" belongs on both
    // lists, and neither list is a decision about the other.
    const byDocument = looksLikeDocument(url, base)
    if (!byShape && !byText && !byFolder && !byDocument) continue
    // One read of the surrounding prose, however many lists the link joins.
    const context = contextAround(html, anchor.index, anchor[0].length)
    if (byDocument) documents.add(url, label, context)
    if (!byShape && !byText && !byFolder) continue
    into.add({
      url,
      ...(label ? { label } : {}),
      ...(context ? { context } : {}),
      via: byShape ? 'anchor' : byFolder ? 'directory' : 'anchor-text',
    })
  }

  // (e) `<meta name="citation_pdf_url">` and friends: a page naming its own
  //     artefact where no anchor does.
  CITATION_META_RE.lastIndex = 0
  let meta: RegExpExecArray | null
  while ((meta = CITATION_META_RE.exec(html))) {
    const url = candidateUrl(meta[2], base)
    if (!url) continue
    into.add({ url, label: meta[1], context: `The page names this in its ${meta[1]} metadata.`, via: 'meta' })
  }

  return {
    candidates: into.found,
    documents: documents.found,
    total: into.total,
    insecure: base.protocol === 'http:',
  }
}
