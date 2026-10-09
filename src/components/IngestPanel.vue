<script setup lang="ts">
/**
 * "What is this link, and how does it come in?" (P5-59).
 *
 * Two halves of one decision, kept together because they are read together:
 * what the server found when it looked at the link, and the plan an admin has
 * (or has not) recorded for it.
 *
 * The panel proposes and never applies. The inspection is data about the link;
 * the plan is written by an admin-only route; registering a source hands the
 * proposal up to the filing form, where a person still presses File. A
 * researcher sees everything and can re-run the look; only an admin sees the
 * plan picker and the copy button, because those are decisions about our work.
 */
import { computed, ref } from 'vue'
import { ADMIN_REASON_TEXT } from '@/lib/ask'
import { friendlyError } from '@/lib/errors'
import { PULL_STATUS_TEXT, pullDocuments, pullSummary, type PullResult } from '@/lib/documentPull'
import {
  INGEST_PLANS,
  LINK_ROLE_LABELS,
  PLAN_LABELS,
  canRegisterAsSource,
  droppedLinkCount,
  hostOf,
  inspectEntryLink,
  inspectionLine,
  inspectionOf,
  ingestOf,
  fetchSourceProposal,
  replicateEntryNow,
  setIngestPlan,
  whatHappensNext,
  type CatalogEntry,
  type IngestMode,
  type IngestPlanName,
  type Inspection,
  type ProposalResponse,
} from '@/lib/libraryCatalog'

const props = defineProps<{ entry: CatalogEntry; isAdmin: boolean }>()
const emit = defineEmits<{
  (e: 'register', proposal: ProposalResponse): void
  (e: 'drop-link', url: string): void
  (e: 'changed'): void
}>()

const busy = ref('')
const note = ref('')
const isError = ref(false)
/** The freshest look, when this session ran one; else what the entry carries. */
const fresh = ref<Inspection | null>(null)

const inspection = computed<Inspection | null>(() => fresh.value ?? inspectionOf(props.entry))
const ingest = computed(() => ingestOf(props.entry))
const summary = computed(() => (inspection.value ? inspectionLine(inspection.value) : ''))

/** Only a link can be looked at; an uploaded file has nothing to probe. */
const hasLink = computed(() => typeof props.entry.meta?.url === 'string' && !!props.entry.meta.url)

/**
 * A source is worth proposing when the link turned out to BE a dataset.
 *
 * P5-61 widened that from "a service or a file" to "or a page that describes
 * one" — the whole point of reading a page for data is that the page becomes
 * something you can register.
 */
const canRegister = computed(() => {
  if (props.entry.kind === 'source') return false
  return canRegisterAsSource(inspection.value)
})

/** Copying only makes sense for something we could actually pull. */
const canReplicate = computed(() => {
  if (!props.isAdmin) return false
  if (props.entry.kind === 'source') return true
  const kind = inspection.value?.kind
  return kind === 'file'
})

const planned = computed<IngestPlanName | ''>(() => ingest.value?.plan ?? '')
const nextStep = computed(() =>
  ingest.value ? whatHappensNext(ingest.value.plan, ingest.value.mode, ingest.value.done) : '',
)

const portalLinks = computed(() => inspection.value?.links ?? [])
const serviceLayers = computed(() => inspection.value?.layers ?? [])

/** P5-61. The page's other links are counted, never listed: the whole reason
 *  a model prunes before we store anything is that a link tree is noise. */
const leftOut = computed(() => droppedLinkCount(inspection.value))
/** True when nobody read the page and the links are a guess at its shapes. */
const unranked = computed(() => inspection.value?.pruned === 'unranked')
/** P5-61: WHY it is unranked. "Unranked" with no reason is a dead end for
 *  whoever has to decide whether to trust the list or press Look again. */
const whyUnranked = computed(() => {
  // P5-75: when the model itself was the problem, an admin gets the sentence
  // that says what to fix; a member sees the plain reason.
  const code = inspection.value?.pruneErrorCode
  if (props.isAdmin && code) return ADMIN_REASON_TEXT[code].replace(/\.$/, '')
  return inspection.value?.pruneError ?? ''
})
/** The links the pass left out, revealed on request — counted by default. */
const dropped = computed(() => inspection.value?.dropped ?? [])
const showDropped = ref(false)
/** The kept link whose reason is open. One at a time — this is a footnote. */
const openReason = ref('')

