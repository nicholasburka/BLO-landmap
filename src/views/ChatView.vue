<script setup lang="ts">
/**
 * Chat — a conversation with the library (P6-7b, spec section E).
 *
 * Ask answers one question; this holds a conversation, with the library's own
 * tool set behind it. The answer streams (NDJSON over `fetch`, docs/CHAT.md),
 * the tools it ran show as collapsed lines, and a write it wants to make is a
 * proposal with a button — nothing changes the library until a person presses
 * Run.
 *
 * **The layout is three columns on purpose** (spec decision, "Chat and the
 * map"): threads left, the conversation in the middle, and the map pane on
 * the right (P6-10). The pane is closed until someone opens it — `MapPane`
 * is `v-if`'d and loads its canvas on demand, so a reader who never opens it
 * never downloads a county file — and it is desktop-only: two WebGL contexts
 * and a
 * 26rem column are not a phone's business. On a phone the page is one column
 * and the thread list is a select above the conversation.
 */
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, type Ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import KbNav from '@/components/KbNav.vue'
import ChatThreadList from '@/components/chat/ChatThreadList.vue'
import ChatMessageItem from '@/components/chat/ChatMessageItem.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import MapPane from '@/components/MapPane.vue'
import { usePhoneLayout } from '@/composables/usePhoneLayout'
import { useMapPane } from '@/composables/useMapPane'
import { useLibraryChat, type ChatMessageView } from '@/composables/useLibraryChat'
import { useMapState } from '@/composables/useMapState'
import { executeTool, type ToolContext } from '@/lib/mapTools'
import ScopeChip from '@/components/ScopeChip.vue'
import { fetchWorkingSet, type WorkingSetDetail } from '@/lib/workingSets'
import type { ChatToolCall, PaneContext } from '@/lib/libraryChat'
import { fetchView, mapStateOf } from '@/lib/views'
import { friendlyError } from '@/lib/errors'

/**
 * The four map tools run here rather than on the server: they are about this
 * page's map, which only this page has. Everything else the assistant can do
 * — searching, reading, proposing a write — stays on the server and arrives
 * as a line in the answer.
 */
const MAP_TOOLS = new Set(['show_layer', 'zoom_to_county', 'show_county_details', 'set_query_state'])

/** This page's own map state, independent of the public map's (P6-10). */
const mapState = useMapState()
/** Open/close and the desktop-only breakpoint (P6-14 lifted both out of here
 *  so the "Show on map" pages get the same pane). Letting go of the canvas's
 *  context is this page's own business, so it rides on `onClose` — which runs
 *  whether the X was pressed or the window narrowed past the breakpoint. */
const pane = useMapPane({
  onClose: () => {
    mapTools.value = null
    focusedCounty.value = null
  },
})

/** The canvas's tool context, once it has a map to drive. Cast rather than
 *  `ref<ToolContext | null>`: the context holds a `mapboxgl.Map`, and letting
 *  Vue compute `UnwrapRef` over the mapbox-gl v3 class blows TS's
 *  instantiation depth (the same cast `Map.vue` carries). */
const mapTools = ref(null) as Ref<ToolContext | null>
/** Tool calls that arrived before the canvas was ready, in order. */
const queuedToolCalls: ChatToolCall[] = []

function runMapTool(call: ChatToolCall): void {
  // P14-1 made `kind` the real test: a client call is one the server
  // dispatched for this page to run, and it is the only kind that carries
  // arguments as its payload. The name check stays as the second half of the
  // contract — this page can run the four map tools and nothing else.
  if (call.kind !== 'client' || !MAP_TOOLS.has(call.tool) || !call.args) return
  // The assistant showing something on the map is reason enough to open it.
  pane.open()
  if (!mapTools.value) {
    queuedToolCalls.push(call)
    return
  }
  void executeTool(call.tool, call.args, mapTools.value)
}

/** The county the reader last pressed on this page's map, if any. The pane
 *  has no county of its own otherwise — `activeEntity` is a feature in a
 *  point layer, not a place. */
const focusedCounty = ref<{ geoId: string } | null>(null)

function onCountyClick(geoId: string): void {
  // The id only: the server names the county from it.
  focusedCounty.value = /^\d{5}$/.test(geoId) ? { geoId } : null
}

