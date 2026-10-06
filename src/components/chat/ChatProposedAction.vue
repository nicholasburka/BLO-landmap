<script setup lang="ts">
/**
 * A write the assistant wants to make (P6-7b, docs/CHAT.md §5).
 *
 * Nothing has happened. The model called a write tool and the server turned
 * the call into this card instead of running it, so the card asks the
 * question plainly: what it would do, the arguments that matter, and two
 * buttons. **Run** confirms the STORED proposal — the arguments shown are the
 * arguments that execute. **Dismiss** does nothing at all: a proposal nobody
 * confirms stays proposed forever, harmless, and there is no delete tool
 * anywhere on this server to undo one with.
 */
import { ref, computed } from 'vue'
import { RouterLink } from 'vue-router'
import { toAppPath, type ChatToolCall } from '@/lib/libraryChat'
import type { ActionState } from '@/composables/useLibraryChat'

const props = defineProps<{ call: ChatToolCall; state: ActionState }>()
const emit = defineEmits<{ (e: 'run', actionId: string): void }>()

/** Dismissing is a client-side act — it leaves the proposal unrun. */
const dismissed = ref(false)

/** The arguments worth reading, in the order a person would check them.
 *  Everything is shown; the named ones just come first. */
const FIRST = ['title', 'slug', 'name', 'url', 'section', 'body', 'markdown', 'text']

const args = computed(() => {
  const entries = Object.entries(props.call.args ?? {})
  entries.sort(([a], [b]) => {
    const ia = FIRST.indexOf(a)
    const ib = FIRST.indexOf(b)
    return (ia < 0 ? FIRST.length : ia) - (ib < 0 ? FIRST.length : ib)
  })
  return entries.map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return { key, value: text.length > 600 ? `${text.slice(0, 600)}…` : text }
  })
})

/** Where the finished write landed, when it said. */
const openHref = computed(() => {
  const href = props.call.result?.href
  return typeof href === 'string' ? toAppPath(href) : null
})
</script>

<template>
  <section class="proposal" :class="state" data-testid="chat-proposal">
    <p class="proposal-head">
      <span class="proposal-label">The assistant wants to:</span>
      <span class="proposal-summary" data-testid="chat-proposal-summary">{{ call.summary }}</span>
    </p>

    <dl v-if="args.length" class="proposal-args" data-testid="chat-proposal-args">
      <template v-for="arg in args" :key="arg.key">
        <dt>{{ arg.key }}</dt>
        <dd>{{ arg.value }}</dd>
      </template>
    </dl>

    <div v-if="state === 'done'" class="proposal-said" data-testid="chat-proposal-done">
      Done.
      <RouterLink v-if="openHref" :to="openHref" data-testid="chat-proposal-open">Open it</RouterLink>
    </div>
    <p v-else-if="state === 'failed'" class="proposal-said bad" data-testid="chat-proposal-failed">
      It did not run. Nothing was changed.
    </p>
    <p v-else-if="dismissed" class="proposal-said" data-testid="chat-proposal-dismissed">
      Left unrun. It stays here if you change your mind.
    </p>
    <div v-else class="proposal-buttons">
      <button
        type="button"
        class="proposal-run"
        :disabled="state === 'running'"
        data-testid="chat-proposal-run"
        @click="emit('run', call.id)"
      >
        {{ state === 'running' ? 'Running…' : 'Run' }}
      </button>
      <button
        type="button"
        class="proposal-dismiss"
        :disabled="state === 'running'"
        data-testid="chat-proposal-dismiss"
        @click="dismissed = true"
      >
        Dismiss
      </button>
    </div>
  </section>
</template>

<style scoped>
.proposal {
  margin: 10px 0;
  padding: 12px 14px;
  background: var(--blo-orange-soft, rgba(255, 107, 28, 0.1));
  border: 1px solid var(--blo-orange-ring, rgba(255, 107, 28, 0.35));
  border-radius: 10px;
}

.proposal.done {
  background: var(--blo-green-soft, rgba(55, 179, 74, 0.12));
  border-color: var(--blo-green-deep, #1f7a2e);
}

.proposal.failed {
  background: #fdecea;
  border-color: #f0b4ac;
}

.proposal-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 14px;
  color: var(--blo-ink, #111);
}

.proposal-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
}

.proposal-summary {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.proposal-args {
  display: grid;
  grid-template-columns: minmax(4rem, auto) 1fr;
  gap: 2px 10px;
  margin: 8px 0 0;
  font-size: 13px;
}

.proposal-args dt {
  color: var(--blo-stone, #6b6560);
}

.proposal-args dd {
  margin: 0;
  min-width: 0;
  color: var(--blo-ink, #111);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.proposal-buttons {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.proposal-run,
.proposal-dismiss {
  padding: 6px 16px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  border-radius: 999px;
  cursor: pointer;
}

.proposal-run {
  color: #fff;
  background: var(--blo-green-deep, #1f7a2e);
  border: 1px solid var(--blo-green-deep, #1f7a2e);
}

.proposal-dismiss {
  color: var(--blo-ink, #111);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
}

.proposal-run:disabled,
.proposal-dismiss:disabled {
  cursor: default;
  opacity: 0.6;
}

.proposal-said {
  margin: 10px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-stone, #6b6560);
}

.proposal-said a {
  margin-left: 6px;
  color: var(--blo-green-deep, #1f7a2e);
}

.proposal-said.bad {
  color: #7f1d1d;
}

@media (max-width: 640px) {
  .proposal-args,
  .proposal-said {
    font-size: 14px;
  }

  .proposal-run,
  .proposal-dismiss {
    flex: 1 1 0;
    min-height: 44px;
    font-size: 14px;
  }
}
</style>
