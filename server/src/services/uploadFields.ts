/**
 * The checks every upload passes, wherever it came in (P6-8).
 *
 * P5-10's single upload grew these five rules — how big a file may be, what a
 * stored name is allowed to look like, how long a filing field may be, how
 * many tags, how long a tag. The bulk drop has to apply exactly the same ones:
 * "the same type, size and key checks as a single upload" is the spec's
 * wording, and the only way to keep that true is for there to be one copy.
 *
 * Nothing here touches a bucket, a request or a database — it is the rules by
 * themselves, so both routes and their tests can use them.
 */

/** Spec default: 200 MB for one file through the single-upload route. */
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024

export function maxUploadBytes(): number {
  const raw = Number(process.env.LIBRARY_UPLOAD_MAX_BYTES)
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES
}

export function prettyBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${n} bytes`
}

// A stored filename is one segment of a bucket key and one component of a
// mirror path, so it is capped well under the bucket's own 200-byte limit.
export const MAX_FILENAME = 120

/** Trim the stem, never the extension — the extension decides the stored
 *  Content-Type and whether the dataset explorer will open the file. */
export function capFilename(name: string): string {
  if (name.length <= MAX_FILENAME) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const kept = ext.length > 0 && ext.length <= 16 ? ext : ''
  return name.slice(0, MAX_FILENAME - kept.length) + kept
}

/** Stored keys must satisfy libraryBucket's SAFE_KEY charset. The original
 *  (unsanitized) filename is preserved in the manifest.
 *
 *  A browser sending a folder sends `reports/2024/plan.pdf` as the filename;
 *  only the last segment is ours to store, and the path it came from is kept
 *  in the manifest instead. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^A-Za-z0-9]+/, '')
  if (!cleaned) return 'upload.bin'
  // meta.json is reserved for the manifest itself.
  return capFilename(cleaned === 'meta.json' ? 'upload.meta.json' : cleaned)
}

export function parseTags(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
}

// Manifest fields are copied into Postgres and into every catalog listing,
// so they are bounded here — a form field is not a place to stash a novel.
export const FIELD_MAX: Record<string, number> = { title: 160, description: 2000, note: 2000, category: 64 }
export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 40

/** The first thing wrong with the filing fields, or null when they are fine. */
export function fieldError(fields: Record<string, string>, tags: string[]): string | null {
  for (const [name, max] of Object.entries(FIELD_MAX)) {
    if ((fields[name] ?? '').length > max) return `${name} is too long (max ${max} characters)`
  }
  if (tags.length > MAX_TAGS) return `too many tags (max ${MAX_TAGS})`
  const long = tags.find(t => t.length > MAX_TAG_LENGTH)
  return long ? `tag "${long.slice(0, 20)}…" is too long (max ${MAX_TAG_LENGTH} characters)` : null
}
