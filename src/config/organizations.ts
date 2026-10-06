/**
 * Who published a thing (P6-1).
 *
 * The library's third question, beside "what is it about" (topic) and "what is
 * it for" (purpose): **who published it**. It was never asked as a word — the
 * answer lived in a source block's `provider` ("US EPA", "US EPA
 * (decommissioned)", "USDA Forest Service, Southern Research Station") or in a
 * dataset's free `source` prose ("DC Open Data — Community Gardens (ArcGIS
 * export, EDITED 2024-11-19), from …"), which meant the same publisher had a
 * dozen spellings and could not be grouped, counted or filtered.
 *
 * So: one curated vocabulary, the same shape as the taxonomy — a canonical id,
 * a display label, an optional parent, and the spellings we have collected.
 * Reindex folds a provider string through it and stores the id on the row; the
 * datasets browser groups by it.
 *
 * ## Matching
 *
 * `organizationFor` folds case, whitespace and punctuation away and then asks
 * whether the text EQUALS an alias or BEGINS with one, longest alias first.
 * Beginning with one is what makes the collected strings work: a provider is
 * almost always the publisher's name followed by qualifiers — a programme, a
 * decommissioning note, a research station, an export date — and the publisher
 * is the part in front.
 *
 * A string nothing matches is NOT guessed at. `organizationFor` returns null
 * and the caller keeps the text as its own group, which is what the admin
 * queue's "Datasets with no organization" row counts.
 *
 * ## This module ships in the PUBLIC bundle
 *
 * `src/lib/publicLayers.ts` reads it, and the public map reaches that — the
 * same rule that governs `taxonomy.ts`. So everything below is a publisher's
 * ordinary public name. No dataset slug, no entry title and none of the
 * initiative's own words belong here; the bundle-leak gate
 * (`scripts/check-bundle-leaks.mjs`) enforces the ones we have named, and a
 * test below keeps this file clean of them.
 *
 * The server reads the same table from
 * `server/src/prompt/organizations.generated.json`, written by
 * `npm run export:layers`. A stale export fails a test on both sides.
 */

export interface Organization {
  /** kebab-case, stable: it is written into manifests and into URLs. */
  id: string
  /** Plain words, shown to a reader. A sub-unit reads "USDA · Forest Service". */
  label: string
  /** The parent organization's id, for the sub-units of one agency. */
  parent?: string
  /**
   * Spellings we have collected, plus the obvious short forms. Matched
   * case-insensitively with punctuation folded to spaces, as a whole string or
   * as the beginning of one — so keep them to the publisher's NAME and leave
   * the programme, the year and the export note out.
   */
  aliases: string[]
}

/**
 * Seeded from every publisher the library names today: the `provider` of each
 * data source, the free `source` prose on each held dataset and document, and
 * the `source` of each public map layer.
 *
 * Federal agencies first (the bulk of the registry), then the state and city
 * agencies, then the non-government publishers, then us.
 */
