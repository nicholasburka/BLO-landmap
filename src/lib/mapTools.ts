/**
 * LLM Tool Definitions + Client-Side Handlers
 *
 * Defines the Anthropic tool schemas for map control actions, and implements
 * client-side handlers that execute them. Server relays tool_use blocks from
 * Claude to the client; client invokes these handlers against the map state.
 */

import type mapboxgl from 'mapbox-gl'
import { findCounty, type CountyLookup } from './countyLookup'

export interface LayerSelection {
  layerId: string
  weight: number
  direction: 'higher_better' | 'lower_better'
}

export interface ScoringFilter {
  layerId: string
  operator: 'greater_than' | 'less_than' | 'between'
  value: number
  max?: number
}

export interface LayerSelectionOptions {
  filters?: ScoringFilter[]
  limit?: number
  explanation?: string
}

/** A single ranked county result, used to describe the current ranking to the LLM */
export interface RankedCountyInfo {
  rank: number
  geoId: string
  name: string
  state: string
  score: number
}

/** Context injected by Map.vue — gives tools access to app state + mutators */
export interface ToolContext {
  map: mapboxgl.Map | null
  /** Apply a new layer selection (replaces current selection), with optional filters and display limit */
  setLayerSelection: (layers: LayerSelection[], options?: LayerSelectionOptions) => void
  /** Open the county detail modal for a given GEOID */
  openCountyModal: (geoId: string) => void
  /** Expand or collapse the ranking panel */
  toggleRankingPanel: (expanded: boolean) => void
  /** Filter the ranking panel to a specific state (by name or abbr) */
  setRankingStateFilter: (stateName: string) => void
  /** Trigger property listing search for a county */
  triggerHousingSearch: (county: CountyLookup) => void
  /** Zoom to a GEOID using the counties GeoJSON (Map.vue owns this logic) */
  zoomToGeoId: (geoId: string) => void
  /** Read the current top-N ranked counties (after scoring has run) */
  getTopRankedCounties: (limit: number) => Promise<RankedCountyInfo[]>
}

