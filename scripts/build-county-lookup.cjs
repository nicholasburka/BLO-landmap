#!/usr/bin/env node
/**
 * Build a lightweight county lookup index from the counties GeoJSON.
 *
 * Output: public/datasets/geographic/county-lookup.json
 * Shape: [{ geoId, name, stateName, stateAbbr }]
 */

const fs = require('fs')
const path = require('path')

const FIPS_TO_STATE = {
  '01': { name: 'Alabama', abbr: 'AL' },
  '02': { name: 'Alaska', abbr: 'AK' },
  '04': { name: 'Arizona', abbr: 'AZ' },
  '05': { name: 'Arkansas', abbr: 'AR' },
  '06': { name: 'California', abbr: 'CA' },
  '08': { name: 'Colorado', abbr: 'CO' },
  '09': { name: 'Connecticut', abbr: 'CT' },
  '10': { name: 'Delaware', abbr: 'DE' },
  '11': { name: 'District of Columbia', abbr: 'DC' },
  '12': { name: 'Florida', abbr: 'FL' },
  '13': { name: 'Georgia', abbr: 'GA' },
  '15': { name: 'Hawaii', abbr: 'HI' },
  '16': { name: 'Idaho', abbr: 'ID' },
  '17': { name: 'Illinois', abbr: 'IL' },
  '18': { name: 'Indiana', abbr: 'IN' },
  '19': { name: 'Iowa', abbr: 'IA' },
  '20': { name: 'Kansas', abbr: 'KS' },
  '21': { name: 'Kentucky', abbr: 'KY' },
  '22': { name: 'Louisiana', abbr: 'LA' },
  '23': { name: 'Maine', abbr: 'ME' },
  '24': { name: 'Maryland', abbr: 'MD' },
  '25': { name: 'Massachusetts', abbr: 'MA' },
  '26': { name: 'Michigan', abbr: 'MI' },
  '27': { name: 'Minnesota', abbr: 'MN' },
  '28': { name: 'Mississippi', abbr: 'MS' },
  '29': { name: 'Missouri', abbr: 'MO' },
  '30': { name: 'Montana', abbr: 'MT' },
  '31': { name: 'Nebraska', abbr: 'NE' },
  '32': { name: 'Nevada', abbr: 'NV' },
  '33': { name: 'New Hampshire', abbr: 'NH' },
  '34': { name: 'New Jersey', abbr: 'NJ' },
  '35': { name: 'New Mexico', abbr: 'NM' },
  '36': { name: 'New York', abbr: 'NY' },
  '37': { name: 'North Carolina', abbr: 'NC' },
  '38': { name: 'North Dakota', abbr: 'ND' },
  '39': { name: 'Ohio', abbr: 'OH' },
  '40': { name: 'Oklahoma', abbr: 'OK' },
  '41': { name: 'Oregon', abbr: 'OR' },
  '42': { name: 'Pennsylvania', abbr: 'PA' },
  '44': { name: 'Rhode Island', abbr: 'RI' },
  '45': { name: 'South Carolina', abbr: 'SC' },
  '46': { name: 'South Dakota', abbr: 'SD' },
  '47': { name: 'Tennessee', abbr: 'TN' },
  '48': { name: 'Texas', abbr: 'TX' },
  '49': { name: 'Utah', abbr: 'UT' },
  '50': { name: 'Vermont', abbr: 'VT' },
  '51': { name: 'Virginia', abbr: 'VA' },
  '53': { name: 'Washington', abbr: 'WA' },
  '54': { name: 'West Virginia', abbr: 'WV' },
  '55': { name: 'Wisconsin', abbr: 'WI' },
  '56': { name: 'Wyoming', abbr: 'WY' },
}

// LSAD codes for county-level designations (informs suffix in full name)
const LSAD_SUFFIX = {
  '06': 'County',
  '15': 'Borough',
  '04': 'Borough',
  '05': 'Census Area',
  '03': 'City and Borough',
  '10': 'Island',
  '12': 'Municipality',
  '13': 'Parish',
  '20': 'city',
  '25': 'city',
  '00': '', // Independent
}

const GEOJSON_PATH = path.join(__dirname, '..', 'public', 'datasets', 'geographic', 'counties.geojson')
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'datasets', 'geographic', 'county-lookup.json')

console.log('Reading counties GeoJSON...')
const raw = fs.readFileSync(GEOJSON_PATH, 'utf8')
const data = JSON.parse(raw)

console.log(`Processing ${data.features.length} features...`)
const lookup = []
let skipped = 0

for (const feature of data.features) {
  const props = feature.properties
  const stateFips = props.STATEFP
  const stateInfo = FIPS_TO_STATE[stateFips]

  // Skip territories (Puerto Rico, Guam, etc.) not in our 50 states + DC
  if (!stateInfo) {
    skipped++
    continue
  }

  const lsad = props.LSAD || '06'
  const suffix = LSAD_SUFFIX[lsad] !== undefined ? LSAD_SUFFIX[lsad] : 'County'
  // Some names already include the suffix
  const baseName = props.NAME
  const fullName = suffix && !baseName.toLowerCase().includes(suffix.toLowerCase())
    ? `${baseName} ${suffix}`
    : baseName

  lookup.push({
    geoId: props.GEOID,
    name: fullName.trim(),
    baseName: baseName,
    stateName: stateInfo.name,
    stateAbbr: stateInfo.abbr,
  })
}

console.log(`Built lookup with ${lookup.length} counties (skipped ${skipped} territories)`)

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(lookup))
const sizeKb = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)
console.log(`Wrote ${OUTPUT_PATH} (${sizeKb} KB)`)
