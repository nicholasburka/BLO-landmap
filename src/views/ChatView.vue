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
import { useRoute, useRouter } from 'vue-router'
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
import type { ChatToolCall } from '@/lib/libraryChat'

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
const pane = useMapPane({ onClose: () => { mapTools.value = null } })

/** The canvas's tool context, once it has a map to drive. Cast rather than
 *  `ref<ToolContext | null>`: the context holds a `mapboxgl.Map`, and letting
 *  Vue compute `UnwrapRef` over the mapbox-gl v3 class blows TS's
 *  instantiation depth (the same cast `Map.vue` carries). */
const mapTools = ref(null) as Ref<ToolContext | null>
/** Tool calls that arrived before the canvas was ready, in order. */
const queuedToolCalls: ChatToolCall[] = []

function runMapTool(call: ChatToolCall): void {
  // Without arguments there is nothing to run: a read tool's line is a
  // summary for the reader, not a call this page can replay.
  if (!MAP_TOOLS.has(call.tool) || !call.args) return
  // The assistant showing something on the map is reason enough to open it.
  pane.open()
  if (!mapTools.value) {
    queuedToolCalls.push(call)
    return
  }
  void executeTool(call.tool, call.args, mapTools.value)
}

const chat = useLibraryChat({ onToolCall: runMapTool })
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

onMounted(async () => {
  await chat.loadThreads()
  // `/chat?q=…` is where the Ask boxes on entry, layer and compare pages
  // land (the retired `/ask` redirects here): the question starts a new
  // thread at once, and the URL loses the query so a refresh cannot ask
  // it twice.
  const question = typeof route.query.q === 'string' ? route.query.q.trim() : ''
  if (question) {
    await router.replace({ path: route.path })
    await chat.send(question)
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

          <ChatMessageItem
            v-for="entry in thread"
            :key="entry.message.id"
            :message="entry.message"
            :question="entry.question"
            :running-actions="chat.runningActions.value"
            @run="chat.runAction($event)"
          />
        </div>

        <p v-if="chat.error.value" class="chat-error" role="alert" data-testid="chat-error">{{ chat.error.value }}</p>
        <p v-if="chat.actionError.value" class="chat-error" role="alert" data-testid="chat-action-error">{{ chat.actionError.value }}</p>

        <ChatComposer
          :streaming="chat.streaming.value"
          :seed="chat.unsentText.value"
          @send="chat.send($event)"
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

.chat-title {
  margin: 0 0 10px;
  font-size: 18px;
  color: var(--blo-ink, #111);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
