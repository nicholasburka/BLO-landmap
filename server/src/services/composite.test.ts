import { describe, it, expect } from 'vitest'
import {
  COMPOSITE_BYTES_BUDGET,
  COMPOSITE_DECIMALS,
  COMPOSITE_TERMS_MAX,
  COMPOSITE_TERMS_MIN,
  COMPOSITE_WEIGHT_MAX,
  canonicalTerms,
  compositeMethod,
  compositeRefusal,
  computeComposite,
  readCompositeTerms,
  sameTerms,
  type CompositeTermValues,
} from './composite.js'

/** A term over a handful of counties, spelled the way the service hands it in. */
function term(
  layer: string,
  weight: number,
  direction: 'higher_better' | 'lower_better',
  values: Record<string, number>,
): CompositeTermValues {
  return { layer, weight, direction, values }
}

describe('computeComposite — the Lens, generalised', () => {
  it('normalises each term over its own counties and weights the result onto 0-100', () => {
    // One term, three counties, 0/50/100 of its own span.
    const result = computeComposite([term('a', 1, 'higher_better', { '01001': 0, '01003': 5, '01005': 10 })])
    expect(result.values).toEqual({ '01001': 0, '01003': 50, '01005': 100 })
    expect(result.scales).toEqual([
      { layer: 'a', weight: 1, direction: 'higher_better', min: 0, max: 10, counties: 3, scale: 'observed' },
    ])
  })

  it('inverts a lower_better term rather than the score', () => {
    const result = computeComposite([term('a', 1, 'lower_better', { '01001': 0, '01003': 5, '01005': 10 })])
    expect(result.values).toEqual({ '01001': 100, '01003': 50, '01005': 0 })
  })

  it('weights terms against each other', () => {
    // 3:1 — the first term's county wins on the heavier layer.
    const result = computeComposite([
      term('a', 3, 'higher_better', { '01001': 10, '01003': 0 }),
      term('b', 1, 'higher_better', { '01001': 0, '01003': 10 }),
    ])
    expect(result.values).toEqual({ '01001': 75, '01003': 25 })
  })

  it('is invariant under a proportional rescaling of every weight', () => {
    const values = { '01001': 10, '01003': 4, '01005': 0 }
    const other = { '01001': 1, '01003': 9, '01005': 3 }
    const small = computeComposite([
      term('a', 2, 'higher_better', values),
      term('b', 1, 'lower_better', other),
    ])
    const large = computeComposite([
      term('a', 8, 'higher_better', values),
      term('b', 4, 'lower_better', other),
    ])
    expect(large.values).toEqual(small.values)
  })

  it('divides by the FULL declared weight, so a county missing a layer scores lower', () => {
    // 01001 carries both layers at the top; 01003 carries only the first, also
    // at the top. Redistributing the missing weight would tie them at 100.
    const result = computeComposite([
      term('a', 1, 'higher_better', { '01001': 10, '01003': 10, '01005': 0 }),
      term('b', 1, 'higher_better', { '01001': 10, '01005': 0 }),
    ])
    expect(result.values['01001']).toBe(100)
    expect(result.values['01003']).toBe(50)
    expect(result.values['01005']).toBe(0)
    expect(result.stats.complete).toBe(2)
    expect(result.stats.partial).toBe(1)
  })

  it('gives a county no term covers no number at all, rather than a zero', () => {
    const result = computeComposite([
      term('a', 1, 'higher_better', { '01001': 1, '01003': 9 }),
      term('b', 1, 'higher_better', { '01001': 1, '01003': 9 }),
    ])
    expect(Object.keys(result.values).sort()).toEqual(['01001', '01003'])
    expect('99999' in result.values).toBe(false)
  })

  it('treats a non-finite value as missing rather than as arithmetic', () => {
    const result = computeComposite([
      term('a', 1, 'higher_better', { '01001': 10, '01003': Number.NaN, '01005': 0 }),
      term('b', 1, 'higher_better', { '01001': 10, '01003': 10, '01005': 0 }),
    ])
    expect(result.values['01003']).toBe(50)
    expect(Number.isFinite(result.values['01001'])).toBe(true)
    expect(result.scales[0].counties).toBe(2)
  })

  it('rounds to a fixed number of decimals, so the same definition prints the same number', () => {
    const result = computeComposite([
      term('a', 1, 'higher_better', { '01001': 1, '01003': 2, '01005': 10 }),
      term('b', 2, 'higher_better', { '01001': 7, '01003': 3, '01005': 10 }),
    ])
    for (const value of Object.values(result.values)) {
      const decimals = (String(value).split('.')[1] ?? '').length
      expect(decimals).toBeLessThanOrEqual(COMPOSITE_DECIMALS)
    }
  })

  it('refuses a term that cannot rank anything instead of scoring it as zero', () => {
    // Every county the same: `normalize` would hand back 0 for all of them,
    // quietly dragging every score down by this term's whole weight share.
    expect(() => computeComposite([term('flat', 1, 'higher_better', { '01001': 4, '01003': 4 })])).toThrow(
      /“flat” has the same value in every county/,
    )
  })

  it('refuses a term no county carries', () => {
    expect(() => computeComposite([term('empty', 1, 'higher_better', {})])).toThrow(
      /“empty” has no county values/,
    )
  })

  it('is order-independent to the last bit, because the terms are sorted first', () => {
    const a = term('aaa', 3, 'higher_better', { '01001': 0.1, '01003': 0.7, '01005': 0.33 })
    const b = term('bbb', 7, 'lower_better', { '01001': 12.5, '01003': 0.25, '01005': 9.1 })
    const c = term('ccc', 2, 'higher_better', { '01001': 5, '01003': 11, '01005': 2 })
    const one = computeComposite([a, b, c])
    const other = computeComposite([c, a, b])
    expect(other.values).toEqual(one.values)
    expect(other.scales.map(s => s.layer)).toEqual(['aaa', 'bbb', 'ccc'])
  })
})

