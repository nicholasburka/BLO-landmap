<script setup lang="ts">
/**
 * P6-8a: the two vocabulary fields a filing form carries beside the taxonomy —
 * who publishes the thing, and what shape its data takes. Both are optional:
 * "Not set" leaves the manifest without the field, and a reindex derives it
 * from the provider string or the file's columns as before.
 */
import { ORGANIZATIONS, organizationLabel } from '@/config/organizations'
import { SHAPES } from '@/config/taxonomy'

defineProps<{
  organization: string
  shape: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:organization': [value: string]
  'update:shape': [value: string]
}>()

function pick(event: Event): string {
  return (event.target as HTMLSelectElement).value
}
</script>

<template>
  <div class="vocab-fields">
    <label>
      <span>Organization</span>
      <select
        :value="organization"
        :disabled="disabled"
        aria-label="Organization"
        data-testid="filing-organization"
        @change="emit('update:organization', pick($event))"
      >
        <option value="">Not set</option>
        <option v-for="org in ORGANIZATIONS" :key="org.id" :value="org.id">{{ organizationLabel(org.id) }}</option>
      </select>
    </label>
    <label>
      <span>Type</span>
      <select
        :value="shape"
        :disabled="disabled"
        aria-label="Type"
        data-testid="filing-shape"
        @change="emit('update:shape', pick($event))"
      >
        <option value="">Not set</option>
        <option v-for="s in SHAPES" :key="s.id" :value="s.id" :title="s.description">{{ s.label }}</option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.vocab-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}
.vocab-fields label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.85rem;
  color: var(--kb-muted, #555);
}
.vocab-fields select {
  font: inherit;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--kb-border, #ccc);
  border-radius: 6px;
  background: var(--kb-surface, #fff);
  color: inherit;
}
@media (max-width: 600px) {
  .vocab-fields {
    grid-template-columns: 1fr;
  }
}
</style>
