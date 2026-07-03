/**
 * LLM Tool Definitions + Client-Side Handlers
 *
 * Defines the Anthropic tool schemas for map control actions, and implements
 * client-side handlers that execute them. Server relays tool_use blocks from
 * Claude to the client; client invokes these handlers against the map state.
 */

import type mapboxgl from 'mapbox-gl'
import { findCounty, type CountyLookup } from './countyLookup'
import { LAYER_REGISTRY } from '@/config/layerRegistry'

export interface LayerSelection {
  layerId: string
  weight: number
  // Optional: the LLM tool path always supplies a direction (dispatch
  // defaults it), but snapshot replay of UI-selected layers may not —
  // scoring then falls back to the layer registry's default direction.
  direction?: 'higher_better' | 'lower_better'
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

/** Atomic query state — Phase 4g unified mutation shape. */
export interface QueryStateInput {
  layers: LayerSelection[]
  filters: ScoringFilter[]
  limit: number | null
  regionStates: string[]
  explanation?: string
}

/** Context injected by Map.vue — gives tools access to app state + mutators */
export interface ToolContext {
  map: mapboxgl.Map | null
  /** Phase 4g: atomic state mutator. Replaces setLayerSelection +
   *  setRankingStateFilter. Pass the entire desired state in one call. */
  applyQueryState: (input: QueryStateInput) => void
  /** Open the county detail modal for a given GEOID */
  openCountyModal: (geoId: string) => void
  /** Expand or collapse the ranking panel */
  toggleRankingPanel: (expanded: boolean) => void
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
    name: 'set_query_state',
    description: 'Atomically set the entire map query (layers, filters, limit, regionStates) in one call. Replaces all prior state — there is no merge. Use for region queries like "Southeast" by passing the full state array; never call this multiple times to expand a region.',
    input_schema: {
      type: 'object' as const,
      properties: {
        layers: {
          type: 'array' as const,
          description: '0-6 weighted scoring layers. Empty array clears scoring.',
          items: {
            type: 'object' as const,
            properties: {
              layerId: { type: 'string' as const, description: 'Exact layer ID from the registry' },
              weight: { type: 'number' as const, description: 'Relative weight 1-10' },
              direction: { type: 'string' as const, enum: ['higher_better', 'lower_better'], description: 'Scoring direction' },
            },
            required: ['layerId', 'weight', 'direction'],
          },
        },
        filters: {
          type: 'array' as const,
          description: 'Threshold filters. Empty array clears filters.',
          items: {
            type: 'object' as const,
            properties: {
              layerId: { type: 'string' as const },
              operator: { type: 'string' as const, enum: ['greater_than', 'less_than', 'between'] },
              value: { type: 'number' as const },
              max: { type: 'number' as const },
            },
            required: ['layerId', 'operator', 'value'],
          },
        },
        limit: { type: 'number' as const, description: 'Top N (1-50). Omit/null for all.' },
        regionStates: {
          type: 'array' as const,
          description: '2-letter US state codes restricting the ranking. Empty/omitted = nationwide.',
          items: { type: 'string' as const },
        },
        explanation: { type: 'string' as const, description: 'Sentence shown to the user describing what changed.' },
      },
      required: ['layers', 'explanation'],
    },
  },
  {
    name: 'toggle_ranking_panel',
    description: 'Expand or collapse the county ranking panel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        expanded: { type: 'boolean' as const, description: 'true to expand, false to collapse' },
      },
      required: ['expanded'],
    },
  },
  {
    name: 'show_county_details',
    description: 'Open an inspection panel for a specific county. The map zooms regionally and the right-side rail shows the county name, score, and key stats. Use this when the user wants details about a specific county.',
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

      case 'set_query_state': {
        const rawLayers = Array.isArray(toolInput.layers) ? toolInput.layers : []
        const rawFilters = Array.isArray(toolInput.filters) ? toolInput.filters : []
        const limitIn = toolInput.limit
        const rawRegions = Array.isArray(toolInput.regionStates) ? toolInput.regionStates : []
        // Normalize region codes: uppercase, strip whitespace, drop anything
        // that isn't a 2-letter US state code. Bad codes are silently dropped
        // rather than rejecting the whole call — partial regions are still
        // useful and the explanation will mention the active states anyway.
        const regionStates: string[] = []
        for (const r of rawRegions) {
          if (typeof r !== 'string') continue
          const code = r.trim().toUpperCase()
          if (/^[A-Z]{2}$/.test(code)) regionStates.push(code)
        }
        // Validate layers against the registry the scoring engine uses
        // (usePersonalizedScore resolves layerIds via LAYER_REGISTRY).
        // Malformed/unknown entries are dropped and enumerated in the
        // tool_result so the LLM can self-correct instead of narrating
        // layers that were never applied.
        const layers: LayerSelection[] = []
        const ignoredLayerIds: string[] = []
        for (const raw of rawLayers) {
          if (raw == null || typeof raw !== 'object') {
            ignoredLayerIds.push('(malformed entry)')
            continue
          }
          const layerId = typeof raw.layerId === 'string' ? raw.layerId : ''
          if (!layerId || !LAYER_REGISTRY[layerId]) {
            ignoredLayerIds.push(layerId || '(missing layerId)')
            continue
          }
          const weightIn = typeof raw.weight === 'number' && Number.isFinite(raw.weight) ? raw.weight : 5
          layers.push({
            layerId,
            weight: Math.min(10, Math.max(1, weightIn)),
            direction: raw.direction === 'lower_better' ? 'lower_better' : 'higher_better',
          })
        }

        // Same treatment for filters: known layerId, known operator,
        // finite numeric value (and max, when present).
        const filters: ScoringFilter[] = []
        const ignoredFilterIds: string[] = []
        for (const raw of rawFilters) {
          if (raw == null || typeof raw !== 'object') {
            ignoredFilterIds.push('(malformed entry)')
            continue
          }
          const layerId = typeof raw.layerId === 'string' ? raw.layerId : ''
          const operatorOk = raw.operator === 'greater_than' || raw.operator === 'less_than' || raw.operator === 'between'
          const valueOk = typeof raw.value === 'number' && Number.isFinite(raw.value)
          const maxOk = raw.max == null || (typeof raw.max === 'number' && Number.isFinite(raw.max))
          if (!layerId || !LAYER_REGISTRY[layerId] || !operatorOk || !valueOk || !maxOk) {
            ignoredFilterIds.push(layerId || '(missing layerId)')
            continue
          }
          const filter: ScoringFilter = { layerId, operator: raw.operator, value: raw.value }
          if (typeof raw.max === 'number') filter.max = raw.max
          filters.push(filter)
        }

        const queryState: QueryStateInput = {
          layers,
          filters,
          // Clamp to the documented 1-50 range — 0/negative would blank
          // the ranking panel while the tool_result claims success.
          limit: typeof limitIn === 'number' && Number.isFinite(limitIn)
            ? Math.min(50, Math.max(1, Math.round(limitIn)))
            : null,
          regionStates,
          explanation: typeof toolInput.explanation === 'string' ? toolInput.explanation : undefined,
        }
        ctx.applyQueryState(queryState)

        // Build the human-readable tool_result the LLM will see.
        const layerNames = queryState.layers.length > 0
          ? queryState.layers.map((l) => l.layerId).join(', ')
          : '(cleared)'
        const filterSummary = queryState.filters.length > 0
          ? ` Filters: ${queryState.filters.map(f => `${f.layerId} ${f.operator} ${f.value}${f.max != null ? '-' + f.max : ''}`).join(', ')}.`
          : ''
        const regionSummary = regionStates.length > 0
          ? ` Region: ${regionStates.join(', ')}.`
          : ''
        const ignoredNote = (ignoredLayerIds.length > 0 ? ` Ignored unknown layers: ${ignoredLayerIds.join(', ')}.` : '')
          + (ignoredFilterIds.length > 0 ? ` Ignored invalid filters: ${ignoredFilterIds.join(', ')}.` : '')
        if (queryState.layers.length === 0) {
          return `Applied query state. Layers: (cleared).${filterSummary}${regionSummary}${ignoredNote} Scoring cleared — map shows the default BLO Livability Index.`
        }
        const resultCount = queryState.limit ?? 10
        const topCounties = await ctx.getTopRankedCounties(Math.max(resultCount, 10))
        const topList = topCounties
          .slice(0, resultCount)
          .map((c) => `${c.rank}. ${c.name}, ${c.state} (GEOID ${c.geoId}, score ${c.score.toFixed(1)})`)
          .join('\n')
        const emptyNote = topCounties.length === 0 ? '\n\nNo counties match the current criteria.' : ''
        return `Applied query state. Layers: ${layerNames}.${filterSummary}${regionSummary}${ignoredNote} Map recolored.\n\nTop ${Math.min(resultCount, topCounties.length)} counties:\n${topList}${emptyNote}`
      }

      case 'toggle_ranking_panel': {
        ctx.toggleRankingPanel(!!toolInput.expanded)
        return `Ranking panel ${toolInput.expanded ? 'expanded' : 'collapsed'}.`
      }

      case 'show_county_details': {
        const resolved = resolveCounty(toolInput.county_name, toolInput.state)
        if ('error' in resolved) return resolved.error
        // Phase 4e: openCountyModal now routes through inspectCounty in
        // Map.vue — opens the right-side inspect rail, not the centered
        // modal. Same tool API, different surface.
        ctx.openCountyModal(resolved.match.geoId)
        return `Opened inspection for ${resolved.match.name}, ${resolved.match.stateAbbr}.`
      }

      default:
        return `Unknown tool: ${toolName}`
    }
  } catch (err: any) {
    return `Error executing ${toolName}: ${err?.message || 'unknown error'}`
  }
}
