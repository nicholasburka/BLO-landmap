<template>
  <div
    v-if="show"
    id="detailed-popup"
    :class="{ 'desktop-view': isDesktopView }"
    @click.stop
    role="dialog"
    aria-modal="true"
    :aria-labelledby="'modal-title-' + countyId"
  >
    <button
      @click="$emit('close')"
      class="detailed-popup-close"
      aria-label="Close county details"
      type="button"
    >
      &times;
    </button>
    <div class="detailed-popup-content">
      <h2 :id="'modal-title-' + countyId">{{ countyName }}, {{ stateName }}</h2>

      <!-- BLO Liveability Index Section -->
      <div v-if="hasBLOV2Data" class="blo-v2-section">
        <div class="score-header">
          <h3 class="section-title inline">BLO Liveability Index:</h3>
          <span class="score-value">{{ formatBLOScoreV2 }}</span>
          <span v-html="getBLOScoreDiff"></span>
        </div>

        <h4 class="subsection-title">Demographics</h4>
        <table class="county-stats-table compact">
          <tr>
            <td class="label">Total Population:</td>
            <td class="value">{{ formatPopulation }}<span v-html="getPopulationDiff"></span></td>
          </tr>
          <tr>
            <td class="label">Percent Black:</td>
            <td class="value">{{ formatPercentBlack }}<span v-html="getPctBlackDiff"></span></td>
          </tr>
          <tr>
            <td class="label">Diversity Index:</td>
            <td class="value">{{ formatDiversityIndex }}<span v-html="getDiversityIndexDiff"></span></td>
          </tr>
        </table>

        <h4 class="subsection-title">Racial Equity</h4>
        <table class="county-stats-table compact">
          <tr>
            <td class="label">Poverty Rate (Black):</td>
            <td class="value">{{ formatPovertyRateBlack }}<span v-html="getPovertyRateBlackDiff"></span></td>
          </tr>
          <tr>
            <td class="label">Black Progress Index:</td>
            <td class="value">{{ formatBlackProgressIndex }}<span v-html="getBlackProgressIndexDiff"></span></td>
          </tr>
        </table>

        <h4 class="subsection-title">Economic Indicators</h4>
        <table class="county-stats-table compact">
          <tr>
            <td class="label">Avg Weekly Wage:</td>
            <td class="value">{{ formatAvgWeeklyWage }}<span v-html="getAvgWeeklyWageDiff"></span></td>
          </tr>
          <tr>
            <td class="label">Median Income (Black):</td>
            <td class="value">{{ formatMedianIncomeBlack }}<span v-html="getMedianIncomeBlackDiff"></span></td>
          </tr>
        </table>

        <h4 class="subsection-title">Housing & Affordability</h4>
        <table class="county-stats-table compact">
          <tr>
            <td class="label">Median Home Value:</td>
            <td class="value">{{ formatMedianHomeValue }}<span v-html="getMedianHomeValueDiff"></span></td>
          </tr>
          <tr>
            <td class="label">Median Property Tax:</td>
            <td class="value">{{ formatMedianPropertyTax }}<span v-html="getMedianPropertyTaxDiff"></span></td>
          </tr>
          <tr>
            <td class="label">Black Homeownership Rate:</td>
            <td class="value">{{ formatHomeownershipBlack }}<span v-html="getHomeownershipBlackDiff"></span></td>
          </tr>
        </table>

        <h4 class="subsection-title">Environment</h4>
        <table class="county-stats-table compact">
          <tr>
            <td class="label">EPA Toxicity Sites:</td>
            <td class="value">{{ formatContamination }}<span v-html="getContaminationDiff"></span></td>
          </tr>
        </table>

        <h4 class="subsection-title">Health</h4>
        <table class="county-stats-table compact">
          <tr>
            <td class="label">Life Expectancy:</td>
            <td class="value">{{ formatLifeExpectancy }}<span v-html="getLifeExpectancyDiff"></span></td>
          </tr>
        </table>
      </div>

      <p v-else>No data available for this county</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { getStateNameFromFips } from '@/config/stateFips'
import type {
  CountyDiversityData,
  ContaminationData,
  CombinedScoreData,
  BLOScoreV2Data,
  EconomicData,
  HousingData,
  EquityData,
} from '@/types/mapTypes'

// National averages
const nationalAverages = ref<any>(null)

interface Props {
  show: boolean
  countyId: string
  countyName: string
  diversityData?: CountyDiversityData
  contaminationData?: ContaminationData | number
  lifeExpectancy?: number
  combinedScore?: CombinedScoreData
  combinedScoreV2?: BLOScoreV2Data
  economicData?: EconomicData
  housingData?: HousingData
  equityData?: EquityData
}

const props = defineProps<Props>()

defineEmits<{
  close: []
}>()

// Load national averages on mount
onMounted(async () => {
  try {
    const response = await fetch('/datasets/precomputed/national_averages.json')
    nationalAverages.value = await response.json()
  } catch (error) {
    console.error('Failed to load national averages:', error)
  }
})

