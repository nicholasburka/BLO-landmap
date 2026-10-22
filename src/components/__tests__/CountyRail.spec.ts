import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import CountyRail from '../CountyRail.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'
import { stubViewportWidth, restoreViewport } from '@/testing/viewport'

/**
 * The national leaderboard's front door (P15-2).
 *
 * The rank explorer lists all 3,144 counties by BLO Livability Index and has
 * always worked with no query at all — `Map.vue`'s `rankExplorerCounties`
 * keeps a BLO fallback for exactly that. What it lacked was a way in: you had
 * to inspect a county first and then notice that the grey "rank 412th of
 * 3,144" line under its score is a button. These tests pin both doors open —
 * the new one, and the old one unchanged, since "unchanged" is the half of
 * this ticket that nothing else would catch.
 */

/** Three rows, enough to tell "highlighted" from "not". */
const RANK_ROWS = [
  { geoId: '13121', rank: 1, name: 'Fulton County', stateAbbr: 'GA', scoreFmt: '4.21' },
  { geoId: '37119', rank: 2, name: 'Mecklenburg County', stateAbbr: 'NC', scoreFmt: '4.08' },
  { geoId: '48201', rank: 3, name: 'Harris County', stateAbbr: 'TX', scoreFmt: '3.94' },
]

/** The rail with no county behind it — what a bare `/` has to offer. */
const EMPTY_COUNTY = {
  visible: true,
  mode: 'inspect' as const,
  countyName: '',
  stateName: '',
  score: null,
  stats: [],
  currentGeoId: null,
  rankCounties: RANK_ROWS,
}

/**
 * Open the leaderboard the way `Map.vue` does.
 *
 * The rail is mounted once for the life of the app and gated internally on
 * `visible`, so the `view` ref's initialiser runs long before anyone presses
 * anything: the watch on `initialView` is the only path that ever reaches the
 * rank view in production. Mounting straight into `initialView: 'rank'` would
 * test a code path the app never takes.
 */
async function openLeaderboard(extra: Record<string, unknown> = {}) {
  const rail = mount(CountyRail, {
    props: { ...EMPTY_COUNTY, visible: false, initialView: null, ...extra },
  })
  await rail.setProps({ visible: true, initialView: 'rank' })
  return rail
}

