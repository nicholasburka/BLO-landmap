/**
 * The five EPA contamination site layers, as plain data (P5-78).
 *
 * They live apart from `layerConfig.ts` for one reason: the SERVER has to
 * know them too. A saved map view names the site layers that were on when it
 * was saved (`state.siteLayers`), and the server validates that list and
 * writes the view's description ("… · Superfund Sites"), so the ids and their
 * labels have to exist on both sides. `npm run export:layers` copies this
 * table to `server/src/prompt/siteLayers.generated.json` — the same trip the
 * public layer registry makes, and for the same reason: a second hand-kept
 * copy would drift within a week.
 *
 * Plain data with no imports, so the export script can load it directly.
 * The map plumbing (loading, showing, hiding) stays in `layerConfig.ts`.
 */

export interface SiteLayerDefinition {
  id: string
  name: string
  file: string
  color: string
  tooltip: string
}

export const SITE_LAYERS: SiteLayerDefinition[] = [
  {
    id: 'acres_brownfields',
    name: 'Brownfields',
    file: '/datasets/epa-contamination/acres_brownfields.geojson',
    color: '#FF0000',
    tooltip: 'Properties with potential hazardous substances complicating development. (EPA)',
  },
  {
    id: 'air_pollution_sources',
    name: 'Air Pollution Sources',
    file: '/datasets/epa-contamination/air_pollution_sources.geojson',
    // Magenta — contrasts with the green choropleth so dots stay visible
    // when overlaid (#00FF00 was nearly invisible against BLO green).
    color: '#d946ef',
    tooltip: 'Facilities that emit air pollutants tracked by EPA. (EPA)',
  },
  {
    id: 'hazardous_waste_sites',
    name: 'Hazardous Waste Sites',
    file: '/datasets/epa-contamination/hazardous_waste_sites.geojson',
    color: '#0000FF',
    tooltip: 'RCRA-regulated facilities managing hazardous waste. (EPA)',
  },
  {
    id: 'superfund_sites',
    name: 'Superfund Sites',
    file: '/datasets/epa-contamination/superfund_sites.geojson',
    color: '#FFFF00',
    tooltip: 'National Priorities List sites requiring long-term hazardous cleanup. (EPA)',
  },
  {
    id: 'toxic_release_inventory',
    name: 'Toxic Release Inventory',
    file: '/datasets/epa-contamination/toxic_release_inventory.geojson',
    color: '#FF00FF',
    tooltip: 'Facilities reporting annual toxic chemical releases. (EPA)',
  },
]

/** The vocabulary a saved view's `siteLayers` speaks. */
export const SITE_LAYER_IDS: string[] = SITE_LAYERS.map(layer => layer.id)

export function isSiteLayerId(value: unknown): value is string {
  return typeof value === 'string' && SITE_LAYER_IDS.includes(value)
}

/** The label a person reads. Falls back to the id, which is what an
 *  unrecognised layer would have shown anyway. */
export function siteLayerName(id: string): string {
  return SITE_LAYERS.find(layer => layer.id === id)?.name ?? id
}
