/**
 * Anthropic tool definitions for the PUBLIC MAP's prompt box (`POST /api/chat`).
 *
 * Duplicated from src/lib/mapTools.ts for server-side use.
 * Keep in sync when adding/modifying tools.
 *
 * The four map-driving tools moved to `mapToolDefinitions.ts` in P14-2, so
 * the library chat can register the same four without a second copy. The two
 * below are this bus's own: the chat page has no listings search and no
 * ranking panel.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { MAP_TOOL_DEFINITIONS } from './mapToolDefinitions.js'

const PUBLIC_MAP_ONLY: Anthropic.Messages.Tool[] = [
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
]

export const TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
  ...MAP_TOOL_DEFINITIONS,
  ...PUBLIC_MAP_ONLY,
]
