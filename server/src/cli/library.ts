import 'dotenv/config'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { closeLibraryDb, initLibraryDb, isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import {
  closeLibraryBucket,
  deleteFile,
  getFile,
  initLibraryBucket,
  isSafeKey,
  listFiles,
  putFileFromPath,
  walkLocal,
} from '../services/libraryBucket.js'
import { DATASET_STATUSES, NOTE_STATUSES, reindexCatalog } from '../services/libraryCatalog.js'
import { isDerivedKey } from '../services/textExtract.js'
import { parseGeocodeArgs, runGeocode } from './geocode.js'
import { fetchLink } from './fetchLink.js'
import { printCoverageTable, printOrganizationTable, printRetagTable, printShapeTable, retagLibrary } from './retag.js'
import { formatProximityReport, isLibraryTree, parseProximityArgs, runProximity } from './proximity.js'
import { formatCompositeReport, parseCompositeArgs, runComposite } from './composite.js'

/**
 * Dev sync CLI (P5-13) — the "fluid pathway": pull the library tree to a
 * local folder, clean data there (by hand or with Claude Code), push it back.
 *
 *   npm run library -- pull   [--prune]           # bucket → local folder
 *   npm run library -- push   [--delete] [--delete-incoming] [--force]
 *   npm run library -- status                      # dry-run diff, no writes
 *   npm run library -- geocode <csv> …             # enrichment: lat/lng/GEOID (P5-23, see geocode.ts)
 *   npm run library -- retag  [--apply] [--organizations] [--shapes] [--coverage]
 *                                                  # vocabulary migrations (P5-63, P6-1, P6-2, P6-19, see retag.ts)
 *   npm run library -- proximity <set> --to <layer> [--apply]
 *                                                  # bulk proximity into a working set's derived column
 *                                                  # (P7-5, see proximity.ts) — no ceiling, unlike the API
 *   npm run library -- index <set> --name <label> --layer <layer>:<weight>:<direction> … [--apply]
 *                                                  # bulk weighted index into a working set's derived
 *                                                  # column (P7-8, see composite.ts) — no ceiling either
 *
 * All commands take --dir <path> (default $LIBRARY_SYNC_DIR or ./library-local).
 *
 * Design notes:
 *  - SDK sync, not an rclone wrapper: reuses the bucket service (SAFE_KEY
 *    enforcement, B2 checksum quirks already solved) and is testable against
 *    FakeS3. rclone remains documented in DEPLOY.md as the raw escape hatch.
 *  - Non-destructive by default: push never deletes remote objects without
 *    --delete, pull never deletes local files without --prune. Strays are
 *    reported either way. --delete still spares library/incoming/, where
 *    teammates' uploads land between one pull and the next: a --delete from
 *    a folder pulled an hour ago would destroy drops nobody has seen yet.
 *    Removing those takes --delete-incoming as well.
 *  - Comparison is by size, EXCEPT meta.json manifests, which are compared
 *    by content — a status flip can be size-neutral and manifests are the
 *    catalog's truth, so they must never be missed. (`status` is size-only.)
 *  - main() points the bucket service's mirror at a fresh temp dir per run,
 *    so the mirror-first getFile cache can never serve stale bytes on a dev
 *    machine. Command functions are exported for tests.
 */

const META_SUFFIX = '/meta.json'
const KNOWN_STATUSES = [...DATASET_STATUSES, 'needs-cataloging', ...NOTE_STATUSES]

function defaultSyncDir(): string {
  return resolve(process.env.LIBRARY_SYNC_DIR || './library-local')
}

async function localSize(path: string): Promise<number | null> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return null
  }
}

/** Uploads land here; see the --delete note above. */
const INCOMING_PREFIX = 'library/incoming/'

/** Working files of the local folder, not library content: editor and OS
 *  droppings (.DS_Store, .swp, anything under .git) and the geocoder's
 *  resume cache, which is a large by-product of a run rather than something
 *  anyone means to publish. */
