import { z } from 'zod'
import { appUrl, McpToolError, requireLibrary } from './mcpTools.js'
import { writeAudit } from './libraryDb.js'
import { fetchForPlace, listSlices } from './placeFetch.js'
import { PlaceScopeError, runPlaceReport } from './placeReport.js'
import { failureText, PlaceFetchError } from './placeHttp.js'

/**
 * `fetch_for_place` for a desktop assistant (P5-57 × P5-50).
 *
 * Same tool as the Ask loop's, same validation, same cache: "any Superfund
 * sites near 123 Main St?" asked in Claude Desktop runs the same fetch and
 * cites the same slice as the same question asked in the app.
 *
 * It lives in its own file, registered by its own function, so the MCP tool
 * table stays one list and this ticket adds to it without editing it.
 *
 * Unlike every other MCP tool, this one **reaches the outside world** — so its
 * annotations say `openWorldHint: true`, and it is the only tool here that is
 * not purely a read of what we already hold.
 */

/** The slice of the MCP request context these tools need. Structural on
 *  purpose: the caller passes its own context object, whatever else it holds. */
export interface PlaceToolContext {
  user: { id: number; username: string }
  /** The calling program, from the User-Agent — "which assistant did this". */
  client: string
}

/** The MCP server surface used here — just enough to register a tool, so this
 *  module does not depend on a particular SDK class. */
export interface ToolRegistrar {
  registerTool(
    name: string,
    config: {
      title: string
      description: string
      inputSchema: z.ZodRawShape
      annotations?: Record<string, boolean>
    },
    handler: (args: any) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>,
  ): unknown
}

/** Rows handed back over MCP. A desktop assistant reads these into a context
 *  window, so the cap is tighter than the app's table. */
export const MCP_PLACE_ROWS = 50

export const FETCH_FOR_PLACE_INPUT = {
  source: z.string().trim().min(1).max(120).describe('The source entry’s slug.'),
  address: z.string().trim().max(300).optional().describe('A street address or place name, geocoded before anything is fetched.'),
  point: z
    .object({ lat: z.number(), lng: z.number() })
    .optional()
    .describe('Coordinates, when the question already gave them.'),
  geoid: z.string().trim().regex(/^\d{5}$/).optional().describe('A 5-digit county FIPS code.'),
  radiusMiles: z.number().positive().max(100).optional().describe('How far around the point to look.'),
} satisfies z.ZodRawShape

export const LIST_SLICES_INPUT = {
  source: z.string().trim().min(1).max(120).describe('The source entry’s slug.'),
} satisfies z.ZodRawShape

/** Rows per section over MCP. Tighter than the app's ten: a report carries
 *  twenty-five sections, and a desktop assistant reads all of them into one
 *  context window. */
export const MCP_REPORT_ROWS = 5

export const PLACE_REPORT_INPUT = {
  address: z.string().trim().max(300).optional().describe('A street address or place name, geocoded before anything is fetched.'),
  point: z
    .object({ lat: z.number(), lng: z.number() })
    .optional()
    .describe('Coordinates, when the question already gave them.'),
  geoid: z.string().trim().regex(/^\d{5}$/).optional().describe('A 5-digit county FIPS code.'),
  radiusMiles: z.number().positive().max(100).optional().describe('How far around the point to look. Defaults to five miles.'),
  // P7-1. The spec's reason for putting an analysis on the server applies here
  // too: chat and MCP have to be able to ask the scoped question, not only the
  // browser.
  workingSet: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
    .optional()
    .describe(
      'Run inside a working set — ask only that set’s sources instead of every source that covers the place. Find one with search_library and kind "working-set".',
    ),
} satisfies z.ZodRawShape

