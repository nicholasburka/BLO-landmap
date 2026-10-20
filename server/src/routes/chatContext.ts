import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { privateNoCache } from '../middleware/privateCache.js'
import { chatTools, buildChatSystemPrompt } from '../services/chatLoop.js'
import { listInternalLayers } from '../services/internalLayers.js'
import { renderInternalLayersContext } from '../prompt/internalLayersContext.js'
import { getWorkingSet } from '../services/libraryWorkingSets.js'
import { isLibraryEnabled } from '../services/libraryDb.js'

/**
 * GET /api/chat-context — exactly what the chat model is given (P13-1).
 *
 * **Generated, never maintained.** The point of this route is that it reads
 * the same `chatTools()` and `buildChatSystemPrompt()` the turn itself reads,
 * so it cannot describe a tool set the model does not have. A hand-written
 * page listing the tools would have been wrong within a week, and a hand-
 * written ANSWER already was: the phase-10 audit reported the in-app chat as
 * having six tools and none of phase 9's capabilities, because it read
 * `prompt/toolDefinitions.ts` — which belongs to the PUBLIC MAP's prompt box
 * (`/api/chat`), not to the library chat at `/chat`. The library chat has had
 * the whole MCP surface all along. This route exists so nobody has to take
 * that question on trust again.
 *
 * Internal-tier only. Nothing here is a secret — the system prompt is our own
 * copy and the schemas are the model's — but it is a team tool, not a public
 * one, and it reads the library to render the layer manifest.
 *
 * `?set=<slug>` renders the prompt as a conversation scoped to that set
 * (P11-9), which is the one part of the prompt that varies per turn.
 */
const router = Router()

interface ToolRow {
  name: string
  description: string
  /** The model sees this as the tool's shape; shown verbatim. */
  inputSchema: unknown
  /** A write is proposed rather than run — the person confirms it. */
  write: boolean
  /** Characters the description costs, which is what a long one really is. */
  descriptionChars: number
}

router.get('/api/chat-context', requireInternalUser, internalRateLimit, privateNoCache, async (req, res) => {
  try {
    const tools = chatTools()
    const rows: ToolRow[] = tools.map(t => ({
      name: t.name,
      description: String(t.definition.description ?? ''),
      inputSchema: t.definition.input_schema ?? null,
      write: t.write,
      descriptionChars: String(t.definition.description ?? '').length,
    }))

    const asked = typeof req.query.set === 'string' ? req.query.set.trim() : ''
    let scope: { slug: string; name: string; members: string[] } | null = null
    if (asked && isLibraryEnabled()) {
      const set = await getWorkingSet(asked).catch(() => null)
      if (set) scope = { slug: set.slug, name: set.title, members: set.datasets }
    }

    // The layer manifest is the other half of what a logged-in reader's
    // prompt carries, and it is the half that changes as the library grows.
    const layers = isLibraryEnabled() ? await listInternalLayers().catch(() => []) : []
    const systemPrompt = buildChatSystemPrompt(scope)
    const layersContext = renderInternalLayersContext(layers)

    res.json({
      tools: rows,
      counts: {
        tools: rows.length,
        reads: rows.filter(r => !r.write).length,
        writes: rows.filter(r => r.write).length,
        internalLayers: layers.length,
      },
      systemPrompt,
      layersContext,
      scope,
      // A rough sense of what the fixed part of every turn costs, before the
      // question, the excerpts and the history. Characters/4 is the usual
      // rule of thumb and is labelled as an estimate on the page.
      approxPromptChars: systemPrompt.length + layersContext.length +
        rows.reduce((n, r) => n + r.descriptionChars + JSON.stringify(r.inputSchema ?? {}).length, 0),
    })
  } catch (err: any) {
    console.error('[chat-context] failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
