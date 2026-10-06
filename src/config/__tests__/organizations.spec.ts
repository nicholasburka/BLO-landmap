import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ORGANIZATIONS,
  ORGANIZATION_IDS,
  foldOrganizationText,
  isOrganizationId,
  organizationFor,
  organizationLabel,
  organizationParent,
} from '@/config/organizations'
import { LAYER_REGISTRY } from '@/config/layerRegistry'

describe('organizations — shape', () => {
  it('gives every organization a kebab id, plain words and at least one alias', () => {
    expect(ORGANIZATIONS.length).toBeGreaterThan(20)
    for (const org of ORGANIZATIONS) {
      expect(org.id, JSON.stringify(org)).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(org.label.trim().length).toBeGreaterThan(0)
      expect(org.label).not.toBe(org.id)
      expect(org.aliases.length).toBeGreaterThan(0)
      for (const alias of org.aliases) expect(alias.trim().length, `${org.id}: "${alias}"`).toBeGreaterThan(0)
    }
  })

  it('has one entry per id, and every parent is an organization of its own', () => {
    expect(new Set(ORGANIZATION_IDS).size).toBe(ORGANIZATION_IDS.length)
    for (const org of ORGANIZATIONS) {
      if (!org.parent) continue
      expect(isOrganizationId(org.parent), `${org.id} → ${org.parent}`).toBe(true)
      // One level. A sub-unit of a sub-unit would make "USDA · NRCS · …"
      // headings, and nothing in the library needs that.
      expect(organizationParent(org.parent)).toBeNull()
    }
  })

  it('carries the USDA sub-units under one parent, named the way they are shown', () => {
    for (const id of ['usda-nass', 'usda-nrcs', 'usda-fs', 'usda-fpac']) {
      expect(organizationParent(id), id).toBe('usda')
      expect(organizationLabel(id).startsWith('USDA · '), id).toBe(true)
    }
  })

  it('never gives the same alias to two organizations', () => {
    const seen = new Map<string, string>()
    for (const org of ORGANIZATIONS) {
      for (const alias of org.aliases) {
        const folded = foldOrganizationText(alias)
        const owner = seen.get(folded)
        expect(owner, `"${alias}" belongs to both ${owner} and ${org.id}`).toBeUndefined()
        seen.set(folded, org.id)
      }
    }
  })

  it('keeps the initiative’s own words out of a module the public bundle reaches', () => {
    // The bundle-leak gate scans dist/ for these; this test says why, and
    // catches it in the suite rather than at the end of a build. It is what
    // keeps the `blo` alias cut short at "final folder for".
    const words = JSON.stringify(ORGANIZATIONS).toLowerCase()
    for (const canary of ['homesteading', 'blo-library', 'p518-standin', 'library_users']) {
      expect(words, `organizations mentions "${canary}"`).not.toContain(canary)
    }
  })
})

describe('organizations — folding a publisher string', () => {
  it('folds case, punctuation and whitespace away', () => {
    expect(foldOrganizationText('US EPA')).toBe('us epa')
    expect(foldOrganizationText('  NAACP & Brookings Institution ')).toBe('naacp brookings institution')
    expect(foldOrganizationText('engaginglandowners.org')).toBe('engaginglandowners org')
    expect(foldOrganizationText('US DOT — PHMSA')).toBe('us dot phmsa')
  })

  it('matches a name exactly', () => {
    expect(organizationFor('FEMA')).toBe('fema')
    expect(organizationFor('usgs')).toBe('usgs')
    expect(organizationFor('US Fish and Wildlife Service')).toBe('usfws')
  })

  it('matches a name the publisher then qualified', () => {
    expect(organizationFor('US EPA (decommissioned)')).toBe('epa')
    expect(organizationFor('NOAA National Hurricane Center')).toBe('noaa')
    expect(organizationFor('Regrid (Loveland Technologies)')).toBe('regrid')
    expect(organizationFor('HUD (publisher) and the US Treasury CDFI Fund (designating authority)')).toBe('hud')
    expect(organizationFor('NCED partnership (Ducks Unlimited, Trust for Public Land)')).toBe('nced')
  })

  it('files a sub-unit under itself, not under its parent', () => {
    expect(organizationFor('USDA NASS')).toBe('usda-nass')
    expect(organizationFor('USDA NRCS')).toBe('usda-nrcs')
    expect(organizationFor('USDA Forest Service, Southern Research Station')).toBe('usda-fs')
    expect(organizationFor('USDA Farm Production and Conservation')).toBe('usda-fpac')
    // The parent still answers for itself.
    expect(organizationFor('USDA')).toBe('usda')
  })

  it('maps this library’s own provenance prose onto us', () => {
    expect(organizationFor('Black Land Ownership (BLO)')).toBe('blo')
    expect(organizationFor('final folder for a plan / (Nick, 2026-09)')).toBe('blo')
    expect(organizationFor('engaginglandowners.org — TELE Engagement Guide')).toBe('tele')
  })

  it('matches only on a word boundary, so a short alias cannot claim a longer name', () => {
    expect(organizationFor('Bloomberg Philanthropies')).toBeNull()
    expect(organizationFor('Census of Agriculture')).toBeNull()
    expect(organizationFor('Nassau County Assessor')).toBeNull()
  })

  it('says nothing rather than guessing, and nothing about nothing', () => {
    expect(organizationFor('Shelby County Register of Deeds')).toBeNull()
    expect(organizationFor('')).toBeNull()
    expect(organizationFor(undefined)).toBeNull()
    expect(organizationFor('   ')).toBeNull()
  })

  it('shows an unknown publisher as it was written rather than as a blank', () => {
    expect(organizationLabel('epa')).toBe('US EPA')
    expect(organizationLabel('usda-fs')).toBe('USDA · Forest Service')
    expect(organizationLabel('Shelby County Register of Deeds')).toBe('Shelby County Register of Deeds')
  })
})

describe('organizations — every publisher the app already names', () => {
  it('files each public map layer under an organization', () => {
    for (const layer of Object.values(LAYER_REGISTRY)) {
      if (layer.category === 'internal') continue
      expect(organizationFor(layer.source), `${layer.id}: "${layer.source}"`).not.toBeNull()
    }
  })
})

describe('organizations — the server copy', () => {
  it('matches the exported JSON the server reads (run `npm run export:layers` after editing the vocabulary)', () => {
    const path = resolve(process.cwd(), 'server/src/prompt/organizations.generated.json')
    const exported = JSON.parse(readFileSync(path, 'utf8')) as { id: string; label: string; parent?: string; aliases: string[] }[]
    expect(exported).toEqual(
      ORGANIZATIONS.map(org => ({
        id: org.id,
        label: org.label,
        ...(org.parent ? { parent: org.parent } : {}),
        aliases: org.aliases,
      })),
    )
  })
})
