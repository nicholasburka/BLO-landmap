import { ref, type Ref, reactive } from 'vue'
import Papa from 'papaparse'
import { DATA_PATHS, debugLog } from '@/config/constants'
import type {
  DiversityData,
  LifeExpectancyDataMap,
  ContaminationDataMap,
  CombinedScoresDataMap,
  BLOScoreV2DataMap,
  EconomicDataMap,
  HousingDataMap,
  EquityDataMap,
  CountiesGeoJSON,
} from '@/types/mapTypes'

export function useMapData() {
  // Data refs
  const countiesData = ref<CountiesGeoJSON | null>(null)
  const diversityData = ref<DiversityData>({})
  const lifeExpectancyData = ref<LifeExpectancyDataMap>({})
  const countyContaminationCounts = reactive<ContaminationDataMap>({})
  const combinedScoresData = ref<CombinedScoresDataMap>({})
  const combinedScoresV2Data = ref<BLOScoreV2DataMap>({})
  const economicData = ref<EconomicDataMap>({})
  const housingData = ref<HousingDataMap>({})
  const equityData = ref<EquityDataMap>({})

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
   * Load BLO v2.0 combined scores data
   */
  const loadCombinedScoresV2 = async (): Promise<void> => {
    try {
      const response = await fetch(DATA_PATHS.COMBINED_SCORES_V2)
      combinedScoresV2Data.value = await response.json()

      debugLog('BLO v2.0 scores loaded:', {
        totalCounties: Object.keys(combinedScoresV2Data.value).length,
      })
    } catch (error) {
      console.error('Error loading BLO v2.0 scores:', error)
      throw error
    }
  }

  /**
   * Load economic data from CSV files
   */
  const loadEconomicData = async (): Promise<void> => {
    try {
      // Load average weekly wages
      const wagesResponse = await fetch(DATA_PATHS.AVG_WEEKLY_WAGES)
      const wagesText = await wagesResponse.text()
      const wagesResults = Papa.parse(wagesText, {
        header: true,
        dynamicTyping: true,
      })

      // Load median income by race
      const incomeResponse = await fetch(DATA_PATHS.MEDIAN_INCOME_BY_RACE)
      const incomeText = await incomeResponse.text()
      const incomeResults = Papa.parse(incomeText, {
        header: true,
        dynamicTyping: true,
      })

      // Merge data by GEOID
      wagesResults.data.forEach((row: any) => {
        if (!row.GEOID) return
        const geoID = row.GEOID.toString().padStart(5, '0')

        economicData.value[geoID] = {
          GEOID: geoID,
          county_name: row.county_name,
          state_name: row.state_name,
          year: row.year,
          avg_weekly_wage: row.avg_weekly_wage,
        }
      })

      incomeResults.data.forEach((row: any) => {
        if (!row.GEOID) return
        const geoID = row.GEOID.toString().padStart(5, '0')

        if (economicData.value[geoID]) {
          economicData.value[geoID].median_income_black = row.median_income_black
        } else {
          economicData.value[geoID] = {
            GEOID: geoID,
            county_name: row.county_name,
            state_name: row.state_name,
            year: row.year,
            avg_weekly_wage: 0,
            median_income_black: row.median_income_black,
          }
        }
      })

      debugLog('Economic data loaded:', {
        totalCounties: Object.keys(economicData.value).length,
      })
    } catch (error) {
      console.error('Error loading economic data:', error)
      throw error
    }
  }

  /**
   * Load housing data from CSV files
   */
  const loadHousingData = async (): Promise<void> => {
    try {
      // Load median home value
      const homeValueResponse = await fetch(DATA_PATHS.MEDIAN_HOME_VALUE)
      const homeValueText = await homeValueResponse.text()
      const homeValueResults = Papa.parse(homeValueText, {
        header: true,
        dynamicTyping: true,
      })

      // Load median property tax
      const propertyTaxResponse = await fetch(DATA_PATHS.MEDIAN_PROPERTY_TAX)
      const propertyTaxText = await propertyTaxResponse.text()
      const propertyTaxResults = Papa.parse(propertyTaxText, {
        header: true,
        dynamicTyping: true,
      })

      // Load homeownership by race
      const homeownershipResponse = await fetch(DATA_PATHS.HOMEOWNERSHIP_BY_RACE)
      const homeownershipText = await homeownershipResponse.text()
      const homeownershipResults = Papa.parse(homeownershipText, {
        header: true,
        dynamicTyping: true,
      })

      // Merge data by GEOID
      homeValueResults.data.forEach((row: any) => {
        if (!row.GEOID) return
        const geoID = row.GEOID.toString().padStart(5, '0')

        housingData.value[geoID] = {
          GEOID: geoID,
          county_name: row.county_name,
          state_name: row.state_name,
          year: row.year,
          median_home_value: row.median_home_value_with_mortgage,
        }
      })

      propertyTaxResults.data.forEach((row: any) => {
        if (!row.GEOID) return
        const geoID = row.GEOID.toString().padStart(5, '0')

        if (housingData.value[geoID]) {
          housingData.value[geoID].median_property_tax =
            row.median_property_tax_with_mortgage
        } else {
          housingData.value[geoID] = {
            GEOID: geoID,
            county_name: row.county_name,
            state_name: row.state_name,
            year: row.year,
            median_property_tax: row.median_property_tax_with_mortgage,
          }
        }
      })

      homeownershipResults.data.forEach((row: any) => {
        if (!row.GEOID) return
        const geoID = row.GEOID.toString().padStart(5, '0')

        if (housingData.value[geoID]) {
          housingData.value[geoID].homeownership_rate_black =
            row.homeownership_rate_black
        } else {
          housingData.value[geoID] = {
            GEOID: geoID,
            county_name: row.county_name,
            state_name: row.state_name,
            year: row.year,
            homeownership_rate_black: row.homeownership_rate_black,
          }
        }
      })

      debugLog('Housing data loaded:', {
        totalCounties: Object.keys(housingData.value).length,
      })
    } catch (error) {
      console.error('Error loading housing data:', error)
      throw error
    }
  }

  /**
   * Load equity data from CSV files
   */
  const loadEquityData = async (): Promise<void> => {
    try {
      // Load poverty by race
      const povertyResponse = await fetch(DATA_PATHS.POVERTY_BY_RACE)
      const povertyText = await povertyResponse.text()
      const povertyResults = Papa.parse(povertyText, {
        header: true,
        dynamicTyping: true,
      })

      // Load Black Progress Index
      const blackProgressResponse = await fetch(DATA_PATHS.BLACK_PROGRESS_INDEX)
      const blackProgressText = await blackProgressResponse.text()
      const blackProgressResults = Papa.parse(blackProgressText, {
        header: true,
        dynamicTyping: true,
      })

      // Merge data by GEOID
      povertyResults.data.forEach((row: any) => {
        if (!row.GEOID) return
        const geoID = row.GEOID.toString().padStart(5, '0')

        equityData.value[geoID] = {
          GEOID: geoID,
          county_name: row.county_name,
          state_name: row.state_name,
          year: row.year,
          poverty_rate_black: row.poverty_rate_black,
        }
      })

      blackProgressResults.data.forEach((row: any) => {
        if (!row.GEOID) return
        const geoID = row.GEOID.toString().padStart(5, '0')

        if (equityData.value[geoID]) {
          equityData.value[geoID].black_progress_index = row.black_progress_index
        } else {
          equityData.value[geoID] = {
            GEOID: geoID,
            county_name: row.county_name,
            state: row.state,
            black_progress_index: row.black_progress_index,
          }
        }
      })

      debugLog('Equity data loaded:', {
        totalCounties: Object.keys(equityData.value).length,
      })
    } catch (error) {
      console.error('Error loading equity data:', error)
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
      await loadCombinedScoresV2()
      await loadEconomicData()
      await loadHousingData()
      await loadEquityData()

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
    combinedScoresV2Data,
    economicData,
    housingData,
    equityData,

    // Loading functions
    loadCountiesGeoJSON,
    loadContaminationData,
    loadDiversityData,
    loadLifeExpectancyData,
    loadCombinedScores,
    loadCombinedScoresV2,
    loadEconomicData,
    loadHousingData,
    loadEquityData,
    loadAllCountyData,
  }
}
