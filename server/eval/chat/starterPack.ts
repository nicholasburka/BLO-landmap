import 'dotenv/config'

import { runChatTurn, type ChatEvent } from '../../src/services/chatLoop.js'
import { initLibraryDb } from '../../src/services/libraryDb.js'
import { initLibraryBucket } from '../../src/services/libraryBucket.js'
import { getAssistantClient, type AnthropicLike } from '../../src/services/assistantCall.js'
import type { ChatRow } from '../../src/services/libraryChat.js'
import type { InternalUser } from '../../src/services/internalSessions.js'

/**
 * One real chat turn, scored by hand (P13-5).
 *
 *     npm run eval:chat
 *     npm run eval:chat -- "some other question"
 *
 * **Why this is a script and not a test.** The P13-2 prompt amendments are
 * the kind of change a test cannot check: `chatLoop.test.ts` pins that the
 * rules SAY what they should, not that the model ACTS on them. The only
 * honest check is to ask the question again and look at what comes back.
 * Like `eval:inspect` next door, every run is a real call and costs money,
 * so it stays out of the suite.
 *
 * The question is the one a lead actually asked, verbatim, typos and all —
 * `specs/chat-starter-pack-postmortem.md` is the transcript it produced
 * before the amendments. What that run did NOT do, and what each amendment
 * was written to fix, is printed as a checklist at the end.
 *
 * **Nothing is written.** A write tool in chat is proposed and never run
 * (`chatLoop.ts`, "The model asked to change the library. It does not get
 * to."), so a proposal here is the signal, not a side effect.
 */

const QUESTION =
  process.argv.slice(2).join(' ').trim() ||
  'using our libraryof documents as well as links and achive, I need to pull a "starter pack" ' +
    'together for a person new to land ownership and stewardship and in need of sorting out an ' +
    'heirs prperty issue.  Give me ten resourcs (documents, links, organizations)'

// The same two the server boots with: a turn reads the catalog and the
// bucket, and neither opens itself.
await initLibraryDb()
await initLibraryBucket()

const now = new Date().toISOString()
const chat: ChatRow = {
  id: -1, userId: -1, title: 'eval', createdAt: now, updatedAt: now, archived: false,
}
const user: InternalUser = { id: -1, username: 'eval', role: 'internal' }

// Round-by-round, because "no answer" can mean several different things and
// the turn result does not say which.
const inner = getAssistantClient()
let round = 0
const client: AnthropicLike = {
  messages: {
    create: async (params: any) => {
      const n = ++round
      const reply: any = await inner.messages.create(params)
      const kinds = (reply.content ?? []).map((b: any) => b.type).join('+') || '(empty)'
      console.log(
        `  [round ${n}] tools:${params.tools ? params.tools.length : 'withdrawn'} ` +
        `→ stop:${reply.stop_reason} content:${kinds} ` +
        `in:${reply.usage?.input_tokens} out:${reply.usage?.output_tokens}`,
      )
      return reply
    },
  },
} as AnthropicLike

const events: ChatEvent[] = []
console.log(`\nASKING:\n${QUESTION}\n`)

const result = await runChatTurn({
  chat,
  user,
  question: QUESTION,
  history: [],
  client,
  emit: e => {
    events.push(e)
    if (e.type === 'tool_call' && e.phase === 'started') console.log(`  → ${e.call.tool}`)
    if (e.type === 'proposed_action') console.log(`  ✎ PROPOSED ${e.action.tool}: ${e.action.summary}`)
  },
})

if (result.failure) {
  console.log(`\nMODEL UNAVAILABLE: ${result.failure.code} — ${result.failure.reason}`)
  process.exit(1)
}

console.log(`\n--- ANSWER (${result.answer.length} chars) ---\n${result.answer}\n`)

const tools = result.toolCalls.map(c => c.tool)
const proposed = result.toolCalls.filter(c => c.kind === 'write')
// A linked item is a markdown link into the library or a page.
const links = [...result.answer.matchAll(/\]\((\/[^)]+)\)/g)].map(m => m[1])

/** The pack itself, wherever it ended up: on the proposed page when there is
 *  one, otherwise in the message. A short message beside a long proposed page
 *  is the right shape, not a short answer. */
const compiled = Math.max(
  result.answer.length,
  ...proposed.map(p => String((p.args as Record<string, unknown>)?.markdown ?? '').length),
)

console.log('--- WHAT THE TRANSCRIPT MISSED, AND WHETHER THIS RUN DOES ---')
const rows: [string, boolean, string][] = [
  ['rule 6  proposes something to keep', proposed.length > 0,
    proposed.map(p => `${p.tool} — ${p.summary}`).join('; ') || 'nothing proposed'],
  ['rule 8  links what it names', links.length > 0,
    `${links.length} link(s): ${links.slice(0, 4).join(', ')}`],
  ['rule 4b reaches the organizations rows', tools.includes('query_dataset'),
    `tools: ${tools.join(', ') || 'none'}`],
  ['rule 5b the pack is actually compiled somewhere', compiled > 1200,
    proposed.length
      ? `${compiled} chars of page markdown, ${result.answer.length} in the message`
      : `${compiled} chars, all in the message`],
]
for (const [label, ok, detail] of rows) console.log(`  ${ok ? 'YES' : 'NO '}  ${label}  —  ${detail}`)
console.log(`\ncitations: ${result.citations.length} · tokens in/out: ${result.inputTokens}/${result.outputTokens}\n`)
process.exit(0)
