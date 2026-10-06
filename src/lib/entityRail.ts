/** Shared types/constants for the entity rail (P5-28) — kept out of the SFC
 *  because `<script setup>` can't export. */
import type { InternalFeature, FeatureGeometry } from './internalLayers'

export interface EntityRailLayer {
  id: string
  /** Catalog slug — for the About / Data links (P5-36). */
  slug: string
  /** P7-3: what the rail is listing, so it can say "line layers" when it is. */
  geometry: FeatureGeometry
  name: string
  color: string | null
  popupFields: string[]
  features: InternalFeature[]
}

export interface EntityRef {
  layerId: string
  index: number
}

/** Rendering more than this many rows at once is pointless — search instead. */
export const ENTITY_ROWS_MAX = 500
