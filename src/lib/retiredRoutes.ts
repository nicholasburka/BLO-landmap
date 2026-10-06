/**
 * Where the retired pages go (P6-5, spec §A.5).
 *
 * `/library`, `/wiki`, `/layers` and `/ask` were the knowledge base's list
 * pages for all of phase 5. Every one of them is in somebody's bookmarks, in
 * a wiki page, in an email, and in the `href` of half the help recipes. So
 * none of them 404s: each works out which of the new surfaces holds the rows
 * it was asked for and hands the rest of the query straight over.
 *
 * It is a pure function on purpose — one test per case, no router, no mount —
 * and `RetiredRedirect.vue` is the two lines of Vue that run it.
 */

/** Vue Router's LocationQuery, loosened so this module needs no router
 *  import (and neither do its tests). */
export type QueryLike = Record<string, unknown>

export interface RetiredTarget {
  path: string
  query: Record<string, string>
}

function value(query: QueryLike, key: string): string {
  const raw = query[key]
  const first = Array.isArray(raw) ? raw[0] : raw
  return typeof first === 'string' ? first.trim() : ''
}

/** Everything that was not consumed by the decision, as plain strings. An
 *  empty value is dropped: `?topic=` narrows nothing and only makes the new
 *  URL uglier than the old one. */
function rest(query: QueryLike, consumed: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(query)) {
    if (consumed.includes(key)) continue
    const v = value(query, key)
    if (v) out[key] = v
  }
  return out
}

/** The catalog kinds the datasets browser holds, and the readiness chip each
 *  one answers to — `/datasets` asks "do we hold it?", not "what kind is it?",
 *  so the filter has to be translated or the list would come back unfiltered. */
const DATASET_KINDS: Record<string, string> = { dataset: 'held', source: 'indexed' }

/** The kinds the docs browser holds, under the same key it already uses. */
const DOC_KINDS = ['document', 'wiki', 'note', 'incoming']

/** Queues whose rows are datasets and sources; every other queue is docs.
 *  (The live panel decides this from the rows themselves — see `kb.ts` — but
 *  a link arriving cold has no catalog to count, so it uses the usual home.) */
const DATASET_QUEUES = ['no-organization', 'source-failing', 'in-cleaning', 'replicate-todo']

/** Old `?status=` links from the attention panel, as the queue keys the two
 *  browsers now filter by. */
const STATUS_QUEUES: Record<string, string> = {
  'needs-cataloging': 'to-file',
  'needs-review': 'needs-review',
  'in-cleaning': 'in-cleaning',
}

function queueTarget(key: string, query: QueryLike, consumed: string[]): RetiredTarget {
  const path = DATASET_QUEUES.includes(key) ? '/datasets' : '/docs'
  return { path, query: { ...rest(query, consumed), attention: key } }
}

/** `/library?…` — the one that has to think. */
function fromLibrary(query: QueryLike): RetiredTarget {
  // Adding something is its own page now.
  if (value(query, 'drop') || value(query, 'upload')) return { path: '/new', query: rest(query, ['drop', 'upload']) }

  const kind = value(query, 'kind')
  if (DATASET_KINDS[kind]) {
    return { path: '/datasets', query: { ...rest(query, ['kind']), readiness: DATASET_KINDS[kind] } }
  }
  if (DOC_KINDS.includes(kind)) return { path: '/docs', query: { ...rest(query, ['kind']), kind } }
  if (kind === 'view') return { path: '/analysis', query: rest(query, ['kind']) }

  const attention = value(query, 'attention')
  if (attention) return queueTarget(attention, query, ['attention'])

  const status = value(query, 'status')
  if (STATUS_QUEUES[status]) return queueTarget(STATUS_QUEUES[status], query, ['status'])

  // P5-65 renamed the ideas query from `category` to `purpose`; both still
  // mean the ideas shelf, which lives in Docs now.
  const purpose = value(query, 'purpose') || value(query, 'category')
  if (purpose) return { path: '/docs', query: { ...rest(query, ['purpose', 'category']), purpose } }

  // P6-21: `tag` was forwarded verbatim and then dropped on the floor —
  // `/search` has no such filter — so every shared `/library?tag=…` link
  // opened a blank page. The tag becomes the search words instead, which is
  // what the catalog can actually answer (it matches tags, and folds the
  // spelling). An explicit `q` wins: the person said what they were looking
  // for.
  const tag = value(query, 'tag')
  if (tag && !value(query, 'q')) {
    return { path: '/search', query: { ...rest(query, ['tag']), q: tag } }
  }

  // Nothing said which kind, so nothing can say which browser. Search is the
  // one page that answers across all three, and it reads the same chips.
  return { path: '/search', query: rest(query, ['tag']) }
}

/**
 * Where a retired path goes. Unknown paths fall back to the landing rather
 * than throwing — this function is only ever reached from the four routes
 * below, and a fifth added by mistake should land somewhere useful.
 */
export function retiredTarget(path: string, query: QueryLike = {}): RetiredTarget {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path
  switch (clean) {
    case '/library':
      return fromLibrary(query)
    // Every map layer is a dataset now, and a public layer's type is always
    // "statistics by county" — so the layers index IS that filter.
    case '/layers':
      return { path: '/datasets', query: { ...rest(query, ['type']), type: 'statistics' } }
    // Pages are one kind of doc.
    case '/wiki':
      return { path: '/docs', query: { ...rest(query, ['kind']), kind: 'wiki' } }
    // Ask grew into a conversation (P6-7). The question rides along in `q`.
    case '/ask':
      return { path: '/chat', query: rest(query, []) }
    default:
      return { path: '/kb', query: {} }
  }
}
