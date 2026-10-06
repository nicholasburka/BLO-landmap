/**
 * The United States, as the three spellings everything here needs.
 *
 * A state turns up in this codebase under three names: the **2-digit FIPS**
 * prefix that begins every county GEOID (`13121` → `13`), the **2-letter
 * postal code** a person writes in a filter or the chat's region axis (`GA`),
 * and the **name** a heading reads (`Georgia`). Those were three separate
 * tables — this file's FIPS map, `STATE_ABBR_BY_NAME` buried in
 * `useMapState.ts`, and the county lookup's lazily-fetched JSON — so a
 * caller holding one spelling could not reliably reach the others.
 *
 * One row per state now carries all three, and the helpers below are the only
 * conversions. P6-19 needs every direction of it: a held table's GEOIDs give
 * FIPS prefixes, a manifest's `coverage: state:GA` gives a code, and a chip
 * has to read "Georgia".
 *
 * Territories are included: EPA and FEMA data covers Puerto Rico and the
 * Virgin Islands, and a ranking that renders "Unknown State" for a real place
 * is a bug rather than a simplification.
 *
 * ## This module ships in the PUBLIC bundle
 *
 * `CountyModal` and `RankingPanel` read it and the public map reaches those —
 * the same rule that governs `taxonomy.ts` and `organizations.ts`. Everything
 * below is an ordinary public fact about the United States, which is why it
 * can be.
 *
 * The server reads the same table from
 * `server/src/prompt/taxonomy.generated.json`, written by
 * `npm run export:layers`. A stale export fails a test on both sides.
 */

export interface UsState {
  /** 2-digit FIPS: the first two digits of every county GEOID. */
  fips: string
  /** 2-letter postal code — how a person writes a state. */
  code: string
  /** Plain words for a heading. */
  name: string
}

/** The 50 states, DC, and the five inhabited territories, in FIPS order. */
export const US_STATES: UsState[] = [
  { fips: '01', code: 'AL', name: 'Alabama' },
  { fips: '02', code: 'AK', name: 'Alaska' },
  { fips: '04', code: 'AZ', name: 'Arizona' },
  { fips: '05', code: 'AR', name: 'Arkansas' },
  { fips: '06', code: 'CA', name: 'California' },
  { fips: '08', code: 'CO', name: 'Colorado' },
  { fips: '09', code: 'CT', name: 'Connecticut' },
  { fips: '10', code: 'DE', name: 'Delaware' },
  { fips: '11', code: 'DC', name: 'District of Columbia' },
  { fips: '12', code: 'FL', name: 'Florida' },
  { fips: '13', code: 'GA', name: 'Georgia' },
  { fips: '15', code: 'HI', name: 'Hawaii' },
  { fips: '16', code: 'ID', name: 'Idaho' },
  { fips: '17', code: 'IL', name: 'Illinois' },
  { fips: '18', code: 'IN', name: 'Indiana' },
  { fips: '19', code: 'IA', name: 'Iowa' },
  { fips: '20', code: 'KS', name: 'Kansas' },
  { fips: '21', code: 'KY', name: 'Kentucky' },
  { fips: '22', code: 'LA', name: 'Louisiana' },
  { fips: '23', code: 'ME', name: 'Maine' },
  { fips: '24', code: 'MD', name: 'Maryland' },
  { fips: '25', code: 'MA', name: 'Massachusetts' },
  { fips: '26', code: 'MI', name: 'Michigan' },
  { fips: '27', code: 'MN', name: 'Minnesota' },
  { fips: '28', code: 'MS', name: 'Mississippi' },
  { fips: '29', code: 'MO', name: 'Missouri' },
  { fips: '30', code: 'MT', name: 'Montana' },
  { fips: '31', code: 'NE', name: 'Nebraska' },
  { fips: '32', code: 'NV', name: 'Nevada' },
  { fips: '33', code: 'NH', name: 'New Hampshire' },
  { fips: '34', code: 'NJ', name: 'New Jersey' },
  { fips: '35', code: 'NM', name: 'New Mexico' },
  { fips: '36', code: 'NY', name: 'New York' },
  { fips: '37', code: 'NC', name: 'North Carolina' },
  { fips: '38', code: 'ND', name: 'North Dakota' },
  { fips: '39', code: 'OH', name: 'Ohio' },
  { fips: '40', code: 'OK', name: 'Oklahoma' },
  { fips: '41', code: 'OR', name: 'Oregon' },
  { fips: '42', code: 'PA', name: 'Pennsylvania' },
  { fips: '44', code: 'RI', name: 'Rhode Island' },
  { fips: '45', code: 'SC', name: 'South Carolina' },
  { fips: '46', code: 'SD', name: 'South Dakota' },
  { fips: '47', code: 'TN', name: 'Tennessee' },
  { fips: '48', code: 'TX', name: 'Texas' },
  { fips: '49', code: 'UT', name: 'Utah' },
  { fips: '50', code: 'VT', name: 'Vermont' },
  { fips: '51', code: 'VA', name: 'Virginia' },
  { fips: '53', code: 'WA', name: 'Washington' },
  { fips: '54', code: 'WV', name: 'West Virginia' },
  { fips: '55', code: 'WI', name: 'Wisconsin' },
  { fips: '56', code: 'WY', name: 'Wyoming' },
  { fips: '60', code: 'AS', name: 'American Samoa' },
  { fips: '66', code: 'GU', name: 'Guam' },
  { fips: '69', code: 'MP', name: 'Northern Mariana Islands' },
  { fips: '72', code: 'PR', name: 'Puerto Rico' },
  { fips: '78', code: 'VI', name: 'U.S. Virgin Islands' },
]

/**
 * How many of these are STATES, for the purpose of "is this nationwide?".
 *
 * P6-19 reads ≥45 distinct states off a table as `national`. The threshold is
 * about the 50 states and DC — a table covering every state but missing Guam
 * is nationwide — so the territories are not counted in the denominator.
 */
export const US_STATE_COUNT = 51

/** FIPS code to state name. Kept as its own export: the map's ranking and
 *  county modal have read it since long before the rest of this file. */
export const FIPS_TO_STATE: Record<string, string> = Object.fromEntries(US_STATES.map(s => [s.fips, s.name]))

const BY_FIPS = new Map(US_STATES.map(s => [s.fips, s]))
const BY_CODE = new Map(US_STATES.map(s => [s.code, s]))
const BY_FOLDED_NAME = new Map(US_STATES.map(s => [s.name.toLowerCase(), s]))

/** Get state name from FIPS code. */
export function getStateNameFromFips(fipsCode: string): string {
  return FIPS_TO_STATE[fipsCode] || 'Unknown State'
}

/** The postal code for a 2-digit FIPS prefix, or '' when it names no state. */
export function stateCodeForFips(fipsCode: string): string {
  return BY_FIPS.get(fipsCode.trim())?.code ?? ''
}

/** The name for a postal code, or '' when it names no state. */
export function stateNameForCode(code: string): string {
  return BY_CODE.get(code.trim().toUpperCase())?.name ?? ''
}

/**
 * A state's postal code, from however it was written: a code (`ga`, `GA`), a
 * name (`Georgia`, `georgia`) or a FIPS prefix (`13`). '' when nothing matches
 * — never a guess, because a wrong state is worse than no state.
 */
export function stateCodeFor(text: string): string {
  const value = text.trim()
  if (!value) return ''
  if (/^\d{2}$/.test(value)) return stateCodeForFips(value)
  const upper = value.toUpperCase()
  if (BY_CODE.has(upper)) return upper
  return BY_FOLDED_NAME.get(value.toLowerCase())?.code ?? ''
}
