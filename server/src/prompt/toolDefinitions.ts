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
    name: 'set_layer_selection',
    description: "Apply a new scoring query to the map. This replaces any currently active layers, sets weights and directions, and recolors the choropleth based on a custom composite score. Optionally includes threshold filters (excludes counties below/above a value) and a result limit (top N). Use this when the user asks to find counties matching criteria like 'best for homeownership', 'top 5 affordable with more than 30% Black'.",
    input_schema: {
      type: 'object',
      properties: {
        layers: {
          type: 'array',
          description: 'Array of 2-6 layer selections for ranking',
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
          description: "Optional threshold filters that exclude counties not meeting the criteria. Use when the user specifies a cutoff (e.g., 'more than 50%', 'under $200k').",
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
          description: "Optional: show only the top N counties in the ranking. Clamped to 1-50. Omit to show all passing counties. Use 10-20 as a reasonable default when the user says 'top counties' without a number.",
        },
        explanation: { type: 'string', description: 'Brief explanation of why these layers were selected, shown to the user' },
      },
      required: ['layers'],
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
    name: 'filter_ranking_by_state',
    description: "Filter the ranking panel to show only counties in a specific state. Use this when the user wants to narrow results to a region, e.g., 'focus on Texas' or 'show only North Carolina'.",
    input_schema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: "State name (e.g., 'Texas') or abbreviation (e.g., 'TX'). Use empty string '' to clear the filter." },
      },
      required: ['state'],
    },
  },
  {
    name: 'show_county_details',
    description: 'Open the detailed information modal for a specific county, showing all its data across demographics, economics, housing, equity, transportation, environment, and health.',
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