const isDesktopView = computed(() => window.innerWidth > 768)

const stateName = computed(() => {
  const stateFIPS = props.countyId.substring(0, 2)
  return getStateNameFromFips(stateFIPS)
})

const hasData = computed(() => !!props.diversityData)

const formatCombinedScore = computed(() => {
  if (props.combinedScore?.combinedScore != null) {
    return `${props.combinedScore.combinedScore.toFixed(2)} of 5.0`
  }
  return '?'
})

const formatRank = computed(() => {
  if (props.combinedScore?.rankScore != null) {
    return `${props.combinedScore.rankScore} of 3244`
  }
  return '?'
})

const formatPopulation = computed(() => {
  if (props.diversityData?.totalPopulation != null) {
    return props.diversityData.totalPopulation.toLocaleString()
  }
  return '?'
})

const formatPercentBlack = computed(() => {
  if (props.diversityData?.pct_Black != null) {
    return `${props.diversityData.pct_Black.toFixed(2)}%`
  }
  return '?'
})

const formatLifeExpectancy = computed(() => {
  if (props.lifeExpectancy != null) {
    return `${props.lifeExpectancy.toFixed(1)} years`
  }
  return '?'
})

const formatDiversityIndex = computed(() => {
  if (props.diversityData?.diversityIndex != null) {
    return `${props.diversityData.diversityIndex.toFixed(4)} of 1`
  }
  return '?'
})

const formatContamination = computed(() => {
  const total = typeof props.contaminationData === 'number'
    ? props.contaminationData
    : props.contaminationData?.total

  return total != null ? total : '?'
})

// BLO v2.0 computed properties
const formatBLOScoreV2 = computed(() => {
  if (props.combinedScoreV2?.blo_score_v2 != null) {
    return `${props.combinedScoreV2.blo_score_v2.toFixed(2)} of 5.0`
  }
  return null
})

const hasBLOV2Data = computed(() => !!props.combinedScoreV2)

const formatAvgWeeklyWage = computed(() => {
  if (props.economicData?.avg_weekly_wage != null) {
    return `$${props.economicData.avg_weekly_wage.toLocaleString()}`
  }
  return '?'
})

const formatMedianIncomeBlack = computed(() => {
  if (props.economicData?.median_income_black != null) {
    return `$${props.economicData.median_income_black.toLocaleString()}`
  }
  return '?'
})

const formatMedianHomeValue = computed(() => {
  if (props.housingData?.median_home_value != null) {
    return `$${props.housingData.median_home_value.toLocaleString()}`
  }
  return '?'
})

const formatMedianPropertyTax = computed(() => {
  if (props.housingData?.median_property_tax != null) {
    return `$${props.housingData.median_property_tax.toLocaleString()}`
  }
  return '?'
})

const formatHomeownershipBlack = computed(() => {
  if (props.housingData?.homeownership_rate_black != null) {
    return `${props.housingData.homeownership_rate_black.toFixed(1)}%`
  }
  return '?'
})

const formatPovertyRateBlack = computed(() => {
  if (props.equityData?.poverty_rate_black != null) {
    return `${props.equityData.poverty_rate_black.toFixed(1)}%`
  }
  return '?'
})

const formatBlackProgressIndex = computed(() => {
  if (props.equityData?.black_progress_index != null) {
    return props.equityData.black_progress_index.toFixed(2)
  }
  return '?'
})

