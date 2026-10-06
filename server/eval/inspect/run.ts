import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { harvestLinks, type LinkCandidate } from '../../src/services/linkHarvest.js'
import { pageText } from '../../src/services/linkInspect.js'
import { pruneLinks, type KeptLink, type LinkRole, type ProseRead } from '../../src/services/linkPrune.js'
import { getAssistantClient, type AnthropicLike } from '../../src/services/assistantCall.js'
import { askModel } from '../../src/services/askKb.js'
import {
  GOLDEN_DIR,
  RESULTS_DIR,
  capturedSlugs,
  goldenPath,
  hasLabel,
  normaliseUrl,
  readCapture,
  readLabel,
  type Label,
} from './fixtures.js'

/**
 * Score the model pass over the eval set (P5-62).
 *
 *     npm run eval:inspect                       # 3 runs of every page
 *     npm run eval:inspect -- --runs 1
 *     npm run eval:inspect -- --only epa-frs-download
 *     npm run eval:inspect -- --offline          # harvest only, no key, free
 *     npm run eval:inspect -- --write-golden     # record the first answers
 *
 * Nick's question was "how did the llm pass perform? did we informally eval
 * it?" and the honest answer was "by eye, on four pages, once". This is what
 * replaces that: fourteen captured pages, hand-labelled, run N times, with the
 * numbers written to `results/<date>.json` so the next prompt change can be
 * compared against this one rather than argued about.
 *
 * It costs money — every run is a real call — so it is a script, never a test.
 * The offline half (is every wanted link even harvested?) IS a test, next door
 * in `harvest.test.ts`.
 */

// --- What one page's score looks like ----------------------------------------

interface RunScore {
  kept: string[]
  roles: Record<string, LinkRole>
  prose: ProseRead
  pruned: 'model' | 'unranked'
  pruneError?: string
  inputTokens: number
  outputTokens: number
  ms: number
}

interface PageScore {
  slug: string
  candidates: number
  runs: number
  /** Averaged over the runs. */
  hits: number
  missed: number
  extrasBad: number
  extrasNeutral: number
  kept: number
  wanted: number
  /** Of the hits, how many carried the role the label gives them. */
  roleRight: number
  proseExact: number
  prosePartial: number
  proseWanted: number
  /** Fields the model filled in that the label leaves blank. */
  proseExtra: number
  isDatasetRight: number
  /** P5-63: did it file the page under the subject the label gives it? Only
   *  counted on pages whose label states one. */
  topicRight: number
  topicWanted: number
  /** P5-63: tags against the labelled ones, averaged over the runs. */
  tagHits: number
  tagGot: number
  tagWanted: number
  agreement: number
  inputTokens: number
  outputTokens: number
  ms: number
  fellBack: number
  /** Named, so the table can be read without the JSON beside it. */
  missedUrls: string[]
  extraBadUrls: string[]
  wrongRoles: { url: string; wanted: LinkRole; got: LinkRole }[]
}

// --- Price -------------------------------------------------------------------

/**
 * List price per million tokens, for an ESTIMATE and nothing more.
 *
 * Not a bill: it ignores caching, batch discounts and every other thing that
 * moves a real invoice. It is here so "is this pass worth running on every
 * dropped link?" has a number in front of it instead of a shrug.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

function estimateDollars(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICE_PER_MTOK[model]
  if (!price) return null
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}

// --- A client that remembers what it cost ------------------------------------

interface Call {
  inputTokens: number
  outputTokens: number
  ms: number
  text: string
}

/**
 * The real client, wrapped so the scorer can see the usage and the latency.
 *
 * `pruneLinks` returns links and prose, which is right — a caller should not
 * have to carry token counts around to store an inspection. The eval needs
 * them, so it takes them at the seam it already has: the injected client.
 */
function recordingClient(): { client: AnthropicLike; calls: Call[] } {
  const inner = getAssistantClient()
  const calls: Call[] = []
  const client = {
    messages: {
      create: async (params: any) => {
        const started = Date.now()
        const message = await inner.messages.create(params)
        calls.push({
          inputTokens: (message as any).usage?.input_tokens ?? 0,
          outputTokens: (message as any).usage?.output_tokens ?? 0,
          ms: Date.now() - started,
          text: ((message as any).content ?? [])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n'),
        })
        return message
      },
    },
  } as unknown as AnthropicLike
  return { client, calls }
}

// --- Comparing words ---------------------------------------------------------

const fold = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tokens = (value: string) => new Set(fold(value).split(' ').filter(word => word.length > 2))

