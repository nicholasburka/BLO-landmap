#!/usr/bin/env node
/**
 * Export the public layer registry for the server (P5-45).
 *
 * The Ask index (server/src/services/kbSearch.ts) needs one chunk per public
 * map layer so a question like "where does the Black homeownership layer come
 * from?" can be answered with a source. The server has no copy of the client
 * registry and must not grow one by hand — it would drift the first week —
 * so this script writes the registry's metadata to a committed JSON file that
 * the server imports.
 *
 * Run: `npm run export:layers` (from the repo root).
 *
 * Node's type stripping loads the TypeScript registry directly, which is why
 * the npm script carries `--experimental-strip-types`. The registry is plain
 * data with no imports, so nothing else has to be compiled.
 *
 * A stale export fails CI: src/lib/__tests__/publicLayers.spec.ts asserts the
 * exported ids equal the registry's public ids.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { LAYER_REGISTRY } from '../src/config/layerRegistry.ts'
import { SITE_LAYERS } from '../src/config/siteLayers.ts'
import { TOPICS, PURPOSES, SHAPES, COVERAGE_SCOPES, TAG_ALIASES, CROSS_TAGS } from '../src/config/taxonomy.ts'
import { ORGANIZATIONS } from '../src/config/organizations.ts'
import { US_STATES } from '../src/config/stateFips.ts'

const OUT = fileURLToPath(new URL('../server/src/prompt/publicLayers.generated.json', import.meta.url))
const TAXONOMY_OUT = fileURLToPath(new URL('../server/src/prompt/taxonomy.generated.json', import.meta.url))
const SITES_OUT = fileURLToPath(new URL('../server/src/prompt/siteLayers.generated.json', import.meta.url))
const ORGS_OUT = fileURLToPath(new URL('../server/src/prompt/organizations.generated.json', import.meta.url))

// Prose the server can quote, plus (P5-50) where the numbers live: the MCP
// `county_values` tool reads the same file the map reads, so `dataPath` and
// the file's own value column travel with the metadata. `formatValue` is a
// function and `gradient`/`color` are rendering details nobody asks about.
const layers = Object.values(LAYER_REGISTRY)
  .filter(layer => layer.category !== 'internal')
  .map(layer => ({
    id: layer.id,
    name: layer.name,
    category: layer.category,
    dataType: layer.dataType,
    direction: layer.direction,
    unit: layer.unit,
    range: layer.range,
    description: layer.description,
    source: layer.source,
    sourceUrl: layer.sourceUrl ?? '',
    year: layer.year,
    dataPath: layer.dataPath,
    // `dataKey` is the field name AFTER the client's loader reshapes a row;
    // `valueColumn` overrides it wherever the raw file spells it differently.
    valueColumn: layer.valueColumn ?? layer.dataKey,
  }))

writeFileSync(OUT, `${JSON.stringify(layers, null, 2)}\n`, 'utf8')
console.log(`export:layers wrote ${layers.length} public layers → ${OUT}`)

// P5-63: the same trip for the taxonomy. The server files, filters, prompts
// and MCP tools all speak topics and purposes now, and a second hand-kept copy
// of the vocabulary would drift exactly as the three vocabularies it replaced
// did. Plain data only — the helpers live beside the JSON on each side.
const taxonomy = {
  topics: TOPICS.map(topic => ({
    id: topic.id,
    label: topic.label,
    description: topic.description,
    ...(topic.layerCategory ? { layerCategory: topic.layerCategory } : {}),
    suggestedTags: topic.suggestedTags,
  })),
  purposes: PURPOSES.map(purpose => ({ id: purpose.id, label: purpose.label, description: purpose.description })),
  // P6-2: the dataset shapes ride with the taxonomy — one vocabulary module,
  // one export, one stale check.
  shapes: SHAPES.map(shape => ({ id: shape.id, label: shape.label, description: shape.description })),
  // P6-19: and so do the coverage scopes, for the same reason. The STATES ride
  // here too — they are a fact table rather than a vocabulary, but the server
  // needs them for exactly one question (which state is FIPS 13?) and a second
  // generated file for 56 rows would be a file to keep in step for nothing.
  coverageScopes: COVERAGE_SCOPES.map(scope => ({ id: scope.id, label: scope.label, description: scope.description })),
  states: US_STATES.map(state => ({ fips: state.fips, code: state.code, name: state.name })),
  tagAliases: TAG_ALIASES,
  crossTags: CROSS_TAGS,
}

writeFileSync(TAXONOMY_OUT, `${JSON.stringify(taxonomy, null, 2)}\n`, 'utf8')
console.log(
  `export:layers wrote ${taxonomy.topics.length} topics + ${taxonomy.purposes.length} purposes → ${TAXONOMY_OUT}`,
)

// P5-78: the five EPA contamination site layers. A saved map view names the
// ones that were on when it was saved, and the server both validates that
// list and writes the view's description ("… · Superfund Sites"), so it needs
// the ids and the labels. Ids and names only — the file, colour and tooltip
// are the map's business.
const sites = SITE_LAYERS.map(layer => ({ id: layer.id, name: layer.name }))

writeFileSync(SITES_OUT, `${JSON.stringify(sites, null, 2)}\n`, 'utf8')
console.log(`export:layers wrote ${sites.length} contamination site layers → ${SITES_OUT}`)

// P6-1: the same trip for the organization vocabulary. Reindex folds every
// manifest's provider string through it, the catalog filters on the id and the
// MCP results carry the label — all server-side, all reading this file.
const organizations = ORGANIZATIONS.map(org => ({
  id: org.id,
  label: org.label,
  ...(org.parent ? { parent: org.parent } : {}),
  aliases: org.aliases,
}))

writeFileSync(ORGS_OUT, `${JSON.stringify(organizations, null, 2)}\n`, 'utf8')
console.log(`export:layers wrote ${organizations.length} organizations → ${ORGS_OUT}`)