// Helper to calculate difference from national average
// isInverted: true for metrics where LOWER is better (poverty, contamination, etc.)
const getDiffFromAverage = (value: number | null | undefined, avgKey: string, isInverted: boolean = false) => {
  if (!nationalAverages.value || value == null) return ''

  const avg = nationalAverages.value[avgKey]
  if (avg == null) return ''

  const diff = value - avg
  const isPositive = isInverted ? diff < 0 : diff > 0
  const color = isPositive ? '#00aa00' : '#dd0000'

  // Calculate intensity based on percentage difference from average
  const pctDiff = Math.abs(diff / avg)
  const opacity = Math.min(0.4 + (pctDiff * 1.5), 1.0) // 0.4 to 1.0 opacity

  const sign = diff > 0 ? '+' : ''
  const formattedDiff = Math.abs(diff) > 100
    ? `${sign}${diff.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : `${sign}${diff.toFixed(2)}`

  return `<span style="color: ${color}; opacity: ${opacity}; margin-left: 8px; font-weight: 600; font-size: 13px;">${formattedDiff} from avg</span>`
}

// Specific diff formatters for each metric type
const getBLOScoreDiff = computed(() => {
  if (props.combinedScoreV2?.blo_score_v2 != null) {
    return getDiffFromAverage(props.combinedScoreV2.blo_score_v2, 'blo_score_v2', false)
  }
  return ''
})

const getPopulationDiff = computed(() => {
  if (props.diversityData?.totalPopulation != null) {
    return getDiffFromAverage(props.diversityData.totalPopulation, 'total_population', false)
  }
  return ''
})

const getPctBlackDiff = computed(() => {
  if (props.diversityData?.pct_Black != null) {
    return getDiffFromAverage(props.diversityData.pct_Black, 'pct_black', false)
  }
  return ''
})

const getDiversityIndexDiff = computed(() => {
  if (props.diversityData?.diversityIndex != null) {
    return getDiffFromAverage(props.diversityData.diversityIndex, 'diversity_index', false)
  }
  return ''
})

const getLifeExpectancyDiff = computed(() => {
  if (props.lifeExpectancy != null) {
    return getDiffFromAverage(props.lifeExpectancy, 'life_expectancy', false)
  }
  return ''
})

const getContaminationDiff = computed(() => {
  const total = typeof props.contaminationData === 'number'
    ? props.contaminationData
    : props.contaminationData?.total

  if (total != null) {
    return getDiffFromAverage(total, 'contamination', true) // Lower is better
  }
  return ''
})

const getAvgWeeklyWageDiff = computed(() => {
  if (props.economicData?.avg_weekly_wage != null) {
    return getDiffFromAverage(props.economicData.avg_weekly_wage, 'avg_weekly_wage', false)
  }
  return ''
})

const getMedianIncomeBlackDiff = computed(() => {
  if (props.economicData?.median_income_black != null) {
    return getDiffFromAverage(props.economicData.median_income_black, 'median_income_black', false)
  }
  return ''
})

const getMedianHomeValueDiff = computed(() => {
  if (props.housingData?.median_home_value != null) {
    return getDiffFromAverage(props.housingData.median_home_value, 'median_home_value', true) // Lower is better for affordability
  }
  return ''
})

const getMedianPropertyTaxDiff = computed(() => {
  if (props.housingData?.median_property_tax != null) {
    return getDiffFromAverage(props.housingData.median_property_tax, 'median_property_tax', true) // Lower is better
  }
  return ''
})

const getHomeownershipBlackDiff = computed(() => {
  if (props.housingData?.homeownership_rate_black != null) {
    return getDiffFromAverage(props.housingData.homeownership_rate_black, 'homeownership_rate_black', false)
  }
  return ''
})

const getPovertyRateBlackDiff = computed(() => {
  if (props.equityData?.poverty_rate_black != null) {
    return getDiffFromAverage(props.equityData.poverty_rate_black, 'poverty_rate_black', true) // Lower is better
  }
  return ''
})

const getBlackProgressIndexDiff = computed(() => {
  if (props.equityData?.black_progress_index != null) {
    return getDiffFromAverage(props.equityData.black_progress_index, 'black_progress_index', false)
  }
  return ''
})
</script>

<style scoped>
#detailed-popup {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: white;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  z-index: 1000;
  max-width: 500px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
}

#detailed-popup.desktop-view {
  max-width: 600px;
}

.detailed-popup-close {
  position: absolute;
  top: 10px;
  right: 10px;
  background: none;
  border: none;
  font-size: 30px;
  cursor: pointer;
  color: #666;
  line-height: 1;
  padding: 0;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.detailed-popup-close:hover {
  color: #000;
}

.detailed-popup-close:focus {
  outline: 2px solid #4a90e2;
  outline-offset: 2px;
  border-radius: 4px;
}

@media (max-width: 768px) {
  #detailed-popup {
    width: 90% !important;
    max-width: none !important;
    max-height: 85vh !important;
  }

  .detailed-popup-content h2 {
    font-size: 20px;
    padding-right: 40px;
  }
}

.detailed-popup-content {
  margin-top: 10px;
}

.detailed-popup-content h2 {
  margin-top: 0;
  color: #333;
  font-size: 24px;
  margin-bottom: 20px;
}

.county-stats-table {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0;
}

.county-stats-table tr {
  border-bottom: 1px solid #e0e0e0;
}

.county-stats-table td {
  padding: 8px 10px;
  line-height: 1.4;
}

.county-stats-table td.label {
  font-weight: 600;
  color: #555;
  width: 50%;
  text-align: left;
}

.county-stats-table td.value {
  color: #333;
  text-align: right;
  width: 50%;
}

.county-stats-table.compact tr {
  border-bottom: 1px solid #f0f0f0;
}

.county-stats-table.compact td {
  padding: 6px 10px;
  font-size: 14px;
}

.blo-v2-section,
.legacy-section {
  margin-top: 10px;
}

.score-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 20px;
  padding: 12px;
  background: linear-gradient(135deg, #f0f4f0 0%, #e8ded0 100%);
  border-radius: 6px;
  border-left: 4px solid #6b8e23;
}

.section-title {
  color: #2c3e50;
  font-size: 18px;
  margin: 15px 0 10px 0;
  border-bottom: 2px solid #3498db;
  padding-bottom: 5px;
}

.section-title.inline {
  margin: 0;
  border-bottom: none;
  padding-bottom: 0;
  font-size: 18px;
  font-weight: 600;
}

.score-value {
  font-size: 22px;
  font-weight: bold;
  color: #2d5016;
}

.subsection-title {
  color: #34495e;
  font-size: 14px;
  font-weight: 600;
  margin: 12px 0 6px 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
</style>
