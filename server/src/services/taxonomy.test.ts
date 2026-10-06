import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TOPICS,
  PURPOSES,
  SHAPES,
  SHAPE_IDS,
  TAG_ALIASES,
  CROSS_TAGS,
  TOPIC_IDS,
  PURPOSE_IDS,
  CATEGORY_IDS,
  isTopic,
  isPurpose,
  isShape,
  shapeLabel,
  isTopicable,
  normalizeTag,
  normalizeTags,
  normalizeCategory,
  topicLabel,
  categoryLabel,
  topicForLayerCategory,
  suggestedTagsFor,
  tagChoicesFor,
  topicFor,
  purposeFor,
  topicsSentence,
  COVERAGE_SCOPES,
  COVERAGE_SCOPE_IDS,
  US_STATES,
  coverageScopeLabel,
  isCoverageScope,
  stateCodeFor,
  stateCodeForFips,
  stateFipsFor,
  stateNameForCode,
} from './taxonomy.js'

/**
 * P5-63: the server's copy of the taxonomy is generated
 * (`npm run export:layers` at the repo root) and committed, because the server
 * has no way to read the client's TypeScript at runtime.
 *
 * The client half of this contract is src/config/__tests__/taxonomy.spec.ts,
 * which fails when the export is stale against the module a person edits.
 * This half fails when the committed JSON does not describe a usable taxonomy
 * at all.
 */
describe('taxonomy.generated.json', () => {
  it('describes every topic well enough to file by', () => {
    expect(TOPICS.length).toBeGreaterThan(8)
    for (const topic of TOPICS) {
      expect(topic.id, JSON.stringify(topic)).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(topic.label.trim().length).toBeGreaterThan(0)
      expect(topic.description.trim().length).toBeGreaterThan(0)
      expect(topic.suggestedTags.length).toBeGreaterThan(0)
    }
    expect(PURPOSE_IDS).toEqual(['strategy', 'research', 'outreach', 'ideas'])
    expect(new Set(CATEGORY_IDS).size).toBe(CATEGORY_IDS.length)
  })

  it('is the file the export script writes, byte for byte', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = JSON.parse(readFileSync(join(here, '../prompt/taxonomy.generated.json'), 'utf8'))
    expect(raw.topics).toEqual(TOPICS)
    expect(raw.purposes).toEqual(PURPOSES)
    expect(raw.shapes).toEqual(SHAPES)
    expect(raw.coverageScopes).toEqual(COVERAGE_SCOPES)
    expect(raw.states).toEqual(US_STATES)
    expect(raw.tagAliases).toEqual(TAG_ALIASES)
    expect(raw.crossTags).toEqual(CROSS_TAGS)
  })

  it('carries the four dataset shapes, in reading order and in plain words (P6-2)', () => {
    expect(SHAPE_IDS).toEqual(['areas', 'points', 'statistics', 'records'])
    expect(shapeLabel('statistics')).toBe('Statistics by county or tract')
    expect(shapeLabel('geospatial')).toBe('geospatial')
    expect(isShape('geospatial')).toBe(false)
    for (const id of SHAPE_IDS) {
      expect(isTopic(id), id).toBe(false)
      expect(isPurpose(id), id).toBe(false)
    }
  })

  it('carries the public map’s eight layer categories as topics', () => {
    for (const category of ['composite', 'demographic', 'economic', 'housing', 'equity', 'transportation', 'environment', 'health']) {
      expect(topicForLayerCategory(category), category).toBe(category)
    }
    expect(topicForLayerCategory('internal')).toBeNull()
  })
})

describe('taxonomy — normalising', () => {
  it('folds the spellings we have collected', () => {
    expect(normalizeTag('Flooding')).toBe('flood')
    expect(normalizeTag('environmental_risk')).toBe('environmental-risk')
    expect(normalizeTag('environmental')).toBe('environment')
    expect(normalizeCategory('demographics')).toBe('demographic')
    expect(normalizeCategory('primary-sources')).toBe('research')
  })

  it('keeps an unknown word rather than dropping it', () => {
    expect(normalizeCategory('kitchen sink')).toBe('kitchen-sink')
    expect(isTopic('kitchen-sink')).toBe(false)
    expect(isPurpose('kitchen-sink')).toBe(false)
  })

  it('normalises a list once, in order, without duplicates or blanks', () => {
    expect(normalizeTags(['Flooding', 'flood', '  ', 'Water Quality', 42, 'land'])).toEqual(['flood', 'water', 'land'])
  })

  it('is idempotent', () => {
    for (const [from, to] of Object.entries(TAG_ALIASES)) {
      expect(normalizeTag(from)).toBe(to)
      expect(normalizeTag(to)).toBe(to)
    }
    for (const tag of [...CROSS_TAGS, ...TOPICS.flatMap(t => t.suggestedTags)]) {
      expect(normalizeTag(tag), tag).toBe(tag)
    }
  })
})

