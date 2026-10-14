<template>
  <p class="scope" data-testid="scope-chip">
    <span class="scope-label">{{ label }}</span>
    <span class="scope-name" data-testid="scope-name">{{ name }}</span>
    <button type="button" class="scope-clear" :aria-label="clearLabel" data-testid="scope-clear" @click="emit('clear')">
      ✕
    </button>
    <RouterLink :to="setWorkspaceHref(slug)" class="scope-open" data-testid="scope-open">Open the set</RouterLink>
  </p>
</template>

<script setup lang="ts">
/**
 * What a page is scoped to, and the way out of it (P11-8/P11-9).
 *
 * A removable chip rather than a mode. Scope that is not visible is scope
 * nobody can account for: a chat answered "from this set" reads identically
 * to one answered from the whole library, and the reader cannot tell which
 * they got. The chip says which, and dismissing it is how you widen — so
 * "in this set" and "everything" are one control in two states rather than
 * two features.
 *
 * Shared by Search and Chat deliberately. They are the same promise.
 */
import { RouterLink } from 'vue-router'
import { setWorkspaceHref } from '@/lib/workingSets'

defineProps<{
  /** The set's slug, for the link out to it. */
  slug: string
  /** The set's name, or its slug while the name is still loading. */
  name: string
  /** "Searching in" / "Asking about" — the verb this page does. */
  label: string
  clearLabel: string
}>()

const emit = defineEmits<{ clear: [] }>()
</script>

<style scoped>
.scope {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 12px;
  padding: 6px 10px;
  font-size: 13px;
  background: var(--blo-green-soft, rgba(55, 179, 74, 0.12));
  border: 1px solid var(--blo-cream-divider);
  border-radius: 999px;
  width: fit-content;
  max-width: 100%;
}

.scope-label {
  color: var(--blo-stone);
}

.scope-name {
  font-weight: 600;
  color: var(--blo-ink);
  overflow-wrap: anywhere;
}

.scope-clear {
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 3px 6px;
  color: var(--blo-stone);
  background: none;
  border: none;
  border-radius: 999px;
  cursor: pointer;
}

.scope-clear:hover {
  color: var(--blo-ink);
  background: rgba(0, 0, 0, 0.06);
}

.scope-open {
  font-size: 12px;
  color: var(--blo-green-deep);
}

@media (max-width: 640px) {
  .scope-clear {
    min-width: 44px;
    min-height: 44px;
  }
}
</style>