/**
 * P5-80: the documents ON the page, and which of them a person has ticked.
 *
 * Nothing is ticked by default. Pulling files off somebody else's site is a
 * choice, and a panel that pre-ticked thirty boxes would be making it for
 * them.
 */
const documents = computed(() => inspection.value?.documents ?? [])
const chosen = ref<string[]>([])
const pulled = ref<PullResult[]>([])
const allChosen = computed(() => documents.value.length > 0 && chosen.value.length === documents.value.length)

function chooseAll(): void {
  chosen.value = documents.value.map(d => d.url)
}

function chooseNone(): void {
  chosen.value = []
}

function statusText(result: PullResult): string {
  return PULL_STATUS_TEXT[result.status] ?? result.status
}

function toggleReason(url: string): void {
  openReason.value = openReason.value === url ? '' : url
}

function roleLabel(role: string | undefined): string {
  return role ? (LINK_ROLE_LABELS[role as keyof typeof LINK_ROLE_LABELS] ?? role) : ''
}

function say(text: string, failed = false): void {
  note.value = text
  isError.value = failed
}

async function look(): Promise<void> {
  if (busy.value) return
  busy.value = 'inspect'
  say('')
  try {
    const result = await inspectEntryLink(props.entry.slug)
    fresh.value = result.inspection
    say(
      result.inspection.kind === 'unreachable'
        ? 'We could not reach it. Check the link, or try again in a minute.'
        : `Looked at it: ${result.summary}`,
      result.inspection.kind === 'unreachable',
    )
    emit('changed')
  } catch (err: unknown) {
    say(friendlyError(err, 'we could not look at that link.'), true)
  } finally {
    busy.value = ''
  }
}

async function register(): Promise<void> {
  if (busy.value) return
  busy.value = 'register'
  say('')
  try {
    const proposal = await fetchSourceProposal(props.entry.slug)
    emit('register', proposal)
    say('Filled the data-source form in below. Everything the machine worked out is marked "inferred" — check it, then press File.')
  } catch (err: unknown) {
    say(friendlyError(err, 'we could not build a proposal for this link.'), true)
  } finally {
    busy.value = ''
  }
}

async function choosePlan(plan: IngestPlanName, mode?: IngestMode): Promise<void> {
  if (busy.value) return
  busy.value = 'plan'
  say('')
  try {
    await setIngestPlan(props.entry.slug, { plan, ...(mode ? { mode } : {}) })
    say(`Plan saved: ${PLAN_LABELS[plan]}.`)
    emit('changed')
  } catch (err: unknown) {
    say(friendlyError(err, 'we could not save the plan.'), true)
  } finally {
    busy.value = ''
  }
}

/** Pull the ticked documents in. One call, per-file results, and the entry
 *  is reloaded afterwards so the Files tab shows what landed. */
async function pullIn(): Promise<void> {
  if (busy.value || !chosen.value.length) return
  busy.value = 'documents'
  say('')
  pulled.value = []
  try {
    const results = await pullDocuments(props.entry.slug, chosen.value)
    pulled.value = results
    say(pullSummary(results), results.every(r => r.status !== 'stored'))
    // Keep only what did NOT work ticked: the obvious next press is "try
    // those again", never "pull the same twenty in twice".
    const failed = new Set(results.filter(r => r.status !== 'stored').map(r => r.url))
    chosen.value = chosen.value.filter(url => failed.has(url))
    if (results.some(r => r.status === 'stored')) emit('changed')
  } catch (err: unknown) {
    say(friendlyError(err, 'we could not pull those documents in.'), true)
  } finally {
    busy.value = ''
  }
}