describe('a declared range beats the observed one (P9-4)', () => {
  /**
   * P7-8 scaled every term against its observed min and max. The Lens scales
   * a registry layer against `LAYER_REGISTRY[id].range`, a literal — so the
   * same weights produced two different numbers, and "the index is a working
   * set" would have silently moved published scores.
   *
   * Tracing `calculate_blo_v2_scores.cjs` settled which is right: it computes
   * observed min/max for most terms and declares bounds only where the
   * measure HAS natural ones — percentages 0-100, the diversity index 0-1. So
   * the registry's ranges are not declarations competing with observation,
   * they ARE observation, recorded and tidied. One concept: a range is
   * derived by default and PINNED where someone decided it.
   */
  it('uses a pinned range instead of the observed span', () => {
    // Observed span is 30-55; pinned says a percentage runs 0-100.
    const t: CompositeTermValues = {
      layer: 'pct', weight: 1, direction: 'higher_better',
      values: { '01001': 30, '01003': 55 },
      declaredRange: { min: 0, max: 100 },
    }
    const r = computeComposite([t])
    // Observed scaling would have made these 0 and 100 — a dramatic gradient
    // manufactured from a narrow real range.
    expect(r.values).toEqual({ '01001': 30, '01003': 55 })
    expect(r.scales[0]).toMatchObject({ min: 0, max: 100, scale: 'pinned' })
  })

  it('falls back to the observed span when nothing is pinned', () => {
    const r = computeComposite([term('a', 1, 'higher_better', { '01001': 30, '01003': 55 })])
    expect(r.values).toEqual({ '01001': 0, '01003': 100 })
    expect(r.scales[0]).toMatchObject({ min: 30, max: 55, scale: 'observed' })
  })

  it('clamps a value outside its pinned range rather than scoring past the ends', () => {
    const t: CompositeTermValues = {
      layer: 'pct', weight: 1, direction: 'higher_better',
      values: { '01001': -5, '01003': 150 },
      declaredRange: { min: 0, max: 100 },
    }
    const r = computeComposite([t])
    expect(r.values).toEqual({ '01001': 0, '01003': 100 })
  })

  it('ignores a pinned range that says nothing (min === max)', () => {
    const t: CompositeTermValues = {
      layer: 'flat', weight: 1, direction: 'higher_better',
      values: { '01001': 2, '01003': 8 },
      declaredRange: { min: 5, max: 5 },
    }
    const r = computeComposite([t])
    expect(r.scales[0]).toMatchObject({ scale: 'observed' })
  })
})