/**
 * exact · partial · miss, for one prose field.
 *
 * Partial is generous on purpose: a label says "USDA Economic Research
 * Service" and a model says "Economic Research Service (ERS), U.S. Department
 * of Agriculture". Those are the same answer, and scoring it a miss would
 * make the number measure phrasing rather than reading.
 */
function matchField(label: string, got: string | undefined): 'exact' | 'partial' | 'miss' {
  if (!got) return 'miss'
  if (fold(label) === fold(got)) return 'exact'
  if (fold(got).includes(fold(label)) || fold(label).includes(fold(got))) return 'partial'
  const wanted = tokens(label)
  const have = tokens(got)
  if (!wanted.size) return 'miss'
  let shared = 0
  for (const word of wanted) if (have.has(word)) shared++
  return shared / wanted.size >= 0.6 ? 'partial' : 'miss'
}

const PROSE_FIELDS = ['provider', 'program', 'updateCadence', 'license', 'coverage', 'geography'] as const

/** How alike two runs' answers were: |A ∩ B| / |A ∪ B| over the kept URLs. */
function jaccard(a: string[], b: string[]): number {
  const left = new Set(a)
  const right = new Set(b)
  if (!left.size && !right.size) return 1
  let shared = 0
  for (const url of left) if (right.has(url)) shared++
  return shared / (left.size + right.size - shared)
}

// --- One page ----------------------------------------------------------------

async function scorePage(slug: string, runs: number, client: AnthropicLike, calls: Call[]): Promise<PageScore> {
  const { capture, html } = readCapture(slug)
  const label = readLabel(slug)
  const finalUrl = new URL(capture.finalUrl)
  const { candidates, total } = harvestLinks(html, finalUrl)
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim()

  const results: RunScore[] = []
  for (let run = 0; run < runs; run++) {
    const before = calls.length
    const started = Date.now()
    const pruned = await pruneLinks(
      { url: capture.finalUrl, ...(title ? { title } : {}), text: pageText(html), candidates },
      { client, label: slug },
    )
    const call = calls[before]
    results.push({
      kept: pruned.links.map(l => normaliseUrl(l.url)),
      roles: Object.fromEntries(pruned.links.map(l => [normaliseUrl(l.url), l.role])),
      prose: pruned.prose ?? {},
      pruned: pruned.pruned,
      ...(pruned.pruneError ? { pruneError: pruned.pruneError } : {}),
      inputTokens: call?.inputTokens ?? 0,
      outputTokens: call?.outputTokens ?? 0,
      ms: call?.ms ?? Date.now() - started,
    })
  }

  return summarise(slug, label, total, results)
}

