/**
 * Dataset Metadata - derived from layerRegistry.ts
 *
 * This file is maintained for backwards compatibility. The canonical source
 * of layer metadata is now layerRegistry.ts.
 */

import { LAYER_REGISTRY } from './layerRegistry'

export interface DatasetMetadata {
  id: string
  name: string
  description: string
  source: string
  sourceUrl?: string
  year: string | number
  unit?: string
  range?: { min: number; max: number }
}

/** Derive metadata from the layer registry */
export const datasetMetadata: Record<string, DatasetMetadata> = Object.fromEntries(
  Object.values(LAYER_REGISTRY).map((layer) => [
    layer.id,
    {
      id: layer.id,
      name: layer.name,
      description: layer.description,
      source: layer.source,
      sourceUrl: layer.sourceUrl,
      year: layer.year,
      unit: layer.unit,
      range: layer.range,
    },
  ])
)

// BLO Calculation Methodology
export const bloCalculationMethodology = `
## BLO Livability Index Calculation

The BLO Livability Index is a comprehensive measure designed to evaluate county-level conditions for Black American livability. It combines 11 normalized metrics across 6 key dimensions:

### Metric Weights

**Demographics (20%)**
- Diversity Index: 10%
- Percent Black Population: 10%

**Health (10%)**
- Life Expectancy: 10%

**Environment (5%)**
- EPA Contamination Sites: 5%

**Economic Opportunity (20%)**
- Average Weekly Wage: 10%
- Median Household Income (Black): 10%

**Housing Affordability (20%)**
- Median Home Value: 10%
- Median Property Tax: 5%
- Black Homeownership Rate: 5%

**Racial Equity (15%)**
- Poverty Rate (Black): 10%
- Black Progress Index: 15%

### Normalization Process

1. Each metric is normalized to a 0-1 scale using min-max normalization
2. Inverted metrics (contamination, home value, property tax, poverty) are reversed so higher normalized values = better conditions
3. Missing data is handled through dynamic weight redistribution - available metrics are weighted proportionally to maintain the 0-5 scale

### Final Score Calculation

The weighted sum of normalized metrics is scaled to a 0-5 range:

\`\`\`
BLO Score = (Σ(normalized_metric × weight) / total_available_weight) × 5
\`\`\`

### Score Interpretation

- **Range**: 1.15 - 3.28 (actual county scores)
- **National Average**: 2.39
- **Higher is Better**: Higher scores indicate more favorable conditions across all measured dimensions

### Data Quality

All 3,144 US counties receive scores through weighted averaging. Counties with missing data for specific metrics have those weights redistributed among available metrics, ensuring comprehensive coverage while maintaining scoring integrity.
`

export function getDatasetById(id: string): DatasetMetadata | undefined {
  return datasetMetadata[id]
}

export function getAllDatasets(): DatasetMetadata[] {
  return Object.values(datasetMetadata)
}