function isLocalWorkingFile(key: string): boolean {
  const segments = key.split('/')
  return segments.some(seg => seg.startsWith('.')) || key.endsWith('.geocode-cache.json')
}

async function listLocal(localDir: string): Promise<string[]> {
  const out: string[] = []
  await walkLocal(join(localDir, 'library'), localDir, out)
  return out.filter(key => !isLocalWorkingFile(key)).sort()
}

/**
 * The bucket as this CLI sees it: everything except `library/derived/`, the
 * text the server pulls out of documents (P5-46).
 *
 * Derived text is a by-product the server rebuilds on demand, not library
 * content. Mirroring it would bloat every dev's folder with machine-written
 * JSON nobody edits — and, worse, a `push --delete` from a folder pulled
 * before those files existed would delete them all as strays.
 */
async function listRemote(): Promise<{ key: string; size: number }[]> {
  return (await listFiles('library/')).filter(file => !isDerivedKey(file.key))
}

/** Manifest sanity warnings (push): files are the truth, so problems warn
 *  rather than block — but a malformed manifest or unknown status is almost
 *  certainly a mistake the dev wants to hear about before it hits the index. */
async function metaWarnings(key: string, path: string): Promise<string[]> {
  const warnings: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    warnings.push(`${key}: not valid JSON — the catalog will index this entry with defaults`)
    return warnings
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`${key}: not a JSON object — the catalog will index this entry with defaults`)
    return warnings
  }
  const status = (parsed as Record<string, unknown>).status
  if (typeof status === 'string' && status && !KNOWN_STATUSES.includes(status)) {
    warnings.push(`${key}: unknown status "${status}" — known statuses: ${KNOWN_STATUSES.join(', ')}`)
  }
  return warnings
}

function contentTypeFor(key: string): string | undefined {
  if (key.endsWith('.json')) return 'application/json'
  if (key.endsWith('.csv')) return 'text/csv'
  if (key.endsWith('.md')) return 'text/markdown'
  return undefined
}

export interface PullResult {
  downloaded: string[]
  skipped: number
  localStrays: string[]
  pruned: string[]
}

/** Bucket → local folder. Downloads missing/size-changed files; manifests
 *  are content-compared. Local strays are reported, deleted only with prune. */
export async function pullLibrary(
  localDir: string,
  options: { prune?: boolean } = {},
): Promise<PullResult> {
  const remote = await listRemote()
  const remoteKeys = new Set(remote.map(f => f.key))
  const downloaded: string[] = []
  let skipped = 0

  for (const file of remote) {
    if (!isSafeKey(file.key)) {
      console.warn(`[library] skipping unsafe remote key ${JSON.stringify(file.key)}`)
      continue
    }
    const path = join(localDir, file.key)
    const size = await localSize(path)
    let body: Buffer | null = null
    if (size === file.size) {
      if (!file.key.endsWith(META_SUFFIX)) {
        skipped++
        continue
      }
      body = await getFile(file.key)
      if (body.equals(await fs.readFile(path))) {
        skipped++
        continue
      }
    }
    body = body ?? (await getFile(file.key))
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, body)
    downloaded.push(file.key)
  }

  const localStrays = (await listLocal(localDir)).filter(key => !remoteKeys.has(key))
  const pruned: string[] = []
  if (options.prune) {
    for (const key of localStrays) {
      await fs.rm(join(localDir, key), { force: true })
      pruned.push(key)
    }
  }
  return { downloaded: downloaded.sort(), skipped, localStrays, pruned }
}

export interface PushResult {
  uploaded: string[]
  skipped: number
  remoteStrays: string[]
  deleted: string[]
  /** Strays under library/incoming/ that --delete deliberately spared. */
  skippedIncoming: string[]
  warnings: string[]
  /** reindexCatalog() count, or null when the catalog DB is unavailable. */
  indexed: number | null
}

