import { describe, it, expect, beforeEach } from 'vitest'
import {
  FIRST_RUN_KEY,
  FIRST_RUN_TOTAL,
  firstRunSteps,
  matchFirstRunStep,
  recordFirstRunVisit,
  completeFirstRunStep,
  dismissFirstRun,
  loadFirstRun,
  firstRunComplete,
  firstRunVisible,
  firstRunState,
  type FirstRunStepId,
} from '../firstRun'

/** P6-5: one step per surface, in the order they read on screen. */
const ALL: FirstRunStepId[] = ['data', 'read', 'map', 'ask', 'add', 'search']

beforeEach(() => {
  localStorage.clear()
  loadFirstRun()
})

describe('firstRun — the six steps (P6-5)', () => {
  it('lists six steps, each linking at one of the new surfaces', () => {
    const steps = firstRunSteps()
    expect(steps.map(s => s.id)).toEqual(ALL)
    expect(steps).toHaveLength(FIRST_RUN_TOTAL)
    expect(steps.map(s => s.href)).toEqual(['/datasets', '/docs', '/analysis', '/chat', '/new', '/search'])
    expect(steps.every(s => s.label.length > 0 && s.hint.length > 0)).toBe(true)
  })

  it('names no page the cutover retired', () => {
    const everything = firstRunSteps()
      .flatMap(s => [s.label, s.hint, s.href])
      .join(' ')
    for (const gone of ['/library', '/wiki', '/layers', '/ask']) {
      expect(everything, gone).not.toContain(gone)
    }
  })

  it('says what makes each one tick, so nobody waits for a visit to count', () => {
    const hints = Object.fromEntries(firstRunSteps().map(s => [s.id, s.hint]))
    expect(hints.data).toContain('it ticks when you filter, sort or summarise a table')
    expect(hints.read).toContain('it ticks when a document opens in the app')
    expect(hints.map).toContain('it ticks when a report runs or a layer goes on')
    // The one honest compromise: Chat writes nothing to the URL, so opening
    // it is the most a route can prove, and the hint says exactly that.
    expect(hints.ask).toContain('it ticks when you open Chat')
    expect(hints.add).toContain('it ticks when the drop or the upload lands')
    expect(hints.search).toContain('it ticks when you search')
  })
})

describe('firstRun — reading progress off the routes people visit', () => {
  it('recognises the URLs that could not exist unless the thing was done', () => {
    expect(matchFirstRunStep('/search', { q: 'absentee owners' })).toBe('search')
    expect(matchFirstRunStep('/place', { address: '55 Trinity Ave SW' })).toBe('map')
    expect(matchFirstRunStep('/place', { geoid: '13121' })).toBe('map')
    expect(matchFirstRunStep('/place', { lat: '33.7', lng: '-84.4' })).toBe('map')
    expect(matchFirstRunStep('/chat')).toBe('ask')
  })

  it('ignores visits that only look like progress', () => {
    expect(matchFirstRunStep('/search')).toBeNull() // opened the page, searched nothing
    expect(matchFirstRunStep('/search', { q: '' })).toBeNull()
    expect(matchFirstRunStep('/place')).toBeNull() // the empty form
    expect(matchFirstRunStep('/datasets')).toBeNull() // browsing is not opening a table
    expect(matchFirstRunStep('/docs')).toBeNull()
    expect(matchFirstRunStep('/analysis')).toBeNull()
    expect(matchFirstRunStep('/new')).toBeNull() // opening the drop page is not dropping
    expect(matchFirstRunStep('/')).toBeNull()
    expect(matchFirstRunStep('/account')).toBeNull()
  })

  it('no longer ticks anything off the retired routes', () => {
    // They redirect, so these never reach the tracker in practice — but a
    // stale `/ask?q=` in somebody's history must not tick "ask" either.
    expect(matchFirstRunStep('/ask', { q: 'who owns this land' })).toBeNull()
    expect(matchFirstRunStep('/wiki/home')).toBeNull()
    expect(matchFirstRunStep('/library', { drop: 'link' })).toBeNull()
  })

  it('accepts the shapes the router really produces', () => {
    // Trailing slash, and array-valued queries (vue-router hands those over
    // when a param repeats).
    expect(matchFirstRunStep('/chat/')).toBe('ask')
    expect(matchFirstRunStep('/search', { q: ['a', 'b'] })).toBe('search')
  })
})