function summarise(slug: string, label: Label, candidates: number, results: RunScore[]): PageScore {
  const wanted = new Map(label.keep.map(k => [normaliseUrl(k.url), k.role]))
  const bad = new Set(label.drop.map(normaliseUrl))

  const totals = {
    hits: 0,
    missed: 0,
    extrasBad: 0,
    extrasNeutral: 0,
    kept: 0,
    roleRight: 0,
    proseExact: 0,
    prosePartial: 0,
    proseExtra: 0,
    isDatasetRight: 0,
    topicRight: 0,
    tagHits: 0,
    tagGot: 0,
    inputTokens: 0,
    outputTokens: 0,
    ms: 0,
    fellBack: 0,
  }
  const missedUrls = new Set<string>()
  const extraBadUrls = new Set<string>()
  const wrongRoles = new Map<string, { url: string; wanted: LinkRole; got: LinkRole }>()

  for (const run of results) {
    const kept = new Set(run.kept)
    totals.kept += kept.size
    for (const [url, role] of wanted) {
      if (kept.has(url)) {
        totals.hits++
        if (run.roles[url] === role) totals.roleRight++
        else wrongRoles.set(url, { url, wanted: role, got: run.roles[url] })
      } else {
        totals.missed++
        missedUrls.add(url)
      }
    }
    for (const url of kept) {
      if (wanted.has(url)) continue
      if (bad.has(url)) {
        totals.extrasBad++
        extraBadUrls.add(url)
      } else {
        totals.extrasNeutral++
      }
    }
    for (const field of PROSE_FIELDS) {
      const want = label.prose[field]
      const got = run.prose[field]
      if (!want) {
        if (got) totals.proseExtra++
        continue
      }
      const verdict = matchField(want, got)
      if (verdict === 'exact') totals.proseExact++
      else if (verdict === 'partial') totals.prosePartial++
    }
    if ((run.prose.isDataset ?? null) === label.isDataset) totals.isDatasetRight++
    // P5-63. A label with no topic is a page whose words name no subject, so
    // it asks nothing of the pass and is left out of the accuracy entirely.
    if (label.topic && run.prose.topic === label.topic) totals.topicRight++
    if (label.tags?.length) {
      const want = new Set(label.tags)
      const got = run.prose.tags ?? []
      totals.tagGot += got.length
      for (const tag of got) if (want.has(tag)) totals.tagHits++
    }
    totals.inputTokens += run.inputTokens
    totals.outputTokens += run.outputTokens
    totals.ms += run.ms
    if (run.pruned !== 'model') totals.fellBack++
  }

  // Every pair of runs, so three runs give three comparisons.
  const pairs: number[] = []
  for (let a = 0; a < results.length; a++) {
    for (let b = a + 1; b < results.length; b++) pairs.push(jaccard(results[a].kept, results[b].kept))
  }

  const n = results.length
  const proseWanted = PROSE_FIELDS.filter(field => label.prose[field]).length
  return {
    slug,
    candidates,
    runs: n,
    hits: totals.hits / n,
    missed: totals.missed / n,
    extrasBad: totals.extrasBad / n,
    extrasNeutral: totals.extrasNeutral / n,
    kept: totals.kept / n,
    wanted: wanted.size,
    roleRight: totals.roleRight / n,
    proseExact: totals.proseExact / n,
    prosePartial: totals.prosePartial / n,
    proseWanted,
    proseExtra: totals.proseExtra / n,
    isDatasetRight: totals.isDatasetRight / n,
    topicRight: totals.topicRight / n,
    topicWanted: label.topic ? 1 : 0,
    tagHits: totals.tagHits / n,
    tagGot: totals.tagGot / n,
    tagWanted: label.tags?.length ?? 0,
    agreement: pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : 1,
    inputTokens: totals.inputTokens / n,
    outputTokens: totals.outputTokens / n,
    ms: totals.ms / n,
    fellBack: totals.fellBack,
    missedUrls: [...missedUrls],
    extraBadUrls: [...extraBadUrls],
    wrongRoles: [...wrongRoles.values()],
  }
}

// --- Printing ----------------------------------------------------------------

const pad = (value: string | number, width: number) => String(value).padEnd(width)
const padLeft = (value: string | number, width: number) => String(value).padStart(width)
const ratio = (top: number, bottom: number) => (bottom ? `${Math.round((top / bottom) * 100)}%` : '—')
const round1 = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))

function printTable(scores: PageScore[], model: string): void {
  const head =
    pad('page', 26) +
    padLeft('cand', 5) +
    padLeft('kept', 6) +
    padLeft('hit', 6) +
    padLeft('miss', 6) +
    padLeft('bad', 5) +
    padLeft('neut', 6) +
    padLeft('role', 7) +
    padLeft('prose', 8) +
    padLeft('ds', 5) +
    padLeft('topic', 7) +
    padLeft('tags', 8) +
    padLeft('agree', 7) +
    padLeft('in', 8) +
    padLeft('out', 7) +
    padLeft('s', 7) +
    padLeft('$/page', 9)
  console.log(head)
  console.log('-'.repeat(head.length))
  for (const s of scores) {
    const dollars = estimateDollars(model, s.inputTokens, s.outputTokens)
    console.log(
      pad(s.slug, 26) +
        padLeft(s.candidates, 5) +
        padLeft(round1(s.kept), 6) +
        padLeft(`${round1(s.hits)}/${s.wanted}`, 6) +
        padLeft(round1(s.missed), 6) +
        padLeft(round1(s.extrasBad), 5) +
        padLeft(round1(s.extrasNeutral), 6) +
        padLeft(ratio(s.roleRight, s.hits), 7) +
        padLeft(`${round1(s.proseExact + s.prosePartial)}/${s.proseWanted}`, 8) +
        padLeft(ratio(s.isDatasetRight, 1), 5) +
        padLeft(s.topicWanted ? ratio(s.topicRight, 1) : '—', 7) +
        padLeft(s.tagWanted ? `${round1(s.tagHits)}/${s.tagWanted}` : '—', 8) +
        padLeft(s.runs > 1 ? s.agreement.toFixed(2) : '—', 7) +
        padLeft(Math.round(s.inputTokens), 8) +
        padLeft(Math.round(s.outputTokens), 7) +
        padLeft((s.ms / 1000).toFixed(1), 7) +
        padLeft(dollars === null ? '?' : `$${dollars.toFixed(4)}`, 9),
    )
  }
}

