import { describe, it, expect, vi } from 'vitest'
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from '../mapTools'

function ctx(showLayer?: ToolContext['showLayer']): ToolContext {
  return {
    map: null,
    applyQueryState: vi.fn(),
    openCountyModal: vi.fn(),
    toggleRankingPanel: vi.fn(),
    triggerHousingSearch: vi.fn(),
    zoomToGeoId: vi.fn(),
    getTopRankedCounties: vi.fn(async () => []),
    showLayer,
  }
}

describe('show_layer tool (P5-26)', () => {
  it('is defined for the model and routes to ctx.showLayer with a default of on', async () => {
    expect(TOOL_DEFINITIONS.some(t => t.name === 'show_layer')).toBe(true)
    const show = vi.fn(async (id: string, on: boolean) => `${id} is now ${on ? 'on' : 'off'}.`)
    expect(await executeTool('show_layer', { layerId: 'internal-organizations' }, ctx(show))).toBe('internal-organizations is now on.')
    expect(await executeTool('show_layer', { layerId: 'pct_Black', on: false }, ctx(show))).toBe('pct_Black is now off.')
    expect(show).toHaveBeenCalledWith('internal-organizations', true)
  })

  it('reports unknown ids, rejects malformed ids, and degrades when the host has no showLayer', async () => {
    const show = vi.fn(async () => null)
    expect(await executeTool('show_layer', { layerId: 'internal-nope' }, ctx(show))).toBe('No layer with id "internal-nope" is available in this session.')
    expect(await executeTool('show_layer', { layerId: '../x' }, ctx(show))).toBe('show_layer needs a layerId.')
    expect(show).toHaveBeenCalledTimes(1)
    expect(await executeTool('show_layer', { layerId: 'pct_Black' }, ctx(undefined))).toBe('Layer toggling is not available here.')
  })
})
