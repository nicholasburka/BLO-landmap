import { describe, it, expect } from 'vitest'
import { ref, reactive, isReactive } from 'vue'
import { useColorCalculation } from '../useColorCalculation'
import type {
  DiversityData,
  LifeExpectancyDataMap,
  ContaminationDataMap,
  CombinedScoresDataMap,
} from '@/types/mapTypes'

/**
 * P5-87. `preCalculateColors` used to write ~3,200 counties × 8 colours into a
 * deeply reactive ref (3,200 proxies, 3,200 trigger()s) and derive its ranges
 * with `Math.max(...bigArray)`. It now fills a plain frozen object behind a
 * shallowRef and walks the data with loops.
 *
 * The colours themselves must not move a single digit. Every expectation below
 * was captured from the pre-P5-87 implementation against this fixture, then
 * pasted in — so a refactor that changes any blend, any alpha, or any rounding
 * fails here.
 */

const fixture = () => {
  const diversityData = ref<DiversityData>({
    // A middling county: half the max diversity, some Black population.
    '01001': { diversityIndex: 0.5, pct_Black: 20, totalPopulation: 1000 } as never,
    // Zero Black population and the best life expectancy in the set.
    '01003': { diversityIndex: 0.25, pct_Black: 0, totalPopulation: 2000 } as never,
    // Missing everything — the "no data" alpha-0 path, and no combined score.
    '02013': { diversityIndex: null, pct_Black: null, totalPopulation: 30 } as never,
    // The maximum of every range.
    '06037': { diversityIndex: 1, pct_Black: 100, totalPopulation: 9 } as never,
  })
  const lifeExpectancyData = ref<LifeExpectancyDataMap>({
    '01001': { lifeExpectancy: 75.3, standardError: 1.8 },
    '01003': { lifeExpectancy: 80.1, standardError: 1.1 },
    '06037': { lifeExpectancy: 70, standardError: 2 },
  })
  // Both shapes the counts file has ever used: an object with a total, and a
  // bare number.
  const countyContaminationCounts = reactive<ContaminationDataMap>({
    '01001': { total: 15, layers: {} } as never,
    '01003': 4 as never,
    '06037': { total: 60, layers: {} } as never,
  })
  const combinedScoresData = ref<CombinedScoresDataMap>({
    '01001': { combinedScore: 4.3333 } as never,
    '01003': { combinedScore: 2 } as never,
    '06037': { combinedScore: 1 } as never,
  })
  return { diversityData, lifeExpectancyData, countyContaminationCounts, combinedScoresData }
}

const build = () => {
  const f = fixture()
  const calc = useColorCalculation(
    f.diversityData,
    f.lifeExpectancyData,
    f.countyContaminationCounts,
    f.combinedScoresData,
  )
  calc.preCalculateColors()
  return calc
}

/** Captured from the implementation this ticket replaced. */
const EXPECTED = {
  '01001': {
    geoID: '01001',
    diversityColor: [128, 0, 128, 0.5],
    blackPctColor: [139, 69, 19, 0.2],
    contaminationColor: [255, 0, 0, 0.25],
    lifeExpectancyColor: [0, 128, 0, 0.5247524752475248],
    blendedColors: {
      diversityAndContamination: [127.75, 0, 64, 0.5],
      blackPctAndContamination: [91.55, 13.8, 3.8000000000000003, 0.25],
    },
    combinedScoreColor: [0, 255, 0, 0.7],
  },
  '01003': {
    geoID: '01003',
    diversityColor: [128, 0, 128, 0.25],
    blackPctColor: [139, 69, 19, 0],
    contaminationColor: [255, 0, 0, 0.06666666666666667],
    lifeExpectancyColor: [0, 128, 0, 1],
    blendedColors: {
      diversityAndContamination: [49, 0, 32, 0.25],
      blackPctAndContamination: [17, 0, 0, 0.06666666666666667],
    },
    combinedScoreColor: [178, 255, 0, 0.7],
  },
  '02013': {
    geoID: '02013',
    diversityColor: [0, 0, 0, 0],
    blackPctColor: [0, 0, 0, 0],
    contaminationColor: [255, 0, 0, 0],
    lifeExpectancyColor: [0, 0, 0, 0],
    blendedColors: {
      diversityAndContamination: [0, 0, 0, 0],
      blackPctAndContamination: [0, 0, 0, 0],
    },
    combinedScoreColor: [255, 255, 0, 0.7],
  },
  '06037': {
    geoID: '06037',
    diversityColor: [128, 0, 128, 1],
    blackPctColor: [139, 69, 19, 1],
    contaminationColor: [255, 0, 0, 1],
    lifeExpectancyColor: [0, 128, 0, 0],
    blendedColors: {
      diversityAndContamination: [255, 0, 128, 1],
      blackPctAndContamination: [255, 69, 19, 1],
    },
    combinedScoreColor: [255, 255, 0, 0.7],
  },
}

