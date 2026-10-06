import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ORGANIZATIONS,
  ORGANIZATION_IDS,
  foldOrganizationText,
  isOrganizationId,
  organizationFor,
  organizationForMeta,
  organizationLabel,
  organizationParent,
  providerTextOf,
} from './organizations.js'

/**
 * P6-1: the server's copy of the organization vocabulary is generated
 * (`npm run export:layers` at the repo root) and committed, because the server
 * has no way to read the client's TypeScript at runtime.
 *
 * The client half of this contract is src/config/__tests__/organizations.spec.ts,
 * which fails when the export is stale against the module a person edits. This
 * half fails when the committed JSON does not describe a usable vocabulary at
 * all, and covers the one thing only the server does with it: reading a
 * publisher off a manifest.
 */
describe('organizations.generated.json', () => {
  it('describes every organization well enough to file by', () => {
    expect(ORGANIZATIONS.length).toBeGreaterThan(20)
    for (const org of ORGANIZATIONS) {
      expect(org.id, JSON.stringify(org)).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(org.label.trim().length).toBeGreaterThan(0)
      expect(org.aliases.length).toBeGreaterThan(0)
      if (org.parent) expect(isOrganizationId(org.parent), org.id).toBe(true)
    }
    expect(new Set(ORGANIZATION_IDS).size).toBe(ORGANIZATION_IDS.length)
  })

  it('is the file the export script writes, entry for entry', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = JSON.parse(readFileSync(join(here, '../prompt/organizations.generated.json'), 'utf8'))
    expect(raw).toEqual(ORGANIZATIONS)
  })

  it('carries the publishers the library names most', () => {
    for (const id of ['epa', 'usgs', 'fema', 'noaa', 'hud', 'census', 'usda', 'usda-fs', 'blo', 'tele']) {
      expect(isOrganizationId(id), id).toBe(true)
    }
  })
})

describe('organizations — folding a publisher string', () => {
  it('folds punctuation and matches on the name in front', () => {
    expect(foldOrganizationText('US DOT — PHMSA')).toBe('us dot phmsa')
    expect(organizationFor('US EPA (decommissioned)')).toBe('epa')
    expect(organizationFor('USDA Forest Service, Southern Research Station')).toBe('usda-fs')
    expect(organizationFor('Shelby County Register of Deeds')).toBeNull()
  })

  it('labels a sub-unit under its parent and says who the parent is', () => {
    expect(organizationLabel('usda-nrcs')).toBe('USDA · NRCS')
    expect(organizationParent('usda-nrcs')).toBe('usda')
    expect(organizationParent('usda')).toBeNull()
  })
})

describe('organizations — reading a manifest', () => {
  it('reads the provider out of a cleaned source block', () => {
    expect(providerTextOf({ source: { provider: 'US EPA', program: 'Superfund' } })).toBe('US EPA')
    expect(organizationForMeta({ source: { provider: 'FEMA' } })).toBe('fema')
  })

  it('reads the free source prose a dataset has always carried', () => {
    const meta = { source: 'DC Open Data — Community Gardens (ArcGIS export, EDITED 2024-11-19)' }
    expect(providerTextOf(meta)).toBe(meta.source)
    expect(organizationForMeta(meta)).toBe('dc-open-data')
  })

  it('lets the manifest field win, and reads it through the aliases too', () => {
    // A stated id is taken as it is…
    expect(organizationForMeta({ organization: 'usda-nass', source: { provider: 'US EPA' } })).toBe('usda-nass')
    // …and a stated NAME is folded, so a hand-written field is not a group of
    // one beside the entries whose provider says the same thing.
    expect(organizationForMeta({ organization: 'US Census Bureau' })).toBe('census')
  })

  it('keeps an unknown publisher’s own text as its group', () => {
    const meta = { source: { provider: 'Shelby County Register of Deeds' } }
    expect(organizationForMeta(meta)).toBe('Shelby County Register of Deeds')
    expect(isOrganizationId(organizationForMeta(meta))).toBe(false)
    // Including one somebody wrote into the field by hand.
    expect(organizationForMeta({ organization: 'Some New Agency' })).toBe('Some New Agency')
  })

  it('says nothing when the manifest names nobody', () => {
    expect(organizationForMeta({})).toBe('')
    expect(organizationForMeta(undefined)).toBe('')
    expect(organizationForMeta({ source: '   ' })).toBe('')
    expect(organizationForMeta({ source: { program: 'no provider here' } })).toBe('')
  })
})
