import { writeFileSync, existsSync, mkdirSync } from 'node:fs'

import { guardedGet } from '../../src/services/placeHttp.js'
import { inspectMaxBytes, inspectTimeoutMs } from '../../src/services/linkInspect.js'
import { CAPTURE_MARKER, PAGES_DIR, capturePath, pagesManifest, type Capture, type EvalPage } from './fixtures.js'

/**
 * Capture the eval set's pages, once (P5-62).
 *
 *     npx tsx eval/inspect/capture.ts             # anything not captured yet
 *     npx tsx eval/inspect/capture.ts --force     # all of them again
 *     npx tsx eval/inspect/capture.ts --only usda-ers-rucc
 *
 * This is the ONLY part of the eval set that touches the network, and it is
 * meant to be run by hand and rarely. The whole point of a captured page is
 * that a score moved because the prompt changed, not because an agency
 * redesigned its site overnight.
 *
 * The fetch is the inspector's own — `guardedGet` with the inspect timeout
 * and byte cap — so what lands on disk is what `inspectUrl` would have read,
 * including the truncation if the page is bigger than the probe cap.
 */

/** The inspector's own headers. An agency that refuses these refuses
 *  production too, and we want to find that out here rather than in the UI. */
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (BLO link inspector)',
  accept: 'text/html,application/json,text/csv,*/*',
}

async function fetchPage(page: EvalPage): Promise<{ meta: Capture; html: string }> {
  const res = await guardedGet(new URL(page.url), {
    timeoutMs: inspectTimeoutMs(),
    maxBytes: inspectMaxBytes(),
    truncate: true,
    headers: HEADERS,
  })
  return {
    meta: {
      url: page.url,
      finalUrl: res.finalUrl.toString(),
      capturedAt: new Date().toISOString(),
      bytes: res.bytes,
      contentType: res.contentType,
      ...(res.truncated ? { truncated: true } : {}),
    },
    html: res.body,
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined
  const wanted = pagesManifest().pages.filter(page => (only ? page.slug === only : true))
  if (!wanted.length) {
    console.error(only ? `No page called "${only}" in pages.json` : 'No pages in pages.json')
    process.exit(1)
  }
  mkdirSync(PAGES_DIR, { recursive: true })

  let saved = 0
  let already = 0
  const failures: string[] = []

  for (const page of wanted) {
    const path = capturePath(page.slug)
    if (existsSync(path) && !force) {
      console.log(`· ${page.slug} — already captured (use --force to replace it)`)
      already++
      continue
    }
    const started = Date.now()
    try {
      const { meta, html } = await fetchPage(page)
      // The header sits ABOVE the document, so the file is still the bytes the
      // agency served plus one comment — openable in a browser, and read back
      // by `readCapture` for the final URL and the capture date.
      writeFileSync(path, `<!-- ${CAPTURE_MARKER}\n${JSON.stringify(meta, null, 2)}\n-->\n${html}`)
      console.log(
        `✓ ${page.slug} — ${meta.bytes.toLocaleString()} bytes in ${Date.now() - started} ms` +
          (meta.truncated ? ' (TRUNCATED at the probe cap)' : ''),
      )
      if (meta.finalUrl !== meta.url) console.log(`    redirected to ${meta.finalUrl}`)
      saved++
    } catch (err: any) {
      // A page that blocks automated clients is a finding, not a crash: note
      // it under "skipped" in pages.json with the reason and move on.
      failures.push(`${page.slug} (${page.url}): ${[err?.code, err?.message ?? err].filter(Boolean).join(' — ')}`)
      console.error(`✗ ${page.slug} — ${err?.message ?? err}`)
    }
  }

  console.log(`\n${saved} captured, ${already} already on disk, ${failures.length} failed`)
  if (failures.length) {
    console.log('\nFailed — add these to "skipped" in pages.json with the reason:')
    for (const line of failures) console.log(`  ${line}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
