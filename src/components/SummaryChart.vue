<script setup lang="ts">
/**
 * One chart, drawn as plain SVG (P5-54). No charting library: three shapes
 * (bars, histogram, line) with labelled marks is the whole requirement, and
 * a dependency that ships a rendering engine to draw twelve rectangles is a
 * bad trade in a bundle this map already fills.
 *
 * The shape comes from src/lib/charts.ts — this file is geometry and paint.
 * The drawing is a viewBox with no fixed width, so it scales to whatever
 * column it lands in and stays legible at 360 px.
 *
 * "Copy as image" rasterises the SVG through a canvas and puts a PNG on the
 * clipboard, so a chart can go straight into a slide deck. Where the
 * clipboard is unavailable (Safari without a user-gesture path, an insecure
 * origin, a browser without ClipboardItem) it offers the same PNG as a
 * download instead — the researcher still leaves with the picture.
 *
 * Colours are literal here rather than CSS variables on purpose: a
 * serialised SVG carries no stylesheet, so a var() would rasterise black.
 */
import { computed, ref, onBeforeUnmount } from 'vue'
import type { ChartSpec } from '@/lib/charts'

const props = defineProps<{
  spec: ChartSpec
  /** Names the downloaded file, e.g. "orgs-tier". */
  fileName?: string
}>()

const INK = '#111111'
const STONE = '#6b6560'
const GREEN = '#1f7a2e'
const CREAM = '#ede8dd'
const PAPER = '#ffffff'

/** The drawing is this many units wide; every x below is a fraction of it. */
const WIDTH = 320
/** Bars: one labelled row each. */
const BAR_ROW = 30
/** Columns and lines: the plot area's height. */
const PLOT_HEIGHT = 132

const svgEl = ref<SVGSVGElement | null>(null)

/** Long value names would run off the edge; the full text stays in the
 *  mark's <title>, which is also what a screen reader announces. */
function clip(label: string): string {
  return label.length > 30 ? `${label.slice(0, 29)}…` : label
}

const points = computed(() => props.spec.points)
const max = computed(() => Math.max(props.spec.max, 1))

// --- Horizontal bars ---------------------------------------------------------

const barRows = computed(() =>
  points.value.map((p, i) => ({
    ...p,
    short: clip(p.label),
    y: i * BAR_ROW,
    width: Math.max(2, (p.value / max.value) * WIDTH),
  })),
)

// --- Vertical columns (histogram) --------------------------------------------

const columns = computed(() => {
  const gap = points.value.length > 20 ? 1 : 3
  const slot = WIDTH / Math.max(points.value.length, 1)
  return points.value.map((p, i) => {
    const height = Math.max(1, (p.value / max.value) * PLOT_HEIGHT)
    return {
      ...p,
      x: i * slot + gap / 2,
      width: Math.max(1, slot - gap),
      y: PLOT_HEIGHT - height,
      height,
      centre: i * slot + slot / 2,
    }
  })
})

// --- Line --------------------------------------------------------------------

const linePoints = computed(() => {
  const n = points.value.length
  const step = n > 1 ? WIDTH / (n - 1) : 0
  return points.value.map((p, i) => ({
    ...p,
    x: n > 1 ? i * step : WIDTH / 2,
    y: PLOT_HEIGHT - (p.value / max.value) * PLOT_HEIGHT,
  }))
})

const linePath = computed(() => linePoints.value.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))

/** Only the ends and the peak get a number — a label on every point of a
 *  36-month line is unreadable. */
const lineLabelled = computed(() => {
  const list = linePoints.value
  if (list.length === 0) return []
  const peak = list.reduce((best, p) => (p.value > best.value ? p : best), list[0])
  const keep = new Set([list[0], list[list.length - 1], peak])
  return [...keep]
})

/** Ticks under a column/line chart: the ends, plus the middle when there is
 *  room for a third without them colliding. */
const axisTicks = computed(() => {
  const list = props.spec.kind === 'line' ? linePoints.value : columns.value.map(c => ({ ...c, x: c.centre }))
  if (list.length === 0) return []
  const first = list[0]
  const last = list[list.length - 1]
  if (list.length < 5) return [{ label: first.label, x: 0, anchor: 'start' }, ...(list.length > 1 ? [{ label: last.label, x: WIDTH, anchor: 'end' }] : [])]
  const mid = list[Math.floor(list.length / 2)]
  return [
    { label: first.label, x: 0, anchor: 'start' },
    { label: mid.label, x: WIDTH / 2, anchor: 'middle' },
    { label: last.label, x: WIDTH, anchor: 'end' },
  ]
})