describe('useColorCalculation — precomputed county colours (P5-87)', () => {
  it('produces the same colours as the implementation it replaced', () => {
    const calc = build()
    expect(calc.preCalculatedColors.value).toEqual(EXPECTED)
    expect(calc.colorCalculationComplete.value).toBe(true)
  })

  it('serves those colours through getColorForLayer, per layer id', () => {
    const calc = build()
    expect(calc.getColorForLayer('diversity_index', '01001')).toEqual([128, 0, 128, 0.5])
    expect(calc.getColorForLayer('pct_Black', '01001')).toEqual([139, 69, 19, 0.2])
    expect(calc.getColorForLayer('contamination', '01003')).toEqual([255, 0, 0, 0.06666666666666667])
    expect(calc.getColorForLayer('life_expectancy', '01003')).toEqual([0, 128, 0, 1])
    expect(calc.getColorForLayer('combined_scores', '01003')).toEqual([178, 255, 0, 0.7])
    expect(calc.getColorForLayer('diversity_contamination_blend', '06037')).toEqual([255, 0, 128, 1])
    expect(calc.getColorForLayer('black_pct_contamination_blend', '06037')).toEqual([255, 69, 19, 1])
    expect(calc.getColorForLayer('nope', '01001')).toBeNull()
    expect(calc.getColorForLayer('diversity_index', '99999')).toBeNull()
  })

  it('keeps the colour table out of the reactivity system', () => {
    const calc = build()
    // A deep reactive ref here cost one Proxy and one trigger() per county.
    expect(isReactive(calc.preCalculatedColors.value)).toBe(false)
    expect(Object.isFrozen(calc.preCalculatedColors.value)).toBe(true)
    expect(isReactive(calc.preCalculatedColors.value['01001'])).toBe(false)
  })

  it('survives empty data without spreading an empty array into Math.max', () => {
    const calc = useColorCalculation(
      ref({}),
      ref({}),
      reactive({}),
      ref({}),
    )
    calc.preCalculateColors()
    expect(calc.preCalculatedColors.value).toEqual({})
    expect(calc.colorCalculationComplete.value).toBe(true)
  })

  it('handles a county set far larger than the argument limit of Math.max', () => {
    // 3,200 counties spread into Math.max is already within sight of the
    // engine's argument cap; the loop form has no cap at all.
    const COUNTIES = 150_000
    const many: DiversityData = {}
    const lifeExp: LifeExpectancyDataMap = {}
    for (let i = 0; i < COUNTIES; i++) {
      const id = String(i).padStart(5, '0')
      many[id] = { diversityIndex: (i % 100) / 100, pct_Black: i % 101 } as never
      lifeExp[id] = { lifeExpectancy: 60 + (i % 40), standardError: 1 }
    }
    // `Math.max(...values)` blows the argument list somewhere in this range —
    // exactly where depends on the engine's stack, which is the point: the
    // loop form has no such ceiling to be near.
    const calc = useColorCalculation(ref(many), ref(lifeExp), reactive({}), ref({}))
    expect(() => calc.preCalculateColors()).not.toThrow()
    expect(Object.keys(calc.preCalculatedColors.value).length).toBe(COUNTIES)
  })

  it('exposes the numeric helpers unchanged', () => {
    const calc = build()
    expect(calc.normalizeValue(5, 0, 10)).toBe(0.5)
    expect(calc.normalizeValue(5, 5, 5)).toBe(0)
    expect(calc.blendColors([255, 0, 0], 1, [0, 255, 0], 0.5)).toEqual([255, 127.5, 0, 1])
    expect(calc.interpolateColors([0, 0, 0], [100, 200, 40], 0.5)).toEqual([50, 100, 20, 0.7])
  })
})
