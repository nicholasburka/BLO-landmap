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

      <table v-if="hasData" class="county-stats-table">
        <tr>
          <td class="label">BLO Liveability Score:</td>
          <td class="value">{{ formatCombinedScore }}</td>
        </tr>
        <tr>
          <td class="label">Rank:</td>
          <td class="value">{{ formatRank }}</td>
        </tr>
        <tr>
          <td class="label">Total Population:</td>
          <td class="value">{{ formatPopulation }}</td>
        </tr>
        <tr>
          <td class="label">Percent Black:</td>
          <td class="value">{{ formatPercentBlack }}</td>
        </tr>
        <tr>
          <td class="label">Life Expectancy:</td>
          <td class="value">{{ formatLifeExpectancy }}</td>
        </tr>
        <tr>
          <td class="label">Diversity Index:</td>
          <td class="value">{{ formatDiversityIndex }}</td>
        </tr>
        <tr>
          <td class="label">EPA Sites of Land Toxicity:</td>
          <td class="value">{{ formatContamination }}</td>
        </tr>
      </table>

      <p v-else>No data available</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { getStateNameFromFips } from '@/config/stateFips'
import type {
  CountyDiversityData,
  ContaminationData,
  CombinedScoreData,
} from '@/types/mapTypes'

interface Props {
  show: boolean
  countyId: string
  countyName: string
  diversityData?: CountyDiversityData
  contaminationData?: ContaminationData | number
  lifeExpectancy?: number
  combinedScore?: CombinedScoreData
}

const props = defineProps<Props>()

defineEmits<{
  close: []
}>()

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
</style>