async function copyItIn(): Promise<void> {
  if (busy.value) return
  busy.value = 'replicate'
  say('')
  try {
    await replicateEntryNow(props.entry.slug)
    say('Copying it in now. It can take a few minutes; the dataset appears in the library when it lands.')
  } catch (err: unknown) {
    say(friendlyError(err, 'we could not start the copy.'), true)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <section v-if="hasLink || ingest" class="ingest-block" data-testid="ingest-panel">
    <h2>What this is, and how it comes in</h2>

    <p v-if="summary" class="inspect-line" data-testid="inspection-summary">{{ summary }}</p>
    <p v-else class="inspect-line muted" data-testid="inspection-summary">
      Nobody has looked at this link yet.
    </p>

    <p v-if="inspection?.notes?.length" class="inspect-notes" data-testid="inspection-notes">
      {{ inspection.notes.join(' ') }}
    </p>

    <div class="inspect-actions">
      <button
        v-if="hasLink"
        type="button"
        class="blo-act"
        data-testid="inspect-link"
        :disabled="!!busy"
        @click="look"
      >
        {{ busy === 'inspect' ? 'Looking…' : inspection ? 'Look again' : 'Inspect this link' }}
      </button>
      <button
        v-if="canRegister"
        type="button"
        class="blo-act"
        data-testid="register-source"
        :disabled="!!busy"
        @click="register"
      >
        Register as a data source
      </button>
      <button
        v-if="canReplicate"
        type="button"
        class="blo-act"
        data-testid="replicate-now"
        :disabled="!!busy"
        @click="copyItIn"
      >
        {{ busy === 'replicate' ? 'Starting…' : 'Copy it in now' }}
      </button>
    </div>

    <!-- A service holds several layers; we pick none of them on purpose. -->
    <div v-if="serviceLayers.length" class="link-list" data-testid="service-layers">
      <p class="source-key">Layers in this service — drop the one you want</p>
      <ul>
        <li v-for="layer in serviceLayers" :key="layer.id">
          <span class="link-name">{{ layer.id }} · {{ layer.name }}</span>
          <span v-if="layer.geometry" class="muted">{{ layer.geometry }}</span>
          <button type="button" class="link-btn" data-testid="drop-layer" @click="emit('drop-link', layer.url)">
            Drop this link
          </button>
        </li>
      </ul>
    </div>

    <!-- The data links this page turned out to hold. Only what a model pass
         kept is here (P5-61); the rest of the page's links are counted. -->
    <div v-if="portalLinks.length" class="link-list" data-testid="portal-links">
      <p class="source-key">Data this page links to</p>
      <ul>
        <li v-for="link in portalLinks" :key="link.url">
          <div class="link-row">
            <a :href="link.url" target="_blank" rel="noopener noreferrer" class="link-name">
              {{ link.label || hostOf(link.url) }}
            </a>
            <span v-if="link.role" class="badge role-chip" data-testid="link-role">{{ roleLabel(link.role) }}</span>
            <span v-else-if="link.kind" class="muted">{{ link.kind }}</span>
            <button
              v-if="link.reason"
              type="button"
              class="link-btn why-btn"
              :title="link.reason"
              :aria-expanded="openReason === link.url"
              data-testid="link-why"
              @click="toggleReason(link.url)"
            >
              {{ openReason === link.url ? 'Hide why' : 'Why?' }}
            </button>
            <button type="button" class="link-btn" data-testid="drop-portal-link" @click="emit('drop-link', link.url)">
              Drop this link
            </button>
          </div>
          <p v-if="link.reason && openReason === link.url" class="link-reason" data-testid="link-reason">
            {{ link.reason }}
          </p>
        </li>
      </ul>
      <p v-if="leftOut" class="plan-next muted" data-testid="links-left-out">
        {{ leftOut }} other link{{ leftOut === 1 ? '' : 's' }} on the page {{ leftOut === 1 ? 'was' : 'were' }} left out.
        <button
          v-if="dropped.length"
          type="button"
          class="link-btn"
          data-testid="show-dropped"
          @click="showDropped = !showDropped"
        >
          {{ showDropped ? 'Hide them' : 'Show them' }}
        </button>
      </p>
      <ul v-if="showDropped && dropped.length" class="dropped-list" data-testid="dropped-links">
        <li v-for="url in dropped" :key="url">
          <a :href="url" target="_blank" rel="noopener noreferrer">{{ url }}</a>
        </li>
      </ul>
      <p v-if="unranked" class="plan-next muted" data-testid="links-unranked">
        Nobody read the page — these were picked by the shape of their addresses, so check them before using any.
        <span v-if="whyUnranked" data-testid="prune-error">Reason: {{ whyUnranked }}.</span>
      </p>
    </div>

    <!-- P5-80: the documents the page itself offers. A person ticks the ones
         they want; nothing is fetched that the page did not link to. -->
    <div v-if="documents.length" class="link-list documents-block" data-testid="documents-block">
      <p class="source-key">Documents on this page · {{ documents.length }}</p>
      <div class="doc-actions">
        <button
          type="button"
          class="link-btn"
          data-testid="choose-all-documents"
          :disabled="allChosen || !!busy"
          @click="chooseAll"
        >
          Select all
        </button>
        <button
          type="button"
          class="link-btn"
          data-testid="choose-no-documents"
          :disabled="!chosen.length || !!busy"
          @click="chooseNone"
        >
          Select none
        </button>
      </div>
      <ul>
        <li v-for="doc in documents" :key="doc.url">
          <label class="doc-row">
            <input
              v-model="chosen"
              type="checkbox"
              :value="doc.url"
              :disabled="!!busy"
              data-testid="document-check"
            />
            <span class="link-name">{{ doc.label }}</span>
          </label>
          <a :href="doc.url" target="_blank" rel="noopener noreferrer" class="link-btn">Open</a>
        </li>
      </ul>
      <div class="inspect-actions">
        <button
          type="button"
          class="blo-act"
          data-testid="pull-documents"
          :disabled="!!busy || !chosen.length"
          @click="pullIn"
        >
          {{ busy === 'documents' ? 'Pulling them in…' : `Pull in selected${chosen.length ? ` (${chosen.length})` : ''}` }}
        </button>
        <span class="muted" data-testid="documents-note">They are stored on this entry and appear under Files.</span>
      </div>
      <ul v-if="pulled.length" class="dropped-list" data-testid="pull-results">
        <li v-for="result in pulled" :key="result.url" data-testid="pull-result">
          {{ result.file || result.url }} — {{ statusText(result) }}<span v-if="result.error"> ({{ result.error }})</span>
        </li>
      </ul>
    </div>

    <!-- The decision. Admin-only: an ingest plan is a call about our work. -->
    <div class="plan-block">
      <p class="source-key">Ingest plan</p>
      <p v-if="ingest" class="plan-now" data-testid="plan-now">
        <strong>{{ PLAN_LABELS[ingest.plan] }}</strong>
        <span v-if="ingest.mode"> · {{ ingest.mode === 'auto' ? 'automatic' : 'by hand' }}</span>
        <span v-if="ingest.owner"> · {{ ingest.owner }}</span>
        <span v-if="ingest.done" class="badge done-chip" data-testid="plan-done">done</span>
      </p>
      <p v-else class="plan-now muted" data-testid="plan-now">No plan yet.</p>
      <p v-if="nextStep" class="plan-next" data-testid="plan-next">{{ nextStep }}</p>
      <p v-if="ingest?.note" class="plan-next muted" data-testid="plan-note">{{ ingest.note }}</p>

      <div v-if="isAdmin" class="plan-picker" data-testid="plan-picker">
        <button
          v-for="plan in INGEST_PLANS"
          :key="plan"
          type="button"
          class="plan-choice"
          :class="{ chosen: planned === plan }"
          :data-testid="`plan-${plan}`"
          :disabled="!!busy"
          @click="choosePlan(plan)"
        >
          {{ PLAN_LABELS[plan] }}
        </button>
      </div>
      <p v-else class="plan-next muted" data-testid="plan-admin-only">
        An admin decides the plan. Ask Nick, or leave a note on this entry.
      </p>
    </div>

    <p v-if="note" class="ingest-note" :class="{ error: isError }" data-testid="ingest-note">{{ note }}</p>
  </section>
</template>

<style scoped>
/* --- Link inspection and the ingest plan (P5-59) ---
   A solid card, unlike the dashed "suggested filing" panel above it: what the
   probe found is a FACT about the link (this URL answered with an ArcGIS layer
   of twelve fields), and the plan is a decision somebody made. Only the values
   carried into the source FORM are provisional, and they carry their own
   dashed chips there. */
.ingest-block {
  margin: 0 0 16px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.ingest-block h2 {
  margin: 0 0 8px;
  font-size: 14px;
  font-family: var(--blo-font-display, inherit);
  color: var(--blo-ink);
}

.inspect-line {
  margin: 0 0 6px;
  font-size: 14px;
  color: var(--blo-ink);
}

.inspect-notes {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--blo-stone);
}

.muted {
  color: var(--blo-stone);
}

.inspect-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 10px;
}

.link-list {
  margin: 0 0 10px;
}

.link-list ul {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.link-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.link-name {
  color: var(--blo-ink);
}

/* P5-61: the role is the first thing to read on a kept link — it is what
   decides whether this is something we could query, download, or only open. */
.link-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.badge.role-chip {
  padding: 1px 8px;
  font-size: 11px;
  border-radius: 999px;
  color: var(--blo-green-deep, #1b5e20);
  border: 1px solid var(--blo-cream-divider);
  background: var(--blo-cream, #faf7f0);
}

.why-btn {
  color: var(--blo-stone);
}

.link-reason {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--blo-stone);
}

/* The links the pass threw away. Counted by default and only ever revealed on
   request: a reviewer needs to be able to audit the prune, and nobody needs a
   link tree on the page by default. */
.dropped-list {
  margin: 4px 0 8px;
  padding: 0 0 0 16px;
  font-size: 12px;
  color: var(--blo-stone);
  overflow-wrap: anywhere;
}

/* The document collection (P5-80): a list of checkboxes, so the row is a
   label rather than a line of text with a box beside it. */
.documents-block li {
  align-items: center;
}

.doc-actions {
  display: flex;
  gap: 10px;
  margin: 4px 0 0;
}

.doc-row {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.link-btn {
  padding: 0;
  font-size: 13px;
  font-family: inherit;
  color: var(--blo-green-deep);
  background: none;
  border: 0;
  text-decoration: underline;
  cursor: pointer;
}

.link-btn:disabled {
  color: var(--blo-stone);
  text-decoration: none;
  cursor: default;
}

.source-key {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--blo-stone);
}

.plan-block {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--blo-cream-divider);
}

.plan-now {
  margin: 4px 0 4px;
  font-size: 14px;
}

.plan-next {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--blo-stone);
}

.plan-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.plan-choice {
  padding: 4px 10px;
  font-size: 13px;
  font-family: inherit;
  color: var(--blo-ink);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 999px;
  cursor: pointer;
}

.plan-choice.chosen {
  color: #1b5e20;
  border-color: #a5d6a7;
  background: #e8f5e9;
}

.plan-choice:disabled {
  opacity: 0.6;
  cursor: default;
}

.badge.done-chip {
  margin-left: 6px;
  padding: 1px 8px;
  font-size: 11px;
  border-radius: 999px;
  color: #1b5e20;
  border: 1px solid #a5d6a7;
  background: #e8f5e9;
}

.ingest-note {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.ingest-note.error {
  color: var(--blo-orange-deep, #a33);
}

/* P5-60: the inspect/register/copy buttons and the plan chips are the only
   controls on this card — they need thumb-sized boxes, and the meta lines
   need 14 px. The buttons take `.blo-act`, which carries the 44px itself. */
@media (max-width: 640px) {
  .plan-choice {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }

  .link-list li {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
    font-size: 14px;
  }

  .link-btn {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }

  .inspect-notes,
  .plan-next,
  .ingest-note,
  .link-reason,
  .dropped-list,
  .source-key {
    font-size: 14px;
  }

  .badge.done-chip,
  .badge.role-chip {
    font-size: 13px;
  }
}
</style>
