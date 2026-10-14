import 'dotenv/config'
import { pathToFileURL } from 'url'
import { closeLibraryDb, initLibraryDb, writeAudit } from '../services/libraryDb.js'
import { getSavedView, searchCatalog } from '../services/libraryCatalog.js'
import { getWorkingSet, updateWorkingSet } from '../services/libraryWorkingSets.js'
import { WORKING_SET_KIND } from '../services/workingSetMeta.js'
import { parseFraming } from '../services/mapState.js'

/**
 * Fold a working set's saved view into the set itself (P11-3).
 *
 *   node dist/cli/framing.js fold            # dry run: says what it would do
 *   node dist/cli/framing.js fold --write    # does it
 *
 * P11-1 gave a set its own framing and P11-2 made `/sets/<slug>` its home.
 * Sets that predate those open on an equal-weight average of every layer
 * they name, because the weighting they were actually read with lives on a
 * saved view. This copies it across.
 *
 * **Nothing is deleted.** There is no delete endpoint (P8-2 is open) and a
 * view's URL may already be shared; P11-2's redirect carries those to the
 * set, so the view costs nothing by staying. Re-runnable: a set that already
 * has a framing is left alone.
 *
 * **A set with two or more views picks none.** There are none today, and if
 * that changes the right answer is a person choosing, not a heuristic — so
 * it reports them and moves on.
 */

export interface FoldResult {
  /** slug → what happened, in the order the catalog returned them. */
  lines: string[]
  folded: number
  skipped: number
  ambiguous: number
}

interface ViewRow {
  slug: string
  title: string
  workingSet: string
  state: Record<string, unknown>
}

/**
 * The set-backed MAP views, with their state.
 *
 * The catalog ROW carries a summary of a view — type, layers, resultCount —
 * and not its `state`, which lives in the document at
 * `library/views/<slug>.json`. So the row says which views are worth reading
 * and `getSavedView` reads them; this is one extra read per candidate view,
 * of which there are two in the whole library.
 */
async function viewsOfSets(
  rows: { slug: string; title: string; meta: Record<string, unknown> }[],
): Promise<ViewRow[]> {
  const out: ViewRow[] = []
  for (const row of rows) {
    const set = typeof row.meta.workingSet === 'string' ? row.meta.workingSet : ''
    if (!set) continue
    // Only a MAP view carries a map state. A table or compare view presents
    // a set perfectly well and has no framing this field can hold.
    if (row.meta.type !== undefined && row.meta.type !== 'map') continue
    const doc = await getSavedView(row.slug).catch(() => null)
    const state = doc?.state
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue
    out.push({ slug: row.slug, title: doc?.name ?? row.title, workingSet: set, state })
  }
  return out
}

export async function foldViewsIntoSets(write: boolean): Promise<FoldResult> {
  const [setRows, viewRows] = await Promise.all([
    searchCatalog({ kind: WORKING_SET_KIND }),
    searchCatalog({ kind: 'view' }),
  ])
  const views = await viewsOfSets(viewRows as never)

  const result: FoldResult = { lines: [], folded: 0, skipped: 0, ambiguous: 0 }

  for (const row of setRows) {
    const set = await getWorkingSet(row.slug)
    if (!set) continue

    if (set.framing) {
      result.skipped++
      result.lines.push(`${row.slug}: already framed — left alone`)
      continue
    }

    const mine = views.filter(v => v.workingSet === row.slug)
    if (mine.length === 0) {
      result.skipped++
      result.lines.push(`${row.slug}: no map view to fold`)
      continue
    }
    if (mine.length > 1) {
      result.ambiguous++
      result.lines.push(
        `${row.slug}: ${mine.length} map views (${mine.map(v => v.slug).join(', ')}) — ` +
          'pick one by hand; this will not guess',
      )
      continue
    }

    const parsed = await parseFraming(mine[0].state)
    if ('error' in parsed) {
      result.skipped++
      result.lines.push(`${row.slug}: ${mine[0].slug} is not a framing this can use — ${parsed.error}`)
      continue
    }

    if (write) {
      await updateWorkingSet(row.slug, { framing: parsed.state })
      await writeAudit({
        userId: null,
        actor: 'cli',
        action: 'workingset.update',
        target: row.slug,
        detail: { framing: 'folded', fromView: mine[0].slug },
      })
    }
    result.folded++
    result.lines.push(
      `${row.slug}: ${write ? 'folded' : 'would fold'} the framing of “${mine[0].title}” (${mine[0].slug}) — the view stays`,
    )
  }

  return result
}

export function formatFold(result: FoldResult, write: boolean): string {
  const head = write ? 'Folded saved views into their sets.' : 'Dry run — nothing written. Add --write to apply.'
  const tail = `${result.folded} ${result.folded === 1 ? 'set' : 'sets'} ${
    write ? 'folded' : 'to fold'
  }, ${result.skipped} left alone, ${result.ambiguous} needing a person.`
  return [head, '', ...result.lines.map(l => `  ${l}`), '', tail].join('\n')
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const command = args[0] ?? ''
  const write = args.includes('--write')

  if (command !== 'fold') {
    console.error('Usage: node dist/cli/framing.js fold [--write]')
    return 1
  }

  try {
    const ok = await initLibraryDb()
    if (!ok) {
      console.error('Cannot reach the library database — is DATABASE_URL set, and the same one the API uses?')
      return 1
    }
    console.log(formatFold(await foldViewsIntoSets(write), write))
    return 0
  } catch (err: any) {
    console.error(`Error: ${err?.message || err}`)
    return 1
  } finally {
    await closeLibraryDb()
  }
}

// Only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code))
}
