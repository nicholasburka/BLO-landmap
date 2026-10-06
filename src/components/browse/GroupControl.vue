<script setup lang="ts">
/**
 * "Group by: Organization · Topic · Type" (P6-3, P6-4).
 *
 * One row of buttons, one of them pressed. Deliberately not a `<select>`: the
 * whole point of the browser is that regrouping is one press, and the three
 * words are the page's own vocabulary — worth reading without opening a menu.
 */
defineProps<{
  modelValue: string
  options: { id: string; label: string }[]
  /** What the row of buttons is choosing, for a screen reader. */
  label: string
}>()

const emit = defineEmits<{ 'update:modelValue': [string] }>()
</script>

<template>
  <div class="group-control" role="group" :aria-label="label" data-testid="group-control">
    <span class="group-control-label">Group by</span>
    <button
      v-for="option in options"
      :key="option.id"
      type="button"
      class="group-btn"
      :class="{ active: modelValue === option.id }"
      :aria-pressed="modelValue === option.id"
      :data-group-by="option.id"
      @click="emit('update:modelValue', option.id)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.group-control {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.group-control-label {
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
}

.group-btn {
  padding: 3px 12px;
  font-family: inherit;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
}

.group-btn:hover {
  border-color: var(--blo-ink, #111);
  color: var(--blo-ink, #111);
}

.group-btn.active {
  background: var(--blo-ink, #111);
  border-color: var(--blo-ink, #111);
  color: #ffffff;
}

/* --- Phone (P5-60) -------------------------------------------------------- */
@media (max-width: 640px) {
  .group-control-label {
    font-size: 14px;
    width: 100%;
  }

  .group-btn {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }
}
</style>
