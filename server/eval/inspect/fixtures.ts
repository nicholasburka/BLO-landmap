import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { LinkRole } from '../../src/services/linkPrune.js'

/**
 * Reading the inspection eval set off disk (P5-62).
 *
 * No network and no model here: a captured page, its capture header and its
 * hand-written label, so the scorer, the harvest test and the golden test all
 * read the same three things the same way.
 */

export const EVAL_DIR = dirname(fileURLToPath(import.meta.url))
export const PAGES_DIR = join(EVAL_DIR, 'pages')
export const LABELS_DIR = join(EVAL_DIR, 'labels')
export const GOLDEN_DIR = join(EVAL_DIR, 'golden')
export const RESULTS_DIR = join(EVAL_DIR, 'results')

/** What the capture script wrote at the top of the HTML file. */
export interface Capture {
  url: string
  /** Where we ended up. Relative links resolve against THIS, not the typed url. */
  finalUrl: string
  capturedAt: string
  bytes: number
  contentType?: string
  truncated?: boolean
}

/** One page in `pages.json`. */
export interface EvalPage {
  slug: string
  url: string
  shape: string
  why: string
}

/**
 * A label, written BY HAND after reading the page.
 *
 * `keep` is every link a careful researcher would want off this page, with
 * the role they would give it. `drop` is the tempting wrong answers
 * specifically — sibling datasets, navigation, share links — not every other
 * link on the page: anything in neither list is scored as neither, because a
 * pass that keeps a plausible extra has not made a mistake worth counting.
 */
export interface Label {
  url: string
  capturedAt: string
  isDataset: boolean
  keep: { url: string; role: LinkRole; note?: string }[]
  /**
   * Links a researcher WOULD want that the harvester cannot see.
   *
   * Two of these turned up the first time the set was labelled: the NASS
   * Quick Stats tool (an anchor reading only "Quick Stats", pointing at a bare
   * subdomain) and the TIGER file-name-definitions PDF (documents are not data
   * candidates, on purpose). Recording them in `keep` would make the harvest
   * test red for something we chose; leaving them out entirely would quietly
   * lower the bar. So they get their own list, and the harvest test asserts
   * they are still missing — the day one is harvested, the test says to move
   * it into `keep`.
   */
  keepUnharvested?: { url: string; role: LinkRole; why: string }[]
  drop: string[]
  prose: {
    provider?: string
    program?: string
    updateCadence?: string
    license?: string
    geography?: string
    coverage?: string
  }
  /**
   * P5-63: the subject a careful researcher would file this page under, as one
   * taxonomy topic id, and the tags they would give it.
   *
   * Both are LEFT OUT when the page's own words name no subject — an ArcGIS
   * Hub shell that renders everything in the browser says nothing, and a label
   * that guessed would score the guess rather than the reading. Same rule as
   * the prose fields above.
   */
  topic?: string
  tags?: string[]
  notes: string
}

/** The marker the capture script writes, and this reads back. */
export const CAPTURE_MARKER = 'BLO eval capture'

export function pagesManifest(): { pages: EvalPage[] } {
  return JSON.parse(readFileSync(join(EVAL_DIR, 'pages.json'), 'utf8'))
}

/** Every slug with a captured page on disk, in a stable order. */
export function capturedSlugs(): string[] {
  if (!existsSync(PAGES_DIR)) return []
  return readdirSync(PAGES_DIR)
    .filter(name => name.endsWith('.html'))
    .map(name => name.replace(/\.html$/, ''))
    .sort()
}

export function capturePath(slug: string): string {
  return join(PAGES_DIR, `${slug}.html`)
}

export function labelPath(slug: string): string {
  return join(LABELS_DIR, `${slug}.json`)
}

export function goldenPath(slug: string): string {
  return join(GOLDEN_DIR, `${slug}.json`)
}

/**
 * The capture header, and the HTML with it still attached.
 *
 * The header stays in the string handed to the harvester on purpose: it is
 * what production would see if an agency put a comment at the top of its
 * page, and a fixture that has been cleaned up is not the page.
 */
export function readCapture(slug: string): { capture: Capture; html: string } {
  const html = readFileSync(capturePath(slug), 'utf8')
  const header = new RegExp(`<!--\\s*${CAPTURE_MARKER}\\s*([\\s\\S]*?)-->`).exec(html)
  if (!header) throw new Error(`${slug}.html has no capture header — recapture it with eval/inspect/capture.ts`)
  return { capture: JSON.parse(header[1]) as Capture, html }
}

export function readLabel(slug: string): Label {
  return JSON.parse(readFileSync(labelPath(slug), 'utf8')) as Label
}

export function hasLabel(slug: string): boolean {
  return existsSync(labelPath(slug))
}

/**
 * One URL written the one way, so a hand-typed label and a harvested
 * candidate can be compared at all.
 *
 * `new URL().toString()` alone: it settles the default port, the percent
 * encoding and the empty path. Nothing else is touched — `/tiger/2025` and
 * `/tiger/2025/` are genuinely different addresses on a file server.
 */
export function normaliseUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    return url.toString()
  } catch {
    return raw.trim()
  }
}
