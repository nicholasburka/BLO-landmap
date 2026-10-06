<script setup lang="ts">
/**
 * Guided first run (P5-43, re-pointed by P6-5). Six things worth doing once,
 * on the front door, ticking themselves off as the person does them — no tour
 * to sit through, nothing to remember to mark, and gone for good once it is
 * finished.
 *
 * One step per surface, so finishing it means having been everywhere the
 * header and the resource tabs can take you. The words and the links live in
 * `lib/firstRun`; this is the rendering.
 *
 * The tracking itself is registered in App.vue, not here: progress has to be
 * noticed while the person is away on the map or in a document, long after
 * this component has unmounted.
 */
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import {
  firstRunSteps,
  firstRunDone,
  firstRunVisible,
  FIRST_RUN_TOTAL,
  dismissFirstRun,
  loadFirstRun,
  type FirstRunStepId,
} from '@/lib/firstRun'

onMounted(() => {
  // Another tab (or an earlier session) may have got further than this
  // module's copy of the state.
  loadFirstRun()
})

const steps = firstRunSteps()
const doneCount = computed(() => firstRunDone.value.length)

function isDone(id: FirstRunStepId): boolean {
  return firstRunDone.value.includes(id)
}
</script>

<template>
  <section v-if="firstRunVisible" class="firstrun" data-testid="firstrun" aria-labelledby="firstrun-heading">
    <header class="firstrun-head">
      <h2 id="firstrun-heading" class="firstrun-title" data-testid="firstrun-progress">
        Getting started — {{ doneCount }} of {{ FIRST_RUN_TOTAL }}
      </h2>
      <button type="button" class="firstrun-dismiss" data-testid="firstrun-dismiss" @click="dismissFirstRun">Hide this</button>
    </header>
    <p class="firstrun-lede">Six things worth doing once, one on each page. Each ticks itself off the moment you do it — each line says what does it.</p>

    <ol class="firstrun-list">
      <li
        v-for="step in steps"
        :key="step.id"
        class="firstrun-item"
        :class="{ done: isDone(step.id) }"
        data-testid="firstrun-item"
        :data-step="step.id"
      >
        <span class="firstrun-mark" aria-hidden="true">{{ isDone(step.id) ? '✓' : '○' }}</span>
        <span class="firstrun-text">
          <RouterLink :to="step.href" class="firstrun-link">{{ step.label }}</RouterLink>
          <span v-if="isDone(step.id)" class="firstrun-sr">(done)</span>
          <span class="firstrun-hint">{{ step.hint }}</span>
        </span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.firstrun {
  padding: 16px 18px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-left: 3px solid var(--blo-green-deep, #1f7a2e);
  border-radius: 10px;
}

.firstrun-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.firstrun-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--blo-ink, #111);
}

.firstrun-dismiss {
  margin-left: auto;
  padding: 0;
  font-family: inherit;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
  background: none;
  border: none;
  cursor: pointer;
}

.firstrun-dismiss:hover {
  color: var(--blo-ink, #111);
  text-decoration: underline;
}

.firstrun-lede {
  margin: 4px 0 10px;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
}

.firstrun-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.firstrun-item {
  display: flex;
  gap: 10px;
  padding: 6px 0;
  align-items: baseline;
}

.firstrun-mark {
  flex: 0 0 auto;
  width: 14px;
  font-size: 13px;
  color: var(--blo-stone-soft, #9a948e);
}

.firstrun-item.done .firstrun-mark {
  color: var(--blo-green-deep, #1f7a2e);
}

.firstrun-text {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.firstrun-link {
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  text-decoration: none;
}

.firstrun-link:hover {
  color: var(--blo-green-deep, #1f7a2e);
}

/* Done items stay legible — struck-through text is hard to read and the
   tick already says it. */
.firstrun-item.done .firstrun-link {
  color: var(--blo-stone, #6b6560);
  font-weight: 500;
}

.firstrun-hint {
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
}

.firstrun-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* P5-60: six steps, each a link somebody taps once — 44 px rows, and the
   hint text no longer at 12 px. */
@media (max-width: 640px) {
  .firstrun-item {
    align-items: center;
    min-height: 44px;
    padding: 4px 0;
  }

  .firstrun-lede,
  .firstrun-hint {
    font-size: 14px;
  }

  .firstrun-link {
    display: inline-flex;
    align-items: center;
    min-height: 36px;
  }

  .firstrun-dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    min-width: 44px;
    min-height: 44px;
    font-size: 14px;
  }
}
</style>
