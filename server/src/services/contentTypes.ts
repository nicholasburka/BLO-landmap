import { extname } from 'node:path'

/**
 * Filename → Content-Type, derived from the extension only.
 *
 * Shared deliberately: the type we STORE (on the bucket object) and the type
 * we SERVE must come from the same table, and neither may come from the
 * client. A browser-uploaded file arrives with whatever mimeType the client
 * chose to declare — trusting it would let an uploader store `text/html`
 * under a `.csv` name and have the bucket hand it back as a live page. The
 * declared type is kept in the entry's manifest as a record of what the
 * uploader claimed; it never decides how bytes are labelled.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rtf': 'application/rtf',
  '.zip': 'application/zip',
}

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}
