<script setup lang="ts">
/**
 * One file of a bulk drop (P6-8).
 *
 * The row IS the review: what the machine proposed, in grey because nothing
 * has been written, with **Accept** (apply it as it stands) and **Edit** (the
 * same fields, prefilled, yours to change before saving). A row that failed
 * says why and offers **Look again**.
 *
 * The row decides nothing. Every button emits, and the panel above makes the
 * one call — so a single Accept and Accept-all are the same code.
 */
import { computed, ref, watch } from 'vue'
import TaxonomyFields from '@/components/TaxonomyFields.vue'
import OrganizationShapeFields from '@/components/OrganizationShapeFields.vue'
import { organizationLabel } from '@/config/organizations'
import { categoryLabel, shapeLabel } from '@/config/taxonomy'
import { filingFrom, hasProposal, type AcceptedFiling, type BulkRow } from '@/lib/bulkDrop'
import { ADMIN_REASON_TEXT, type AskFailureReason } from '@/lib/ask'

const props = defineProps<{ row: BulkRow; busy: boolean; accepted: boolean; isAdmin: boolean }>()
const emit = defineEmits<{
  (event: 'accept', slug: string): void
  (event: 'save', payload: { slug: string; filing: AcceptedFiling }): void
  (event: 'look-again', slug: string): void
}>()

const STATE_TEXT: Record<BulkRow['state'], string> = {
  queued: 'Queued',
  reading: 'Reading…',
  suggested: 'Suggested',
  failed: 'Needs a hand',
}

const proposed = computed(() => (hasProposal(props.row) ? props.row.suggested : null))

/** The values, in the order a person reads them. Absent fields are absent. */
const proposedLines = computed(() => {
  const s = proposed.value
  if (!s) return []
  return [
    s.summary ? { label: 'Summary', value: s.summary } : null,
    s.organization ? { label: 'Organization', value: organizationLabel(s.organization) } : null,
    s.category ? { label: 'Topic', value: categoryLabel(s.category) } : null,
    s.purpose && s.purpose !== s.category ? { label: 'Purpose', value: categoryLabel(s.purpose) } : null,
    s.shape ? { label: 'Type', value: shapeLabel(s.shape) } : null,
    s.tags?.length ? { label: 'Tags', value: s.tags.join(', ') } : null,
  ].filter((line): line is { label: string; value: string } => !!line)
})

/**
 * Why there is no proposal, in words the reader can act on.
 *
 * P5-75's rule: an admin is told what to go and fix, because they can; a
 * member is told the model was unavailable, because that is all they can act
 * on. "No text could be read" is neither — it is about the file.
 */
const failureLine = computed(() => {
  if (props.row.state !== 'failed') return ''
  const reason = props.row.suggested?.reason
  if (props.row.suggested?.error === 'unavailable') {
    const tail = props.isAdmin && reason
      ? ADMIN_REASON_TEXT[reason as AskFailureReason].replace(/\.$/, '')
      : 'the model was unavailable'
    return `No model pass — ${tail}.`
  }
  return props.row.reason ?? 'The pass did not finish.'
})

const editing = ref(false)
const filing = ref<AcceptedFiling>(filingFrom(undefined))

function startEdit(): void {
  filing.value = filingFrom(props.row.suggested)
  if (!filing.value.title) filing.value.title = props.row.title
  editing.value = true
}

function save(): void {
  emit('save', { slug: props.row.slug, filing: filing.value })
}

// An accepted row has nothing left to edit.
watch(
  () => props.accepted,
  is => {
    if (is) editing.value = false
  },
)
</script>