function text(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

/** A failure the caller can act on, in the same shape the tool table uses:
 *  an expected refusal keeps its words, anything else is logged and generic. */
function failure(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  // P7-1: "there is no working set called that" is the one refusal the
  // assistant can fix by itself, so it reaches the model verbatim.
  if (err instanceof PlaceScopeError) {
    return { content: [{ type: 'text', text: err.message }], isError: true }
  }
  if (err instanceof PlaceFetchError) {
    return { content: [{ type: 'text', text: failureText(err.code) }], isError: true }
  }
  if (err instanceof McpToolError) return { content: [{ type: 'text', text: err.message }], isError: true }
  console.error('[mcp] place tool failed:', (err as any)?.message || err)
  return {
    content: [{ type: 'text', text: 'That request could not be completed. Try again, or a narrower place.' }],
    isError: true,
  }
}

export async function runFetchForPlace(args: {
  source: string
  address?: string
  point?: { lat: number; lng: number }
  geoid?: string
  radiusMiles?: number
}, ctx: PlaceToolContext) {
  requireLibrary()
  if (!args.address && !args.point && !args.geoid) {
    throw new McpToolError('Give an address, a point, or a 5-digit county geoid.')
  }
  const result = await fetchForPlace({
    slug: args.source,
    address: args.address,
    point: args.point ?? null,
    geoid: args.geoid,
    radiusMiles: args.radiusMiles,
    actor: { id: ctx.user.id, username: ctx.user.username },
  })
  return {
    source: args.source,
    place: result.place.label,
    geoid: result.place.geoid,
    radiusMiles: result.place.radiusMiles,
    count: result.count,
    truncated: result.truncated,
    adapter: result.adapter,
    cacheKey: result.cacheKey,
    fetchedAt: result.fetchedAt,
    cached: result.cached,
    columns: result.columns,
    rows: result.rows.slice(0, MCP_PLACE_ROWS),
    url: appUrl(`/library/${encodeURIComponent(args.source)}?place=${encodeURIComponent(result.cacheKey)}`),
  }
}

/**
 * One place, every applicable source (P5-58).
 *
 * The same service the app's `/place` page runs, so a report asked for in
 * Claude Desktop and one run in the browser are the same document, cached
 * under the same place key. Rows are trimmed harder here for context's sake;
 * every section still carries the link to the whole slice.
 */
export async function runPlaceReportTool(
  args: {
    address?: string
    point?: { lat: number; lng: number }
    geoid?: string
    radiusMiles?: number
    workingSet?: string
  },
  ctx: PlaceToolContext,
) {
  requireLibrary()
  if (!args.address && !args.point && !args.geoid) {
    throw new McpToolError('Give an address, a point, or a 5-digit county geoid.')
  }
  const { report, placeKey, cached } = await runPlaceReport({
    address: args.address,
    point: args.point ?? null,
    geoid: args.geoid,
    radiusMiles: args.radiusMiles,
    ...(args.workingSet ? { workingSet: args.workingSet } : {}),
    actor: { id: ctx.user.id, username: ctx.user.username },
  })
  return {
    place: report.place,
    placeKey,
    radiusMiles: report.radiusMiles,
    cached,
    generatedAt: report.generatedAt,
    sections: report.sections.map(s => ({
      ...s,
      rows: s.rows.slice(0, MCP_REPORT_ROWS),
      url: appUrl(s.href),
    })),
    county: report.county
      ? { ...report.county, url: appUrl(`/compare?counties=${encodeURIComponent(report.county.geoid)}`) }
      : null,
    organizations: report.organizations.map(o => ({ ...o, url: appUrl(o.href) })),
    summary: report.summary
      ? { ...report.summary, sources: report.summary.sources.map(s => ({ ...s, href: appUrl(s.href) })) }
      : null,
    url: appUrl(`/place?${placeKeyQuery(report)}`),
  }
}

/** The `/place` URL that reopens this report in the app. */
function placeKeyQuery(report: { place: { lat: number | null; lng: number | null; geoid: string | null }; radiusMiles: number }): string {
  const params = new URLSearchParams()
  if (report.place.lat !== null && report.place.lng !== null) {
    params.set('lat', String(report.place.lat))
    params.set('lng', String(report.place.lng))
    params.set('radius', String(report.radiusMiles))
  } else if (report.place.geoid) {
    params.set('geoid', report.place.geoid)
  }
  return params.toString()
}

export async function runListPlaceSlices(args: { source: string }) {
  requireLibrary()
  const slices = await listSlices(args.source)
  return {
    source: args.source,
    slices: slices.map(s => ({
      cacheKey: s.cacheKey,
      place: s.place.label,
      count: s.count,
      adapter: s.adapter,
      fetchedAt: s.fetchedAt,
      url: appUrl(`/library/${encodeURIComponent(args.source)}?place=${encodeURIComponent(s.cacheKey)}`),
    })),
  }
}

/**
 * Register the place tools on an MCP server.
 *
 * The audit wrapper is the same one the tool table uses — `mcp.<tool>`, the
 * source slug as the target, the calling program in the detail, and `failed`
 * on the way out — so a fetch made from a desktop assistant reads the same in
 * the audit log as one made from the app.
 */
export function registerPlaceTools(server: ToolRegistrar, ctx: PlaceToolContext): void {
  const audit = (action: string, target: string | undefined, args: unknown, ok: boolean): void =>
    void writeAudit({
      userId: ctx.user.id,
      actor: ctx.user.username,
      action: `mcp.${action}`,
      target,
      detail: { client: ctx.client, args, ...(ok ? {} : { failed: true }) },
    })

  server.registerTool(
    'fetch_for_place',
    {
      title: 'Fetch a source for a place',
      description:
        'Fetch the rows of an outside data source for one place — the facilities within a few miles of an address, the flood zones at a point, a county’s row. ' +
        'Use it when the question is about a specific address, point or county and the source is indexed here but not held. ' +
        'Give an address, a point, or a 5-digit county FIPS. The answer is cached, so asking again about the same place is free.',
      inputSchema: FETCH_FOR_PLACE_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: any) => {
      const target = typeof args?.source === 'string' ? args.source : undefined
      try {
        const data = await runFetchForPlace(args ?? {}, ctx)
        audit('fetch_for_place', target, args, true)
        return text(data)
      } catch (err) {
        audit('fetch_for_place', target, args, false)
        return failure(err)
      }
    },
  )

  server.registerTool(
    'place_report',
    {
      title: 'Check a place against every data source',
      description:
        'Run every data source that covers one place and return the findings together: what each source has within the radius (with sample rows), which sources have nothing, which have to be checked by hand, the county’s public map-layer values, the organizations nearby, and a short written summary citing the sections. ' +
        'Use it for "what are the environmental risks at this address" and for sizing up a county — one call instead of a fetch per source. ' +
        'Give an address, a point, or a 5-digit county FIPS. Results are cached for a week, so asking again about the same place is free.',
      inputSchema: PLACE_REPORT_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: any) => {
      const target = typeof args?.geoid === 'string' ? args.geoid : typeof args?.address === 'string' ? args.address : undefined
      try {
        const data = await runPlaceReportTool(args ?? {}, ctx)
        audit('place_report', target, args, true)
        return text(data)
      } catch (err) {
        audit('place_report', target, args, false)
        return failure(err)
      }
    },
  )

  server.registerTool(
    'list_place_slices',
    {
      title: 'List the places already fetched for a source',
      description: 'What we already hold for a source: which places, how many rows, and when each was fetched. Reading one back is free.',
      inputSchema: LIST_SLICES_INPUT,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => {
      const target = typeof args?.source === 'string' ? args.source : undefined
      try {
        const data = await runListPlaceSlices(args ?? {})
        audit('list_place_slices', target, args, true)
        return text(data)
      } catch (err) {
        audit('list_place_slices', target, args, false)
        return failure(err)
      }
    },
  )
}
