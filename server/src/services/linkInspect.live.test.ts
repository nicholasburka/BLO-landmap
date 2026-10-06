import { describe, it, expect } from 'vitest'

/**
 * The only test in this repo that touches the real internet, and it is off
 * unless you ask for it:
 *
 *     INSPECT_LIVE=1 npx vitest run src/services/linkInspect.live.test.ts
 *
 * Fixtures keep the classifier honest about shapes we have already seen; this
 * keeps it honest about the two agencies changing their minds. Both URLs were
 * verified by hand on 2026-09-06 (see the P5-59 candidate list). A failure here
 * is as likely to mean "they moved it" as "we broke it", which is exactly why
 * it does not run in the ordinary suite.
 */

const live = process.env.INSPECT_LIVE === '1'
const { inspectUrl, inspectionSummary } = await import('./linkInspect.js')
const { proposeSource } = await import('./sourceProposal.js')
const { proposeIngestPlan } = await import('./ingestPlan.js')
const { harvestLinks } = await import('./linkHarvest.js')
const { pageText } = await import('./linkInspect.js')

describe.skipIf(!live)('inspectUrl against the real internet', () => {
  it(
    'reads NC OneMap parcels: a point layer, its columns, and a bbox in degrees',
    async () => {
      const result = await inspectUrl('https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/0')
      expect(result.kind).toBe('arcgis-layer')
      expect(result.geometry).toBe('point')
      expect(result.fields?.length ?? 0).toBeGreaterThan(30)
      // The layer publishes its extent in EPSG:2264; we must not report feet
      // as degrees, so either we converted it or we left it out.
      if (result.extent) {
        expect(Math.abs(result.extent.xmin)).toBeLessThanOrEqual(180)
        expect(Math.abs(result.extent.ymax)).toBeLessThanOrEqual(90)
      }
      // "secure" is the site's name, not an auth wall.
      expect(result.notes?.join(' ') ?? '').not.toMatch(/refused/i)

      const proposal = proposeSource(result)
      // Three FIPS-ish columns; only the 5-digit one may be the county key.
      expect(proposal.source.placeQuery?.fipsField).toBe('stcntyfips')
      expect(proposeIngestPlan(result)).toMatchObject({ plan: 'fetch-on-demand' })
      console.log('[live]', inspectionSummary(result))
    },
    60_000,
  )

  it(
    'reads the USDA ERS rural-urban continuum CSV and names FIPS as the join key',
    async () => {
      const result = await inspectUrl(
        'https://www.ers.usda.gov/sites/default/files/_laserfiche/DataFiles/53251/Ruralurbancontinuumcodes2023.csv',
      )
      expect(result.kind).toBe('file')
      expect(result.formats).toEqual(['csv'])
      expect(result.fields?.map(f => f.name)).toContain('FIPS')
      const proposal = proposeSource(result)
      expect(proposal.source.access?.[0]).toMatchObject({ type: 'download', format: 'csv' })
      expect(proposal.source.placeQuery?.fipsField).toBe('FIPS')
      expect(proposeIngestPlan(result)).toMatchObject({ plan: 'replicate', mode: 'auto' })
      console.log('[live]', inspectionSummary(result))
    },
    60_000,
  )

  /**
   * P5-61: three real agency PROSE pages, none of them a portal.
   *
   * These are the shape this ticket exists for — paragraphs about a programme
   * with the data files linked from inside them, wrapped in a department's
   * navigation. All three were reachable by hand on 2026-09-06.
   *
   * The model pass is deliberately NOT exercised: under a test runner an
   * un-injected prune does not run (see `pruner` in linkInspect.ts), so what
   * this asserts is the deterministic half — the page is reachable, it is
   * classified as a page rather than a service, and the harvest finds data
   * among the navigation. A failure here means an agency moved something.
   */
  const AGENCY_PAGES = [
    'https://www.ers.usda.gov/data-products/rural-urban-continuum-codes',
    'https://www.epa.gov/frs/geospatial-data-download-service',
    'https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html',
  ]

  it.each(AGENCY_PAGES)(
    'reads %s and harvests its data links out of the navigation',
    async url => {
      const result = await inspectUrl(url)
      expect(['page', 'portal']).toContain(result.kind)
      expect(result.title).toBeTruthy()
      // Something data-shaped was found, and the count of what the page
      // offered is stored whether or not anything read it.
      expect(result.candidates ?? 0).toBeGreaterThan(0)
      expect(result.links?.length ?? 0).toBeGreaterThan(0)
      // With no model pass the links are a guess, and must say so.
      expect(result.pruned).toBe('unranked')
      console.log('[live]', url, '\n   ', inspectionSummary(result), '·', result.candidates, 'candidates')
      for (const link of result.links ?? []) console.log('     -', link.role, link.url)
    },
    60_000,
  )
})

