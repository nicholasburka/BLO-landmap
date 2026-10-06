import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CountyContextPicker from '../CountyContextPicker.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'
import { MAX_CONTEXT_LAYERS, contextLayers } from '@/lib/countyJoin'

function mountPicker(selected: string[] = []) {
  return mount(CountyContextPicker, { props: { selected } })
}

describe('CountyContextPicker (P5-48)', () => {
  it('lists every joinable layer, grouped the way /layers groups them', () => {
    const w = mountPicker()
    expect(w.findAll('[data-testid="context-layer"]')).toHaveLength(contextLayers().length)
    const groups = w.findAll('[data-testid="context-group"]').map(g => g.text())
    expect(groups).toContain('Housing')
    expect(groups).toContain('Overall index')
    // internal library layers have their own entry page; they are not here
    expect(w.text()).not.toContain('Internal library layers')
    w.unmount()
  })

  it('says where each layer comes from, so a column can be cited', () => {
    const w = mountPicker()
    const row = w.findAll('[data-testid="context-layer"]').find(r => r.text().includes('Median Home Value'))!
    expect(row.text()).toContain('Urban Institute')
    expect(row.text()).toContain('2022')
    w.unmount()
  })

  it('searches by name or by what the layer measures', async () => {
    const w = mountPicker()
    await w.get('[data-testid="context-search"]').setValue('home value')
    expect(w.findAll('[data-testid="context-layer"]').map(r => r.find('.context-name').text())).toEqual([
      'Median Home Value',
    ])
    await w.get('[data-testid="context-search"]').setValue('zzz')
    expect(w.get('[data-testid="context-empty"]').text()).toContain('No layer matches')
    w.unmount()
  })

  it('adds and removes a layer through the checkbox', async () => {
    const w = mountPicker()
    await w.get('[data-testid="context-search"]').setValue('home value')
    await w.get('[data-testid="context-layer"] input').setValue(true)
    expect(w.emitted('update:selected')![0]).toEqual([['median_home_value']])

    const on = mountPicker(['median_home_value'])
    await on.get('[data-testid="context-search"]').setValue('home value')
    expect((on.get('[data-testid="context-layer"] input').element as HTMLInputElement).checked).toBe(true)
    await on.get('[data-testid="context-layer"] input').setValue(false)
    expect(on.emitted('update:selected')![0]).toEqual([[]])
    w.unmount()
    on.unmount()
  })

  it('stops at the limit rather than pulling every dataset at once', async () => {
    const selected = contextLayers().slice(0, MAX_CONTEXT_LAYERS).map(l => l.id)
    const w = mountPicker(selected)
    expect(w.get('[data-testid="context-limit"]').text()).toContain(String(MAX_CONTEXT_LAYERS))
    const unselected = w
      .findAll('[data-testid="context-layer"]')
      .find(r => !(r.get('input').element as HTMLInputElement).checked)!
    expect(unselected.get('input').attributes('disabled')).toBeDefined()
    // an already-chosen layer can still be removed
    const chosen = w.findAll('[data-testid="context-layer"]').find(r => (r.get('input').element as HTMLInputElement).checked)!
    expect(chosen.get('input').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('counts what is added and can remove them all', async () => {
    const w = mountPicker(['median_home_value', 'life_expectancy'])
    expect(w.get('[data-testid="context-count"]').text()).toBe(`2 of ${contextLayers().length} added`)
    await w.get('[data-testid="context-clear"]').trigger('click')
    expect(w.emitted('update:selected')![0]).toEqual([[]])
    w.unmount()
  })

  it('closes on request', async () => {
    const w = mountPicker()
    await w.get('.close-btn').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })
})

/**
 * P5-60: as a popover inside a 375 px toolbar this checklist was unreadable
 * and its rows were 20 px tall. On a phone it is a bottom sheet with a handle,
 * 44 px rows and 20 px checkboxes whose hit area is the whole row.
 */
const PICKER_SFC = readStyles('src/components/CountyContextPicker.vue')
const PICKER_PHONE = mediaBlock(PICKER_SFC, 640)

describe('CountyContextPicker — phone layout (P5-60)', () => {
  it('is a bottom sheet with a handle and a 44 px close', () => {
    const w = mount(CountyContextPicker, { props: { selected: [] } })
    const picker = w.get('[data-testid="county-context-picker"]')
    expect(picker.classes()).toContain('sheet')
    expect(picker.find('.sheet-handle').exists()).toBe(true)
    expect(w.get('.close-btn').classes()).toContain('touch-target')

    const sheet = ruleFor(PICKER_PHONE, '.sheet')
    expect(sheet).toContain('bottom: 0')
    expect(sheet).toContain('max-height: 85svh')
    expect(sheet).toContain('env(safe-area-inset-bottom')
    expect(ruleFor(PICKER_PHONE, '.sheet-handle')).toContain('display: block')
    expect(ruleFor(PICKER_SFC, '.sheet-handle')).toContain('display: none')
  })

  it('gives each layer a 44 px row and a 20 px checkbox', () => {
    expect(ruleFor(PICKER_PHONE, '.context-row')).toContain('min-height: 44px')
    expect(ruleFor(PICKER_PHONE, ".context-row input[type='checkbox']")).toContain('width: 20px')
    expect(ruleFor(PICKER_PHONE, '.close-btn')).toContain('min-width: 44px')
    expect(ruleFor(PICKER_PHONE, '.picker-search')).toContain('min-height: 44px')
    expect(ruleFor(PICKER_PHONE, '.picker-hint')).toContain('font-size: 14px')
  })
})
