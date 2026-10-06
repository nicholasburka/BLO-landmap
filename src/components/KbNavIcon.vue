<script setup lang="ts">
/**
 * The six glyphs beside the library strip's items (P6-30).
 *
 * Drawn from Nick's handdrawn mockup (`BLO-library-redesign-mockup.jpg`),
 * which puts an icon beside each item: a grid for Datasets, a page of text for
 * Docs, a bar chart for Analysis, a magnifier for Search, a speech bubble for
 * Chat, and an upward mark for New.
 *
 * Inline SVG rather than an icon font or a sprite: six 16px glyphs are smaller
 * as markup than any dependency that would draw them, they inherit `color`
 * through `currentColor` so an active tab's icon lights with its label for
 * free, and there is no extra request on a page the whole knowledge base
 * renders.
 *
 * Decorative by construction — `aria-hidden`, no `<title>`. Every item still
 * carries its own word, so announcing the glyph too would say everything
 * twice.
 */
defineProps<{ name: 'datasets' | 'docs' | 'analysis' | 'search' | 'chat' | 'new' }>()
</script>

<template>
  <svg
    class="kb-icon"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.3"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    :data-icon="name"
  >
    <!-- Datasets: a table. Rows and columns are what a dataset IS here. -->
    <template v-if="name === 'datasets'">
      <rect x="2" y="2.5" width="12" height="11" rx="1.2" />
      <path d="M2 6h12M2 10h12M6.5 6v7.5M10.5 6v7.5" />
    </template>

    <!-- Docs: a page with lines of writing. -->
    <template v-else-if="name === 'docs'">
      <path d="M3.5 2h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
      <path d="M9.5 2v3.5h3" />
      <path d="M5.5 8.5h5M5.5 11h3.5" />
    </template>

    <!-- Analysis: bars of different heights — the mockup's bracketed chart. -->
    <template v-else-if="name === 'analysis'">
      <path d="M2.5 13.5h11" />
      <path d="M4.5 13.5v-4M8 13.5v-7M11.5 13.5v-2.5" />
    </template>

    <!-- Search: a magnifier. -->
    <template v-else-if="name === 'search'">
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3.3 3.3" />
    </template>

    <!-- Chat: a speech bubble with a tail. -->
    <template v-else-if="name === 'chat'">
      <path d="M13.5 9.5a2 2 0 0 1-2 2H6l-3 2.5v-2.5h-.5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2Z" />
    </template>

    <!-- New: something going in — an arrow rising into the shelf it lands on. -->
    <template v-else>
      <path d="M8 11V2.5" />
      <path d="m4.5 6 3.5-3.5L11.5 6" />
      <path d="M2.5 13.5h11" />
    </template>
  </svg>
</template>

<style scoped>
.kb-icon {
  flex: 0 0 auto;
  /* Optical, not geometric: a 14px glyph beside 13px text sits a touch high on
     its own baseline. */
  margin-right: 5px;
  vertical-align: -2px;
  /* Quieter than the word it accompanies. KbNav lifts this to 1 on the active
     and hovered items — those rules live there, with the `.kb-nav-link` class
     they depend on, rather than reaching up out of this component. */
  opacity: 0.75;
}
</style>
