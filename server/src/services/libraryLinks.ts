import { randomUUID } from 'node:crypto'
import { putFile } from './libraryBucket.js'
import { indexFileBackedEntry, SOURCES_PREFIX } from './libraryCatalog.js'
import { parseSourceMeta, sourceDropWarning } from './sourceMeta.js'
import { isForbiddenHostname, literalIp } from './hostGuard.js'
import { queueLinkFetch, writeFetchState, type FetchState, type FetchStatus } from './linkFetchQueue.js'
import { INGEST_PLANS, INGEST_MODES, type IngestPlan, type IngestPlanName, type IngestMode } from './ingestPlan.js'

/**
 * Creating a link drop (P5-34 / P5-47), as a service rather than a route body.
 *
 * It moved out of routes/libraryLinks.ts for P5-52: the MCP `drop_link` tool
 * has to take exactly the same path as the drop form — same URL guard, same
 * quick-drop rule, same source block, same queued fetch — and the only way to
 * guarantee "the same" is for there to be one implementation. The route keeps
 * what is genuinely HTTP (status codes, the audit row, the response shape).
 */

export const LINK_MAX_LENGTH = 2048
const TITLE_MAX = 160
const NOTE_MAX = 2000

/** http(s) only — never javascript:, data:, file:, ftp:, or a bare host.
 *  Also refused: userinfo (credentials would be stored in the manifest),
 *  literal IP addresses in any form, and names that only resolve inside a
 *  network — the fetch job downloads these URLs later, so a link must never
 *  be able to point it at this host, its neighbours, or cloud metadata. */
export function parseLinkUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > LINK_MAX_LENGTH) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  if (url.username || url.password) return null
  if (isForbiddenHostname(url.hostname) || literalIp(url.hostname)) return null
  return url
}

/** Default title for a link: hostname + a trimmed path, e.g. "data.census.gov/table/ACS…". */
export function defaultLinkTitle(url: URL): string {
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  const text = `${url.hostname}${path}`
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text
}

export function cleanLinkTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean)
    : []
}

export interface LinkDropInput {
  /** Raw, as it arrived — validated here so both callers refuse the same URLs. */
  url: unknown
  title?: unknown
  note?: unknown
  category?: unknown
  tags?: unknown
  /** P5-56: an optional data-source block. `undefined`/`null` means a plain link. */
  source?: unknown
  /** false = record the link, never download it. */
  fetch?: boolean
  /**
   * P5-59: the ingest plan, when the caller already knows it. Setting a plan
   * is an ADMIN decision — this function does not check that, so every caller
   * must (the MCP tool does; the drop form does not offer it at all).
   */
  plan?: unknown
  planMode?: unknown
  actor: string
  userId: number | null
  /** The dropping user's address, so the suggestion pass bills to them. */
  clientIp?: string
}

export type LinkDropResult =
  | { error: 'bad-url' }
  | { error: 'bad-source'; dropped: string[] }
  | {
      error?: undefined
      slug: string
      kind: 'incoming' | 'source'
      status: string
      title: string
      url: string
      /** 'skipped' when nothing was queued (a source, or fetch: false). */
      fetch: FetchStatus | 'skipped'
      /** P5-59: the plan recorded on the drop, when one was. */
      plan?: IngestPlanName
      dropped: string[]
    }

/**
 * Drop a link: manifest into the bucket, catalog row, and — for a plain link
 * the caller wants downloaded — a queued fetch. Never waits for the download;
 * that is the whole point of P5-47.
 */
export async function createLinkEntry(input: LinkDropInput): Promise<LinkDropResult> {
  const url = parseLinkUrl(input.url)
  if (!url) return { error: 'bad-url' }

  const note = typeof input.note === 'string' ? input.note.trim().slice(0, NOTE_MAX) : ''
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, TITLE_MAX) : ''
  const category = typeof input.category === 'string' ? input.category.trim() : ''
  const tags = cleanLinkTags(input.tags)
  // A bare link (no title/category/tags) is a quick drop: it goes to the
  // "to file" queue. A note alone doesn't count as filing.
  const quickDrop = !title && !category && tags.length === 0
  const status = quickDrop ? 'needs-cataloging' : 'needs-review'

  // P5-56: an optional `source` block turns the drop into a data source.
  // Provider is the one thing we cannot guess, so a block without one is a
  // refusal rather than a silently-plain link drop.
  const { source, dropped } = parseSourceMeta(input.source)
  if (input.source !== undefined && input.source !== null && !source) {
    return { error: 'bad-source', dropped }
  }
  const kind: 'incoming' | 'source' = source ? 'source' : 'incoming'

  // P5-47: fetch on drop. A SOURCE is a pointer — the whole point is that we
  // do not hold that data — so it is never downloaded; `fetch: false` is the
  // same "just record the link" for anything else.
  const wantsFetch = kind === 'incoming' && input.fetch !== false

  // A plan the caller already decided. Anything else is left unset, which is
  // a real state: "no plan yet" is exactly what the admin queue lists.
  const planName = INGEST_PLANS.find(p => p === input.plan) as IngestPlanName | undefined
  const planMode = INGEST_MODES.find(m => m === input.planMode) as IngestMode | undefined
  const ingest: IngestPlan | null = planName
    ? {
        plan: planName,
        ...(planMode ? { mode: planMode } : {}),
        decidedBy: input.actor,
        decidedAt: new Date().toISOString(),
      }
    : null

  const slug = randomUUID()
  const metaKey = `${source ? SOURCES_PREFIX : 'library/incoming/'}${slug}/meta.json`
  const meta: Record<string, unknown> = {
    title: title || defaultLinkTitle(url),
    category,
    status,
    tags,
    url: url.toString(),
    ...(note ? { note } : {}),
    // The dropped link IS the source's homepage unless a better one came
    // with the block. http links are left out — the block only keeps https.
    ...(source
      ? { source: source.homepage || url.protocol !== 'https:' ? source : { ...source, homepage: url.toString() } }
      : {}),
    linkedBy: input.actor,
    linkedById: input.userId,
    linkedAt: new Date().toISOString(),
    originalFilename: null,
    ...(ingest ? { ingest } : {}),
    // Written before the job is queued so the entry is never briefly silent
    // about a download that is already on its way.
    ...(wantsFetch ? { fetch: { status: 'queued', at: new Date().toISOString() } satisfies FetchState } : {}),
  }
  const metaJson = JSON.stringify(meta, null, 2)
  await putFile(metaKey, metaJson, 'application/json')
  await indexFileBackedEntry(kind, slug, meta, [{ key: metaKey, size: Buffer.byteLength(metaJson) }])
  if (dropped.length) console.warn(sourceDropWarning(slug, dropped))

  // Queued AFTER the manifest and the row exist — the job reads both.
  let fetchState: FetchState | null = null
  if (wantsFetch) {
    fetchState = queueLinkFetch({
      slug,
      userId: input.userId,
      actor: input.actor,
      clientIp: input.clientIp,
    })
    // The queue was full: correct the optimistic 'queued' we just wrote.
    if (fetchState.status !== 'queued') void writeFetchState(slug, fetchState)
  }

  return {
    slug,
    kind,
    status,
    title: meta.title as string,
    url: url.toString(),
    fetch: fetchState ? fetchState.status : 'skipped',
    ...(planName ? { plan: planName } : {}),
    dropped,
  }
}