describe('firstRun — ticking off an action that actually happened', () => {
  it('ticks once and remembers it, however many times it is called', () => {
    completeFirstRunStep('add')
    completeFirstRunStep('add')
    expect(firstRunState.value.done).toEqual(['add'])
    expect(loadFirstRun().done).toEqual(['add'])
  })

  it('covers the three steps no route can see', () => {
    // Reported by NewView, LibraryEntryView, DatasetView and Map.vue.
    for (const id of ['add', 'read', 'data'] as FirstRunStepId[]) completeFirstRunStep(id)
    expect(firstRunState.value.done).toEqual(['add', 'read', 'data'])
  })

  it('keeps a dismissal, and stores nothing but the step names', () => {
    dismissFirstRun()
    completeFirstRunStep('read')
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBe('{"done":["read"],"dismissed":true}')
  })

  it('shrugs off a step id that is not one of the six', () => {
    completeFirstRunStep('nonsense' as FirstRunStepId)
    // The ids the cutover retired are just as unknown as nonsense.
    completeFirstRunStep('start' as FirstRunStepId)
    expect(firstRunState.value.done).toEqual([])
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBeNull()
  })
})

describe('firstRun — stored progress', () => {
  it('ticks a step off once and remembers it', () => {
    expect(recordFirstRunVisit('/search', { q: 'hello' })).toBe('search')
    expect(recordFirstRunVisit('/search', { q: 'again' })).toBeNull()
    expect(firstRunState.value.done).toEqual(['search'])

    // Survives a reload of the module state (a new tab, a refresh).
    expect(loadFirstRun().done).toEqual(['search'])
    expect(JSON.parse(localStorage.getItem(FIRST_RUN_KEY)!)).toEqual({ done: ['search'], dismissed: false })
  })

  it('records nothing for a visit that completes nothing', () => {
    expect(recordFirstRunVisit('/datasets')).toBeNull()
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBeNull()
  })

  it('is complete, and hidden, once all six are done', () => {
    expect(firstRunComplete.value).toBe(false)
    expect(firstRunVisible.value).toBe(true)

    recordFirstRunVisit('/search', { q: 'x' })
    recordFirstRunVisit('/chat')
    recordFirstRunVisit('/place', { address: 'Atlanta' })
    completeFirstRunStep('data')
    completeFirstRunStep('add')
    expect(firstRunComplete.value).toBe(false)
    completeFirstRunStep('read')

    expect(firstRunState.value.done).toHaveLength(FIRST_RUN_TOTAL)
    expect(firstRunComplete.value).toBe(true)
    expect(firstRunVisible.value).toBe(false)
  })

  it('stays hidden for good once dismissed, without losing progress', () => {
    recordFirstRunVisit('/chat')
    dismissFirstRun()
    expect(firstRunVisible.value).toBe(false)
    expect(loadFirstRun()).toEqual({ done: ['ask'], dismissed: true })
  })

  it('stores progress only — never anything the person read, asked or typed', () => {
    recordFirstRunVisit('/search', { q: 'a question that must not be stored' })
    completeFirstRunStep('data')
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBe('{"done":["search","data"],"dismissed":false}')
  })

  it('shrugs off a corrupt or hand-edited value', () => {
    localStorage.setItem(FIRST_RUN_KEY, '{not json')
    expect(loadFirstRun()).toEqual({ done: [], dismissed: false })
    localStorage.setItem(FIRST_RUN_KEY, JSON.stringify({ done: ['ask', 'nonsense'], dismissed: 'yes' }))
    expect(loadFirstRun()).toEqual({ done: ['ask'], dismissed: false })
  })
})
