import { ref, type Ref } from 'vue'
import { LAYER_COLORS, debugLog } from '@/config/constants'
import type {
  ColorBlend,
  DiversityData,
  LifeExpectancyDataMap,
  ContaminationDataMap,
  CombinedScoresDataMap,
  RGBColor,
  RGBAColor,
} from '@/types/mapTypes'

export function useColorCalculation(
  diversityData: Ref<DiversityData>,
  lifeExpectancyData: Ref<LifeExpectancyDataMap>,
  countyContaminationCounts: ContaminationDataMap,
  combinedScoresData: Ref<CombinedScoresDataMap>
) {
  const preCalculatedColors = ref<{ [key: string]: ColorBlend }>({})
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
   * Pre-calculate colors for all counties
   */
  const preCalculateColors = () => {
    debugLog('Pre-calculating color blends...')

    const colors = {
      diversity_index: LAYER_COLORS.DIVERSITY_INDEX,
      pct_Black: LAYER_COLORS.PCT_BLACK,
      contamination: LAYER_COLORS.CONTAMINATION,
      life_expectancy: LAYER_COLORS.LIFE_EXPECTANCY,
      combined_scores: {
        min: [255, 255, 0] as RGBColor, // Yellow
        max: [0, 255, 0] as RGBColor,   // Vivid green
      },
    }

    // Get the range of combined scores
    const combinedScores = Object.values(combinedScoresData.value || {})
      .filter((d) => d && typeof d.combinedScore === 'number')
      .map((d) => d.combinedScore)

    const maxCombinedScore =
      combinedScores.length > 0 ? Math.max(...combinedScores) : 5
    const minCombinedScore =
      combinedScores.length > 0 ? Math.min(...combinedScores) : 0

    // Get all necessary ranges
    const maxDiversityIndex = Math.max(
      ...Object.values(diversityData.value).map((d) => d.diversityIndex || 0)
    )

    const maxContamination = Math.max(
      ...Object.values(countyContaminationCounts).map((d) =>
        typeof d === 'number' ? d : d.total
      )
    )

    // Get life expectancy range
    const lifeExpectancyValues = Object.values(lifeExpectancyData.value)
      .map((d) => d.lifeExpectancy)
      .filter((v) => v !== undefined && v !== null)
    const maxLifeExpectancy = Math.max(...lifeExpectancyValues)
    const minLifeExpectancy = Math.min(...lifeExpectancyValues)

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
    Object.entries(diversityData.value).forEach(([geoID, data]) => {
      // Check if diversity data exists, return 0 alpha if missing
      const diversityValue =
        data.diversityIndex != null && maxDiversityIndex > 0
          ? data.diversityIndex / maxDiversityIndex
          : 0
      const hasDiversityData = data.diversityIndex != null

      const blackPctValue = data.pct_Black != null ? data.pct_Black / 100 : 0
      const hasBlackPctData = data.pct_Black != null

      const contaminationValue =
        typeof countyContaminationCounts[geoID] === 'number'
          ? countyContaminationCounts[geoID]
          : (countyContaminationCounts[geoID]?.total as number) || 0
      const contaminationNormalized =
        maxContamination > 0 ? (contaminationValue as number) / maxContamination : 0

      // Linear normalization to [0,1] range - check if life expectancy data exists
      const lifeExpectancyValue = lifeExpectancyData.value[geoID]?.lifeExpectancy
      const hasLifeExpectancyData = lifeExpectancyValue != null
      const lifeExpectancyNormalized = hasLifeExpectancyData
        ? normalizeValue(lifeExpectancyValue, minLifeExpectancy, maxLifeExpectancy)
        : 0

      // Calculate combined score color
      const combinedScore =
        combinedScoresData.value?.[geoID]?.combinedScore ?? minCombinedScore
      const combinedScoreNormalized = normalizeValue(
        combinedScore,
        minCombinedScore,
        maxCombinedScore
      )

      preCalculatedColors.value[geoID] = {
        geoID,
        diversityColor: hasDiversityData
          ? [...colors.diversity_index, diversityValue] as RGBAColor
          : [0, 0, 0, 0] as RGBAColor,
        blackPctColor: hasBlackPctData
          ? [...colors.pct_Black, blackPctValue] as RGBAColor
          : [0, 0, 0, 0] as RGBAColor,
        contaminationColor: [
          ...colors.contamination,
          contaminationNormalized,
        ] as RGBAColor,
        lifeExpectancyColor: hasLifeExpectancyData
          ? [...colors.life_expectancy, lifeExpectancyNormalized] as RGBAColor
          : [0, 0, 0, 0] as RGBAColor,
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
    })

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
