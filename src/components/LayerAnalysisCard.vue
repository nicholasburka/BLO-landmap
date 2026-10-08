<template>
  <!-- P9-7, spec §E: four questions about the set's own layers, answered in
       the browser over numbers already on the page. No request, so no cost,
       so nothing on screen about where it runs — that is our problem, not the
       reader's. -->
  <section v-if="choices.length" class="analysis" data-testid="layer-analysis">
    <h3 class="a-title">Look at a layer</h3>

    <p class="a-pick">
      <label class="a-label" for="layer-analysis-pick">Layer</label>
      <select id="layer-analysis-pick" v-model="pick" data-testid="analysis-layer">
        <option v-for="c in choices" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <label class="a-label" for="layer-analysis-against">against</label>
      <select id="layer-analysis-against" v-model="against" data-testid="analysis-against">
        <option value="">nothing — just describe it</option>
        <option v-for="c in otherChoices" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
    </p>

    <p v-if="!spread" class="a-note" data-testid="analysis-empty">
      {{ pickedName }} has no numbers on this map yet.
    </p>

    <template v-else>
      <!-- What the host did to get these numbers, when it did anything —
           a rollup's unplaced points belong beside its counts, not nowhere. -->
      <p v-if="note" class="a-note" data-testid="analysis-note">{{ note }}</p>
      <!-- Coverage first: an index built on a layer covering a third of the
           country is an index about that third, and nothing else says so. -->
      <p class="a-line" data-testid="analysis-coverage">{{ coverageText }}</p>
      <p class="a-line" data-testid="analysis-spread">{{ spreadText }}</p>

      <!-- Capped: `SummaryChart`'s viewBox is 320 wide and it scales to its
           container, so in a 704px column every label renders at 2.2× and the
           bar counts come out bigger than the page's own headings. -->
      <div class="a-chart">
        <SummaryChart :spec="chart" />
      </div>

      <p v-if="spread.outliers.length" class="a-line" data-testid="analysis-outliers">
        Out on their own:
        <span v-for="(o, i) in spread.outliers" :key="o.geoId" class="a-outlier">
          {{ placeName(o.geoId) }} ({{ readable(o.value) }}){{ i < spread.outliers.length - 1 ? ', ' : '' }}
        </span>
      </p>

      <!-- Both ends, always. "The worst ten counties for X" is a different
           claim from "the best ten", and one without the other invites a
           reader to assume the other end is unremarkable. -->
      <div v-if="ends.top.length" class="a-ends" data-testid="analysis-ends">
        <div>
          <p class="a-ends-title">Highest</p>
          <ol class="a-list">
            <li v-for="r in ends.top" :key="r.geoId">
              <span class="a-place">{{ placeName(r.geoId) }}</span>
              <span class="a-value">{{ readable(r.value) }}</span>
            </li>
          </ol>
          <!-- A list cannot show a tie and will lie by omission: five
               counties named out of thirty-one holding the same number reads
               as a ranking. -->
          <p v-if="topTie" class="a-tie" data-testid="analysis-tie-top">{{ topTie }}</p>
        </div>
        <div v-if="ends.bottom.length">
          <p class="a-ends-title">Lowest</p>
          <ol class="a-list">
            <li v-for="r in ends.bottom" :key="r.geoId">
              <span class="a-place">{{ placeName(r.geoId) }}</span>
              <span class="a-value">{{ readable(r.value) }}</span>
            </li>
          </ol>
          <p v-if="bottomTie" class="a-tie" data-testid="analysis-tie-bottom">{{ bottomTie }}</p>
        </div>
      </div>
    </template>

    <!-- §E: a correlation is NEVER a bare r. The count and the scatter are
         part of the number, not decoration beside it. -->
    <div v-if="correlation" class="a-correlation" data-testid="analysis-correlation">
      <p v-if="correlation.r === null" class="a-note" data-testid="analysis-correlation-note">
        {{ correlation.note }}
      </p>
      <template v-else>
        <p class="a-line" data-testid="analysis-correlation-verdict">
          {{ verdict }} — <strong>{{ correlation.r.toFixed(2) }}</strong>
          across {{ correlation.n.toLocaleString() }}
          {{ correlation.n === 1 ? 'county' : 'counties' }} with both numbers.
        </p>
        <svg
          class="a-scatter"
          :viewBox="`0 0 ${SCATTER} ${SCATTER}`"
          role="img"
          :aria-label="`${pickedName} against ${againstName}, ${correlation.n} counties`"
          data-testid="analysis-scatter"
        >
          <rect x="0" y="0" :width="SCATTER" :height="SCATTER" fill="#fff" stroke="#e7e2da" />
          <circle v-for="p in scatter" :key="p.geoId" :cx="p.cx" :cy="p.cy" r="1.6" fill="#1f7a2e" fill-opacity="0.45" />
        </svg>
        <p class="a-axes">
          <span>↑ {{ againstName }}</span>
          <span>→ {{ pickedName }}</span>
        </p>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * The free analyses over one working set's layers (P9-7).
 *
 * Everything here is arithmetic over `GEOID → number` maps the map state
 * already holds, which is why there is no loading state and no progress bar:
 * 3,144 counties is nothing, and the answer is on screen in the same frame as
 * the question. The maths is `lib/layerStats`; this is the surface.
 */