/**
 * The model pass against the real internet AND the real model — off unless
 * BOTH switches are on, because this one costs money:
 *
 *     INSPECT_LIVE=1 PRUNE_LIVE=1 npx vitest run src/services/linkInspect.live.test.ts
 *
 * It exists because of a bug the fixtures could not have caught: on 2026-09-06
 * the EPA FRS page came back `unranked` on a server with a key configured, and
 * NOTHING was logged. The cause was a truncated answer — 18 candidates with
 * reasons plus quoted evidence overran the output cap, the JSON never closed,
 * and `jsonObjectIn` returned null down a path that said nothing. Both halves
 * are fixed (a bigger cap, and every fallback names itself); this is what
 * keeps them fixed against pages that really are this big.
 */
const livePrune = live && process.env.PRUNE_LIVE === '1'
const { getAssistantClient } = await import('./assistantCall.js')
const { buildPruneUserMessage, pruneMaxTokens, KEPT_LINKS_MAX, ACCESS_NOTES_MAX } = await import('./linkPrune.js')

/**
 * The measurement behind the fix, and it needs no model.
 *
 * A full answer for one candidate is roughly "index + role + a reason", and
 * the prose block adds six fields plus a quoted evidence sentence each. This
 * asserts the OUTPUT cap has room for the biggest of the three real pages —
 * which 1,500 tokens did not, silently.
 */
describe.skipIf(!live)('the prune prompt against real pages', () => {
  it.each([
    'https://www.epa.gov/frs/geospatial-data-download-service',
    'https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html',
  ])('%s fits inside the token cap, in and out', async url => {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (BLO link inspector)' } })
    const html = await res.text()
    const { candidates, total } = harvestLinks(html, new URL(res.url))
    const message = buildPruneUserMessage({ url, title: 'x', text: pageText(html), candidates })
    // A full answer at the caps this module enforces: every kept link with a
    // 200-char reason, six prose fields, six access notes and six quoted
    // evidence sentences, plus JSON punctuation. ~4 chars a token, the
    // estimator's own ratio. This is the sum 1,500 did not cover.
    //
    // P5-62: this sum is a FLOOR, not the answer's real size. It measures what
    // we STORE, and the model does not know about `REASON_MAX_CHARS` — it
    // writes what it likes and we trim afterwards. The eval caught a page
    // overrunning 3,000 tokens whose worst case by this arithmetic is 2,040,
    // which is why the cap is 6,000. Keep the assertion; do not trust it alone.
    const worstCaseOut = Math.ceil((KEPT_LINKS_MAX * 240 + 6 * 220 + ACCESS_NOTES_MAX * 340 + 6 * 320) / 4)
    console.log('[live-prompt]', url, '\n   candidates', total, '· prompt', message.length, 'chars ·',
      'worst-case answer ~', worstCaseOut, 'tokens · cap', pruneMaxTokens())
    expect(worstCaseOut).toBeLessThan(pruneMaxTokens())
  }, 60_000)
})

describe.skipIf(!livePrune)('the model pass against real agency pages', () => {
  const PAGES = [
    'https://www.ers.usda.gov/data-products/rural-urban-continuum-codes',
    'https://www.epa.gov/frs/geospatial-data-download-service',
    'https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html',
  ]

  it.each(PAGES)(
    'prunes %s without falling back',
    async url => {
      const result = await inspectUrl(url, { client: getAssistantClient(), label: url })
      console.log('[live-prune]', url)
      console.log('   ', result.candidates, 'candidates ·', result.pruned, result.pruneError ? `· ${result.pruneError}` : '')
      for (const link of result.links ?? []) console.log(`     [${link.role}] ${link.url}\n        ${link.reason}`)
      if (result.prose) console.log('    prose:', JSON.stringify(result.prose, null, 2).slice(0, 900))
      console.log('    dropped:', (result.dropped ?? []).length)

      // The whole point: a page this size must not silently fall back.
      expect(result.pruneError).toBeUndefined()
      expect(result.pruned).toBe('model')
      expect(result.links?.length ?? 0).toBeGreaterThan(0)
      // Every kept link is one we harvested, never text the model wrote.
      expect(result.links!.every(l => l.role && l.reason)).toBe(true)
    },
    120_000,
  )
})