export const ORGANIZATIONS: Organization[] = [
  {
    id: 'epa',
    label: 'US EPA',
    aliases: ['us epa', 'epa', 'environmental protection agency', 'us environmental protection agency', 'united states environmental protection agency'],
  },
  {
    id: 'usgs',
    label: 'USGS',
    aliases: ['usgs', 'us geological survey', 'united states geological survey'],
  },
  {
    id: 'fema',
    label: 'FEMA',
    aliases: ['fema', 'federal emergency management agency'],
  },
  {
    id: 'noaa',
    label: 'NOAA',
    aliases: ['noaa', 'national oceanic and atmospheric administration'],
  },
  {
    id: 'hud',
    label: 'HUD',
    aliases: ['hud', 'us department of housing and urban development', 'department of housing and urban development'],
  },
  {
    id: 'census',
    // Never a bare "census": "Census of Agriculture" is published by USDA.
    label: 'US Census Bureau',
    aliases: ['us census bureau', 'united states census bureau', 'census bureau', 'us census'],
  },
  {
    id: 'usdot-phmsa',
    label: 'US DOT · PHMSA',
    aliases: [
      'us dot pipeline and hazardous materials safety administration',
      'us dot phmsa',
      'pipeline and hazardous materials safety administration',
      'phmsa',
    ],
  },
  {
    id: 'dol-msha',
    label: 'US Department of Labor · MSHA',
    aliases: [
      'us department of labor mine safety and health administration',
      'us department of labor msha',
      'mine safety and health administration',
      'msha',
    ],
  },
  {
    id: 'usfws',
    label: 'US Fish and Wildlife Service',
    aliases: ['us fish and wildlife service', 'united states fish and wildlife service', 'fish and wildlife service', 'usfws'],
  },
  {
    id: 'eia',
    label: 'US Energy Information Administration',
    aliases: ['us energy information administration', 'energy information administration', 'eia'],
  },
  {
    id: 'usda',
    label: 'USDA',
    aliases: ['usda', 'us department of agriculture', 'united states department of agriculture', 'department of agriculture'],
  },
  {
    id: 'usda-nass',
    label: 'USDA · NASS',
    parent: 'usda',
    aliases: ['usda nass', 'usda national agricultural statistics service', 'national agricultural statistics service', 'nass'],
  },
  {
    id: 'usda-nrcs',
    label: 'USDA · NRCS',
    parent: 'usda',
    aliases: ['usda nrcs', 'usda natural resources conservation service', 'natural resources conservation service', 'nrcs'],
  },
  {
    id: 'usda-fs',
    label: 'USDA · Forest Service',
    parent: 'usda',
    aliases: ['usda forest service', 'us forest service', 'forest service', 'usfs'],
  },
  {
    id: 'usda-fpac',
    label: 'USDA · Farm Production and Conservation',
    parent: 'usda',
    aliases: [
      'usda farm production and conservation',
      'farm production and conservation',
      'usda fpac',
      'usda farm service agency',
      'farm service agency',
    ],
  },
  {
    id: 'georgia-epd',
    label: 'Georgia EPD',
    aliases: ['georgia environmental protection division', 'georgia epd', 'ga epd'],
  },
  {
    id: 'nc-deq',
    label: 'North Carolina DEQ',
    aliases: ['north carolina department of environmental quality', 'north carolina deq', 'nc deq'],
  },
  {
    id: 'alabama-adem',
    label: 'Alabama ADEM',
    aliases: ['alabama department of environmental management', 'alabama adem', 'adem'],
  },
  {
    id: 'dc-open-data',
    label: 'DC Open Data',
    aliases: ['dc open data', 'district of columbia open data', 'opendata dc'],
  },
  {
    id: 'memphis-horticulture',
    label: 'Memphis Horticulture Society',
    aliases: ['memphis horticulture society', 'memphis horticultural society'],
  },
  {
    id: 'nced',
    label: 'NCED partnership',
    aliases: ['nced partnership', 'nced', 'national conservation easement database'],
  },
  {
    id: 'regrid',
    label: 'Regrid',
    aliases: ['regrid', 'loveland technologies'],
  },
  {
    id: 'urban-institute',
    label: 'Urban Institute',
    aliases: ['urban institute', 'diversity data kids', 'diversitydatakids'],
  },
  {
    id: 'bwdc',
    label: 'Black Worker Data Center',
    aliases: ['black worker data center', 'bwdc'],
  },
  {
    id: 'bls',
    label: 'US Bureau of Labor Statistics',
    aliases: ['us bureau of labor statistics', 'bureau of labor statistics', 'bls'],
  },
  {
    id: 'naacp-brookings',
    // Never a bare "naacp" or "brookings": this is the joint publication, and
    // either alone would swallow a future source from one of them.
    label: 'NAACP & Brookings',
    aliases: ['naacp brookings', 'naacp and brookings'],
  },
  {
    id: 'ihme',
    label: 'Institute for Health Metrics and Evaluation',
    aliases: ['institute for health metrics and evaluation', 'ihme'],
  },
  {
    id: 'tele',
    label: 'TELE (Yale / UMass)',
    aliases: ['engaginglandowners', 'tele', 'tools for engaging landowners effectively'],
  },
  {
    id: 'blo',
    label: 'Black Land Ownership (BLO)',
    // The founding content load's manifests say where the material came from
    // in prose that begins "final folder for …". The alias is deliberately cut
    // at that prefix: this module ships in the public bundle, and the rest of
    // that sentence is the initiative's own words, which the bundle-leak gate
    // forbids in client code. Nothing else in the tree begins that way.
    aliases: ['black land ownership', 'blo', 'final folder for'],
  },
]

// --- Helpers ---------------------------------------------------------------

const BY_ID = new Map(ORGANIZATIONS.map(o => [o.id, o]))

export const ORGANIZATION_IDS: string[] = ORGANIZATIONS.map(o => o.id)

export function isOrganizationId(id: string): boolean {
  return BY_ID.has(id)
}

/** The display label, or the text itself when we have never met it — an
 *  unknown publisher is shown as it was written, never as a blank. */
export function organizationLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id
}

/** The parent agency's id for a sub-unit, else null. */
export function organizationParent(id: string): string | null {
  return BY_ID.get(id)?.parent ?? null
}

/**
 * One publisher string, reduced to what can be compared: lowercase, and every
 * run of punctuation or whitespace collapsed to a single space. Em dashes,
 * ampersands, brackets, full stops in "engaginglandowners.org" — all of them
 * are typography, not identity.
 */
export function foldOrganizationText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Longest alias first, so "USDA NASS" is NASS and not USDA. Built once: the
 * table is fixed at module load and this runs on every catalog row.
 */
const ALIAS_INDEX: { alias: string; id: string }[] = ORGANIZATIONS.flatMap(org =>
  org.aliases.map(alias => ({ alias: foldOrganizationText(alias), id: org.id })),
).sort((a, b) => b.alias.length - a.alias.length)

/**
 * The organization a publisher string names, or null when nothing in the
 * vocabulary does.
 *
 * Matches the whole folded string or its beginning — on a word boundary, so
 * "blo" cannot claim "Bloomberg". Null is a real answer: the caller keeps the
 * text as its own group rather than filing it under a guess.
 */
export function organizationFor(text: string | undefined | null): string | null {
  const folded = foldOrganizationText(text ?? '')
  if (!folded) return null
  for (const { alias, id } of ALIAS_INDEX) {
    if (folded === alias || folded.startsWith(`${alias} `)) return id
  }
  return null
}
