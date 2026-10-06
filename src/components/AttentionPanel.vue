<script setup lang="ts">
/**
 * Needs attention (P5-40): what is waiting on a person, each count linking
 * straight into the filtered list that fixes it. Computed from the catalog
 * the landing already fetched — no extra request, no extra state.
 */
import { RouterLink } from 'vue-router'
import type { AttentionItem } from '@/lib/kb'

withDefaults(defineProps<{ items?: AttentionItem[]; loading?: boolean }>(), { items: () => [] })
</script>

<template>
  <section class="attention" data-testid="attention">
    <h2>Needs attention</h2>

    <p v-if="loading" class="state-note">Checking…</p>

    <ul v-else-if="items.length" class="rows">
      <li v-for="item in items" :key="item.key">
        <RouterLink :to="item.href" class="row" data-testid="attention-row">
          <span class="count">{{ item.count }}</span>
          <span class="label">{{ item.label }}</span>
          <span class="arrow" aria-hidden="true">→</span>
        </RouterLink>
      </li>
    </ul>

    <p v-else class="state-note all-clear" data-testid="attention-clear">All clear — nothing is waiting to be filed, reviewed, cleaned, or fetched.</p>
  </section>
</template>

<style scoped>
.attention h2 {
  font-size: 16px;
  margin: 0 0 8px;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 9px 12px;
  background: #fff;
  border: 1px solid var(--blo-orange-deep, #e65100);
  border-radius: 8px;
  text-decoration: none;
  color: var(--blo-ink);
}

.row:hover {
  background: var(--blo-cream, #faf6ec);
}

.count {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
  min-width: 24px;
}

.label {
  font-size: 13px;
  font-weight: 600;
}

.arrow {
  margin-left: auto;
  color: var(--blo-orange-deep, #e65100);
}

.state-note {
  font-size: 13px;
  color: var(--blo-stone);
}

.all-clear {
  padding: 9px 12px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

/* P5-60: each row is a link to a filtered list — it needs a thumb-sized box. */
@media (max-width: 640px) {
  .row {
    min-height: 44px;
    align-items: center;
    min-width: 0;
  }

  .label {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .label,
  .state-note {
    font-size: 14px;
  }
}
</style>