import { computed, onMounted, ref, watch } from 'vue'
import SummaryChart from '@/components/SummaryChart.vue'
import { getCountyByGeoId, initCountyLookup } from '@/lib/countyLookup'
import {
  coverageLine,
  coverageOf,
  correlationOf,
  correlationVerdict,
  readable,
  spreadChart,
  spreadLine,
  spreadOf,
  tieNote,
  topAndBottom,
  type LayerValues,
} from '@/lib/layerStats'

const props = defineProps<{
  /** The layers this set offers, in the order it names them. */
  choices: { id: string; name: string }[]
  /**
   * One layer's numbers, from the map the host already has — plus anything
   * the host needs said about how it got them.
   *
   * One call returning both, deliberately: the first draft had the host write
   * its rollup note into a `ref` from inside this getter, which is a reactive
   * write during a computed and hung the page outright. A function that
   * answers the whole question has nowhere to put a side effect.
   */
  valuesFor: (layerId: string) => { values: LayerValues; note?: string; counted?: boolean }
  /** The counties the map is drawing — what coverage is measured against. */
  universe: string[]
}>()

const SCATTER = 160

const pick = ref('')
const against = ref('')

watch(
  () => props.choices,
  list => {
    if (!list.some(c => c.id === pick.value)) pick.value = list[0]?.id ?? ''
    if (against.value && !list.some(c => c.id === against.value)) against.value = ''
  },
  { immediate: true, deep: true },
)

/** A layer cannot be correlated with itself; the answer is always 1 and it is
 *  not an answer. */
const otherChoices = computed(() => props.choices.filter(c => c.id !== pick.value))
watch(pick, () => {
  if (against.value === pick.value) against.value = ''
})

const namesReady = ref(false)
onMounted(async () => {
  try {
    await initCountyLookup()
    namesReady.value = true
  } catch {
    // No lookup, no names — a geoid still identifies the county.
  }
})

function placeName(geoId: string): string {
  if (!namesReady.value) return geoId
  try {
    const county = getCountyByGeoId(geoId)
    return county ? `${county.name}, ${county.stateAbbr}` : geoId
  } catch {
    return geoId
  }
}

const nameOf = (id: string) => props.choices.find(c => c.id === id)?.name ?? id
const pickedName = computed(() => nameOf(pick.value))
const againstName = computed(() => nameOf(against.value))