/**
 * What the pane is showing, read at the moment a question is sent (P14-3).
 *
 * Shut means null: a closed pane has nothing to say, and the turn then
 * carries no situational block at all. Everything here is a POINTER — layer
 * ids, a GEOID, two-letter state codes — because the server resolves each
 * one against its own registry and drops what it cannot name. That is the
 * whole reason the page does not send names.
 */
function paneContext(): PaneContext | null {
  if (!pane.isOpen.value) return null
  const weights = mapState.query.weights.value
  return {
    layers: [
      ...mapState.layers.demographic.value,
      ...mapState.layers.economic.value,
      ...mapState.layers.housing.value,
      ...mapState.layers.equity.value,
      ...mapState.layers.transportation.value,
      ...mapState.layers.internal.value,
      ...mapState.layers.points.value,
    ].map(id => ({ id, weight: weights[id] })),
    filters: mapState.query.filters.value.map(filter => ({
      layerId: filter.layerId,
      // One shape for the model: a threshold is a floor, a ceiling, or both.
      ...(filter.operator === 'less_than' ? { max: filter.value } : { min: filter.value }),
      ...(filter.operator === 'between' && filter.max !== undefined ? { max: filter.max } : {}),
    })),
    states: mapState.query.regionStates.value,
    limit: mapState.query.limit.value,
    county: focusedCounty.value,
  }
}

/**
 * Draw a saved view on this page's own map (P14-7).
 *
 * `openTargetFor` matched four route shapes and every one of them navigated
 * AWAY from the conversation — which is a strange thing to offer beside a
 * pane built to show exactly this. The view's state is applied through the
 * same `set_query_state` the assistant drives the map with, so there is one
 * definition of "put this query on the map" rather than a second reader for
 * saved views.
 */
const showing = ref('')
const showError = ref('')

async function showViewHere(slug: string): Promise<void> {
  if (showing.value) return
  showing.value = slug
  showError.value = ''
  pane.open()
  try {
    const view = await fetchView(slug)
    const state = view && mapStateOf(view)
    if (!state) throw new Error('That view has no map in it.')
    // The canvas may still be starting: queue it the way a tool call is.
    const call: ChatToolCall = {
      id: `view-${slug}`,
      tool: 'set_query_state',
      kind: 'client',
      status: 'done',
      summary: `Showed the saved view “${slug}”`,
      args: {
        layers: state.layers,
        filters: state.filters,
        limit: state.limit,
        regionStates: state.regionStates,
      },
    }
    runMapTool(call)
  } catch (err) {
    showError.value = friendlyError(err, 'That view could not be shown here.')
  } finally {
    showing.value = ''
  }
}

const chat = useLibraryChat({
  onToolCall: runMapTool,
  canShowMap: () => pane.canOpen.value,
  paneContext,
})

const isPhone = usePhoneLayout()

/** The canvas has a map: drain whatever the assistant asked for while it was
 *  still starting up, in the order it asked. */
function onMapReady(ctx: ToolContext): void {
  mapTools.value = ctx
  // The internal layer manifest is this page's too, so `show_layer` can
  // resolve an internal id. It is fetched when the pane opens, not before.
  void mapState.loadInternalLayers().then(() => {
    const queued = queuedToolCalls.splice(0, queuedToolCalls.length)
    for (const call of queued) void executeTool(call.tool, call.args!, ctx)
  })
}

/** Each answer is paired with the question above it: what "Save as note"
 *  titles the note with, and what its "ask this again" link asks. */
const thread = computed(() => {
  let question = ''
  return chat.messages.value.map((message: ChatMessageView) => {
    if (message.role === 'user') question = message.text
    return { message, question }
  })
})

const scroller = ref<HTMLElement | null>(null)

/** Follow the answer as it is written. */
function scrollToEnd(): void {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  () => [chat.messages.value.length, chat.messages.value[chat.messages.value.length - 1]?.text],
  () => void nextTick(scrollToEnd),
)

const route = useRoute()
const router = useRouter()

/**
 * P11-9: the working set this conversation is scoped to, or '' for the
 * whole library. It lives on the URL, so it survives a reload and a shared
 * link carries it.
 */
const scopeSlug = computed(() => {
  const raw = route.query.set
  const slug = Array.isArray(raw) ? raw[0] : raw
  return typeof slug === 'string' ? slug.trim() : ''
})

const scopeSet = ref<WorkingSetDetail | null>(null)

