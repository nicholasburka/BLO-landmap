import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { isLibraryEnabled } from '../services/libraryDb.js'
import { isBucketEnabled, isSafeKey } from '../services/libraryBucket.js'
import { getCatalogEntry } from '../services/libraryCatalog.js'
import {
  basenameInEntry,
  extractFile,
  installExtractionHook,
  isExtractable,
  readDerived,
} from '../services/textExtract.js'

/**
 * A document's extracted text (P5-46): `GET /api/library/text/:slug/:filename`
 * hands back the derived object services/textExtract.ts stores — the pages the
 * viewer shows for a .docx or .rtf, and the "Text" view of a PDF.
 *
 * Extraction normally happens after a reindex, so this route usually just
 * reads. When a file has never been seen (someone opened an upload minutes
 * after it landed) it extracts on the spot and stores the result, so the wait
 * happens once rather than on every open.
 *
 * Not audited: reading a document's text is reading a document, and P5-40
 * deliberately keeps reads out of the activity feed. The download route still
 * records the bytes leaving.
 */
const router = Router()
router.use('/api/library', requireInternalUser)

// Mounting this route is what puts the server in the extraction business: from
// here on, every reindex sweeps for documents whose text is missing or stale.
installExtractionHook()

router.get<{ slug: string; filename: string }>(
  '/api/library/text/:slug/:filename',
  internalRateLimit,
  async (req, res) => {
    if (!isLibraryEnabled() || !isBucketEnabled()) {
      res.status(503).json({ error: 'library unavailable' })
      return
    }
    try {
      const entry = await getCatalogEntry(req.params.slug)
      const name = req.params.filename
      const file = entry?.files?.find(f => basenameInEntry(f.key) === name)
      // Unknown slugs and unknown files 404 identically — the same rule the
      // download route follows, so this one cannot be used to probe the tree.
      if (!entry || !file || !isSafeKey(file.key)) {
        res.status(404).json({ error: 'not found' })
        return
      }
      if (!isExtractable(name)) {
        res.status(415).json({ error: 'There is no text to pull out of this kind of file.' })
        return
      }

      // Same staleness rule as the reindex sweep: text extracted from an
      // older version of the file would quietly show the reader the wrong
      // document.
      const stored = await readDerived(entry.slug, name)
      const derived =
        stored && stored.sourceSize === file.size
          ? stored
          : await extractFile(entry.slug, name, file.key, file.size)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(derived)
    } catch (err: any) {
      console.error('[library] text read failed:', err?.message || err)
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
    }
  },
)

export default router