describe('a researcher chooses how missing data counts (P9-4)', () => {
  /**
   * Two defensible answers, and the published index and the server had picked
   * different ones without anybody deciding.
   *
   * `calculate_blo_v2_scores.cjs` divides by the weight it HAS, so a county
   * missing life expectancy is scored on the rest. `computeComposite` divided
   * by the full declared weight, so the same county is dragged down as though
   * it had scored zero. Roughly two thirds of US counties are missing at
   * least one of the eleven, so this is not a rounding difference.
   *
   * Neither is wrong. "We know little about this county, so it should not
   * rank top" is a real position; so is "score it on what we have". A
   * researcher comparing the two wants both, so it is a setting.
   */
  // Every term needs real spread (a flat term is refused, and rightly), and
  // `y` is absent from term b — that absence is the whole subject here.
  const partial: CompositeTermValues[] = [
    term('a', 1, 'higher_better', { x: 0, y: 10 }),
    term('b', 1, 'higher_better', { x: 0, z: 10 }),
  ]

  it('penalises a county for what it is missing, when asked to', () => {
    // y tops term a (weight 1 of 2 declared) and has nothing for b.
    expect(computeComposite(partial, { missing: 'penalise' }).values['y']).toBe(50)
  })

  it('scores a county on the data it has, when asked to', () => {
    // Same county, divided by the 1 weight actually available.
    expect(computeComposite(partial, { missing: 'ignore' }).values['y']).toBe(100)
  })

  it('agrees about a county that has everything', () => {
    // x is at the bottom of both terms either way — the rules only differ
    // where something is absent.
    expect(computeComposite(partial, { missing: 'penalise' }).values['x']).toBe(0)
    expect(computeComposite(partial, { missing: 'ignore' }).values['x']).toBe(0)
  })

  it('defaults to penalise, which is what it did before this was a choice', () => {
    expect(computeComposite(partial).values['y']).toBe(50)
  })

  it('records which rule produced the numbers', () => {
    const r = computeComposite(partial, { missing: 'ignore' })
    expect(r.missing).toBe('ignore')
  })
})

describe('a term can be told to observe its own spread (P9-4)', () => {
  /** Contamination is the live case: the published script scaled it against
   *  the observed spread of site counts, while the registry pins 0-500. */
  it('ignores a pinned range when the term says observe', () => {
    const t: CompositeTermValues = {
      layer: 'contamination', weight: 1, direction: 'higher_better',
      values: { '01001': 10, '01003': 20 },
      declaredRange: { min: 0, max: 500 },
      scale: 'observed',
    }
    const r = computeComposite([t, term('b', 1, 'higher_better', { '01001': 1, '01003': 2 })])
    const c = r.scales.find(x => x.layer === 'contamination')!
    expect(c).toMatchObject({ scale: 'observed', min: 10, max: 20 })
  })
})

describe('canonicalTerms / sameTerms — readable field equality', () => {
  it('sorts by layer id, so the same formula typed in another order is the same formula', () => {
    const typed = [
      { layer: 'b', weight: 1, direction: 'higher_better' as const },
      { layer: 'a', weight: 2, direction: 'lower_better' as const },
    ]
    expect(canonicalTerms(typed)).toEqual([
      { layer: 'a', weight: 2, direction: 'lower_better' },
      { layer: 'b', weight: 1, direction: 'higher_better' },
    ])
    expect(sameTerms(typed, canonicalTerms(typed))).toBe(true)
  })

  it('a changed weight, direction or layer is a different formula', () => {
    const base = [
      { layer: 'a', weight: 2, direction: 'higher_better' as const },
      { layer: 'b', weight: 1, direction: 'higher_better' as const },
    ]
    expect(sameTerms(base, [{ ...base[0], weight: 3 }, base[1]])).toBe(false)
    expect(sameTerms(base, [{ ...base[0], direction: 'lower_better' }, base[1]])).toBe(false)
    expect(sameTerms(base, [{ ...base[0], layer: 'c' }, base[1]])).toBe(false)
    expect(sameTerms(base, [base[0]])).toBe(false)
  })
})