/**
 * Where the scope changed, in order.
 *
 * Session-local: the marks are not stored with the thread, so reopening a
 * conversation shows its CURRENT scope (from the URL) without the history of
 * how it got there. Persisting them needs a message kind the store does not
 * have — noted as a follow-up rather than half-built here.
 */
const scopeMarks = ref<{ id: number; text: string }[]>([])
let markId = 0

watch(
  scopeSlug,
  async (slug, before) => {
    if (slug === scopeSet.value?.slug) return
    scopeSet.value = slug ? await fetchWorkingSet(slug).catch(() => null) : null
    // Not on first load: arriving scoped is not a change, it is a starting
    // point, and the chip already says so.
    if (before === undefined) return
    const name = scopeSet.value?.name ?? slug
    scopeMarks.value.push({
      id: ++markId,
      text: slug ? `Scoped to ${name} from here.` : 'Widened to the whole library from here.',
    })
  },
  { immediate: true },
)

function clearScope(): void {
  const query = { ...route.query } as Record<string, unknown>
  delete query.set
  void router.replace({ query: query as Record<string, string> })
}

onMounted(async () => {
  await chat.loadThreads()
  // `/chat?q=…` is where the Ask boxes on entry, layer and compare pages
  // land (the retired `/ask` redirects here): the question starts a new
  // thread at once, and the URL loses the query so a refresh cannot ask
  // it twice.
  const question = typeof route.query.q === 'string' ? route.query.q.trim() : ''
  if (question) {
    await router.replace({ path: route.path })
    await chat.send(question, scopeSlug.value)
    return
  }
  // Most recently used first: carry on where they left off rather than
  // opening on an empty page they have to press a button to leave.
  const newest = chat.threads.value[0]
  if (newest) await chat.openThread(newest.id)
})

// The stream outlives the component unless it is told not to: leaving the
// page stops reading the body.
onBeforeUnmount(() => chat.stop())
</script>

<template>
  <div class="chat-view">
    <KbNav />

    <div class="chat-cols">
      <!-- Threads. A column on a desktop, one select on a phone. -->
      <ChatThreadList
        class="chat-threads"
        :threads="chat.threads.value"
        :current-id="chat.currentChatId.value"
        :loading="chat.threadsLoading.value"
        :error="chat.threadsError.value"
        :compact="isPhone"
        @create="chat.startThread()"
        @select="chat.openThread($event)"
        @rename="chat.rename($event.chatId, $event.title)"
        @archive="chat.archive($event)"
      />

      <!-- The conversation. -->
      <section class="conversation" data-testid="chat-conversation">
        <div class="chat-head">
          <h1 class="chat-title" data-testid="chat-title">{{ chat.currentChat.value?.title ?? 'Chat' }}</h1>
          <!-- P13-1: a team tool, so a quiet link rather than a control. It
               answers "what can it actually do" from the same functions the
               turn reads — a question that had a wrong answer in writing for
               a week. -->
          <RouterLink
            to="/chat-context"
            class="blo-type-action chat-context-link"
            data-testid="chat-context-link"
          >What it can do</RouterLink>
          <!-- P11-9: what this conversation is scoped to, and the way out. -->
          <ScopeChip
            v-if="scopeSet"
            :slug="scopeSet.slug"
            :name="scopeSet.name"
            label="Asking about"
            clear-label="Ask about the whole library instead"
            @clear="clearScope"
          />
          <!-- Desktop only: the pane is a second map, which a phone should
               not be asked to run. -->
          <button
            v-if="pane.canOpen.value && !pane.isOpen.value"
            type="button"
            class="pane-open"
            data-testid="chat-pane-open"
            @click="pane.open()"
          >Map</button>
        </div>

        <div
          ref="scroller"
          class="messages"
          role="log"
          aria-live="polite"
          :aria-busy="chat.streaming.value"
          data-testid="chat-messages"
        >
          <p v-if="chat.messagesLoading.value" class="state-note" data-testid="chat-loading">Opening the conversation…</p>

          <p v-else-if="!thread.length" class="state-note" data-testid="chat-empty">
            Ask in plain words — "what do we hold on Shelby County?" or "compare Fulton with DeKalb on flood risk". The
            assistant searches the library, reads what it finds, and cites it. It can also propose writing a note or
            adding to a page; nothing is written until you press Run.
          </p>

          <!-- P11-9: where the scope changed, so the turns under it can be
               read against the right one. An answer drawn from one set reads
               exactly like an answer drawn from the library, and without
               this the reader has no way to tell them apart afterwards. -->
          <p v-for="mark in scopeMarks" :key="mark.id" class="scope-mark" data-testid="scope-mark">
            {{ mark.text }}
          </p>

          <ChatMessageItem
            v-for="entry in thread"
            :key="entry.message.id"
            :message="entry.message"
            :question="entry.question"
            :running-actions="chat.runningActions.value"
            :can-show-here="pane.canOpen.value"
            @run="chat.runAction($event)"
            @show-here="showViewHere"
          />
        </div>

        <p v-if="showError" class="chat-error" role="alert" data-testid="chat-show-error">{{ showError }}</p>
        <p v-if="chat.error.value" class="chat-error" role="alert" data-testid="chat-error">{{ chat.error.value }}</p>
        <p v-if="chat.actionError.value" class="chat-error" role="alert" data-testid="chat-action-error">{{ chat.actionError.value }}</p>

        <ChatComposer
          :streaming="chat.streaming.value"
          :seed="chat.unsentText.value"
          @send="chat.send($event, scopeSlug)"
          @stop="chat.stop()"
        />
      </section>

      <!-- The map pane (P6-10, lifted into MapPane by P6-14). Absent until
           opened, so it costs an absent flex item: no track, no gap, and no
           county file downloaded. -->
      <MapPane
        v-if="pane.isOpen.value"
        class="chat-pane"
        testid="chat-pane"
        :layers="mapState.layers"
        :query="mapState.query"
        :data="mapState.data"
        @ready="onMapReady"
        @county-click="onCountyClick"
        @close="pane.close()"
      />
    </div>
  </div>