describe('CountyRail — the rank explorer opens on its own (P15-2)', () => {
  /**
   * jsdom lays nothing out and so ships no `scrollIntoView`, which the rank
   * view calls to centre the current county's row — an unhandled rejection
   * out of a `nextTick`, not a failure, which is the worse kind. A gap in the
   * environment rather than in the code; `DocumentViewer.spec.ts:177` fills
   * the same one the same way.
   */
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {}
  })

  it('opens on the leaderboard with no county inspected and no row highlighted', async () => {
    const rail = await openLeaderboard()

    const list = rail.get('[data-testid="county-rail-rank-list"]')
    expect(rail.findAll('[data-testid="county-rail-rank-row"]')).toHaveLength(3)
    expect(list.text()).toContain('Fulton County')
    expect(rail.get('.rail-rank-sub').text()).toContain('3 counties')

    // No county behind the list: nothing is "current", so nothing highlights
    // and the list is left sitting at the top.
    expect(rail.findAll('.rail-rank-row--current')).toHaveLength(0)
    expect(rail.find('[aria-current]').exists()).toBe(false)

    // And no Back arrow, because there is no detail view to go back to —
    // pressing it would strand the visitor on a blank county card.
    expect(rail.find('[data-testid="county-rail-back"]').exists()).toBe(false)
    expect(rail.get('.rail-eyebrow').text()).toBe('Rankings')
  })

  it('calls itself rankings, not an inspection, while it is the leaderboard', async () => {
    const rail = await openLeaderboard()
    expect(rail.get('[data-testid="county-rail"]').attributes('aria-label')).toBe('County rankings')
    expect(rail.get('.rail-exit').attributes('aria-label')).toBe('Close rankings')
    expect(rail.get('.rail-collapse').attributes('aria-label')).toBe('Collapse rankings')
  })

  it('still reaches the leaderboard when it is the mounted-in view', () => {
    // The belt to openLeaderboard()'s braces: a rail constructed with
    // `initialView: 'rank'` already set lands there too, so the ref
    // initialiser and the watch cannot disagree.
    const rail = mount(CountyRail, { props: { ...EMPTY_COUNTY, initialView: 'rank' } })
    expect(rail.find('[data-testid="county-rail-rank-list"]').exists()).toBe(true)
  })

  it('inspects the county whose row is clicked, and shows it', async () => {
    const rail = await openLeaderboard()
    await rail.findAll('.rail-rank-row-btn')[1].trigger('click')

    expect(rail.emitted('select-county')).toEqual([['37119']])
    // The rail returns to detail on its own so the pick is visible at once;
    // the parent supplies the county it was handed.
    expect(rail.find('[data-testid="county-rail-rank-list"]').exists()).toBe(false)
    await rail.setProps({ currentGeoId: '37119', countyName: 'Mecklenburg County', stateName: 'North Carolina' })
    expect(rail.get('.rail-county-name').text()).toBe('Mecklenburg County')
  })

  it('leaves the inspect → rank line path alone, highlight and Back included', async () => {
    const rail = mount(CountyRail, {
      props: {
        visible: true,
        mode: 'inspect' as const,
        countyName: 'Harris County',
        stateName: 'Texas',
        score: 3.94,
        stats: [],
        currentGeoId: '48201',
        scoreRank: { rank: 3, total: 3144 },
        rankCounties: RANK_ROWS,
        initialView: 'detail' as const,
      },
    })

    const rankLine = rail.get('[data-testid="county-rail-score-rank"]')
    expect(rankLine.text()).toContain('rank 3rd of 3,144')
    await rankLine.trigger('click')

    const current = rail.findAll('.rail-rank-row--current')
    expect(current).toHaveLength(1)
    expect(current[0].text()).toContain('Harris County')
    expect(current[0].get('button').attributes('aria-current')).toBe('true')

    // Back still returns to the county it came from.
    await rail.get('[data-testid="county-rail-back"]').trigger('click')
    expect(rail.get('.rail-county-name').text()).toBe('Harris County')
  })

  /**
   * P15-3: the leaderboard has to take the keyboard with it.
   *
   * The welcome overlay's other two doors land focus in the prompt box and on
   * the first layer checkbox. This one opened the rail and left focus on the
   * `<body>` the dismissed overlay dropped it to, so the visitor who asked
   * for the rankings had to Tab the length of the document to reach the thing
   * they had just opened.
   */
  describe('taking the keyboard with it (P15-3)', () => {
    it('lands focus on the rail itself, not on the first control inside it', async () => {
      const rail = mount(CountyRail, {
        attachTo: document.body,
        props: { ...EMPTY_COUNTY, visible: false, initialView: null },
      })

      // The host's own sequence: open the rail and ask for focus in the same
      // tick, without waiting for a render. The rail is `v-if`'d on `visible`,
      // so there is no element to focus yet — the seam owns that wait.
      void rail.setProps({ visible: true, initialView: 'rank' })
      await rail.vm.focus()

      const aside = rail.get('[data-testid="county-rail"]').element
      expect(document.activeElement).toBe(aside)
      // Focusable on purpose and not a tab stop: it is a destination for a
      // host handing focus over, not a new stop in everyone else's Tab order.
      expect(aside.getAttribute('tabindex')).toBe('-1')

      // Emphatically not the first control. That is the collapse chevron,
      // which announces "Collapse rankings" and names nothing about what just
      // opened; the first meaningful one is a rank row, which starts a reader
      // inside a list whose heading they have not heard yet.
      expect(document.activeElement).not.toBe(rail.get('.rail-collapse').element)
      rail.unmount()
    })

    it('does nothing when there is no rail on screen to focus', async () => {
      const rail = mount(CountyRail, {
        attachTo: document.body,
        props: { ...EMPTY_COUNTY, visible: false, initialView: null },
      })
      await rail.vm.focus()
      expect(document.activeElement).toBe(document.body)
      rail.unmount()
    })
  })

  describe('on a phone', () => {
    afterEach(restoreViewport)

    it('renders one rankings surface, not two', async () => {
      stubViewportWidth(390)
      // The worst case: a query is live, so Phase 4h's mobile `rankings`
      // view has rows of its own and would be the rail's default. The
      // leaderboard was asked for explicitly, so it wins — and because the
      // rail has a single `view`, the loser renders nothing rather than
      // stacking a second list under the first.
      const rail = await openLeaderboard({
        rankingsCounties: RANK_ROWS,
        queryDescriptor: 'Black Homeownership',
      })

      expect(rail.findAll('.rail-rank-list')).toHaveLength(1)
      expect(rail.find('[data-testid="county-rail-rank-list"]').exists()).toBe(true)
      expect(rail.find('[data-testid="county-rail-rankings-list"]').exists()).toBe(false)
      expect(rail.find('.rail-rankings-head').exists()).toBe(false)

      // The other candidate for a second surface is RankingPanel, which is
      // off at this width (Phase 4h). jsdom computes no layout, so the rule
      // itself is the assertion — see sfcStyles.
      const mobile = mediaBlock(readStyles('src/components/RankingPanel.vue'), 768)
      expect(ruleFor(mobile, '.ranking-panel')).toContain('display: none')
    })
  })
})