interface Summary {
  pages: number
  runs: number
  precision: number
  recall: number
  roleAccuracy: number
  isDatasetRight: number
  isDatasetOf: number
  /** P5-63: subject accuracy over the pages whose label states one. */
  topicRight: number
  topicOf: number
  /** P5-63: tag precision and recall against the labelled tags. */
  tagPrecision: number
  tagRecall: number
  agreement: number
  proseExact: number
  prosePartial: number
  proseWanted: number
  inputTokens: number
  outputTokens: number
  ms: number
  dollarsPerPage: number | null
  fellBack: number
}

function summariseAll(scores: PageScore[], model: string): Summary {
  const sum = (pick: (s: PageScore) => number) => scores.reduce((total, s) => total + pick(s), 0)
  const hits = sum(s => s.hits)
  const kept = sum(s => s.kept)
  const wanted = sum(s => s.wanted)
  const inputTokens = sum(s => s.inputTokens) / (scores.length || 1)
  const outputTokens = sum(s => s.outputTokens) / (scores.length || 1)
  return {
    pages: scores.length,
    runs: scores[0]?.runs ?? 0,
    // Precision counts a NEUTRAL extra against the pass too: storing a link
    // nobody asked for is the link-tree spam this whole pass exists to stop.
    precision: kept ? hits / kept : 0,
    recall: wanted ? hits / wanted : 0,
    roleAccuracy: hits ? sum(s => s.roleRight) / hits : 0,
    isDatasetRight: sum(s => s.isDatasetRight),
    isDatasetOf: scores.length,
    topicRight: sum(s => s.topicRight),
    topicOf: sum(s => s.topicWanted),
    tagPrecision: sum(s => s.tagGot) ? sum(s => s.tagHits) / sum(s => s.tagGot) : 0,
    tagRecall: sum(s => s.tagWanted) ? sum(s => s.tagHits) / sum(s => s.tagWanted) : 0,
    agreement: scores.length ? sum(s => s.agreement) / scores.length : 0,
    proseExact: sum(s => s.proseExact),
    prosePartial: sum(s => s.prosePartial),
    proseWanted: sum(s => s.proseWanted),
    inputTokens,
    outputTokens,
    ms: sum(s => s.ms) / (scores.length || 1),
    dollarsPerPage: estimateDollars(model, inputTokens, outputTokens),
    fellBack: sum(s => s.fellBack),
  }
}

function summaryLine(summary: Summary, model: string): string {
  const cost =
    summary.dollarsPerPage === null
      ? `cost unknown for ${model}`
      : `~$${summary.dollarsPerPage.toFixed(4)} per page (estimated from tokens at ${model}'s list price)`
  return (
    `links: precision ${(summary.precision * 100).toFixed(0)}% recall ${(summary.recall * 100).toFixed(0)}% · ` +
    `roles ${(summary.roleAccuracy * 100).toFixed(0)}% · ` +
    `isDataset ${summary.isDatasetRight.toFixed(1)}/${summary.isDatasetOf} · ` +
    `topic ${summary.topicRight.toFixed(1)}/${summary.topicOf} · ` +
    `tags P${(summary.tagPrecision * 100).toFixed(0)}%/R${(summary.tagRecall * 100).toFixed(0)}% · ` +
    `agreement ${summary.agreement.toFixed(2)} · ${cost}`
  )
}

// --- The delta against last time ---------------------------------------------

interface ResultsFile {
  recordedAt: string
  model: string
  runs: number
  summary: Summary
  pages: PageScore[]
}

/**
 * `results/<date>.json`, or `<date>T<hh-mm>.json` when that day already has
 * one.
 *
 * The ticket asks for a file per date and that is the common case. But the
 * day a prompt is being changed is exactly the day it gets run twice, and the
 * second run silently overwriting the first would take the delta column — the
 * whole point of keeping the file — away on the one day it is wanted.
 */
function resultsPath(): string {
  const now = new Date()
  const day = join(RESULTS_DIR, `${now.toISOString().slice(0, 10)}.json`)
  if (!existsSync(day)) return day
  return join(RESULTS_DIR, `${now.toISOString().slice(0, 16).replace(':', '-')}.json`)
}

