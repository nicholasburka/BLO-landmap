import organizations from '../prompt/organizations.generated.json' with { type: 'json' }

/**
 * The server's half of the organization vocabulary (P6-1).
 *
 * The vocabulary itself lives in `src/config/organizations.ts` on the client,
 * which is where a person edits it; `npm run export:layers` writes it here as
 * plain data. Same contract as the taxonomy, for the same reason: the server
 * cannot import the client's TypeScript at runtime and a second hand-kept copy
 * would drift within a week. A stale export fails a test on both sides.
 *
 * What this module adds on top of the generated table is the one question the
 * server actually asks: **who published the entry this manifest describes**.
 */

export interface Organization {
  id: string
  label: string
  parent?: string
  aliases: string[]
}

export const ORGANIZATIONS: Organization[] = organizations as Organization[]
export const ORGANIZATION_IDS: string[] = ORGANIZATIONS.map(o => o.id)

const BY_ID = new Map(ORGANIZATIONS.map(o => [o.id, o]))

export function isOrganizationId(id: string): boolean {
  return BY_ID.has(id)
}

/** The display label, or the text itself for a publisher we have never met. */
export function organizationLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id
}

export function organizationParent(id: string): string | null {
  return BY_ID.get(id)?.parent ?? null
}

/** Lowercase, punctuation and whitespace folded to single spaces. */
export function foldOrganizationText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Longest alias first, so "USDA NASS" is NASS and not USDA. */
const ALIAS_INDEX: { alias: string; id: string }[] = ORGANIZATIONS.flatMap(org =>
  org.aliases.map(alias => ({ alias: foldOrganizationText(alias), id: org.id })),
).sort((a, b) => b.alias.length - a.alias.length)

/**
 * The organization a publisher string names, or null when nothing does.
 *
 * Whole match or beginning-of-string on a word boundary — a provider is
 * almost always the publisher's name followed by qualifiers ("US EPA
 * (decommissioned)", "USDA Forest Service, Southern Research Station"), and
 * the publisher is the part in front.
 */
export function organizationFor(text: string | undefined | null): string | null {
  const folded = foldOrganizationText(text ?? '')
  if (!folded) return null
  for (const { alias, id } of ALIAS_INDEX) {
    if (folded === alias || folded.startsWith(`${alias} `)) return id
  }
  return null
}

/**
 * The publisher STRING a manifest offers, whichever way it says it: a cleaned
 * `source` block's provider, or the free `source` prose a dataset has carried
 * since the first content load ("DC Open Data — Community Gardens …").
 */
export function providerTextOf(meta: Record<string, unknown> | undefined | null): string {
  const raw = meta?.source
  if (typeof raw === 'string') return raw.trim()
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const provider = (raw as { provider?: unknown }).provider
    if (typeof provider === 'string') return provider.trim()
  }
  return ''
}

/**
 * Who published this entry: the manifest's own `organization` when it has one,
 * otherwise the publisher string folded through the aliases.
 *
 * A stated `organization` is read through the aliases too, so a manifest that
 * says `"organization": "US EPA"` files under `epa` rather than under a
 * one-entry group of its own.
 *
 * What comes back is either a vocabulary id or, for a publisher the vocabulary
 * has never met, that publisher's own trimmed text — its own group, counted in
 * the admin queue's "Datasets with no organization" row. An entry that names
 * no publisher at all gets `''`.
 */
export function organizationForMeta(meta: Record<string, unknown> | undefined | null): string {
  const stated = typeof meta?.organization === 'string' ? meta.organization.trim() : ''
  if (stated) return isOrganizationId(stated) ? stated : (organizationFor(stated) ?? stated)
  const provider = providerTextOf(meta)
  return provider ? (organizationFor(provider) ?? provider) : ''
}