const answer = computed(() => (pick.value ? props.valuesFor(pick.value) : { values: {} }))
const values = computed<LayerValues>(() => answer.value.values)
const note = computed(() => answer.value.note ?? '')
const spread = computed(() => spreadOf(values.value))
// Blank and zero are different claims: a county with no coal mines is not a
// county whose coal mines nobody counted.
const coverageText = computed(() =>
  coverageLine(coverageOf(values.value, props.universe), answer.value.counted ? 'counted' : 'measured'),
)
const spreadText = computed(() => (spread.value ? spreadLine(spread.value) : ''))
const chart = computed(() => spreadChart(spread.value!, pickedName.value))
const ends = computed(() => topAndBottom(values.value, 5))
const topTie = computed(() => (ends.value.top.length ? tieNote(ends.value.tiedAtTop, ends.value.top[0].value) : ''))
const bottomTie = computed(() =>
  ends.value.bottom.length ? tieNote(ends.value.tiedAtBottom, ends.value.bottom[0].value) : '',
)

const correlation = computed(() => {
  if (!against.value || !pick.value) return null
  return correlationOf(values.value, props.valuesFor(against.value).values)
})
const verdict = computed(() => (correlation.value?.r === null || !correlation.value ? '' : correlationVerdict(correlation.value.r)))

/** The scatter, in the drawing's own units. Both axes are scaled to their own
 *  spread, so the picture shows the SHAPE of the relationship rather than
 *  whichever layer happens to carry bigger numbers. */
const scatter = computed(() => {
  const c = correlation.value
  if (!c || c.r === null) return []
  const xs = c.points.map(p => p.x)
  const ys = c.points.map(p => p.y)
  const span = (list: number[]) => {
    const lo = Math.min(...list)
    const hi = Math.max(...list)
    return { lo, range: hi - lo || 1 }
  }
  const sx = span(xs)
  const sy = span(ys)
  const pad = 6
  const usable = SCATTER - pad * 2
  return c.points.map(p => ({
    geoId: p.geoId,
    cx: pad + ((p.x - sx.lo) / sx.range) * usable,
    // SVG y grows downward; a scatter reads bottom-left to top-right.
    cy: SCATTER - pad - ((p.y - sy.lo) / sy.range) * usable,
  }))
})
</script>

<style scoped>
.analysis {
  max-width: 44rem;
  margin: 1rem 0;
  padding-top: 0.75rem;
  border-top: 1px solid #e7e2da;
}
.a-title { margin: 0 0 0.5rem; font-size: 0.95rem; }
.a-pick { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; margin: 0 0 0.6rem; }
.a-label { font-size: 0.82rem; color: #6b6560; }

/* A bare <select> inherits nothing: it renders in the UA's own Arial at
   13.3px among the app's type, and the native dropdown it opens is sized from
   that. Saying `font: inherit` is what makes it look like it belongs here. */
.a-pick select {
  font: inherit;
  font-size: 0.82rem;
  max-width: 100%;
  padding: 2px 4px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  background: #fff;
}

/* The chart draws from a 320-wide viewBox and scales to whatever box it is
   given, so the box is what keeps its text the size of everything else. */
.a-chart {
  max-width: 26rem;
}
.a-line { margin: 0.3rem 0; font-size: 0.86rem; }
.a-note { margin: 0.3rem 0; font-size: 0.86rem; color: #6b6560; }
.a-outlier { white-space: nowrap; }
.a-ends { display: flex; flex-wrap: wrap; gap: 1.5rem; margin-top: 0.6rem; }
.a-ends-title { margin: 0 0 0.2rem; font-size: 0.8rem; color: #6b6560; }
.a-list { margin: 0; padding-left: 1.1rem; font-size: 0.84rem; }
.a-list li { margin: 0.1rem 0; }
.a-place { margin-right: 0.4rem; }
.a-value { font-variant-numeric: tabular-nums; color: #6b6560; }
.a-tie { margin: 0.25rem 0 0; font-size: 0.78rem; color: #6b6560; }
.a-correlation { margin-top: 0.8rem; }
.a-scatter { width: 180px; height: 180px; display: block; margin-top: 0.3rem; }
.a-axes { display: flex; gap: 1rem; margin: 0.2rem 0 0; font-size: 0.78rem; color: #6b6560; }
</style>
