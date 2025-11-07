<template>
  <div v-if="activeLayers.length > 0" class="color-legend">
    <div class="legend-header">Color Key</div>
    <div v-for="layer in activeLayers" :key="layer.id" class="legend-item">
      <div class="legend-label">{{ layer.name }}</div>
      <div class="legend-gradient" :style="{ background: layer.gradient }"></div>
      <div class="legend-values">
        <span class="legend-low">{{ layer.lowLabel }}</span>
        <span class="legend-high">{{ layer.highLabel }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface LayerLegend {
  id: string
  name: string
  gradient: string
  lowLabel: string
  highLabel: string
}

interface Props {
  selectedDemographicLayers: string[]
  selectedEconomicLayers: string[]
  selectedHousingLayers: string[]
  selectedEquityLayers: string[]
  showContaminationChoropleth: boolean
}

const props = defineProps<Props>()

// Define legend information for each layer
const layerLegends: Record<string, LayerLegend> = {
  combined_scores_v2: {
    id: 'combined_scores_v2',
    name: 'BLO Liveability Index',
    gradient: 'linear-gradient(to right, rgb(255, 245, 100), rgb(0, 100, 0))',
    lowLabel: 'Lower',
    highLabel: 'Higher',
  },
  diversity_index: {
    id: 'diversity_index',
    name: 'Diversity Index',
    gradient: 'linear-gradient(to right, rgb(200, 0, 200), rgb(100, 0, 150))',
    lowLabel: 'Less Diverse',
    highLabel: 'More Diverse',
  },
  pct_Black: {
    id: 'pct_Black',
    name: 'Percent Black',
    gradient: 'linear-gradient(to right, rgb(139, 69, 19, 0.3), rgb(69, 35, 10, 0.95))',
    lowLabel: 'Lower %',
    highLabel: 'Higher %',
  },
  life_expectancy: {
    id: 'life_expectancy',
    name: 'Life Expectancy',
    gradient: 'linear-gradient(to right, rgb(255, 100, 100), rgb(100, 200, 100))',
    lowLabel: 'Lower',
    highLabel: 'Higher',
  },
  avg_weekly_wage: {
    id: 'avg_weekly_wage',
    name: 'Average Weekly Wage',
    gradient: 'linear-gradient(to right, rgb(200, 220, 100), rgb(0, 100, 0))',
    lowLabel: 'Lower',
    highLabel: 'Higher',
  },
  median_income_by_race: {
    id: 'median_income_by_race',
    name: 'Median Income (Black)',
    gradient: 'linear-gradient(to right, rgba(100, 200, 255, 0.3), rgba(0, 50, 150, 0.95))',
    lowLabel: 'Lower',
    highLabel: 'Higher',
  },
  median_home_value: {
    id: 'median_home_value',
    name: 'Median Home Value',
    gradient: 'linear-gradient(to right, rgb(0, 180, 0), rgb(220, 0, 0))',
    lowLabel: 'More Affordable',
    highLabel: 'Less Affordable',
  },
  median_property_tax: {
    id: 'median_property_tax',
    name: 'Median Property Tax',
    gradient: 'linear-gradient(to right, rgb(100, 200, 100), rgb(255, 100, 100))',
    lowLabel: 'Lower',
    highLabel: 'Higher',
  },
  homeownership_by_race: {
    id: 'homeownership_by_race',
    name: 'Black Homeownership Rate',
    gradient: 'linear-gradient(to right, rgb(220, 100, 100), rgb(100, 200, 100))',
    lowLabel: 'Lower',
    highLabel: 'Higher',
  },
  poverty_by_race: {
    id: 'poverty_by_race',
    name: 'Poverty Rate (Black)',
    gradient: 'linear-gradient(to right, rgb(100, 200, 100), rgb(200, 0, 0))',
    lowLabel: 'Lower',
    highLabel: 'Higher',
  },
  black_progress_index: {
    id: 'black_progress_index',
    name: 'Black Progress Index',
    gradient: 'linear-gradient(to right, rgb(220, 100, 100), rgb(100, 200, 100))',
    lowLabel: 'Lower',
    highLabel: 'Higher',
  },
  contamination: {
    id: 'contamination',
    name: 'EPA Contamination Sites',
    gradient: 'linear-gradient(to right, rgba(255, 0, 0, 0), rgba(255, 0, 0, 1))',
    lowLabel: 'Fewer Sites',
    highLabel: 'More Sites',
  },
}

const activeLayers = computed(() => {
  const allSelected = [
    ...props.selectedDemographicLayers,
    ...props.selectedEconomicLayers,
    ...props.selectedHousingLayers,
    ...props.selectedEquityLayers,
  ]

  if (props.showContaminationChoropleth) {
    allSelected.push('contamination')
  }

  // If multiple layers are selected (multi-layer mode), show BLO gradient
  const nonBLOLayers = allSelected.filter(id => id !== 'combined_scores' && id !== 'combined_scores_v2')
  if (nonBLOLayers.length >= 2) {
    return [{
      ...layerLegends.combined_scores_v2,
      name: 'BLO Liveability Sub-Index'
    }]
  }

  // Otherwise show the specific layer legend
  return allSelected
    .filter(id => layerLegends[id])
    .map(id => layerLegends[id])
})
</script>

<style scoped>
.color-legend {
  position: absolute;
  bottom: 30px;
  left: 10px;
  background: white;
  padding: 12px;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  z-index: 5;
  min-width: 200px;
  pointer-events: auto;
}

.legend-header {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 10px;
  color: #2c3e50;
}

.legend-item {
  margin-bottom: 12px;
}

.legend-item:last-child {
  margin-bottom: 0;
}

.legend-label {
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 4px;
  color: #34495e;
}

.legend-gradient {
  height: 12px;
  border-radius: 3px;
  margin-bottom: 4px;
  border: 1px solid rgba(0, 0, 0, 0.1);
}

.legend-values {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #555;
}

.legend-low,
.legend-high {
  font-style: italic;
}

@media (max-width: 768px) {
  .color-legend {
    bottom: 90px;
    left: 10px;
    top: auto;
    min-width: 160px;
    padding: 10px;
  }

  .legend-header {
    font-size: 12px;
    margin-bottom: 8px;
  }

  .legend-label {
    font-size: 11px;
  }

  .legend-gradient {
    height: 10px;
  }

  .legend-values {
    font-size: 9px;
  }
}
</style>