describe('a term may declare the span it is scored against (P9-5)', () => {
  /**
   * The published index needs this. Its six unbounded terms were scored
   * against spans the registry does not hold — life expectancy 69-89.5 where
   * the registry pins 65-87 — so "use the layer's range" and "use today's
   * spread" both give the wrong answer. The definition has to be able to say
   * the number.
   *
   * It is also the honest shape for a PUBLISHED index: a span recomputed on
   * every refresh silently moves every historical score, and two vintages
   * stop being comparable.
   */
  it('a range on the term beats the layer\'s own', () => {
    const t: CompositeTermValues = {
      layer: 'life_expectancy', weight: 1, direction: 'higher_better',
      values: { a: 69, b: 89.5 },
      declaredRange: { min: 65, max: 87 },   // what the layer pins
      range: { min: 69, max: 89.5 },          // what THIS index was built on
    }
    const r = computeComposite([t, term('b', 1, 'higher_better', { a: 0, b: 1 })])
    const s = r.scales.find(x => x.layer === 'life_expectancy')!
    expect(s).toMatchObject({ min: 69, max: 89.5, scale: 'pinned' })
  })

  it('reads a range off a definition and refuses a backwards one', () => {
    const ok = readCompositeTerms([
      { layer: 'a', weight: 1, direction: 'higher_better', range: { min: 69, max: 89.5 } },
      { layer: 'b', weight: 1, direction: 'higher_better' },
    ])
    expect('error' in ok).toBe(false)
    if ('error' in ok) return
    expect(ok.terms.find(t => t.layer === 'a')?.range).toEqual({ min: 69, max: 89.5 })

    const bad = readCompositeTerms([
      { layer: 'a', weight: 1, direction: 'higher_better', range: { min: 100, max: 0 } },
      { layer: 'b', weight: 1, direction: 'higher_better' },
    ])
    expect('error' in bad).toBe(true)
  })

  it('keeps it through canonicalTerms, and two spans are two formulas', () => {
    const c = canonicalTerms([
      { layer: 'a', weight: 1, direction: 'higher_better', range: { min: 0, max: 10 } },
      { layer: 'b', weight: 1, direction: 'higher_better' },
    ])
    expect(c.find(t => t.layer === 'a')?.range).toEqual({ min: 0, max: 10 })
    expect(
      sameTerms(
        [{ layer: 'a', weight: 1, direction: 'higher_better', range: { min: 0, max: 10 } }],
        [{ layer: 'a', weight: 1, direction: 'higher_better', range: { min: 0, max: 20 } }],
      ),
    ).toBe(false)
  })
})

describe('the scale choice survives being saved (P9-4)', () => {
  it('canonicalTerms keeps it — a definition that lost it would re-run differently', () => {
    const c = canonicalTerms([
      { layer: 'contamination', weight: 1, direction: 'lower_better', scale: 'observed' },
      { layer: 'pct_Black', weight: 1, direction: 'higher_better' },
    ])
    expect(c.find(t => t.layer === 'contamination')?.scale).toBe('observed')
    // Absent stays absent, so a term stored before this field existed is
    // still byte-identical.
    expect('scale' in (c.find(t => t.layer === 'pct_Black') as object)).toBe(false)
  })

  it('two formulas differing only in scale are not the same formula', () => {
    const a = [{ layer: 'x', weight: 1, direction: 'higher_better' as const }]
    const b = [{ layer: 'x', weight: 1, direction: 'higher_better' as const, scale: 'observed' as const }]
    expect(sameTerms(a, b)).toBe(false)
  })

  it('reads the scale off a definition, and refuses one it does not know', () => {
    const ok = readCompositeTerms([
      { layer: 'a', weight: 1, direction: 'higher_better', scale: 'observed' },
      { layer: 'b', weight: 1, direction: 'higher_better' },
    ])
    expect('error' in ok).toBe(false)
    if ('error' in ok) return
    expect(ok.terms.find(t => t.layer === 'a')?.scale).toBe('observed')

    const bad = readCompositeTerms([
      { layer: 'a', weight: 1, direction: 'higher_better', scale: 'sideways' },
      { layer: 'b', weight: 1, direction: 'higher_better' },
    ])
    expect('error' in bad).toBe(true)
  })
})

