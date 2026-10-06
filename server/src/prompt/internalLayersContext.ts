import type { InternalLayerManifestEntry } from '../services/internalLayers.js'

/**
 * P5-26: internal layers rendered into the LLM prompts — only for requests
 * that carry a valid internal session (the anonymous public prompt never
 * mentions them). County layers join `set_query_state` like public layers;
 * point, line and state layers can't be scored, so the model shows them with
 * `show_layer`.
 *
 * Everything here lands in the SYSTEM prompt. The manifest comes from our
 * own catalog (manifest fields validated at reindex), but names and
 * descriptions are still author-supplied text, so they are clipped and
 * stripped of backticks/newlines before rendering.
 */

const NAME_MAX = 80
const DESC_MAX = 240
const UNIT_MAX = 20

function clean(text: unknown, max: number): string {
  return String(text ?? '').replace(/[`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function internalCountyIds(layers: InternalLayerManifestEntry[]): Set<string> {
  return new Set(layers.filter(l => l.geometry === 'county').map(l => l.id))
}

export function renderInternalLayersContext(layers: InternalLayerManifestEntry[]): string {
  if (!layers.length) return ''
  const lines: string[] = [
    '',
    '## Internal data layers (available in this session only)',
    '',
    'The user is a logged-in team member, so these internal layers are available in addition to the public ones. Use the exact ids.',
    '- County layers work in `set_query_state` exactly like public layers (weights, directions, filters).',
    '- Point, line and state layers cannot be scored or filtered; when the user wants to see them, call `show_layer` with the id.',
    '',
  ]
  for (const l of layers) {
    const name = clean(l.name, NAME_MAX) || l.id
    const desc = clean(l.description, DESC_MAX)
    if (l.geometry === 'county') {
      const range = l.range ? `${l.range.min}–${l.range.max}` : 'data-derived'
      // Every free-text manifest field that reaches the prompt goes through
      // clean(); id/dataType/direction are slug- or enum-constrained upstream.
      const unit = clean(l.unit, UNIT_MAX) || 'n/a'
      lines.push(`- **${name}** (id: \`${l.id}\`) — county layer · Type: ${l.dataType} · Unit: ${unit} · Direction: ${l.direction} · Range: ${range}${desc ? ` · ${desc}` : ''}`)
    } else {
      lines.push(`- **${name}** (id: \`${l.id}\`) — ${l.geometry} layer (show with show_layer)${desc ? ` · ${desc}` : ''}`)
    }
  }
  return lines.join('\n')
}
