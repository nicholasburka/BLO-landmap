import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { isBucketEnabled } from '../services/libraryBucket.js'
import {
  readDataset,
  queryRows,
  parseRowsQuery,
  selectRows,
  summarizeColumn,
  overviewColumns,
  toCsv,
  TabularError,
  SUMMARY_TOP_N,
  SUMMARY_GROUP_TOP_N,
  TABULAR_MAX_ROWS,
} from '../services/libraryTabular.js'
import { parseLayerBlock, INTERNAL_LAYER_ID_PREFIX } from '../services/internalLayers.js'

/**
 * Dataset explorer API (P5-31): schema + column stats, and paged /
 * searched / sorted / filtered rows for any library entry with a tabular
 * file. Internal-tier throughout (guard runs before any handler — bare
 * 401s, auth-sweep enforced). Reads are not audited.
 *
 * P5-42 adds the two calls a researcher needs to ANALYSE rather than
 * browse: `/summary` (per-column distribution, or a per-column overview)
 * and `/export.csv` (the filtered rows, as a file). Both take the same
 * q/filter params as /rows and describe the same filtered set. Reads stay
 * unaudited; the export does not — it leaves the building, so it is logged.
 */
const router = Router()
router.use('/api/library', requireInternalUser)

function firstString(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' && v ? v : undefined
}

function unavailable(res: import('express').Response): boolean {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return true
  }
  return false
}

function fail(res: import('express').Response, err: unknown, what: string): void {
  if (err instanceof TabularError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error(`[library] ${what} failed:`, (err as any)?.message || err)
  res.status(500).json({ error: 'Internal server error' })
}

router.get<{ slug: string }>('/api/library/data/:slug', internalRateLimit, async (req, res) => {
  if (unavailable(res)) return
  try {
    const { entry, candidates, parsed } = await readDataset(req.params.slug, firstString(req.query.file))
    // P5-36: tell the table whether this entry is (or could be) a map layer,
    // so it can offer "Show on map" — names only, never the block's plumbing.
    const block = parseLayerBlock(entry.meta)
    const layer =
      'block' in block
        ? { id: `${INTERNAL_LAYER_ID_PREFIX}${entry.slug}`, geometry: block.block.geometry, name: block.block.name, labelKey: block.block.geometry === 'county' ? null : block.block.labelKey }
        : null
    res.json({
      entry: { slug: entry.slug, title: entry.title, kind: entry.kind },
      layer,
      file: parsed.file,
      files: candidates,
      columns: parsed.columns,
      rowCount: parsed.rowCount,
      bytes: parsed.bytes,
      parsedAt: parsed.parsedAt,
    })
  } catch (err) {
    fail(res, err, 'dataset schema')
  }
})

router.get<{ slug: string }>('/api/library/data/:slug/rows', internalRateLimit, async (req, res) => {
  if (unavailable(res)) return
  try {
    const { parsed } = await readDataset(req.params.slug, firstString(req.query.file))
    const query = parseRowsQuery(
      req.query as Record<string, unknown>,
      parsed.columns.map(c => c.name),
    )
    if ('error' in query) {
      res.status(400).json({ error: query.error })
      return
    }
    res.json(queryRows(parsed, query))
  } catch (err) {
    fail(res, err, 'dataset rows')
  }
})

/**
 * `GET /api/library/data/:slug/summary?…same q/filter as /rows`
 *
 * With `?column=` → that column's distribution over the CURRENT filtered
 * set. Without one → a one-line overview of every column. `?groupBy=1`
 * raises the `top` cap from 20 to 200, which IS the group-by table: the
 * full value/count list of one column, so there is no second endpoint.
 * `sort`, `page` and `limit` are still validated (a stale table URL is
 * passed through whole) but mean nothing to a summary.
 */
router.get<{ slug: string }>('/api/library/data/:slug/summary', internalRateLimit, async (req, res) => {
  if (unavailable(res)) return
  try {
    const { parsed } = await readDataset(req.params.slug, firstString(req.query.file))
    const names = parsed.columns.map(c => c.name)
    const query = parseRowsQuery(req.query as Record<string, unknown>, names)
    if ('error' in query) {
      res.status(400).json({ error: query.error })
      return
    }
    const column = firstString(req.query.column)
    if (column === undefined) {
      res.json(overviewColumns(parsed, query))
      return
    }
    if (!names.includes(column)) {
      res.status(400).json({ error: `unknown column: ${column}` })
      return
    }
    const groupBy = firstString(req.query.groupBy) === '1'
    res.json(summarizeColumn(parsed, column, query, { topLimit: groupBy ? SUMMARY_GROUP_TOP_N : SUMMARY_TOP_N }))
  } catch (err) {
    fail(res, err, 'dataset summary')
  }
})

/** Which columns the export writes: all of them, or the visible ones the
 *  table asked for. Accepts a JSON array, a comma-separated list, or
 *  repeated `columns=` params; every name must exist. */
export function parseColumnsParam(raw: unknown, names: string[]): string[] | { error: string } {
  if (raw === undefined || raw === '') return names
  let list: unknown[]
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (!Array.isArray(parsed)) return { error: 'columns must be a list of column names' }
        list = parsed
      } catch {
        return { error: 'columns must be a list of column names' }
      }
    } else list = trimmed.split(',')
  } else return { error: 'columns must be a list of column names' }
  const known = new Set(names)
  const chosen: string[] = []
  for (const item of list) {
    const name = typeof item === 'string' ? item.trim() : ''
    if (!known.has(name)) return { error: `unknown column: ${String(item)}` }
    if (!chosen.includes(name)) chosen.push(name)
  }
  return chosen.length > 0 ? chosen : names
}