<template>
  <li class="row" :class="[row.state, { accepted }]" data-testid="bulk-row" :data-state="accepted ? 'accepted' : row.state">
    <div class="head">
      <span class="file" data-testid="bulk-row-file">{{ row.file }}</span>
      <span class="chip" data-testid="bulk-row-state">{{ accepted ? 'Filed' : STATE_TEXT[row.state] }}</span>
    </div>

    <p v-if="accepted" class="filed" data-testid="bulk-row-filed">Filed as “{{ row.title }}”.</p>

    <template v-else-if="proposed && !editing">
      <p class="title suggested" data-testid="bulk-row-title">
        {{ proposed.title || row.title }}
        <span class="badge" data-testid="suggested-badge">suggested</span>
      </p>
      <dl v-if="proposedLines.length" class="fields suggested" data-testid="bulk-row-fields">
        <template v-for="line in proposedLines" :key="line.label">
          <dt>{{ line.label }}</dt>
          <dd>{{ line.value }}</dd>
        </template>
      </dl>
      <div class="actions">
        <button type="button" class="primary" :disabled="busy" data-testid="accept-row" @click="emit('accept', row.slug)">
          Accept
        </button>
        <button type="button" class="plain" :disabled="busy" data-testid="edit-row" @click="startEdit">Edit</button>
        <RouterLink class="plain link" :to="`/library/${row.slug}`">Open</RouterLink>
      </div>
    </template>

    <form v-else-if="editing" class="edit" data-testid="bulk-row-edit" @submit.prevent="save">
      <input v-model="filing.title" type="text" aria-label="Title" placeholder="Title" />
      <TaxonomyFields v-model:category="filing.category" v-model:tags="filing.tags" :disabled="busy" />
      <OrganizationShapeFields
        :organization="filing.organization ?? ''"
        :shape="filing.shape ?? ''"
        :disabled="busy"
        @update:organization="v => (filing.organization = v)"
        @update:shape="v => (filing.shape = v)"
      />
      <textarea v-model="filing.description" rows="2" aria-label="Description" placeholder="Description"></textarea>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy" data-testid="save-row">Save</button>
        <button type="button" class="plain" :disabled="busy" @click="editing = false">Cancel</button>
      </div>
    </form>

    <template v-else-if="row.state === 'failed'">
      <p class="title">{{ row.title }}</p>
      <p class="why" data-testid="bulk-row-why">{{ failureLine }}</p>
      <div class="actions">
        <button type="button" class="plain" :disabled="busy" data-testid="look-again" @click="emit('look-again', row.slug)">
          Look again
        </button>
        <RouterLink class="plain link" :to="`/library/${row.slug}`">Open</RouterLink>
      </div>
    </template>

    <p v-else class="title">{{ row.title }}</p>
  </li>
</template>

<style scoped>
.row {
  list-style: none;
  border: 1px solid var(--blo-cream-divider, #e8e1d4);
  border-radius: 8px;
  padding: 12px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
}

.file {
  font-size: 0.82rem;
  color: #7a7063;
  word-break: break-all;
}

.chip {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f0ece2;
  color: #5c5348;
  white-space: nowrap;
}

.row.suggested .chip {
  background: #eaf2ea;
  color: #2f5d3a;
}

.row.failed .chip {
  background: #fdeee5;
  color: #9a3412;
}

.row.accepted .chip {
  background: var(--blo-green, #2f5d3a);
  color: #fff;
}

.title {
  margin: 0;
  font-weight: 600;
}

/* Grey until a person accepts it: nothing here has been written down. */
.suggested {
  color: #6b6357;
}

.badge {
  margin-left: 6px;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid #ddd5c6;
  color: #7a7063;
  font-weight: 600;
  vertical-align: middle;
}

.fields {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  font-size: 0.88rem;
}

.fields dt {
  font-weight: 600;
}

.fields dd {
  margin: 0;
}

.why,
.filed {
  margin: 0;
  font-size: 0.88rem;
  color: #5c5348;
}

.edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.edit input,
.edit textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  font: inherit;
  box-sizing: border-box;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.primary {
  padding: 7px 14px;
  border: none;
  border-radius: 6px;
  background: var(--blo-green, #2f5d3a);
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.plain {
  padding: 7px 12px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  background: #fff;
  font: inherit;
  cursor: pointer;
  color: inherit;
  text-decoration: none;
}

.primary:disabled,
.plain:disabled {
  opacity: 0.6;
  cursor: default;
}

@media (max-width: 640px) {
  .actions button,
  .actions .link {
    flex: 1 1 auto;
    text-align: center;
  }
}
</style>