/** Local folder → bucket, then rebuild the catalog index. Never deletes
 *  remote objects unless the delete flag is set. */
export async function pushLibrary(
  localDir: string,
  options: { delete?: boolean; force?: boolean; deleteIncoming?: boolean } = {},
): Promise<PushResult> {
  const localKeys = await listLocal(localDir)
  if (localKeys.length === 0) {
    throw new Error(
      `nothing to push — no files under ${join(localDir, 'library')} (run "library pull" first)`,
    )
  }
  const remoteSizes = new Map((await listRemote()).map(f => [f.key, f.size]))
  const uploaded: string[] = []
  const warnings: string[] = []
  let skipped = 0

  for (const key of localKeys) {
    if (!isSafeKey(key)) {
      warnings.push(
        `skipped ${JSON.stringify(key)} — unsafe name (use letters, digits, . _ - only; no spaces)`,
      )
      continue
    }
    const path = join(localDir, key)
    if (key.endsWith(META_SUFFIX)) warnings.push(...(await metaWarnings(key, path)))

    const size = (await fs.stat(path)).size
    const remoteSize = remoteSizes.get(key)
    let changed = options.force || remoteSize === undefined || remoteSize !== size
    if (!changed && key.endsWith(META_SUFFIX)) {
      // Size-neutral manifest edits (e.g. a status flip) must still sync.
      changed = !(await getFile(key)).equals(await fs.readFile(path))
    }
    if (!changed) {
      skipped++
      continue
    }
    await putFileFromPath(key, path, size, contentTypeFor(key), { keepSource: true })
    uploaded.push(key)
  }

  const localSet = new Set(localKeys)
  const remoteStrays = [...remoteSizes.keys()].filter(key => !localSet.has(key)).sort()
  const deleted: string[] = []
  const skippedIncoming: string[] = []
  if (options.delete) {
    for (const key of remoteStrays) {
      // An incoming/ stray is far more likely to be a drop made after this
      // folder was pulled than a file the dev meant to remove.
      if (key.startsWith(INCOMING_PREFIX) && !options.deleteIncoming) {
        skippedIncoming.push(key)
        continue
      }
      await deleteFile(key)
      deleted.push(key)
    }
    if (skippedIncoming.length) {
      warnings.push(
        `kept ${skippedIncoming.length} remote file(s) under ${INCOMING_PREFIX} that are not in your local folder — ` +
          'pull first, or pass --delete-incoming as well to remove them',
      )
    }
  }

  let indexed: number | null = null
  if (isLibraryEnabled()) {
    indexed = (await reindexCatalog()).indexed
    if (uploaded.length || deleted.length) {
      await writeAudit({
        actor: 'cli',
        action: 'library.push',
        detail: { uploaded: uploaded.length, deleted: deleted.length, indexed },
      })
    }
  } else {
    warnings.push(
      'pushed but NOT reindexed — DATABASE_URL is unset or unreachable; ' +
        'hit Reindex in the app (or rerun push with the DB reachable) so the catalog sees the changes',
    )
  }
  return { uploaded, skipped, remoteStrays, deleted, skippedIncoming, warnings, indexed }
}

export interface StatusResult {
  changed: string[]
  remoteOnly: string[]
  localOnly: string[]
}

/** Dry-run diff (size-based; push additionally content-compares manifests). */
export async function statusLibrary(localDir: string): Promise<StatusResult> {
  const remoteSizes = new Map((await listRemote()).map(f => [f.key, f.size]))
  const localKeys = await listLocal(localDir)
  const localSet = new Set(localKeys)
  const changed: string[] = []
  const localOnly: string[] = []
  for (const key of localKeys) {
    const remoteSize = remoteSizes.get(key)
    if (remoteSize === undefined) localOnly.push(key)
    else if (remoteSize !== (await fs.stat(join(localDir, key))).size) changed.push(key)
  }
  const remoteOnly = [...remoteSizes.keys()].filter(key => !localSet.has(key)).sort()
  return { changed, remoteOnly, localOnly }
}