/** Rows per write, so a 200k-row export streams instead of building one
 *  enormous string in memory. */
const EXPORT_CHUNK_ROWS = 1000

/**
 * `GET /api/library/data/:slug/export.csv?…same params` — the filtered
 * rows, in the table's current sort, with the visible columns, as a file.
 *
 * Not a confidentiality boundary (the same user can download the whole
 * file from /api/library/file), but it IS data leaving the building, so
 * it is audited as `library.export`. Cells that would open as spreadsheet
 * formulas are neutralised in the service (see csvCell).
 */
router.get<{ slug: string }>('/api/library/data/:slug/export.csv', internalRateLimit, async (req, res) => {
  if (unavailable(res)) return
  try {
    const { entry, parsed } = await readDataset(req.params.slug, firstString(req.query.file))
    const names = parsed.columns.map(c => c.name)
    const query = parseRowsQuery(req.query as Record<string, unknown>, names)
    if ('error' in query) {
      res.status(400).json({ error: query.error })
      return
    }
    const columns = parseColumnsParam(req.query.columns, names)
    if (!Array.isArray(columns)) {
      res.status(400).json({ error: columns.error })
      return
    }
    // The parser already refuses files over TABULAR_MAX_ROWS, so this cap
    // can never bite today; it is here so a future streaming parser cannot
    // turn "export" into an unbounded response by accident.
    const selected = selectRows(parsed, query).slice(0, TABULAR_MAX_ROWS)

    const filename = `${entry.slug.replace(/[^A-Za-z0-9._-]/g, '_')}-filtered.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')

    const user = res.locals.internalUser
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'library.export',
      target: `${entry.slug}/${parsed.file}`,
      detail: { slug: entry.slug, rows: selected.length, filters: query.filter ?? [] },
    })

    const write = (text: string): Promise<void> =>
      new Promise((resolve, reject) => {
        res.write(text, err => (err ? reject(err) : resolve()))
      })
    await write(toCsv(columns, [], { header: true }))
    for (let i = 0; i < selected.length; i += EXPORT_CHUNK_ROWS) {
      await write(toCsv(columns, selected.slice(i, i + EXPORT_CHUNK_ROWS).map(s => s.row), { header: false }))
    }
    res.end()
  } catch (err) {
    // Half a CSV cannot become a JSON error page — drop the connection so
    // the browser shows a failed download instead of a corrupt file.
    if (res.headersSent) {
      console.error('[library] dataset export failed mid-stream:', (err as any)?.message || err)
      res.destroy()
      return
    }
    fail(res, err, 'dataset export')
  }
})

export default router
