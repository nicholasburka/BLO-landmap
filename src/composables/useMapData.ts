import { ref, type Ref, reactive } from 'vue'
import Papa from 'papaparse'
import { DATA_PATHS, debugLog } from '@/config/constants'
import type {
  DiversityData,
  LifeExpectancyDataMap,
  ContaminationDataMap,
  CombinedScoresDataMap,
  CountiesGeoJSON,
} from '@/types/mapTypes'

export function useMapData() {
  // Data refs
  const countiesData = ref<CountiesGeoJSON | null>(null)
  const diversityData = ref<DiversityData>({})
  const lifeExpectancyData = ref<LifeExpectancyDataMap>({})
  const countyContaminationCounts = reactive<ContaminationDataMap>({})
  const combinedScoresData = ref<CombinedScoresDataMap>({})

  /**
   * Load counties GeoJSON data
   */
  const loadCountiesGeoJSON = async (): Promise<void> => {
    try {
      const response = await fetch(DATA_PATHS.COUNTIES)
      countiesData.value = await response.json()

      debugLog('Counties data loaded:', {
        features: countiesData.value?.features?.length,
        sampleFeature: countiesData.value?.features?.[0],
      })
    } catch (error) {
      console.error('Error loading counties GeoJSON:', error)
      throw error
    }
  }

  /**
   * Load contamination counts data
   */
  const loadContaminationData = async (): Promise<void> => {
    try {
      const response = await fetch(DATA_PATHS.CONTAMINATION_COUNTS)
      const data = await response.json()
      Object.assign(countyContaminationCounts, data)

      debugLog('Contamination data loaded:', {
        totalCounties: Object.keys(countyContaminationCounts).length,
      })
    } catch (error) {
      console.error('Error loading contamination data:', error)
      throw error
    }
  }

  /**
   * Load diversity data from CSV
   */
  const loadDiversityData = async (): Promise<void> => {
    try {
      const response = await fetch(DATA_PATHS.DIVERSITY_DATA)
      const csvText = await response.text()

      const results = Papa.parse(csvText, {
        header: true,
        dynamicTyping: true,
      })

      debugLog('Diversity data parsing:', {
        totalRows: results.data.length,
        sampleRows: results.data.slice(0, 5),
        sampleGEOIDs: results.data.slice(0, 5).map((row: any) => row.GEOID),
        errors: results.errors,
      })

      results.data.forEach((row: any) => {
        if (!row.GEOID) return

        // Ensure GEOID is properly formatted (5 digits with leading zeros)
        const geoID = row.GEOID.toString().padStart(5, '0')

        diversityData.value[geoID] = {
          diversityIndex: row.diversity_index,
          totalPopulation: row.total_population,
          pct_nhBlack: row.pct_nhBlack,
          pct_Black: row.pct_Black,
          total_Black: row.total_Black,
          nhWhite: row.NH_White,
          nhBlack: row.NH_Black,
          nhAmIndian: row.NH_AmIndian,
          nhAsian: row.NH_Asian,
          nhPacIslander: row.NH_PacIslander,
          nhTwoOrMore: row.NH_TwoOrMore,
          hispanic: row.Hispanic,
          countyName: row.CTYNAME,
          stateName: row.STNAME,
        }
      })

      debugLog('Diversity data loaded:', {
        totalCounties: Object.keys(diversityData.value).length,
        sampleKeys: Object.keys(diversityData.value).slice(0, 5),
        sampleData: Object.entries(diversityData.value).slice(0, 2),
      })
    } catch (error) {
      console.error('Error loading diversity data:', error)
      throw error
    }
  }

  /**
   * Load life expectancy data from CSV
   */
  const loadLifeExpectancyData = async (): Promise<void> => {
    try {
      const response = await fetch(DATA_PATHS.LIFE_EXPECTANCY)
      const csvText = await response.text()

      const results = Papa.parse(csvText, {
        header: true,
        dynamicTyping: true,
      })

      debugLog('Life expectancy raw data sample:', {
        headers: results.meta.fields,
        firstFewRows: results.data.slice(0, 10).map((row: any) => ({
          rawGEOID: row.GEOID,
          typeofGEOID: typeof row.GEOID,
          state: row.STATE2KX,
          county: row.CNTY2KX,
          lifeExp: row['e(0)'],
        })),
      })

      results.data.forEach((row: any) => {
        if (!row.GEOID) return

        // Convert state and county codes to proper GEOID format
        let geoID: string
        if (row.STATE2KX && row.CNTY2KX) {
          const stateCode = row.STATE2KX.toString().padStart(2, '0')
          const countyCode = row.CNTY2KX.toString().padStart(3, '0')
          geoID = stateCode + countyCode
        } else {
          geoID = row.GEOID.toString().padStart(5, '0')
        }

        lifeExpectancyData.value[geoID] = {
          lifeExpectancy: row['e(0)'],
          standardError: row['se(e(0))'],
        }
      })

      debugLog('Life expectancy data loaded:', {
        totalCounties: Object.keys(lifeExpectancyData.value).length,
      })
    } catch (error) {
      console.error('Error loading life expectancy data:', error)
      throw error
    }
  }

  /**
   * Load combined scores data
   */
  const loadCombinedScores = async (): Promise<void> => {
    try {
      const response = await fetch(DATA_PATHS.COMBINED_SCORES)
      combinedScoresData.value = await response.json()

      debugLog('Combined scores loaded:', {
        totalCounties: Object.keys(combinedScoresData.value).length,
      })
    } catch (error) {
      console.error('Error loading combined scores:', error)
      throw error
    }
  }

  /**
   * Load all county data
   */
  const loadAllCountyData = async (): Promise<void> => {
    try {
      await loadCountiesGeoJSON()
      await loadContaminationData()
      await loadDiversityData()
      await loadLifeExpectancyData()
      await loadCombinedScores()

      debugLog('All data loaded successfully')
    } catch (error) {
      console.error('Error loading counties data:', error)
      throw error
    }
  }

  return {
    // Data refs
    countiesData,
    diversityData,
    lifeExpectancyData,
    countyContaminationCounts,
    combinedScoresData,

    // Loading functions
    loadCountiesGeoJSON,
    loadContaminationData,
    loadDiversityData,
    loadLifeExpectancyData,
    loadCombinedScores,
    loadAllCountyData,
  }
}