// ---- main -----------------------------------------------------------------

function printList(label: string, keys: string[]): void {
  if (!keys.length) return
  console.log(`${label}:`)
  for (const key of keys) console.log(`  ${key}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  const flags = new Set(args.filter(a => a.startsWith('--')))
  const dirIndex = args.indexOf('--dir')
  const localDir =
    dirIndex !== -1 && args[dirIndex + 1] ? resolve(args[dirIndex + 1]) : defaultSyncDir()

  // Enrichment (P5-23): pure local work — no bucket or DB needed.
  if (command === 'geocode') {
    const parsed = parseGeocodeArgs(args)
    if ('error' in parsed) {
      console.error(parsed.error)
      console.error(
        'Usage: npm run library -- geocode <csv> (--address COL | --city COL --state COL | --lat COL --lng COL | --county COL --state COL)\n' +
          '       [--out <path> | --in-place] [--dry-run] [--force] [--conflict-field <prefix>]',
      )
      process.exitCode = 1
      return
    }
    await runGeocode(parsed)
    return
  }

  // Bulk proximity (P7-5): pure local file work over a pulled tree, like
  // retag. No bucket, no DB — and NO row ceiling, which is the whole reason
  // this exists beside the API's on-demand tier (spec §F.4b).
  if (command === 'proximity') {
    const parsed = parseProximityArgs(args)
    if ('error' in parsed) {
      console.error(parsed.error)
      console.error(
        'Usage: npm run library -- proximity <working-set> --to <layer> [--from <dataset>]\n' +
          '       [--within <miles>] [--id <column>] [--apply] [--dir <path>]',
      )
      process.exitCode = 1
      return
    }
    if (!(await isLibraryTree(localDir))) {
      console.error(`no library tree under ${join(localDir, 'library')} — is --dir pointing at a pulled tree?`)
      process.exitCode = 1
      return
    }
    try {
      console.log(formatProximityReport(await runProximity(parsed, localDir)))
    } catch (err: any) {
      console.error(err?.message || err)
      process.exitCode = 1
    }
    return
  }

  // Bulk weighted index (P7-8): the same tier-1 shape as proximity — pure
  // local file work over a pulled tree, no bucket, no DB, and NO byte ceiling,
  // which is what the API's 413 names when it declines (spec §F.4b).
  if (command === 'index') {
    const parsed = parseCompositeArgs(args)
    if ('error' in parsed) {
      console.error(parsed.error)
      console.error(
        'Usage: npm run library -- index <working-set> --name "<label>"\n' +
          '       --layer <layer>:<weight>:<direction> --layer … [--id <column>] [--apply] [--dir <path>]\n' +
          '       direction is higher or lower; a layer is a registry id (pct_Black) or internal-<slug>',
      )
      process.exitCode = 1
      return
    }
    if (!(await isLibraryTree(localDir))) {
      console.error(`no library tree under ${join(localDir, 'library')} — is --dir pointing at a pulled tree?`)
      process.exitCode = 1
      return
    }
    try {
      console.log(formatCompositeReport(await runComposite(parsed, localDir)))
    } catch (err: any) {
      console.error(err?.message || err)
      process.exitCode = 1
    }
    return
  }

  // Taxonomy migration (P5-63): pure local file work — reads and (with
  // --apply) rewrites manifests in the folder. No bucket, no DB.
  if (command === 'retag') {
    const organizations = flags.has('--organizations')
    const shapes = flags.has('--shapes')
    const coverage = flags.has('--coverage')
    const result = await retagLibrary(localDir, { apply: flags.has('--apply'), organizations, shapes, coverage })
    if (!result.rows.length) {
      console.error(`no manifests under ${join(localDir, 'library')} — is --dir pointing at a library tree?`)
      process.exitCode = 1
      return
    }
    printRetagTable(result)
    console.log(
      `\n${result.rows.length} entries · ${result.changed.length} ${flags.has('--apply') ? 'changed' : 'would change'} · ` +
        `${result.proposed.length} with a proposed topic · ${result.unknown.length} with a category the taxonomy does not know.`,
    )
    if (result.modelNote) console.log(result.modelNote)
    console.log(`Report: ${result.reportPath}`)
    // P6-1/P6-2: each extra pass prints its own table and names its own report,
    // so one run can be read three ways without the columns fighting.
    if (organizations) {
      console.log('\nOrganizations:\n')
      printOrganizationTable(result.rows)
      console.log(
        `\n${(result.organizationChanged ?? []).length} ${flags.has('--apply') ? 'written' : 'would gain or change an organization'} · ` +
          `${(result.organizationUnknown ?? []).length} name a publisher the vocabulary does not know (add an alias in src/config/organizations.ts, then npm run export:layers).`,
      )
      console.log(`Report: ${result.organizationReportPath}`)
    }
    if (shapes) {
      console.log('\nShapes:\n')
      printShapeTable(result.shaped ?? [])
      console.log(`\n${(result.shaped ?? []).length} datasets and sources. Report only — write \`shape:\` in a manifest to correct one.`)
      console.log(`Report: ${result.shapeReportPath}`)
    }
    if (coverage) {
      console.log('\nCoverage:\n')
      printCoverageTable(result.covered ?? [])
      const placed = (result.covered ?? []).filter(r => r.proposedCoverage)
      const scopes = new Map<string, number>()
      for (const row of placed) scopes.set(row.proposedCoverage!.scope, (scopes.get(row.proposedCoverage!.scope) ?? 0) + 1)
      const distribution = [...scopes.entries()].sort((a, b) => b[1] - a[1]).map(([scope, n]) => `${n} ${scope}`)
      console.log(
        `\n${(result.covered ?? []).length} datasets and sources · ` +
          `${distribution.join(' · ')}${distribution.length ? ' · ' : ''}${(result.covered ?? []).length - placed.length} with no coverage.`,
      )
      console.log('Report only — write `coverage:` in a manifest to correct one.')
      console.log(`Report: ${result.coverageReportPath}`)
    }
    if (flags.has('--apply')) console.log(`Rewrote ${result.applied.length} manifest(s). Push and reindex when you are happy.`)
    else console.log('Nothing was written. Rerun with --apply once the report reads right.')
    return
  }

  // Link-drop ingest (P5-34): needs the bucket (and reindexes when the DB is reachable).
  if (command === 'fetch') {
    const slug = args[1]
    if (!slug || slug.startsWith('--')) {
      console.error('Usage: npm run library -- fetch <slug> [--as <filename>]')
      process.exitCode = 1
      return
    }
    const asIndex = args.indexOf('--as')
    const as = asIndex !== -1 && args[asIndex + 1] ? args[asIndex + 1] : undefined
    const tempMirror = await fs.mkdtemp(join(tmpdir(), 'blo-library-cli-'))
    process.env.LIBRARY_DATA_DIR = tempMirror
    await initLibraryDb()
    if (!(await initLibraryBucket())) {
      console.error('Cannot reach the library bucket — set LIBRARY_BUCKET_* in server/.env.')
      process.exitCode = 1
      return
    }
    try {
      await fetchLink(slug, { as })
    } catch (err: any) {
      console.error(`fetch failed: ${err?.message || err}`)
      process.exitCode = 1
    } finally {
      await closeLibraryBucket()
      await closeLibraryDb()
      await fs.rm(tempMirror, { recursive: true, force: true })
    }
    return
  }

  if (!command || !['pull', 'push', 'status'].includes(command)) {
    console.log(
      'Usage: npm run library -- <pull|push|status> [--dir <path>]\n' +
        '  pull    bucket → local folder            [--prune deletes local strays]\n' +
        '  push    local folder → bucket + reindex  [--delete removes remote strays,\n' +
        '                                            --delete-incoming also removes uploads] [--force]\n' +
        '  status  dry-run diff, no writes\n' +
        '  retag   [--apply] [--organizations] [--shapes]  fold every manifest onto the vocabularies\n' +
        '          taxonomy (P5-63) → retag-report.md; --organizations (P6-1) → retag-organizations.md\n' +
        '          (--apply writes `organization`); --shapes (P6-2) → retag-shapes.md, report only\n' +
        '  geocode <csv> …  enrichment: add lat/lng/GEOID + provenance (no bucket needed)\n' +
        '  proximity <set> --to <layer> [--from <dataset>] [--within <miles>] [--id <column>] [--apply]\n' +
        '          bulk proximity (P7-5) into a working set derived column; dry run without --apply\n' +
        '  index <set> --name "<label>" --layer <layer>:<weight>:<direction> … [--id <column>] [--apply]\n' +
        '          bulk weighted index (P7-8) into a working set derived column, which then draws as a\n' +
        '          county layer; direction is higher or lower; dry run without --apply\n' +
        '  fetch <slug> [--as <filename>]  download a link drop into its entry (P5-34)\n' +
        `Local folder: --dir, $LIBRARY_SYNC_DIR, or ./library-local (now: ${localDir})`,
    )
    process.exitCode = command ? 1 : 0
    return
  }

  // Fresh temp mirror per run: the bucket service caches reads mirror-first,
  // and a stale dev-machine mirror must never masquerade as bucket state.
  const tempMirror = await fs.mkdtemp(join(tmpdir(), 'blo-library-cli-'))
  process.env.LIBRARY_DATA_DIR = tempMirror

  const dbReady = await initLibraryDb()
  if (!(await initLibraryBucket())) {
    console.error('Cannot reach the library bucket — set LIBRARY_BUCKET_* in server/.env.')
    process.exitCode = 1
    return
  }

  try {
    console.log(`Library folder: ${localDir}`)
    if (command === 'pull') {
      const result = await pullLibrary(localDir, { prune: flags.has('--prune') })
      printList('Downloaded', result.downloaded)
      printList('Pruned (local strays removed)', result.pruned)
      if (!flags.has('--prune')) {
        printList('Local strays (kept — use --prune to remove)', result.localStrays)
      }
      console.log(`Pull done: ${result.downloaded.length} downloaded, ${result.skipped} unchanged.`)
    } else if (command === 'push') {
      const result = await pushLibrary(localDir, {
        delete: flags.has('--delete'),
        deleteIncoming: flags.has('--delete-incoming'),
        force: flags.has('--force'),
      })
      printList('Uploaded', result.uploaded)
      printList('Deleted from bucket', result.deleted)
      printList('Kept (uploads not in your folder — add --delete-incoming to remove)', result.skippedIncoming)
      if (!flags.has('--delete')) {
        printList('Remote strays (kept — use --delete to remove)', result.remoteStrays)
      }
      for (const warning of result.warnings) console.warn(`WARNING: ${warning}`)
      console.log(
        `Push done: ${result.uploaded.length} uploaded, ${result.skipped} unchanged` +
          (result.indexed === null ? ' (catalog NOT reindexed).' : `; catalog reindexed (${result.indexed} entries).`),
      )
    } else {
      const result = await statusLibrary(localDir)
      printList('Changed (size differs)', result.changed)
      printList('Remote only (pull would download)', result.remoteOnly)
      printList('Local only (push would upload)', result.localOnly)
      if (!result.changed.length && !result.remoteOnly.length && !result.localOnly.length) {
        console.log('In sync.')
      }
    }
  } catch (err: any) {
    console.error(err?.message || err)
    process.exitCode = 1
  } finally {
    if (dbReady) await closeLibraryDb()
    await closeLibraryBucket()
    await fs.rm(tempMirror, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
