import { ref, shallowRef, toRaw, type Ref } from 'vue'
import { debugLog } from '@/config/constants'
import type {
  ColorBlend,
  DiversityData,
  LifeExpectancyDataMap,
  ContaminationData,
  ContaminationDataMap,
  CombinedScoresDataMap,
  RGBColor,
  RGBAColor,
} from '@/types/mapTypes'

/** The colour table for every county, keyed by GEOID. Frozen and non-reactive
 *  (P5-87): nothing watches an individual county's colour — the choropleth
 *  reads the whole table when it repaints — so paying for ~3,200 reactive
 *  proxies and ~3,200 dependency triggers bought nothing but latency. */
export type ColorTable = Readonly<Record<string, ColorBlend>>

/** `Math.max` over an iterable, without spreading it into an argument list.
 *  Spreading ~3,200 values is already close to the engine's argument cap and
 *  allocates the whole array first; these keep the exact semantics (any NaN
 *  poisons the result, an empty run is ±Infinity) at no cost. */
function maxOf(values: Iterable<number | null | undefined>): number {
  let max = -Infinity
  for (const value of values) {
    const n = Number(value)
    if (Number.isNaN(n)) return NaN
    if (n > max) max = n
  }
  return max
}

function minOf(values: Iterable<number | null | undefined>): number {
  let min = Infinity
  for (const value of values) {
    const n = Number(value)
    if (Number.isNaN(n)) return NaN
    if (n < min) min = n
  }
  return min
}

