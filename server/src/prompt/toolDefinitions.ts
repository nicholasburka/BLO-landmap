/**
 * Anthropic tool definitions for Phase 3 chat.
 *
 * Duplicated from src/lib/mapTools.ts for server-side use.
 * Keep in sync when adding/modifying tools.
 */

import type Anthropic from '@anthropic-ai/sdk'

export const TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
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
    name: 'search_housing',
    description: 'Search for property listings (land for sale) in a specific county. Use this when the user asks about available housing, properties, or land in a location.',
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
  {
    name: 'toggle_ranking_panel',
    description: 'Expand or collapse the county ranking panel (shows top-N counties by the current composite score).',
    input_schema: {
      type: 'object',
      properties: {
        expanded: { type: 'boolean', description: 'true to expand, false to collapse' },
      },
      required: ['expanded'],
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
]
