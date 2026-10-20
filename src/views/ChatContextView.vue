<template>
  <div class="ctx-view">
    <div class="ctx-panel">
      <KbNav />
      <RouterLink to="/chat" class="back-link">← Chat</RouterLink>

      <header class="ctx-head">
        <h1>What chat is given</h1>
        <p class="blo-type-body blo-type-body--measure">
          Every tool and the whole system prompt the model behind
          <RouterLink to="/chat" class="blo-type-action">Chat</RouterLink> receives, read from the
          same functions the turn itself reads. Not a list anybody maintains — if it is wrong here,
          it is wrong there.
        </p>
      </header>

      <p v-if="loading" class="state-note" data-testid="ctx-loading">Reading the context…</p>
      <p v-else-if="error" class="state-note error" data-testid="ctx-error">{{ error }}</p>

      <template v-else-if="ctx">
        <p class="counts" data-testid="ctx-counts">
          <span><strong>{{ ctx.counts.tools }}</strong> tools</span>
          <span><strong>{{ ctx.counts.reads }}</strong> read</span>
          <span><strong>{{ ctx.counts.writes }}</strong> write, each confirmed first</span>
          <span v-if="ctx.counts.clients">
            <strong>{{ ctx.counts.clients }}</strong> run in your browser
          </span>
          <span><strong>{{ ctx.counts.internalLayers }}</strong> internal layers named</span>
          <span class="counts-est">
            ≈{{ Math.round(ctx.approxPromptChars / 4).toLocaleString() }} tokens before the question
          </span>
        </p>

        <!-- Scope is the one part of the prompt that changes per turn. -->
        <form class="scope-form" @submit.prevent="load">
          <label class="blo-type-meta" for="ctx-set">Render it scoped to a working set</label>
          <input
            id="ctx-set"
            v-model="setSlug"
            class="blo-select"
            type="text"
            placeholder="a set's slug, or blank for the whole library"
            data-testid="ctx-set"
          />
          <button type="submit" class="blo-act">Render</button>
        </form>

        <h2 class="blo-type-section">The tools</h2>
        <ul class="tool-list" data-testid="ctx-tools">
          <li v-for="tool in ctx.tools" :key="tool.name" class="tool-row" data-testid="ctx-tool">
            <p class="tool-head">
              <code class="tool-name">{{ tool.name }}</code>
              <span class="tag" :class="`tag-${kindOf(tool)}`">{{ kindOf(tool) }}</span>
              <span class="blo-type-meta">{{ tool.descriptionChars.toLocaleString() }} chars</span>
              <button
                type="button"
                class="blo-act"
                :aria-expanded="open === tool.name"
                @click="open = open === tool.name ? '' : tool.name"
              >
                {{ open === tool.name ? 'Hide the schema' : 'Its schema' }}
              </button>
            </p>
            <p class="blo-type-body tool-desc">{{ tool.description }}</p>
            <pre v-if="open === tool.name" class="schema" data-testid="ctx-schema">{{
              JSON.stringify(tool.inputSchema, null, 2)
            }}</pre>
          </li>
        </ul>

        <h2 class="blo-type-section">The system prompt</h2>
        <p v-if="ctx.scope" class="blo-type-meta">
          Scoped to <strong>{{ ctx.scope.name }}</strong> — {{ ctx.scope.members.length }} members.
        </p>
        <pre class="prompt" data-testid="ctx-prompt">{{ ctx.systemPrompt }}</pre>

        <h2 class="blo-type-section">What they are looking at</h2>
        <p class="blo-type-body blo-type-body--measure">
          When the map pane is open, the turn carries a short block saying what is on it, so
          <em>“add flood risk to this”</em> has a <em>this</em>. Every value in it is a pointer the
          server resolves against its own registry — a layer id it cannot name is dropped, and a
          county is named from its GEOID — so nothing the page sends arrives as prose.
          <strong>This is an example, not part of the prompt above:</strong> a shut pane sends
          nothing and the block is absent entirely.
        </p>
        <pre class="prompt" data-testid="ctx-situation">{{ ctx.situationExample || '(no map pane — nothing is sent)' }}</pre>

        <h2 class="blo-type-section">The internal layers, as the prompt names them</h2>
        <p class="blo-type-body blo-type-body--measure">
          Only a logged-in reader's prompt carries this. It is generated from the catalog, so it
          grows as the library does — a working set's composite columns arrive here as county
          layers without anything being written by hand.
        </p>
        <pre class="prompt" data-testid="ctx-layers">{{ ctx.layersContext || '(none)' }}</pre>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * `/chat-context` — what the chat model is given (P13-1).
 *
 * Nick asked for a page showing the tools and their metadata as the chat page
 * sees them. The reason it is worth a route rather than a note in the docs is
 * that the hand-written answer to that question was already wrong: the
 * phase-10 audit reported the in-app chat as having six tools and none of
 * phase 9's capabilities, having read `prompt/toolDefinitions.ts` — which
 * belongs to the PUBLIC MAP's prompt box, not to the library chat. The
 * library chat has had the whole MCP surface all along.
 *
 * Everything here comes from `GET /api/chat-context`, which calls the same
 * `chatTools()` and `buildChatSystemPrompt()` a turn calls. A page that
 * cannot disagree with the thing it documents.
 */
import { onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import KbNav from '@/components/KbNav.vue'
import { internalFetch } from '@/lib/apiBase'
import { friendlyError } from '@/lib/errors'

interface ToolRow {
  name: string
  description: string
  inputSchema: unknown
  write: boolean
  client: boolean
  descriptionChars: number
}

interface ChatContext {
  tools: ToolRow[]
  counts: { tools: number; reads: number; writes: number; clients: number; internalLayers: number }
  systemPrompt: string
  layersContext: string
  scope: { slug: string; name: string; members: string[] } | null
  map: boolean
  situationExample: string
  approxPromptChars: number
}

/** Three kinds, and the one that is easy to miss: a client tool never runs
 *  here at all. */
function kindOf(tool: ToolRow): 'read' | 'write' | 'client' {
  if (tool.write) return 'write'
  return tool.client ? 'client' : 'read'
}

const route = useRoute()
const ctx = ref<ChatContext | null>(null)
const loading = ref(true)
const error = ref('')
const open = ref('')
const setSlug = ref(typeof route.query.set === 'string' ? route.query.set : '')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const qs = setSlug.value.trim() ? `?set=${encodeURIComponent(setSlug.value.trim())}` : ''
    const res = await internalFetch(`/api/chat-context${qs}`)
    if (!res.ok) throw new Error(`The context could not be read (${res.status})`)
    ctx.value = (await res.json()) as ChatContext
  } catch (err) {
    error.value = friendlyError(err, 'The context could not be read.')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.ctx-view {
  padding: 20px;
}

.ctx-panel {
  max-width: 980px;
  margin: 0 auto;
}

.back-link {
  display: inline-block;
  margin-bottom: 12px;
  font-size: var(--blo-text-meta);
  color: var(--blo-stone);
  text-decoration: none;
}

.ctx-head h1 {
  font-family: var(--blo-font-display);
  font-size: 1.7rem;
  font-weight: 500;
  margin: 0 0 8px;
  color: var(--blo-ink);
}

.state-note {
  font-size: var(--blo-text-body);
  color: var(--blo-stone);
}

.state-note.error {
  color: var(--blo-orange-deep);
}

.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin: 16px 0;
  padding: 10px 14px;
  font-size: var(--blo-text-meta);
  color: var(--blo-stone);
  background: var(--blo-cream-deep);
  border-radius: 8px;
}

.counts strong {
  color: var(--blo-ink);
  font-variant-numeric: tabular-nums;
}

.counts-est {
  color: var(--blo-stone-soft);
}

.scope-form {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 24px;
}

.scope-form input {
  flex: 1 1 22rem;
  min-width: 0;
}

h2 {
  margin: 26px 0 10px;
}

.tool-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.tool-row {
  padding: 12px 14px;
  border-bottom: 1px solid var(--blo-cream-divider);
}

.tool-row:last-child {
  border-bottom: none;
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 4px;
}

.tool-name {
  font-size: var(--blo-text-item);
  font-weight: 600;
  color: var(--blo-ink);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}

.tag {
  font-size: var(--blo-text-eyebrow);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
}

.tag-read {
  color: var(--blo-stone);
  background: rgba(0, 0, 0, 0.05);
}

.tag-write {
  color: var(--blo-green-deep);
  background: var(--blo-green-soft);
}

/* Not a write — it changes nothing stored — but not an ordinary read either,
   because it is the only kind that reaches out of the server. */
.tag-client {
  color: var(--blo-orange-deep);
  background: var(--blo-orange-soft, rgba(200, 110, 40, 0.12));
}

.tool-desc {
  margin: 0;
  max-width: 70ch;
}

.schema,
.prompt {
  margin: 10px 0 0;
  padding: 12px 14px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--blo-text-caption);
  line-height: 1.5;
  color: var(--blo-ink-soft);
  background: var(--blo-cream-deep);
  border-radius: 6px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 640px) {
  .ctx-view {
    padding: 14px;
  }
}
</style>