export function useColorCalculation(
  diversityData: Ref<DiversityData>,
  lifeExpectancyData: Ref<LifeExpectancyDataMap>,
  countyContaminationCounts: ContaminationDataMap,
  combinedScoresData: Ref<CombinedScoresDataMap>
) {
  const preCalculatedColors = shallowRef<ColorTable>({})
  const colorCalculationComplete = ref(false)

  /**
   * Normalize a value to the [0, 1] range
   */
  const normalizeValue = (
    value: number,
    min: number,
    max: number
  ): number => {
    if (max === min) return 0
    return (value - min) / (max - min)
  }

  /**
   * Blend two RGB colors with their respective alpha values
   */
  const blendColors = (
    color1: RGBColor,
    alpha1: number,
    color2: RGBColor,
    alpha2: number
  ): RGBAColor => {
    return [
      Math.min(255, color1[0] * alpha1 + color2[0] * alpha2),
      Math.min(255, color1[1] * alpha1 + color2[1] * alpha2),
      Math.min(255, color1[2] * alpha1 + color2[2] * alpha2),
      Math.max(alpha1, alpha2),
    ]
  }

  /**
   * Interpolate between two colors based on a normalized value
   */
  const interpolateColors = (
    minColor: RGBColor,
    maxColor: RGBColor,
    normalizedValue: number
  ): RGBAColor => {
    return [
      Math.round(
        minColor[0] + (maxColor[0] - minColor[0]) * normalizedValue
      ),
      Math.round(
        minColor[1] + (maxColor[1] - minColor[1]) * normalizedValue
      ),
      Math.round(
        minColor[2] + (maxColor[2] - minColor[2]) * normalizedValue
      ),
      0.7, // Constant opacity
    ]
  }

  /**
   * Pre-calculate colors for all counties.
   *
   * Builds a plain object and publishes it in one assignment. The colours are
   * identical to the reactive-per-county version this replaced — see
   * `useColorCalculation.spec.ts`, whose expectations were captured from it.
   */
  const preCalculateColors = () => {
    debugLog('Pre-calculating color blends...')

    const colors = {
      diversity_index: [128, 0, 128] as RGBColor,     // Purple
      pct_Black: [139, 69, 19] as RGBColor,            // Brown
      contamination: [255, 0, 0] as RGBColor,           // Red
      life_expectancy: [0, 128, 0] as RGBColor,         // Green
      combined_scores: {
        min: [255, 255, 0] as RGBColor, // Yellow
        max: [0, 255, 0] as RGBColor,   // Vivid green
      },
    }

    // Read through the raw objects: these maps are only ever read here, and
    // going through Vue's proxies costs a trap per county per field.
    const diversity = toRaw(diversityData.value) ?? {}
    const lifeExpectancy = toRaw(lifeExpectancyData.value) ?? {}
    const contamination = toRaw(countyContaminationCounts) ?? {}
    const combined = toRaw(combinedScoresData.value) ?? {}

    // Get the range of combined scores
    const combinedScores: number[] = []
    for (const d of Object.values(combined)) {
      if (d && typeof d.combinedScore === 'number') combinedScores.push(d.combinedScore)
    }
    const maxCombinedScore = combinedScores.length > 0 ? maxOf(combinedScores) : 5
    const minCombinedScore = combinedScores.length > 0 ? minOf(combinedScores) : 0

    // Get all necessary ranges
    const diversityIndexes: number[] = []
    for (const d of Object.values(diversity)) diversityIndexes.push(d.diversityIndex || 0)
    const maxDiversityIndex = maxOf(diversityIndexes)

    const contaminationTotals: (number | undefined)[] = []
    for (const d of Object.values(contamination)) {
      contaminationTotals.push(typeof d === 'number' ? d : (d as ContaminationData)?.total)
    }
    const maxContamination = maxOf(contaminationTotals)

    // Get life expectancy range
    const lifeExpectancyValues: number[] = []
    for (const d of Object.values(lifeExpectancy)) {
      if (d.lifeExpectancy !== undefined && d.lifeExpectancy !== null) {
        lifeExpectancyValues.push(d.lifeExpectancy)
      }
    }
    const maxLifeExpectancy = maxOf(lifeExpectancyValues)
    const minLifeExpectancy = minOf(lifeExpectancyValues)

    debugLog('Pre-calculation ranges:', {
      maxDiversityIndex,
      maxContamination,
      lifeExpectancy: {
        min: minLifeExpectancy,
        max: maxLifeExpectancy,
      },
      combinedScore: {
        min: minCombinedScore,
        max: maxCombinedScore,
      },
    })

    // Pre-calculate colors for each county
    const table: Record<string, ColorBlend> = {}
    for (const geoID of Object.keys(diversity)) {
      const data = diversity[geoID]

      // Check if diversity data exists, return 0 alpha if missing
      const diversityValue =
        data.diversityIndex != null && maxDiversityIndex > 0
          ? data.diversityIndex / maxDiversityIndex
          : 0
      const hasDiversityData = data.diversityIndex != null

      const blackPctValue = data.pct_Black != null ? data.pct_Black / 100 : 0
      const hasBlackPctData = data.pct_Black != null

      const counts = contamination[geoID]
      const contaminationValue =
        typeof counts === 'number'
          ? counts
          : ((counts as ContaminationData | undefined)?.total as number) || 0
      const contaminationNormalized =
        maxContamination > 0 ? contaminationValue / maxContamination : 0

      // Linear normalization to [0,1] range - check if life expectancy data exists
      const lifeExpectancyValue = lifeExpectancy[geoID]?.lifeExpectancy
      const hasLifeExpectancyData = lifeExpectancyValue != null
      const lifeExpectancyNormalized = hasLifeExpectancyData
        ? normalizeValue(lifeExpectancyValue, minLifeExpectancy, maxLifeExpectancy)
        : 0

      // Calculate combined score color
      const combinedScore = combined[geoID]?.combinedScore ?? minCombinedScore
      const combinedScoreNormalized = normalizeValue(
        combinedScore,
        minCombinedScore,
        maxCombinedScore
      )

      table[geoID] = {
        geoID,
        diversityColor: hasDiversityData
          ? [colors.diversity_index[0], colors.diversity_index[1], colors.diversity_index[2], diversityValue]
          : [0, 0, 0, 0],
        blackPctColor: hasBlackPctData
          ? [colors.pct_Black[0], colors.pct_Black[1], colors.pct_Black[2], blackPctValue]
          : [0, 0, 0, 0],
        contaminationColor: [
          colors.contamination[0],
          colors.contamination[1],
          colors.contamination[2],
          contaminationNormalized,
        ],
        lifeExpectancyColor: hasLifeExpectancyData
          ? [colors.life_expectancy[0], colors.life_expectancy[1], colors.life_expectancy[2], lifeExpectancyNormalized]
          : [0, 0, 0, 0],
        blendedColors: {
          diversityAndContamination: blendColors(
            colors.diversity_index,
            diversityValue,
            colors.contamination,
            contaminationNormalized
          ),
          blackPctAndContamination: blendColors(
            colors.pct_Black,
            blackPctValue,
            colors.contamination,
            contaminationNormalized
          ),
        },
        combinedScoreColor: interpolateColors(
          colors.combined_scores.min,
          colors.combined_scores.max,
          combinedScoreNormalized
        ),
      }
    }

    preCalculatedColors.value = Object.freeze(table)
    colorCalculationComplete.value = true
    debugLog('Color blend pre-calculation complete')
  }

  /**
   * Get color for a specific layer and county
   */
  const getColorForLayer = (
    layerId: string,
    geoID: string
  ): RGBAColor | null => {
    const colorData = preCalculatedColors.value[geoID]
    if (!colorData) return null

    switch (layerId) {
      case 'diversity_index':
        return colorData.diversityColor
      case 'pct_Black':
        return colorData.blackPctColor
      case 'contamination':
        return colorData.contaminationColor
      case 'life_expectancy':
        return colorData.lifeExpectancyColor
      case 'combined_scores':
        return colorData.combinedScoreColor
      case 'diversity_contamination_blend':
        return colorData.blendedColors.diversityAndContamination
      case 'black_pct_contamination_blend':
        return colorData.blendedColors.blackPctAndContamination
      default:
        return null
    }
  }

  return {
    // State
    preCalculatedColors,
    colorCalculationComplete,

    // Methods
    preCalculateColors,
    getColorForLayer,
    normalizeValue,
    blendColors,
    interpolateColors,
  }
}