function previousResults(todaysFile: string): ResultsFile | null {
  if (!existsSync(RESULTS_DIR)) return null
  const files = readdirSync(RESULTS_DIR)
    .filter(name => name.endsWith('.json') && join(RESULTS_DIR, name) !== todaysFile)
    .sort()
  const last = files[files.length - 1]
  if (!last) return null
  try {
    return JSON.parse(readFileSync(join(RESULTS_DIR, last), 'utf8')) as ResultsFile
  } catch {
    return null
  }
}

function printDelta(now: Summary, before: ResultsFile): void {
  const arrow = (value: number, digits = 0, suffix = '') =>
    `${value > 0 ? '+' : ''}${value.toFixed(digits)}${suffix}`
  console.log(`\nAgainst ${before.recordedAt.slice(0, 10)} (${before.runs} runs, ${before.model}):`)
  console.log(`  precision ${arrow((now.precision - before.summary.precision) * 100, 0, ' pts')}`)
  console.log(`  recall    ${arrow((now.recall - before.summary.recall) * 100, 0, ' pts')}`)
  console.log(`  roles     ${arrow((now.roleAccuracy - before.summary.roleAccuracy) * 100, 0, ' pts')}`)
  console.log(`  isDataset ${arrow(now.isDatasetRight - before.summary.isDatasetRight, 1, ' pages')}`)
  // P5-63 added these; an older results file has neither, so they read as new
  // rather than as a change from zero.
  if (before.summary.topicOf !== undefined) {
    console.log(`  topic     ${arrow(now.topicRight - before.summary.topicRight, 1, ' pages')}`)
    console.log(`  tag recall${arrow((now.tagRecall - before.summary.tagRecall) * 100, 0, ' pts')}`)
  } else {
    console.log(`  topic     new: ${now.topicRight.toFixed(1)}/${now.topicOf} pages`)
    console.log(`  tags      new: P${(now.tagPrecision * 100).toFixed(0)}% R${(now.tagRecall * 100).toFixed(0)}%`)
  }
  console.log(`  agreement ${arrow(now.agreement - before.summary.agreement, 2)}`)
  console.log(`  out tok   ${arrow(now.outputTokens - before.summary.outputTokens, 0)}`)
}

// --- Offline ------------------------------------------------------------------

function runOffline(slugs: string[]): void {
  console.log('Harvest only — no model, no key, no cost.\n')
  const head = pad('page', 26) + padLeft('cand', 6) + padLeft('found', 8) + padLeft('gaps', 6) + '  missing'
  console.log(head)
  console.log('-'.repeat(head.length))
  let found = 0
  let wanted = 0
  for (const slug of slugs) {
    const { capture, html } = readCapture(slug)
    const label = readLabel(slug)
    const { candidates, total } = harvestLinks(html, new URL(capture.finalUrl))
    const harvested = new Set(candidates.map(c => normaliseUrl(c.url)))
    const missing = label.keep.filter(k => !harvested.has(normaliseUrl(k.url)))
    found += label.keep.length - missing.length
    wanted += label.keep.length
    console.log(
      pad(slug, 26) +
        padLeft(total, 6) +
        padLeft(`${label.keep.length - missing.length}/${label.keep.length}`, 8) +
        padLeft((label.keepUnharvested ?? []).length, 6) +
        (missing.length ? `  ${missing.map(m => m.url).join(' ')}` : ''),
    )
  }
  console.log(`\nharvest recall ${wanted ? ((found / wanted) * 100).toFixed(0) : 0}% (${found}/${wanted} wanted links found among the candidates)`)
  const gaps = slugs.flatMap(slug => (readLabel(slug).keepUnharvested ?? []).map(g => ({ slug, ...g })))
  if (gaps.length) {
    console.log('\nKnown gaps — links a researcher wants that the harvester cannot see:')
    for (const gap of gaps) console.log(`  ${gap.slug}: ${gap.url}\n    ${gap.why}`)
  }
}

// --- Golden -------------------------------------------------------------------

/**
 * The answer this run produced, checked in so the validators and the proposal
 * mapping can be refactored without a model call. Written once, on purpose —
 * a golden that regenerates itself asserts nothing.
 */
