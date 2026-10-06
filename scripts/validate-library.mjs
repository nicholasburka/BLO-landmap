#!/usr/bin/env node
/**
 * Validate library content before it is pushed to the bucket (P5-56).
 *
 * Today it checks the data-source registry: every
 * `<dir>/library/sources/<slug>/meta.json` is read with the SAME
 * `parseSourceMeta` the server runs at reindex — imported, not copied, so the
 * two can never drift. What the server would silently drop at reindex shows up
 * here as a warning while it can still be fixed; what would leave an entry
 * unable to answer anything (no title, no provider) is a hard error.
 *
 * Run: `npm run validate:library -- --dir /path/to/library-local`
 * (default: $LIBRARY_SYNC_DIR, else ./library-local — same rule as the sync CLI)
 *
 * Node's type stripping loads the TypeScript validator directly, which is why
 * the npm script carries `--experimental-strip-types`. sourceMeta.ts is pure
 * with no imports, so nothing else has to be compiled.
 *
 * Exit code 1 when anything is a hard error, 0 otherwise (warnings included),
 * so it can gate a push from CI or a shell one-liner.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { parseSourceMeta } from '../server/src/services/sourceMeta.ts'

function parseArgs(argv) {
  const dirIndex = argv.indexOf('--dir')
  const dir =
    dirIndex !== -1 && argv[dirIndex + 1]
      ? resolve(argv[dirIndex + 1])
      : resolve(process.env.LIBRARY_SYNC_DIR || 'library-local')
  return { dir }
}

/** Entry folders under library/sources/, sorted. Missing tree = nothing to do. */
function sourceFolders(root) {
  const dir = join(root, 'library', 'sources')
  try {
    if (!statSync(dir).isDirectory()) return []
  } catch {
    return []
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
}

/** Check one source folder. Returns { errors, warnings } as plain lines. */
export function checkSourceFolder(root, slug) {
  const errors = []
  const warnings = []
  const path = join(root, 'library', 'sources', slug, 'meta.json')
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    errors.push(`${slug}: no meta.json — a source entry IS its manifest`)
    return { errors, warnings }
  }
  let meta
  try {
    meta = JSON.parse(raw)
  } catch (err) {
    errors.push(`${slug}: meta.json is not valid JSON (${err.message})`)
    return { errors, warnings }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    errors.push(`${slug}: meta.json must be a JSON object`)
    return { errors, warnings }
  }

  if (typeof meta.title !== 'string' || !meta.title.trim()) {
    errors.push(`${slug}: title is required`)
  }
  const { source, dropped } = parseSourceMeta(meta.source)
  if (!source) {
    // parseSourceMeta already said why (missing, not an object, no provider).
    const why = dropped.length ? dropped.join('; ') : 'source block is missing'
    errors.push(`${slug}: ${why}`)
  }
  for (const line of dropped) {
    if (source) warnings.push(`${slug}: ${line}`)
  }
  return { errors, warnings }
}

function main() {
  const { dir } = parseArgs(process.argv.slice(2))
  const slugs = sourceFolders(dir)
  const errors = []
  const warnings = []
  for (const slug of slugs) {
    const result = checkSourceFolder(dir, slug)
    errors.push(...result.errors)
    warnings.push(...result.warnings)
  }

  console.log(`Checked ${slugs.length} source ${slugs.length === 1 ? 'entry' : 'entries'} in ${dir}`)
  for (const line of warnings) console.warn(`  warning  ${line}`)
  for (const line of errors) console.error(`  ERROR    ${line}`)
  if (errors.length) {
    console.error(`\n${errors.length} ${errors.length === 1 ? 'error' : 'errors'} — fix these before pushing.`)
    process.exitCode = 1
    return
  }
  console.log(warnings.length ? `\n${warnings.length} warning(s); nothing blocking.` : '\nAll good.')
}

main()
