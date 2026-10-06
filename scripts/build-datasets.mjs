#!/usr/bin/env node
/**
 * Prebuild: one county data file, content-hashed (P5-90).
 *
 * The map used to fetch thirteen files on startup — ten CSVs parsed on the
 * main thread with Papa, plus two overlapping score JSONs (4.8 MB) and the
 * contamination counts — and none of the paths carried a hash, so Netlify
 * could only cache them for a day.
 *
 * This script folds every per-county number the map reads into ONE JSON file
 * named by the hash of its own contents, copies the county geometry beside it
 * under the same scheme, and writes `src/config/datasetsManifest.generated.json`
 * so the hashed names are baked into the bundle at build time. Those two files
 * are the map's entire startup fetch, and `/datasets/build/*` is served
 * `immutable` (see netlify.toml) — a repeat visit re-fetches nothing.
 *
 * The output is keyed exactly like the refs `useMapData` exposes, so nothing
 * downstream had to change:
 *
 *   { version, diversity, lifeExpectancy, contamination, combinedScores,
 *     combinedScoresV2, economic, housing, equity, transportation }
 *
 * with each section a `{ "<5-digit GEOID>": { …fields } }` map.
 *
 * Deterministic by construction: no timestamps, no ordering surprises. The
 * same inputs produce byte-identical outputs, so a rebuild with unchanged
 * data leaves the hashed names — and the bundle — alone.
 *
 * Usage:
 *   node scripts/build-datasets.mjs [--geometry <path>] [--precision <decimals>|none] [--quiet]
 *
 * `--geometry` swaps in a simplified county outline file (P5-90 ships
 * candidates for the lead to diff); the default is the full-resolution
 * `public/datasets/geographic/counties.geojson`.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import Papa from 'papaparse'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Repo root, so every path below can be written relative to it. */
export const REPO_ROOT = resolve(HERE, '..')

/** Bumped when the file's shape changes, so a stale cached copy is obvious. */
export const COUNTY_DATA_VERSION = 1

export const SOURCE_FILES = {
  diversity: 'public/datasets/demographics/county_pctBlack_diversity_index_with_stats.csv',
  lifeExpectancy: 'public/datasets/demographics/lifeexpectancy-USA-county.csv',
  wages: 'public/datasets/economic/avg_weekly_wages.csv',
  income: 'public/datasets/economic/median_income_by_race.csv',
  homeValue: 'public/datasets/housing/median_home_value.csv',
  propertyTax: 'public/datasets/housing/median_property_tax.csv',
  homeownership: 'public/datasets/equity/homeownership_by_race.csv',
  poverty: 'public/datasets/equity/poverty_by_race.csv',
  blackProgress: 'public/datasets/equity/black_progress_index.csv',
  commute: 'public/datasets/transportation/commute_times.csv',
  contamination: 'public/datasets/epa-contamination/contamination_counts.json',
  combinedScores: 'public/datasets/BLO-livability-index/combined_scores.json',
  combinedScoresV2: 'public/datasets/precomputed/combined_scores_v2.json',
}

export const DEFAULT_GEOMETRY = 'public/datasets/geographic/counties.geojson'
/** Decimal places kept in the shipped geometry; `null` ships the source bytes. */
export const DEFAULT_PRECISION = 4
export const BUILD_DIR = 'public/datasets/build'
export const MANIFEST_FILE = 'src/config/datasetsManifest.generated.json'
/** Public URL prefix the browser fetches the built files from. */
export const BUILD_URL_PREFIX = '/datasets/build'

/** The only filenames that may exist under the build directory. `check-bundle-leaks.mjs`
 *  keeps its own copy of this — a gate should not import the thing it gates —
 *  so change both together. */
export const BUILT_FILE_PATTERN = /^(?:county-data|counties)\.[0-9a-f]{10}\.(?:json|geojson)$/

// ---------------------------------------------------------------------------
// Parsing — deliberately identical to the loaders this replaced
// ---------------------------------------------------------------------------