function writeGolden(
  slug: string,
  model: string,
  answer: string,
  candidates: LinkCandidate[],
  links: KeptLink[],
  prose: ProseRead,
): void {
  mkdirSync(GOLDEN_DIR, { recursive: true })
  const path = goldenPath(slug)
  if (existsSync(path)) {
    console.log(`  · golden for ${slug} already exists — left alone`)
    return
  }
  const { capture } = readCapture(slug)
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        slug,
        url: capture.finalUrl,
        capturedAt: capture.capturedAt,
        recordedAt: new Date().toISOString(),
        model,
        answer,
        // The candidate list is stored WITH the answer because the answer
        // names links by index. Without it a golden would silently start
        // asserting about different URLs the first time the harvester
        // changed — which is exactly what happened the day it was written.
        candidates,
        expected: { links, prose },
      },
      null,
      2,
    )}\n`,
  )
  console.log(`  · wrote golden/${slug}.json`)
}

// --- Main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const offline = argv.includes('--offline')
  const writeGoldens = argv.includes('--write-golden')
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined
  const runsArg = argv.includes('--runs') ? Number(argv[argv.indexOf('--runs') + 1]) : 3
  const runs = Number.isFinite(runsArg) && runsArg > 0 ? Math.floor(runsArg) : 3

  const slugs = capturedSlugs()
    .filter(hasLabel)
    .filter(slug => (only ? slug === only : true))
  if (!slugs.length) {
    console.error(only ? `No captured, labelled page called "${only}"` : 'No captured, labelled pages — run capture.ts first')
    process.exit(1)
  }

  if (offline) {
    runOffline(slugs)
    return
  }

  if (!(process.env.ANTHROPIC_API_KEY ?? '').trim()) {
    console.error('This needs ANTHROPIC_API_KEY (the scorer calls the real model, which costs money).')
    console.error('In the server directory:  set -a; . ./.env; set +a')
    console.error('Or run it free with --offline, which scores the harvest alone.')
    process.exit(1)
  }

  const model = askModel()
  console.log(`${slugs.length} pages × ${runs} run${runs === 1 ? '' : 's'} against ${model}\n`)
  const { client, calls } = recordingClient()
  const scores: PageScore[] = []
  for (const slug of slugs) {
    const before = calls.length
    const score = await scorePage(slug, runs, client, calls)
    scores.push(score)
    console.log(
      `✓ ${pad(slug, 26)} kept ${round1(score.kept)}, hit ${round1(score.hits)}/${score.wanted}` +
        (score.fellBack ? `  [FELL BACK ${score.fellBack}×]` : ''),
    )
    if (writeGoldens) {
      // The FIRST run's answer, which is what a golden is: one recorded reply.
      const first = calls[before]
      if (first) {
        const { capture, html } = readCapture(slug)
        const { candidates } = harvestLinks(html, new URL(capture.finalUrl))
        const replay = await replayAnswer(first.text, candidates)
        if (replay) writeGolden(slug, model, first.text, candidates, replay.links, replay.prose)
      }
    }
  }

  console.log('')
  printTable(scores, model)
  const summary = summariseAll(scores, model)
  console.log(`\n${summaryLine(summary, model)}`)
  console.log(
    `prose ${summary.proseExact.toFixed(1)} exact + ${summary.prosePartial.toFixed(1)} partial of ${summary.proseWanted} labelled fields · ` +
      `${(summary.ms / 1000).toFixed(1)} s per page` +
      (summary.fellBack ? ` · ${summary.fellBack} fallbacks` : ''),
  )

  for (const score of scores) {
    if (!score.missedUrls.length && !score.extraBadUrls.length && !score.wrongRoles.length) continue
    console.log(`\n${score.slug}`)
    for (const url of score.missedUrls) console.log(`  missed  ${url}`)
    for (const url of score.extraBadUrls) console.log(`  kept a link the label drops  ${url}`)
    for (const role of score.wrongRoles) console.log(`  role    ${role.url}\n            wanted ${role.wanted}, got ${role.got ?? '(none)'}`)
  }

  mkdirSync(RESULTS_DIR, { recursive: true })
  const path = resultsPath()
  const previous = previousResults(path)
  const file: ResultsFile = { recordedAt: new Date().toISOString(), model, runs, summary, pages: scores }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  console.log(`\nWrote ${path.replace(`${process.cwd()}/`, '')}`)
  if (previous) printDelta(summary, previous)
  else console.log('No earlier results to compare against — this run is the baseline.')
}

/** Re-parse one recorded answer exactly as `pruneLinks` would have. */
async function replayAnswer(text: string, candidates: LinkCandidate[]) {
  const { unwrapAnswer, parseKeptLinks, parseProse, foldAccessNotes } = await import('../../src/services/linkPrune.js')
  const parsed = unwrapAnswer(text)
  if (!parsed) return null
  const links = parseKeptLinks(parsed, candidates)
  return { links, prose: foldAccessNotes(links, parseProse(parsed, candidates)) }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
