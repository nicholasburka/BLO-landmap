/**
 * The four tools that drive a map, shared by both buses (P14-2).
 *
 * They were declared once, in `toolDefinitions.ts`, and belonged to the
 * PUBLIC map's prompt box. The library chat at `/chat` has had its own
 * Mapbox pane since P6-10 and a dispatcher for exactly these four since the
 * same ticket, firing never, because nothing registered them for it.
 *
 * One declaration, two buses. The public map adds `search_housing` and
 * `toggle_ranking_panel` — its own chrome, which the chat page has no
 * equivalent of — and the library chat registers these four as CLIENT tools
 * (`chatLoop.ts`), dispatched to the browser rather than run on the server.
 * Changing a schema here changes it for both, which is the point: the two
 * have drifted once already.
 */

import type Anthropic from '@anthropic-ai/sdk'

export const MAP_TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
  {
    name: 'show_layer',
    description: "Turn a map layer on (or off) and, for an overlay layer, fly to its extent. Use for the internal point, line and state layers listed under 'Internal data layers' (they cannot be scored, so this is the only way to show them), or to switch any single layer on by id without changing the ranked query. Do NOT use this for scoring — use set_query_state for that.",
    input_schema: {
      type: 'object' as const,
      properties: {
        layerId: { type: 'string', description: 'Exact layer id from the registry or the internal layers list' },
        on: { type: 'boolean', description: 'true to show (default), false to hide' },
      },
      required: ['layerId'],
    },
  },
  {
    name: 'zoom_to_county',
    description: 'Zoom the map to a specific US county. Use this when the user wants to focus on a particular county or see it on the map.',
    input_schema: {
      type: 'object',
      properties: {
        county_name: {
          type: 'string',
          description: "County name, with or without suffix (e.g., 'Mecklenburg County' or 'Mecklenburg')",
        },
        state: {
          type: 'string',
          description: "State name or 2-letter abbreviation (recommended to disambiguate when counties share a name)",
        },
      },
      required: ['county_name'],
    },
  },
  {
    name: 'show_county_details',
    description: 'Open an inspection panel for a specific county. The map zooms regionally and the right-side rail shows the county name, score, and key stats. Use this when the user wants details about a specific county.',
    input_schema: {
      type: 'object',
      properties: {
        county_name: { type: 'string', description: 'County name' },
        state: { type: 'string', description: 'State name or 2-letter abbreviation' },
      },
      required: ['county_name'],
    },
  },
  {
    name: 'set_query_state',
    description: "Atomically set the entire map query: scoring layers, threshold filters, top-N limit, and (optionally) region/state restriction. This is the SINGLE tool to use for any state mutation related to ranking and filtering. Replaces all prior layers/filters/limit/region — there is no merge. Use for queries like 'top 5 affordable counties in the Southeast with high Black population' (one call, regionStates=['VA','NC','SC','GA','FL','AL','MS','TN','KY','WV','AR','LA']) or 'just show me Mississippi' (regionStates=['MS']) or 'reset' (all empty). NEVER call this multiple times in a single turn for region expansions — pass the full state array on the first call.",
    input_schema: {
      type: 'object',
      properties: {
        layers: {
          type: 'array',
          description: 'Scoring layers (1-6 entries). Empty array clears scoring and reverts to the default BLO Livability view.',
          items: {
            type: 'object',
            properties: {
              layerId: { type: 'string', description: 'Exact layer ID from the registry' },
              weight: { type: 'number', description: 'Relative weight from 1 (barely mentioned) to 10 (primary focus)' },
              direction: { type: 'string', enum: ['higher_better', 'lower_better'], description: 'Scoring direction' },
            },
            required: ['layerId', 'weight', 'direction'],
          },
        },
        filters: {
          type: 'array',
          description: "Threshold filters that exclude counties not meeting the criteria. Empty array clears all filters.",
          items: {
            type: 'object',
            properties: {
              layerId: { type: 'string', description: 'Exact layer ID from the registry' },
              operator: { type: 'string', enum: ['greater_than', 'less_than', 'between'], description: 'Comparison operator' },
              value: { type: 'number', description: "The threshold value in the layer's natural units" },
              max: { type: 'number', description: 'Only for between: the upper bound (value is the lower bound)' },
            },
            required: ['layerId', 'operator', 'value'],
          },
        },
        limit: {
          type: 'number',
          description: "Top N to surface in the ranking. Clamped to 1-50. Omit or null to show all passing counties.",
        },
        regionStates: {
          type: 'array',
          description: "2-letter US state codes (e.g., ['NC','SC','GA']) restricting which counties appear in the ranking. Pass the full list in ONE call for regional queries — do NOT call this tool multiple times to expand a region. Empty/omitted means all 50 states.",
          items: { type: 'string' },
        },
        explanation: { type: 'string', description: 'Brief explanation shown to the user describing what changed and why.' },
      },
      required: ['layers', 'explanation'],
    },
  },
]