/** Same options the browser loaders used, so numbers, blanks and quoted
 *  "County, State" cells come out exactly as they did before. */
function parseCsv(text) {
  return Papa.parse(text, { header: true, dynamicTyping: true }).data
}

/** GEOIDs arrive as numbers once `dynamicTyping` has had them ("01001" → 1001);
 *  every consumer keys on the 5-digit string. */
function geoIdOf(row) {
  return row.GEOID.toString().padStart(5, '0')
}

/** Walk a parsed CSV, skipping rows without a GEOID (trailing blank lines). */
function eachRow(rows, fn) {
  for (const row of rows) {
    if (!row || !row.GEOID) continue
    fn(row, geoIdOf(row))
  }
}

/**
 * Fold every source into the per-county file the map loads.
 *
 * Takes already-read content (strings for CSVs, parsed objects for JSON) so it
 * can be exercised on fixtures without touching the filesystem.
 */
export function buildCountyData(sources) {
  const diversity = {}
  eachRow(parseCsv(sources.diversity), (row, geoID) => {
    diversity[geoID] = {
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

  const lifeExpectancy = {}
  eachRow(parseCsv(sources.lifeExpectancy), (row, fallbackGeoId) => {
    // This file carries state/county codes separately; the GEOID column is the
    // fallback for rows that don't.
    const geoID =
      row.STATE2KX && row.CNTY2KX
        ? row.STATE2KX.toString().padStart(2, '0') + row.CNTY2KX.toString().padStart(3, '0')
        : fallbackGeoId
    lifeExpectancy[geoID] = {
      lifeExpectancy: row['e(0)'],
      standardError: row['se(e(0))'],
    }
  })

  const economic = {}
  eachRow(parseCsv(sources.wages), (row, geoID) => {
    economic[geoID] = {
      GEOID: geoID,
      county_name: row.county_name,
      state_name: row.state_name,
      year: row.year,
      avg_weekly_wage: row.avg_weekly_wage,
    }
  })
  eachRow(parseCsv(sources.income), (row, geoID) => {
    if (economic[geoID]) {
      economic[geoID].median_income_black = row.median_income_black
    } else {
      economic[geoID] = {
        GEOID: geoID,
        county_name: row.county_name,
        state_name: row.state_name,
        year: row.year,
        avg_weekly_wage: 0,
        median_income_black: row.median_income_black,
      }
    }
  })

  const housing = {}
  eachRow(parseCsv(sources.homeValue), (row, geoID) => {
    housing[geoID] = {
      GEOID: geoID,
      county_name: row.county_name,
      state_name: row.state_name,
      year: row.year,
      median_home_value: row.median_home_value_with_mortgage,
    }
  })
  eachRow(parseCsv(sources.propertyTax), (row, geoID) => {
    if (housing[geoID]) {
      housing[geoID].median_property_tax = row.median_property_tax_with_mortgage
    } else {
      housing[geoID] = {
        GEOID: geoID,
        county_name: row.county_name,
        state_name: row.state_name,
        year: row.year,
        median_property_tax: row.median_property_tax_with_mortgage,
      }
    }
  })
  eachRow(parseCsv(sources.homeownership), (row, geoID) => {
    if (housing[geoID]) {
      housing[geoID].homeownership_rate_black = row.homeownership_rate_black
    } else {
      housing[geoID] = {
        GEOID: geoID,
        county_name: row.county_name,
        state_name: row.state_name,
        year: row.year,
        homeownership_rate_black: row.homeownership_rate_black,
      }
    }
  })

  const equity = {}
  eachRow(parseCsv(sources.poverty), (row, geoID) => {
    equity[geoID] = {
      GEOID: geoID,
      county_name: row.county_name,
      state_name: row.state_name,
      year: row.year,
      poverty_rate_black: row.poverty_rate_black,
    }
  })
  eachRow(parseCsv(sources.blackProgress), (row, geoID) => {
    if (equity[geoID]) {
      equity[geoID].black_progress_index = row.black_progress_index
    } else {
      equity[geoID] = {
        GEOID: geoID,
        county_name: row.county_name,
        state: row.state,
        black_progress_index: row.black_progress_index,
      }
    }
  })

  const transportation = {}
  eachRow(parseCsv(sources.commute), (row, geoID) => {
    transportation[geoID] = {
      GEOID: geoID,
      county_name: row.county_name,
      state_name: row.state_name,
      year: row.year,
      most_frequent_commute_time: row.most_frequent_commute_time,
      commute_time_ordinal: row.commute_time_ordinal,
      pct_drove_alone: row.pct_drove_alone,
      pct_carpooled: row.pct_carpooled,
      pct_public_transit: row.pct_public_transit,
      pct_black: row.pct_black,
    }
  })

  // Counts file: only the per-county total is ever read (tooltip, modal,
  // choropleth, scoring). The per-source breakdown it also carries is 170 KB
  // that nothing opens.
  const contamination = {}
  for (const [geoID, entry] of Object.entries(sources.contamination ?? {})) {
    contamination[geoID] = { total: typeof entry === 'number' ? entry : entry?.total }
  }

  // BLO v1: superseded by v2 as the visible index. Its score and rank are the
  // only fields any consumer can still reach, and they are ~45 KB here instead
  // of a 1.4 MB fetch.
  const combinedScores = {}
  for (const [geoID, entry] of Object.entries(sources.combinedScores ?? {})) {
    combinedScores[geoID] = { combinedScore: entry?.combinedScore, rankScore: entry?.rankScore }
  }

  // BLO v2 (the layer the map opens on): `blo_score_v2` is the only field read.
  // The component/raw breakdowns are 3.3 MB of the source file and nothing
  // renders them.
  const combinedScoresV2 = {}
  for (const [geoID, entry] of Object.entries(sources.combinedScoresV2 ?? {})) {
    combinedScoresV2[geoID] = { blo_score_v2: entry?.blo_score_v2 }
  }

  return {
    version: COUNTY_DATA_VERSION,
    diversity,
    lifeExpectancy,
    contamination,
    combinedScores,
    combinedScoresV2,
    economic,
    housing,
    equity,
    transportation,
  }
}

/** Short content hash — the filename's whole reason to exist. */
/**
 * Round every coordinate in a GeoJSON text to `decimals` places (P5-90,
 * Nick's "coordinate rounding only" choice). The source carries up to 15
 * decimals of a degree — nanometre precision the survey never had — and
 * those digits are a quarter of the file. Four decimals is ~11 m; the map's
 * deepest programmed zoom draws ~125 m per pixel, so no vertex moves a pixel.
 * The vertex count is untouched: this is not simplification.
 *
 * @param {string} text   GeoJSON as text
 * @param {number} decimals
 * @returns {string} compact GeoJSON text with rounded coordinates
 */
export function roundGeometry(text, decimals = 4) {
  const factor = 10 ** decimals
  const round = value => Math.round(value * factor) / factor
  const walk = coords => (typeof coords[0] === 'number' ? coords.map(round) : coords.map(walk))
  const geo = JSON.parse(text)
  const features = geo.type === 'FeatureCollection' ? geo.features : [geo]
  for (const feature of features) {
    const geometry = feature.geometry ?? feature
    if (geometry && Array.isArray(geometry.coordinates)) geometry.coordinates = walk(geometry.coordinates)
  }
  return JSON.stringify(geo)
}

export function hashOf(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 10)
}

// ---------------------------------------------------------------------------
// The build step
// ---------------------------------------------------------------------------

function readSources(root) {
  const sources = {}
  for (const [key, rel] of Object.entries(SOURCE_FILES)) {
    const text = readFileSync(join(root, rel), 'utf8')
    sources[key] = rel.endsWith('.json') ? JSON.parse(text) : text
  }
  return sources
}

/** Remove everything in the build directory that this run did not just write —
 *  old hashes, and anything a person dropped there by hand. */
function pruneBuildDir(buildDir, keep) {
  for (const entry of readdirSync(buildDir)) {
    if (entry.startsWith('.') || keep.has(entry)) continue
    rmSync(join(buildDir, entry), { recursive: true, force: true })
  }
}

/**
 * Build the county data file, the geometry copy and the manifest.
 *
 * @param {object} [options]
 * @param {string} [options.root]      repo root (tests point this at a fixture tree)
 * @param {string} [options.geometry]  county outline file, relative to root or absolute
 * @param {boolean} [options.quiet]    suppress the summary
 * @returns {{countyData: string, counties: string, countyDataBytes: number,
 *            countiesBytes: number, manifest: object}}
 */
export function buildDatasets(options = {}) {
  const root = options.root ?? REPO_ROOT
  const geometrySource = resolve(root, options.geometry ?? DEFAULT_GEOMETRY)
  const buildDir = join(root, BUILD_DIR)

  const data = buildCountyData(readSources(root))
  const countyDataJson = JSON.stringify(data)
  const countyDataName = `county-data.${hashOf(countyDataJson)}.json`

  const precision = options.precision === undefined ? DEFAULT_PRECISION : options.precision
  const geometry = precision === null
    ? readFileSync(geometrySource)
    : Buffer.from(roundGeometry(readFileSync(geometrySource, 'utf8'), precision))
  const countiesName = `counties.${hashOf(geometry)}.geojson`

  mkdirSync(buildDir, { recursive: true })
  pruneBuildDir(buildDir, new Set([countyDataName, countiesName]))
  writeFileSync(join(buildDir, countyDataName), countyDataJson)
  writeFileSync(join(buildDir, countiesName), geometry)

  const manifest = {
    countyData: `${BUILD_URL_PREFIX}/${countyDataName}`,
    counties: `${BUILD_URL_PREFIX}/${countiesName}`,
  }
  const manifestPath = join(root, MANIFEST_FILE)
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const result = {
    ...manifest,
    countyDataBytes: Buffer.byteLength(countyDataJson),
    countiesBytes: geometry.byteLength,
    manifest,
  }

  if (!options.quiet) {
    const mb = n => `${(n / 1024 / 1024).toFixed(2)} MB`
    console.log(`build-datasets: ${BUILD_DIR}/${countyDataName} (${mb(result.countyDataBytes)})`)
    console.log(
      `build-datasets: ${BUILD_DIR}/${countiesName} (${mb(result.countiesBytes)}) ` +
        `from ${options.geometry ?? DEFAULT_GEOMETRY}`,
    )
    console.log(`build-datasets: wrote ${MANIFEST_FILE}`)
  }
  return result
}

/** `--geometry <path>` / `--quiet`. */
export function parseArgs(argv) {
  const options = {}
  const needsPath = () => {
    throw new Error('build-datasets: --geometry needs a file path')
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--quiet') {
      options.quiet = true
    } else if (arg === '--geometry') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) needsPath()
      options.geometry = value
    } else if (arg === '--precision') {
      const value = argv[++i]
      if (value === 'none') options.precision = null
      else if (/^\d+$/.test(value ?? '')) options.precision = Number(value)
      else {
        console.error('build-datasets: --precision needs a number of decimal places, or none')
        process.exit(2)
      }
    } else if (arg.startsWith('--geometry=')) {
      const value = arg.slice('--geometry='.length)
      if (!value) needsPath()
      options.geometry = value
    } else {
      throw new Error(`build-datasets: unknown argument "${arg}"`)
    }
  }
  return options
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.geometry) statSync(resolve(REPO_ROOT, options.geometry)) // fail loudly, early
    buildDatasets(options)
  } catch (err) {
    console.error(`build-datasets failed: ${err.message}`)
    process.exit(1)
  }
}
