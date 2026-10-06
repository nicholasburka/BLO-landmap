import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  TOPICS,
  PURPOSES,
  SHAPES,
  SHAPE_IDS,
  TAG_ALIASES,
  CROSS_TAGS,
  TOPIC_IDS,
  PURPOSE_IDS,
  isTopic,
  isPurpose,
  isShape,
  shapeLabel,
  normalizeTag,
  normalizeCategory,
  topicLabel,
  purposeLabel,
  categoryLabel,
  topicForLayerCategory,
  suggestedTagsFor,
  tagChoicesFor,
  topicFor,
  purposeFor,
  COVERAGE_SCOPES,
  COVERAGE_SCOPE_IDS,
  coverageScopeLabel,
  isCoverageScope,
} from '@/config/taxonomy'
import { US_STATES, stateCodeFor, stateCodeForFips, stateNameForCode, FIPS_TO_STATE, getStateNameFromFips } from '@/config/stateFips'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '@/lib/publicLayers'

describe('taxonomy — shape', () => {
  it('gives every topic an id, a plain label, a description and suggested tags', () => {
    expect(TOPICS.length).toBeGreaterThan(8)
    for (const topic of TOPICS) {
      expect(topic.id, JSON.stringify(topic)).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(topic.label.trim().length).toBeGreaterThan(0)
      expect(topic.label).not.toBe(topic.id)
      expect(topic.description.trim().endsWith('.')).toBe(true)
      expect(topic.suggestedTags.length).toBeGreaterThan(0)
      for (const tag of topic.suggestedTags) expect(tag).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('has one entry per id and never uses a word as both a topic and a purpose', () => {
    expect(new Set(TOPIC_IDS).size).toBe(TOPIC_IDS.length)
    expect(new Set(PURPOSE_IDS).size).toBe(PURPOSE_IDS.length)
    for (const id of PURPOSE_IDS) expect(isTopic(id)).toBe(false)
    for (const id of TOPIC_IDS) expect(isPurpose(id)).toBe(false)
  })

  it('carries the four purposes the library files by', () => {
    expect(PURPOSE_IDS).toEqual(['strategy', 'research', 'outreach', 'ideas'])
  })

  it('carries the four dataset shapes, in reading order and in plain words', () => {
    expect(SHAPE_IDS).toEqual(['areas', 'points', 'statistics', 'records'])
    expect(SHAPES.map(s => s.label)).toEqual([
      'Areas and boundaries',
      'Sites and points',
      'Statistics by county or tract',
      'Records without a location',
    ])
    for (const shape of SHAPES) {
      expect(shape.description.trim().endsWith('.'), shape.id).toBe(true)
      expect(isShape(shape.id)).toBe(true)
    }
    // A shape is a third axis: no word does double duty as a subject or a
    // purpose, or the three filters would fight over the same chip.
    for (const id of SHAPE_IDS) {
      expect(isTopic(id), id).toBe(false)
      expect(isPurpose(id), id).toBe(false)
    }
    expect(shapeLabel('areas')).toBe('Areas and boundaries')
    expect(shapeLabel('geospatial')).toBe('geospatial')
    expect(isShape('geospatial')).toBe(false)
  })

  it('makes every public layer category a topic', () => {
    for (const category of CATEGORY_ORDER) {
      if (category === 'internal') continue
      expect(topicForLayerCategory(category), category).not.toBeNull()
    }
  })

  it('keeps the initiative and its datasets out of a module the public bundle reaches', () => {
    // The bundle-leak gate scans dist/ for these; this test says why, and
    // catches it in the suite rather than at the end of a build.
    const words = JSON.stringify({ TOPICS, PURPOSES, SHAPES, TAG_ALIASES, CROSS_TAGS }).toLowerCase()
    for (const canary of ['homesteading', 'blo-library', 'p518-standin', 'library_users']) {
      expect(words, `taxonomy mentions "${canary}"`).not.toContain(canary)
    }
  })
})

describe('taxonomy — aliases normalise once and stay put', () => {
  it('folds spelling and plural variants', () => {
    expect(normalizeTag('Flooding')).toBe('flood')
    expect(normalizeTag('  FLOODS ')).toBe('flood')
    expect(normalizeTag('Water Quality')).toBe('water')
    expect(normalizeTag('demographics')).toBe('demographic')
    // A cross-cutting screening tag keeps its name; the adjective folds.
    expect(normalizeTag('environmental-risk')).toBe('environmental-risk')
    expect(normalizeTag('environmental')).toBe('environment')
  })

  it('cleans a free tag rather than refusing it', () => {
    expect(normalizeTag('Heirs Property')).toBe('heirs-property')
    expect(normalizeTag('site_selection')).toBe('site-selection')
    expect(normalizeTag('  ***  ')).toBe('')
    expect(normalizeTag('brand-new-word')).toBe('brand-new-word')
  })

  it('is idempotent — normalising twice never moves a word again', () => {
    for (const [from, to] of Object.entries(TAG_ALIASES)) {
      expect(normalizeTag(from)).toBe(to)
      expect(normalizeTag(to), `"${to}" is itself an alias key`).toBe(to)
    }
  })

  it('never recommends a tag it would then rewrite', () => {
    for (const topic of TOPICS) {
      for (const tag of topic.suggestedTags) expect(normalizeTag(tag), tag).toBe(tag)
    }
    for (const tag of CROSS_TAGS) expect(normalizeTag(tag), tag).toBe(tag)
  })

  it('maps the library category spellings onto the taxonomy', () => {
    expect(normalizeCategory('demographics')).toBe('demographic')
    expect(normalizeCategory('primary-sources')).toBe('research')
    expect(isPurpose(normalizeCategory('primary-sources'))).toBe(true)
    // Unknown words survive: they are counted, warned about, and shown as-is.
    expect(normalizeCategory('kitchen-sink')).toBe('kitchen-sink')
    expect(isTopic('kitchen-sink')).toBe(false)
  })
})

describe('taxonomy — labels and lookups', () => {
  it('says a topic in plain words', () => {
    expect(topicLabel('demographic')).toBe('People')
    expect(topicLabel('transportation')).toBe('Getting to work')
    expect(topicLabel('agriculture')).toBe('Agriculture and food')
    // A word we do not know is shown as it was written, never as a blank.
    expect(topicLabel('kitchen-sink')).toBe('kitchen-sink')
  })

  it('labels purposes and either kind through one call', () => {
    expect(purposeLabel('ideas')).toBe('Ideas')
    expect(categoryLabel('land')).toBe('Land')
    expect(categoryLabel('research')).toBe('Research')
    expect(categoryLabel('kitchen-sink')).toBe('kitchen-sink')
  })

  it('offers a topic its own tags first, then the cross-cutting ones', () => {
    expect(suggestedTagsFor('hazards')).toContain('flood')
    const choices = tagChoicesFor('hazards')
    expect(choices.slice(0, suggestedTagsFor('hazards').length)).toEqual(suggestedTagsFor('hazards'))
    for (const tag of CROSS_TAGS) expect(choices).toContain(tag)
    expect(new Set(choices).size).toBe(choices.length)
    expect(tagChoicesFor('kitchen-sink')).toEqual(CROSS_TAGS)
  })
})

describe('taxonomy — an entry’s topic is derived, never stored twice', () => {
  it('uses the category when the category is a topic', () => {
    expect(topicFor('water', ['contamination'])).toBe('water')
    expect(topicFor('demographics', [])).toBe('demographic')
    expect(purposeFor('water')).toBeNull()
  })

  it('falls back to the first tag that names a topic', () => {
    expect(topicFor('research', ['history', 'land', 'water'])).toBe('land')
    expect(topicFor('strategy', ['funding', 'budget'])).toBeNull()
    expect(purposeFor('strategy')).toBe('strategy')
  })

  it('reads a tag through the aliases on the way', () => {
    expect(topicFor('outreach', ['environmental-risk'])).toBeNull()
    expect(topicFor('outreach', ['environmental'])).toBe('environment')
    expect(topicFor('', ['Demographics'])).toBe('demographic')
  })

  it('says nothing rather than guessing when nothing names a topic', () => {
    expect(topicFor('', [])).toBeNull()
    expect(topicFor('ideas', ['pitch'])).toBeNull()
    expect(topicFor(undefined, undefined)).toBeNull()
  })
})

describe('taxonomy — the public layer list reads its labels from here', () => {
  it('keeps the labels /layers has always shown', () => {
    expect(CATEGORY_LABELS).toEqual({
      composite: 'Overall index',
      demographic: 'People',
      economic: 'Jobs and income',
      housing: 'Housing',
      equity: 'Equity',
      transportation: 'Getting to work',
      environment: 'Environment',
      health: 'Health',
      internal: 'Internal library layers',
    })
  })

  it('keeps the reading order, with internal layers last', () => {
    expect(CATEGORY_ORDER).toEqual([
      'composite',
      'demographic',
      'economic',
      'housing',
      'equity',
      'transportation',
      'environment',
      'health',
      'internal',
    ])
  })
})

describe('taxonomy — the server copy', () => {
  it('matches the exported JSON the server reads (run `npm run export:layers` after editing the taxonomy)', () => {
    const path = resolve(process.cwd(), 'server/src/prompt/taxonomy.generated.json')
    const exported = JSON.parse(readFileSync(path, 'utf8')) as {
      topics: { id: string; label: string; description: string; layerCategory?: string; suggestedTags: string[] }[]
      purposes: { id: string; label: string; description: string }[]
      shapes: { id: string; label: string; description: string }[]
      coverageScopes: { id: string; label: string; description: string }[]
      states: { fips: string; code: string; name: string }[]
      tagAliases: Record<string, string>
      crossTags: string[]
    }
    expect(exported.topics).toEqual(
      TOPICS.map(topic => ({
        id: topic.id,
        label: topic.label,
        description: topic.description,
        ...(topic.layerCategory ? { layerCategory: topic.layerCategory } : {}),
        suggestedTags: topic.suggestedTags,
      })),
    )
    expect(exported.purposes).toEqual(PURPOSES)
    expect(exported.shapes).toEqual(SHAPES)
    // P6-19: the coverage scopes and the states ride with the taxonomy.
    expect(exported.coverageScopes).toEqual(COVERAGE_SCOPES)
    expect(exported.states).toEqual(US_STATES)
    expect(exported.tagAliases).toEqual(TAG_ALIASES)
    expect(exported.crossTags).toEqual(CROSS_TAGS)
  })
})

/**
 * P6-19: the coverage scopes, and the one table that holds the three spellings
 * of a state. The FIPS map and `STATE_ABBR_BY_NAME` in `useMapState` were two
 * halves of this and could not reach each other; now there is one row per
 * state with all three on it.
 */
describe('coverage scopes (P6-19)', () => {
  it('reads as five plain cuts, in order, with no "unknown" among them', () => {
    expect(COVERAGE_SCOPE_IDS).toEqual(['national', 'multi-state', 'state', 'county', 'local'])
    for (const scope of COVERAGE_SCOPES) {
      expect(scope.id).toMatch(/^[a-z][a-z-]*$/)
      expect(scope.label.trim().length).toBeGreaterThan(0)
      expect(scope.description.trim().length).toBeGreaterThan(0)
    }
    expect(coverageScopeLabel('local')).toBe('Local area')
    expect(isCoverageScope('national')).toBe(true)
    // "Nothing determinable" is deliberately NOT a scope: a dataset nobody can
    // place carries no coverage at all.
    expect(isCoverageScope('none')).toBe(false)
    expect(isCoverageScope('unknown')).toBe(false)
  })
})

describe('the states (P6-19)', () => {
  it('holds every state once, with FIPS, postal code and name', () => {
    expect(US_STATES).toHaveLength(56)
    expect(new Set(US_STATES.map(s => s.code)).size).toBe(56)
    expect(US_STATES.find(s => s.code === 'GA')).toEqual({ fips: '13', code: 'GA', name: 'Georgia' })
  })

  it('converts in every direction a coverage reading needs, and refuses to guess', () => {
    expect(stateCodeForFips('13')).toBe('GA')
    expect(stateNameForCode('ga')).toBe('Georgia')
    expect(stateCodeFor('Georgia')).toBe('GA')
    expect(stateCodeFor('13')).toBe('GA')
    expect(stateCodeFor('West Virginia')).toBe('WV')
    expect(stateCodeFor('nowhere')).toBe('')
    expect(stateCodeForFips('99')).toBe('')
  })

  it('still answers the map’s own question the way it always did', () => {
    // The ranking panel and the county modal have read these since long before
    // coverage existed; the one table has to keep both working.
    expect(FIPS_TO_STATE['47']).toBe('Tennessee')
    expect(getStateNameFromFips('13')).toBe('Georgia')
    expect(getStateNameFromFips('99')).toBe('Unknown State')
    expect(Object.keys(FIPS_TO_STATE)).toHaveLength(56)
  })
})
