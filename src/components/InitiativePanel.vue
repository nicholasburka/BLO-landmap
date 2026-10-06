<script setup lang="ts">
/**
 * The initiative, at the top of the operations home (P5-40): the plan as a
 * thing with numbers and a next step, not a wiki page you have to know to
 * open. Everything here comes from `library/kb.json` — no facts in code.
 */
import { RouterLink } from 'vue-router'
import type { KbInitiative, KbLink } from '@/lib/kbConfig'

withDefaults(defineProps<{ initiative: KbInitiative | null; links?: KbLink[]; loading?: boolean }>(), { links: () => [] })

/** Site paths route inside the app; anything else is an outside link. */
function isInternal(href: string): boolean {
  return href.startsWith('/')
}
</script>

<template>
  <section v-if="loading" class="initiative skeleton" data-testid="initiative-skeleton" aria-hidden="true">
    <span class="bar title" />
    <span class="bar" />
    <span class="bar short" />
  </section>

  <section v-else-if="initiative" class="initiative" data-testid="initiative">
    <h2 class="name">{{ initiative.name }}</h2>
    <p v-if="initiative.tagline" class="tagline">{{ initiative.tagline }}</p>

    <ul v-if="initiative.facts.length" class="facts" data-testid="initiative-facts">
      <li v-for="fact in initiative.facts" :key="fact.label">
        <RouterLink v-if="fact.href && isInternal(fact.href)" :to="fact.href" class="fact">
          <span class="fact-value">{{ fact.value }}</span>
          <span class="fact-label">{{ fact.label }}</span>
        </RouterLink>
        <a v-else-if="fact.href" :href="fact.href" target="_blank" rel="noopener noreferrer" class="fact">
          <span class="fact-value">{{ fact.value }}</span>
          <span class="fact-label">{{ fact.label }}</span>
        </a>
        <div v-else class="fact">
          <span class="fact-value">{{ fact.value }}</span>
          <span class="fact-label">{{ fact.label }}</span>
        </div>
      </li>
    </ul>

    <div class="footer">
      <RouterLink v-if="initiative.nextStep && isInternal(initiative.nextStep.href)" :to="initiative.nextStep.href" class="next-step" data-testid="initiative-next">
        {{ initiative.nextStep.text }} <span aria-hidden="true">→</span>
      </RouterLink>
      <a v-else-if="initiative.nextStep" :href="initiative.nextStep.href" target="_blank" rel="noopener noreferrer" class="next-step" data-testid="initiative-next">
        {{ initiative.nextStep.text }} <span aria-hidden="true">→</span>
      </a>

      <span v-if="links.length" class="links" data-testid="initiative-links">
        <template v-for="link in links" :key="link.href">
          <RouterLink v-if="isInternal(link.href)" :to="link.href" class="link">{{ link.label }}</RouterLink>
          <a v-else :href="link.href" target="_blank" rel="noopener noreferrer" class="link">{{ link.label }}</a>
        </template>
      </span>
    </div>
  </section>
</template>

<style scoped>
.initiative {
  padding: 18px 20px;
  background: var(--blo-green-soft, rgba(55, 179, 74, 0.12));
  border: 1px solid var(--blo-green-deep, #1f7a2e);
  border-radius: 12px;
}

.name {
  margin: 0;
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 22px;
  line-height: 1.2;
  color: var(--blo-ink);
}

.tagline {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--blo-ink);
}

.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
  text-decoration: none;
  color: var(--blo-ink);
}

a.fact:hover {
  border-color: var(--blo-green-deep);
}

.fact-value {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 24px;
  font-weight: 700;
  line-height: 1.1;
}

.fact-label {
  font-size: 12px;
  color: var(--blo-stone);
}

.footer {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 14px;
  margin-top: 14px;
}

.next-step {
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  background: var(--blo-green-deep, #1f7a2e);
  border-radius: 6px;
  text-decoration: none;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.link {
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-green-deep, #1f7a2e);
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

.skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bar {
  display: block;
  height: 14px;
  border-radius: 4px;
  background: var(--blo-cream-deep, #efe8da);
}

.bar.title {
  height: 22px;
  width: 60%;
}

.bar.short {
  width: 40%;
}

/* P5-60: a phone gets two facts to a row (auto-fit gave one tall column) and
   nothing under 14 px. */
@media (max-width: 640px) {
  .initiative {
    padding: 14px 14px;
  }

  .name {
    font-size: clamp(19px, 6vw, 22px);
  }

  .facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  /* Two equal columns with a zero floor: `minmax(120px, …)` would be a
     240 px + gap minimum the page has to grow to honour. */
  .initiative,
  .facts,
  .fact {
    min-width: 0;
    max-width: 100%;
  }

  .fact {
    padding: 10px;
  }

  .fact-value,
  .tagline {
    overflow-wrap: anywhere;
  }

  .fact-value {
    font-size: 21px;
  }

  .fact-label {
    font-size: 14px;
    line-height: 1.3;
  }

  .next-step,
  .link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }
}
</style>