describe('readCompositeTerms — what a definition may say', () => {
  it('takes a well-formed list', () => {
    const read = readCompositeTerms([
      { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
      { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' },
    ])
    expect(read).toEqual({
      terms: [
        { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
        { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' },
      ],
    })
  })

  it('requires a direction per term rather than guessing one', () => {
    expect(readCompositeTerms([{ layer: 'a', weight: 1 }, { layer: 'b', weight: 1 }])).toEqual({
      error: 'Every layer in an index needs a direction — “higher_better” or “lower_better”. “a” has none.',
    })
  })

  it('refuses an index over one layer, which is that layer', () => {
    const read = readCompositeTerms([{ layer: 'a', weight: 1, direction: 'higher_better' }])
    expect(read).toEqual({
      error: `An index needs at least ${COMPOSITE_TERMS_MIN} layers — over one layer it is that layer rescaled, so draw the layer instead.`,
    })
  })

  it('refuses more terms than a person can read', () => {
    const many = Array.from({ length: COMPOSITE_TERMS_MAX + 1 }, (_, i) => ({
      layer: `l${i}`,
      weight: 1,
      direction: 'higher_better' as const,
    }))
    expect(readCompositeTerms(many)).toEqual({
      error:
        `${COMPOSITE_TERMS_MAX + 1} layers is more than an index holds — ${COMPOSITE_TERMS_MAX} is the most, ` +
        `because past that nobody can say what the number means.`,
    })
  })

  it('refuses a weight that is not a positive number', () => {
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const read = readCompositeTerms([
        { layer: 'a', weight, direction: 'higher_better' },
        { layer: 'b', weight: 1, direction: 'higher_better' },
      ])
      expect(read).toHaveProperty('error')
      expect((read as { error: string }).error).toContain('“a”')
    }
    expect(
      readCompositeTerms([
        { layer: 'a', weight: COMPOSITE_WEIGHT_MAX + 1, direction: 'higher_better' },
        { layer: 'b', weight: 1, direction: 'higher_better' },
      ]),
    ).toEqual({
      error: `A weight of ${COMPOSITE_WEIGHT_MAX + 1} is past the ${COMPOSITE_WEIGHT_MAX} an index takes — weights are relative, so scale them all down instead.`,
    })
  })

  it('refuses the same layer twice, which is one layer with two weights', () => {
    expect(
      readCompositeTerms([
        { layer: 'a', weight: 1, direction: 'higher_better' },
        { layer: 'a', weight: 2, direction: 'higher_better' },
      ]),
    ).toEqual({ error: '“a” is in this index twice. One layer, one weight.' })
  })

  it('refuses anything that is not a list of terms', () => {
    expect(readCompositeTerms(undefined)).toHaveProperty('error')
    expect(readCompositeTerms('a,b')).toHaveProperty('error')
    expect(readCompositeTerms([{ weight: 1, direction: 'higher_better' }, { layer: 'b', weight: 1, direction: 'higher_better' }])).toHaveProperty('error')
  })
})

describe('compositeRefusal — the ceiling', () => {
  it('passes a small index', () => {
    expect(compositeRefusal(3, 2_000_000)).toBeNull()
  })

  it('refuses past the byte budget, and names the local pass', () => {
    const refusal = compositeRefusal(3, COMPOSITE_BYTES_BUDGET + 1)
    expect(refusal).toContain('npm run library -- index')
    expect(refusal).toContain('The layer count alone cannot see this')
  })

  it('says the budget is read off the index before anything is opened', () => {
    // The whole point of bounding BYTES rather than rows: it is decided from
    // the catalog, so a refusal costs no parse at all.
    const refusal = compositeRefusal(12, COMPOSITE_BYTES_BUDGET * 4)
    expect(refusal).toMatch(/MB/)
  })
})

describe('compositeMethod', () => {
  const scales = [
    { layer: 'internal-votes', weight: 6, direction: 'higher_better' as const, min: 1, max: 88, counties: 300 },
    { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' as const, min: 3, max: 44, counties: 318 },
  ]

  it('names every layer with its weight and its direction', () => {
    const method = compositeMethod({
      names: { 'internal-votes': 'Black voter registration', poverty_by_race: 'Black poverty rate' },
      scales,
      stats: { terms: 2, counties: 318, complete: 300, partial: 18 },
    })
    expect(method).toContain('Black voter registration ×6 higher is better')
    expect(method).toContain('Black poverty rate ×4 lower is better')
    expect(method).toContain('318 counties')
    expect(method).toContain('300 with every layer')
  })

  it("stays inside the 500 characters a column's method holds, even at the term ceiling", () => {
    const many = Array.from({ length: COMPOSITE_TERMS_MAX }, (_, i) => ({
      layer: `internal-a-rather-long-layer-slug-number-${i}`,
      weight: 10,
      direction: 'higher_better' as const,
      min: 0,
      max: 100,
      counties: 3142,
    }))
    const names = Object.fromEntries(
      many.map(s => [s.layer, `A rather long human readable layer name number ${s.layer.slice(-1)}`]),
    )
    const method = compositeMethod({
      names,
      scales: many,
      stats: { terms: many.length, counties: 3142, complete: 3000, partial: 142 },
    })
    expect(method.length).toBeLessThanOrEqual(500)
    expect(method).toContain('more')
  })
})