/** Anthropic tool definitions passed to Claude */
export const TOOL_DEFINITIONS = [
  {
    name: 'zoom_to_county',
    description: 'Zoom the map to a specific US county. Use this when the user wants to focus on a particular county or see it on the map.',
    input_schema: {
      type: 'object' as const,
      properties: {
        county_name: {
          type: 'string' as const,
          description: "County name, with or without suffix (e.g., 'Mecklenburg County' or 'Mecklenburg')",
        },
        state: {
          type: 'string' as const,
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
      type: 'object' as const,
      properties: {
        county_name: { type: 'string' as const, description: 'County name' },
        state: { type: 'string' as const, description: 'State name or 2-letter abbreviation' },
      },
      required: ['county_name'],
    },
  },
  {
    name: 'set_layer_selection',
    description: "Apply a new scoring query to the map. This replaces any currently active layers, sets weights and directions, and recolors the choropleth based on a custom composite score. Use this when the user asks to find counties matching criteria like 'best for homeownership' or 'affordable with good schools'.",
    input_schema: {
      type: 'object' as const,
      properties: {
        layers: {
          type: 'array' as const,
          description: 'Array of 2-6 layer selections',
          items: {
            type: 'object' as const,
            properties: {
              layerId: { type: 'string' as const, description: 'Exact layer ID from the registry' },
              weight: { type: 'number' as const, description: 'Relative weight from 1 (barely mentioned) to 10 (primary focus)' },
              direction: { type: 'string' as const, enum: ['higher_better', 'lower_better'], description: 'Scoring direction' },
            },
            required: ['layerId', 'weight', 'direction'],
          },
        },
        explanation: { type: 'string' as const, description: 'Brief explanation of why these layers were selected, shown to the user' },
      },
      required: ['layers'],
    },
  },
  {
    name: 'toggle_ranking_panel',
    description: 'Expand or collapse the county ranking panel (shows top-N counties by the current composite score).',
    input_schema: {
      type: 'object' as const,
      properties: {
        expanded: { type: 'boolean' as const, description: 'true to expand, false to collapse' },
      },
      required: ['expanded'],
    },
  },
  {
    name: 'filter_ranking_by_state',
    description: "Filter the ranking panel to show only counties in a specific state. Use this when the user wants to narrow results to a region, e.g., 'focus on Texas' or 'show only North Carolina'.",
    input_schema: {
      type: 'object' as const,
      properties: {
        state: { type: 'string' as const, description: "State name (e.g., 'Texas') or abbreviation (e.g., 'TX'). Use empty string '' to clear the filter." },
      },
      required: ['state'],
    },
  },
  {
    name: 'show_county_details',
    description: 'Open the detailed information modal for a specific county, showing all its data across demographics, economics, housing, equity, transportation, environment, and health.',
    input_schema: {
      type: 'object' as const,
      properties: {
        county_name: { type: 'string' as const, description: 'County name' },
        state: { type: 'string' as const, description: 'State name or 2-letter abbreviation' },
      },
      required: ['county_name'],
    },
  },
]

/** Helper: resolve a county by name/state, returning a single match or an error string */
function resolveCounty(
  countyName: string,
  stateHint: string | undefined
): { match: CountyLookup } | { error: string } {
  const matches = findCounty(countyName, stateHint)
  if (matches.length === 0) {
    return { error: `No county matching "${countyName}"${stateHint ? ` in ${stateHint}` : ''} was found.` }
  }
  if (matches.length === 1) {
    return { match: matches[0] }
  }
  // Multiple matches — return error so LLM can ask for clarification
  const options = matches.slice(0, 5).map((c) => `${c.name}, ${c.stateAbbr}`).join('; ')
  return { error: `Multiple counties match "${countyName}": ${options}${matches.length > 5 ? ', and more' : ''}. Please specify a state.` }
}

/**
 * Execute a tool by name with the given input and context.
 * Returns a human-readable result string that the LLM sees in the tool_result.
 */
export async function executeTool(
  toolName: string,
  toolInput: any,
  ctx: ToolContext
): Promise<string> {
  try {
    switch (toolName) {
      case 'zoom_to_county': {
        const resolved = resolveCounty(toolInput.county_name, toolInput.state)
        if ('error' in resolved) return resolved.error
        ctx.zoomToGeoId(resolved.match.geoId)
        return `Zoomed to ${resolved.match.name}, ${resolved.match.stateAbbr} (GEOID ${resolved.match.geoId}).`
      }

      case 'search_housing': {
        const resolved = resolveCounty(toolInput.county_name, toolInput.state)
        if ('error' in resolved) return resolved.error
        ctx.triggerHousingSearch(resolved.match)
        return `Triggered property search for ${resolved.match.name}, ${resolved.match.stateAbbr}.`
      }

      case 'set_layer_selection': {
        if (!Array.isArray(toolInput.layers) || toolInput.layers.length === 0) {
          return 'Error: layers array is required and must be non-empty.'
        }
        const options: LayerSelectionOptions = {
          filters: Array.isArray(toolInput.filters) ? toolInput.filters : undefined,
          limit: typeof toolInput.limit === 'number' ? toolInput.limit : undefined,
          explanation: toolInput.explanation,
        }
        ctx.setLayerSelection(toolInput.layers, options)
        const layerNames = toolInput.layers.map((l: LayerSelection) => l.layerId).join(', ')
        // Wait for reactive scoring to complete, then include top N counties
        const resultCount = options.limit ?? 10
        const topCounties = await ctx.getTopRankedCounties(Math.max(resultCount, 10))
        const filterSummary = options.filters && options.filters.length > 0
          ? ` Filters applied: ${options.filters.map(f => `${f.layerId} ${f.operator} ${f.value}${f.max != null ? '-' + f.max : ''}`).join(', ')}.`
          : ''
        const topList = topCounties
          .slice(0, resultCount)
          .map((c) => `${c.rank}. ${c.name}, ${c.state} (GEOID ${c.geoId}, score ${c.score.toFixed(1)})`)
          .join('\n')
        const emptyNote = topCounties.length === 0 ? '\n\nNo counties match the current criteria.' : ''
        return `Applied scoring query with ${toolInput.layers.length} layers: ${layerNames}.${filterSummary} Map recolored.\n\nTop ${Math.min(resultCount, topCounties.length)} counties:\n${topList}${emptyNote}`
      }

      case 'toggle_ranking_panel': {
        ctx.toggleRankingPanel(!!toolInput.expanded)
        return `Ranking panel ${toolInput.expanded ? 'expanded' : 'collapsed'}.`
      }

      case 'filter_ranking_by_state': {
        const state = typeof toolInput.state === 'string' ? toolInput.state : ''
        ctx.setRankingStateFilter(state)
        return state ? `Ranking filtered to ${state}.` : 'Ranking filter cleared (showing all states).'
      }

      case 'show_county_details': {
        const resolved = resolveCounty(toolInput.county_name, toolInput.state)
        if ('error' in resolved) return resolved.error
        ctx.openCountyModal(resolved.match.geoId)
        return `Opened details for ${resolved.match.name}, ${resolved.match.stateAbbr}.`
      }

      default:
        return `Unknown tool: ${toolName}`
    }
  } catch (err: any) {
    return `Error executing ${toolName}: ${err?.message || 'unknown error'}`
  }
}