</template>

<style scoped>
/* The page fills the shell: <main> is a flex row of full height, so the
   conversation can scroll inside itself and the composer can stay put. */
.chat-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 16px 16px 12px;
  background: var(--blo-cream, #f7f4ee);
}

/* Flex, not grid: the pane is absent this phase and an absent flex item
   leaves no track and no gap behind it. */
.chat-cols {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 20px;
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
}

.chat-threads {
  flex: 0 0 15rem;
  padding-right: 16px;
  border-right: 1px solid var(--blo-cream-divider, #e0d9ca);
}

.conversation {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

/* The map pane (P6-10). `MapPane` is the column; this is only how wide it is
   on this page. */
.chat-pane {
  flex: 0 0 26rem;
}

.pane-open {
  padding: 2px 8px;
  font: inherit;
  font-size: 13px;
  color: var(--blo-ink-soft, #5c564e);
  background: transparent;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  cursor: pointer;
}

.pane-open:hover {
  color: var(--blo-ink, #111);
  border-color: var(--blo-ink-soft, #5c564e);
}

.chat-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

/* Below the pane's breakpoint there is no pane and no button to open one. */
@media (max-width: 1023px) {
  .chat-pane,
  .pane-open {
    display: none;
  }
}

.chat-context-link {
  margin-left: auto;
  white-space: nowrap;
}

.chat-title {
  margin: 0 0 10px;
  font-size: 18px;
  color: var(--blo-ink, #111);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* P11-9: a scope change, in the flow of the conversation it changed. */
.scope-mark {
  margin: 10px 0;
  padding: 4px 0;
  font-size: 12px;
  color: var(--blo-stone);
  text-align: center;
  border-top: 1px solid var(--blo-cream-divider);
}

.messages {
  flex: 1 1 auto;
  min-height: 0;
  padding-right: 6px;
  overflow-y: auto;
}

.state-note {
  margin: 0;
  max-width: 34rem;
  font-size: 14px;
  line-height: 1.6;
  color: var(--blo-stone, #6b6560);
}

.chat-error {
  margin: 10px 0 0;
  padding: 10px 12px;
  font-size: 14px;
  color: #7f1d1d;
  background: #fdecea;
  border-radius: 8px;
}

@media (max-width: 640px) {
  .chat-view {
    padding: 12px 12px 8px;
  }

  .chat-cols {
    flex-direction: column;
    gap: 12px;
  }

  /* One column: the thread list is a select above the conversation. */
  .chat-threads {
    flex: 0 0 auto;
    padding-right: 0;
    border-right: 0;
  }

  .chat-title {
    font-size: 17px;
  }

  .state-note {
    font-size: 15px;
  }
}
</style>