describe('taxonomy — deriving a topic', () => {
  it('prefers the category, then the tags', () => {
    expect(topicFor('water', ['land'])).toBe('water')
    expect(topicFor('research', ['history', 'land'])).toBe('land')
    expect(topicFor('outreach', ['environmental-risk'])).toBeNull()
    expect(topicFor('outreach', ['environmental'])).toBe('environment')
  })

  it('says nothing rather than guessing', () => {
    expect(topicFor('strategy', ['funding', 'budget'])).toBeNull()
    expect(topicFor('', [])).toBeNull()
  })

  it('reads the purpose off the same field', () => {
    expect(purposeFor('research')).toBe('research')
    expect(purposeFor('primary-sources')).toBe('research')
    expect(purposeFor('land')).toBeNull()
  })

  it('only asks the question of kinds that carry a manifest category', () => {
    for (const kind of ['dataset', 'document', 'incoming', 'note', 'source']) expect(isTopicable(kind)).toBe(true)
    for (const kind of ['wiki', 'view', 'layer']) expect(isTopicable(kind)).toBe(false)
  })
})

describe('taxonomy — labels', () => {
  it('says a topic in plain words, and an unknown word as it was written', () => {
    expect(topicLabel('demographic')).toBe('People')
    expect(categoryLabel('ideas')).toBe('Ideas')
    expect(categoryLabel('kitchen-sink')).toBe('kitchen-sink')
  })

  it('offers a topic its own tags then the cross-cutting ones', () => {
    expect(suggestedTagsFor('land')).toContain('ownership')
    expect(tagChoicesFor('land')).toEqual([...suggestedTagsFor('land'), ...CROSS_TAGS])
  })

  it('writes one prompt line naming every topic with its label', () => {
    const line = topicsSentence()
    for (const id of TOPIC_IDS) expect(line).toContain(id)
    expect(line).toContain('(Getting to work)')
    expect(line.split('\n')).toHaveLength(1)
  })
})

/**
 * P6-19: the coverage half of the same contract. The scopes are a vocabulary;
 * the states are a fact table that rides with it because the server needs them
 * for exactly one question and a second generated file would be a second thing
 * to keep in step.
 */
describe('coverage scopes and the states (P6-19)', () => {
  it('carries the five scopes, in reading order and in plain words', () => {
    expect(COVERAGE_SCOPE_IDS).toEqual(['national', 'multi-state', 'state', 'county', 'local'])
    expect(coverageScopeLabel('national')).toBe('National')
    expect(coverageScopeLabel('multi-state')).toBe('Several states')
    expect(isCoverageScope('national')).toBe(true)
    expect(isCoverageScope('the-southeast')).toBe(false)
    // An unknown word reads as itself rather than as nothing.
    expect(coverageScopeLabel('the-southeast')).toBe('the-southeast')
  })

  it('carries the whole United States, each state with its three spellings', () => {
    // 50 states + DC + the five inhabited territories.
    expect(US_STATES).toHaveLength(56)
    for (const state of US_STATES) {
      expect(state.fips, JSON.stringify(state)).toMatch(/^\d{2}$/)
      expect(state.code, JSON.stringify(state)).toMatch(/^[A-Z]{2}$/)
      expect(state.name.trim().length).toBeGreaterThan(0)
    }
    expect(new Set(US_STATES.map(s => s.fips)).size).toBe(US_STATES.length)
    expect(new Set(US_STATES.map(s => s.code)).size).toBe(US_STATES.length)
  })

  it('converts between the three spellings, and refuses to guess', () => {
    expect(stateCodeForFips('13')).toBe('GA')
    expect(stateNameForCode('GA')).toBe('Georgia')
    expect(stateCodeFor('13')).toBe('GA')
    expect(stateCodeFor('ga')).toBe('GA')
    expect(stateCodeFor('Georgia')).toBe('GA')
    expect(stateCodeFor('georgia')).toBe('GA')
    // West Virginia is its own state, not a qualifier on Virginia.
    expect(stateCodeFor('West Virginia')).toBe('WV')
    expect(stateCodeFor('Virginia')).toBe('VA')
    expect(stateCodeFor('Atlantis')).toBe('')
    expect(stateCodeFor('99')).toBe('')
    expect(stateCodeFor('')).toBe('')
  })

  // P7-9 needed the fourth direction: a state-keyed dataset writes its key in
  // any of the three spellings, and the geometry is filed under FIPS.
  it('reads a 2-digit FIPS out of all three spellings, forgiving a dropped zero', () => {
    expect(stateFipsFor('13')).toBe('13')
    expect(stateFipsFor('GA')).toBe('13')
    expect(stateFipsFor('ga')).toBe('13')
    expect(stateFipsFor('Georgia')).toBe('13')
    expect(stateFipsFor(' georgia ')).toBe('13')
    // A spreadsheet that decided the column was a number. '01' and '1' and
    // '1.0' are Alabama; a leading zero a tool dropped is not another state.
    expect(stateFipsFor('01')).toBe('01')
    expect(stateFipsFor('1')).toBe('01')
    expect(stateFipsFor('1.0')).toBe('01')
    expect(stateFipsFor('6.00')).toBe('06')
    // Never a guess: a county GEOID is not a state, and a real fraction is
    // not an id.
    expect(stateFipsFor('01001')).toBe('')
    expect(stateFipsFor('1.5')).toBe('')
    expect(stateFipsFor('99')).toBe('')
    expect(stateFipsFor('Atlantis')).toBe('')
    expect(stateFipsFor('')).toBe('')
    // Round trips with the other three for every state there is.
    for (const state of US_STATES) {
      expect(stateFipsFor(state.code)).toBe(state.fips)
      expect(stateFipsFor(state.name)).toBe(state.fips)
      expect(stateFipsFor(state.fips)).toBe(state.fips)
    }
  })
})