const viewBox = computed(() =>
  props.spec.kind === 'bars'
    ? `0 0 ${WIDTH} ${Math.max(BAR_ROW, points.value.length * BAR_ROW)}`
    : `0 0 ${WIDTH} ${PLOT_HEIGHT + 30}`,
)

/** What a screen reader hears instead of the picture. */
const ariaLabel = computed(
  () => `${props.spec.title}. ${props.spec.valueAxis}. ${points.value.map(p => `${p.label}: ${p.value}`).join(', ')}`,
)

// --- Copy as image ------------------------------------------------------------

type CopyState = 'idle' | 'working' | 'copied' | 'download'
const copyState = ref<CopyState>('idle')
const downloadUrl = ref('')

const downloadName = computed(() => `${(props.fileName || props.spec.title).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'chart'}.png`)

function releaseDownload(): void {
  if (downloadUrl.value && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(downloadUrl.value)
  downloadUrl.value = ''
}
onBeforeUnmount(releaseDownload)

/** The SVG as a standalone document, at twice the drawn size so the PNG is
 *  sharp when it lands in a slide. */
function serialize(svg: SVGSVGElement, width: number, height: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  // A white ground: a transparent PNG pasted into a dark slide loses its
  // black labels entirely.
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bg.setAttribute('width', '100%')
  bg.setAttribute('height', '100%')
  bg.setAttribute('fill', PAPER)
  clone.insertBefore(bg, clone.firstChild)
  return new XMLSerializer().serializeToString(clone)
}

async function toPng(svg: SVGSVGElement): Promise<Blob | null> {
  // Read the attribute rather than svg.viewBox.baseVal: the parsed interface
  // is not implemented everywhere (jsdom included), and the string is the
  // thing this component wrote in the first place.
  const box = (svg.getAttribute('viewBox') ?? '').split(/\s+/).map(Number)
  const width = (box[2] || WIDTH) * 2
  const height = (box[3] || PLOT_HEIGHT) * 2
  const markup = serialize(svg, width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof canvas.toBlob !== 'function') return null

  const image = new Image()
  const drawn = new Promise<boolean>(resolve => {
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
  })
  // A data URL (not a blob: URL) keeps the image same-origin, so the canvas
  // is not tainted and toBlob is allowed to read it back.
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
  if (!(await drawn)) return null
  ctx.drawImage(image, 0, 0, width, height)
  return new Promise<Blob | null>(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'))
}

async function copyImage(): Promise<void> {
  if (!svgEl.value || copyState.value === 'working') return
  copyState.value = 'working'
  releaseDownload()
  try {
    const blob = await toPng(svgEl.value)
    if (!blob) {
      copyState.value = 'idle'
      return
    }
    const clipboard = navigator.clipboard as Clipboard | undefined
    const ClipboardItemCtor = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
    if (clipboard?.write && ClipboardItemCtor) {
      await clipboard.write([new ClipboardItemCtor({ 'image/png': blob })])
      copyState.value = 'copied'
      return
    }
    // No clipboard for images here — hand over the file instead.
    downloadUrl.value = URL.createObjectURL(blob)
    copyState.value = 'download'
  } catch {
    try {
      const blob = await toPng(svgEl.value)
      if (blob) downloadUrl.value = URL.createObjectURL(blob)
      copyState.value = 'download'
    } catch {
      copyState.value = 'idle'
    }
  }
}
</script>

<template>
  <figure class="summary-chart" data-testid="summary-chart">
    <figcaption class="chart-head">
      <span class="chart-title">{{ spec.title }}</span>
      <button type="button" class="copy-btn touch-target" data-testid="chart-copy" @click="copyImage">
        {{ copyState === 'working' ? 'Copying…' : copyState === 'copied' ? 'Copied ✓' : 'Copy as image' }}
      </button>
    </figcaption>

    <p class="axis-note">{{ spec.valueAxis }} · {{ spec.categoryAxis }}</p>

    <svg
      ref="svgEl"
      class="chart-svg"
      :viewBox="viewBox"
      preserveAspectRatio="xMinYMin meet"
      role="img"
      :aria-label="ariaLabel"
      data-testid="chart-svg"
    >
      <title>{{ spec.title }}</title>

      <!-- Bars: one labelled row per value, length against the largest. -->
      <g v-if="spec.kind === 'bars'" data-testid="chart-bars">
        <g v-for="row in barRows" :key="row.label">
          <title>{{ row.label }} — {{ row.valueLabel }}</title>
          <text :x="0" :y="row.y + 11" font-size="11" :fill="INK">{{ row.short }}</text>
          <text :x="WIDTH" :y="row.y + 11" font-size="11" text-anchor="end" :fill="STONE">{{ row.valueLabel }}</text>
          <rect :x="0" :y="row.y + 16" :width="WIDTH" height="8" rx="4" :fill="CREAM" />
          <rect :x="0" :y="row.y + 16" :width="row.width" height="8" rx="4" :fill="GREEN" />
        </g>
      </g>

      <!-- Histogram: one column per bin, counts above them. -->
      <g v-else-if="spec.kind === 'histogram'" data-testid="chart-columns">
        <g v-for="col in columns" :key="col.label">
          <title>{{ col.label }} — {{ col.valueLabel }}</title>
          <rect :x="col.x" :y="col.y" :width="col.width" :height="col.height" rx="2" :fill="GREEN" />
          <text v-if="col.value > 0" :x="col.centre" :y="col.y - 3" font-size="10" text-anchor="middle" :fill="STONE">
            {{ col.value.toLocaleString() }}
          </text>
        </g>
        <line :x1="0" :y1="PLOT_HEIGHT" :x2="WIDTH" :y2="PLOT_HEIGHT" :stroke="CREAM" stroke-width="1" />
      </g>

      <!-- Line: count over time, ends and peak labelled. -->
      <g v-else data-testid="chart-line">
        <line :x1="0" :y1="PLOT_HEIGHT" :x2="WIDTH" :y2="PLOT_HEIGHT" :stroke="CREAM" stroke-width="1" />
        <polyline :points="linePath" fill="none" :stroke="GREEN" stroke-width="2" stroke-linejoin="round" />
        <g v-for="p in linePoints" :key="p.label">
          <title>{{ p.valueLabel }}</title>
          <circle :cx="p.x" :cy="p.y" r="2.5" :fill="GREEN" />
        </g>
        <text
          v-for="p in lineLabelled"
          :key="`l-${p.label}`"
          :x="Math.min(Math.max(p.x, 10), WIDTH - 10)"
          :y="p.y - 6"
          font-size="10"
          text-anchor="middle"
          :fill="STONE"
        >
          {{ p.value.toLocaleString() }}
        </text>
      </g>

      <!-- Category ticks under the plot (bars carry their own labels). -->
      <g v-if="spec.kind !== 'bars'" data-testid="chart-ticks">
        <text
          v-for="tick in axisTicks"
          :key="tick.label"
          :x="tick.x"
          :y="PLOT_HEIGHT + 16"
          font-size="10"
          :text-anchor="tick.anchor"
          :fill="STONE"
        >
          {{ tick.label }}
        </text>
      </g>
    </svg>

    <p v-if="spec.note" class="chart-note" data-testid="chart-note">{{ spec.note }}</p>
    <p v-if="copyState === 'download'" class="chart-note" data-testid="chart-download">
      Copying isn’t available in this browser —
      <a :href="downloadUrl" :download="downloadName">download the image</a> instead.
    </p>
  </figure>
</template>

<style scoped>
.summary-chart {
  margin: 0 0 12px;
}

.chart-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 2px;
}

.chart-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--blo-stone);
}

.copy-btn {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 11px;
  color: var(--blo-green-deep);
  cursor: pointer;
  white-space: nowrap;
}

.copy-btn:hover,
.copy-btn:focus-visible {
  text-decoration: underline;
}

.axis-note {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--blo-stone);
}

.chart-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.chart-note {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--blo-stone);
}

/* Phone (P5-60). The drawing itself already scales — it is a viewBox with no
   fixed width and every label is clipped with the full text in a <title> —
   so all that is left is the type sizes and a copy button you can hit. */
@media (max-width: 640px) {
  .chart-head {
    align-items: center;
  }

  .chart-title {
    font-size: 13px;
  }

  .copy-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 8px;
    margin-right: -8px;
    font-size: 14px;
  }

  .axis-note,
  .chart-note {
    font-size: 14px;
  }
}
</style>
