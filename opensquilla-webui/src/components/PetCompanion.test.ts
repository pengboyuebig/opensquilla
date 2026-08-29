// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LEVEL_XP_BASE, WATER_WINDOW_MS, XP_PER_FEED } from '@/composables/usePet'

const PET_STORAGE_KEY = 'opensquilla-pet-v1'

// Shared mutable knobs read by the mocked store factory below.
const knobs: {
  now: () => number
  storage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } | null
} = {
  now: () => 1_000_000,
  storage: null,
}

vi.mock('@/composables/usePet', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/composables/usePet')>()
  return {
    ...mod,
    // Route every store the component creates through the shared knobs so
    // tests control the clock and persistence without touching globals.
    usePet: () => mod.createPetStore({ now: knobs.now, storage: knobs.storage }),
  }
})

// Toasts and confirms are spied so level-up and reset flows stay assertable
// without mounting the global hosts.
const toastKnobs = { pushToast: vi.fn() }
const confirmKnobs: {
  result: boolean
  calls: Array<Record<string, string>>
} = { result: true, calls: [] }

vi.mock('@/composables/useToasts', () => ({
  useToasts: () => ({ pushToast: toastKnobs.pushToast }),
}))

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({
    confirm: async (options: Record<string, string>) => {
      confirmKnobs.calls.push(options)
      return confirmKnobs.result
    },
  }),
}))

let mountedEl: HTMLElement | null = null

beforeEach(() => {
  vi.resetModules()
  const data = new Map<string, string>()
  knobs.now = () => 1_000_000
  knobs.storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
  toastKnobs.pushToast.mockReset()
  confirmKnobs.result = true
  confirmKnobs.calls.length = 0
})

afterEach(() => {
  mountedEl?.parentElement?.removeChild(mountedEl)
  mountedEl = null
  document.body.innerHTML = ''
})

async function mountCompanion(options: {
  storedState?: Record<string, unknown>
  now?: () => number
  props?: Record<string, unknown>
} = {}) {
  if (options.now) knobs.now = options.now
  const seeded = options.storedState
  if (seeded) {
    knobs.storage!.setItem(PET_STORAGE_KEY, JSON.stringify({
      version: 2,
      x: 100,
      y: 100,
      followEnabled: false,
      xp: 0,
      lastFedAt: 1_000_000,
      lastWateredAt: 1_000_000,
      lastRestedAt: 1_000_000,
      ...seeded,
    }))
  }
  const { createApp, h, nextTick } = await import('vue')
  const i18n = (await import('@/i18n')).default
  i18n.global.locale.value = 'en'
  const PetCompanion = (await import('./PetCompanion.vue')).default

  // happy-dom lays out nothing, so offsetWidth/Height stay 0 and the
  // component clamps against its 48px fallback — positions remain assertable.
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({ render: () => h(PetCompanion, options.props ?? {}) })
  app.use(i18n)
  app.mount(el)
  mountedEl = el
  await nextTick()
  return { el, nextTick }
}

function testId(el: Element, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

function pointerEvent(type: string, init: PointerEventInit & { clientX?: number; clientY?: number }) {
  return new PointerEvent(type, {
    bubbles: true,
    button: 0,
    pointerType: 'mouse',
    isPrimary: true,
    ...init,
  })
}

describe('PetCompanion', () => {
  it('renders the anchor with an accessible label and starts idle', async () => {
    const { el } = await mountCompanion()

    const anchor = testId(el, 'pet-anchor')
    expect(anchor).toBeTruthy()
    expect(anchor?.getAttribute('aria-label')).toBe('Pet companion: open status panel')
    expect(anchor?.getAttribute('aria-expanded')).toBe('false')
    expect(testId(el, 'pet-panel')).toBeNull()
    expect(el.querySelector('.pet-companion.is-dead')).toBeNull()
  })

  it('opens the status panel on click and shows level/xp/meters', async () => {
    const { el, nextTick } = await mountCompanion({
      storedState: { xp: 140 }, // level 2, 40/200 xp into it
    })

    testId(el, 'pet-anchor')!.click()
    await nextTick()

    expect(testId(el, 'pet-panel')).toBeTruthy()
    expect(testId(el, 'pet-level')!.textContent).toContain('2')
    expect(testId(el, 'pet-xp-text')!.textContent).toContain('40')
    expect(testId(el, 'pet-xp-text')!.textContent).toContain('200')
    // All three care meters render, freshly full.
    expect(testId(el, 'pet-meter-food')!.textContent).not.toBe('')
    expect(testId(el, 'pet-meter-water')!.textContent).not.toBe('')
    expect(testId(el, 'pet-meter-rest')!.textContent).not.toBe('')
    expect(el.querySelector('[role="progressbar"]')).toBeTruthy()
    // All care actions are reachable even with full meters.
    expect(testId(el, 'pet-drink')).toBeTruthy()
    expect(testId(el, 'pet-rest')).toBeTruthy()
  })

  it('water and rest actions are always available and grant xp on first use', async () => {
    const { el, nextTick } = await mountCompanion()
    const anchor = testId(el, 'pet-anchor')!

    anchor.click()
    await nextTick()

    const drink = testId(el, 'pet-drink') as HTMLButtonElement
    const rest = testId(el, 'pet-rest') as HTMLButtonElement
    expect(drink.disabled).toBe(false)
    expect(rest.disabled).toBe(false)

    drink.click()
    await nextTick()
    // The care landed and persisted, but the xp cooldown now disables the button.
    expect(JSON.parse(knobs.storage!.getItem(PET_STORAGE_KEY)!).lastWateredAt).toBe(1_000_000)
    expect(drink.disabled).toBe(true)
    expect(rest.disabled).toBe(false)
  })

  it('care buttons disable while their own xp cooldown runs', async () => {
    const { el, nextTick } = await mountCompanion({
      storedState: { lastFeedXpAt: 1_000_000, lastWaterXpAt: 1_000_000, lastRestXpAt: 1_000_000 },
    })

    testId(el, 'pet-anchor')!.click()
    await nextTick()

    expect((testId(el, 'pet-feed') as HTMLButtonElement).disabled).toBe(true)
    expect((testId(el, 'pet-drink') as HTMLButtonElement).disabled).toBe(true)
    expect((testId(el, 'pet-rest') as HTMLButtonElement).disabled).toBe(true)
    expect((testId(el, 'pet-drink') as HTMLButtonElement).getAttribute('title')).toContain('Recently cared')
  })

  it('feed works while off cooldown and disables during it', async () => {
    const { el, nextTick } = await mountCompanion()

    testId(el, 'pet-anchor')!.click()
    await nextTick()

    const feed = testId(el, 'pet-feed') as HTMLButtonElement | null
    expect(feed?.disabled).toBe(false)
    feed?.click()
    await nextTick()
    expect(el.querySelector('.pet-xp-burst')).toBeTruthy()
  })

  it('feed button is disabled right after a granted feeding', async () => {
    // A grant just happened at t=1_000_000; still inside the 30 min cooldown.
    const { el, nextTick } = await mountCompanion({
      storedState: { xp: 25, lastFeedXpAt: 1_000_000 },
    })

    testId(el, 'pet-anchor')!.click()
    await nextTick()

    const feed = testId(el, 'pet-feed') as HTMLButtonElement | null
    expect(feed?.disabled).toBe(true)
    expect(feed?.getAttribute('title')).toContain('Recently cared')
    // A rejected click must not conjure an xp burst.
    feed?.click()
    await nextTick()
    expect(el.querySelector('.pet-xp-burst')).toBeNull()
  })

  it('re-enables the feed button once the cooldown has passed', async () => {
    const afterCooldown = 1_000_000 + 30 * 60 * 1000 + 5
    const { el, nextTick } = await mountCompanion({
      now: () => afterCooldown,
      storedState: { xp: 25 },
    })

    testId(el, 'pet-anchor')!.click()
    await nextTick()
    expect((testId(el, 'pet-feed') as HTMLButtonElement | null)?.disabled).toBe(false)
  })

  it('follow toggle flips aria-pressed and label', async () => {
    const { el, nextTick } = await mountCompanion()

    testId(el, 'pet-anchor')!.click()
    await nextTick()
    const toggle = testId(el, 'pet-follow-toggle')!
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.textContent).toContain('Follow cursor')

    toggle.click()
    await nextTick()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.textContent).toContain('Stop following')
  })

  it('shows a dead state with revive instead of feed and revives on click', async () => {
    const deadNow = 1_000_000 + 26 * 60 * 60 * 1000
    const { el, nextTick } = await mountCompanion({
      now: () => deadNow,
      storedState: { lastFedAt: 1_000_000 },
    })

    expect(el.querySelector('.pet-companion.is-dead')).toBeTruthy()
    testId(el, 'pet-anchor')!.click()
    await nextTick()
    expect(testId(el, 'pet-feed')).toBeNull()
    expect(testId(el, 'pet-revive')).toBeTruthy()

    testId(el, 'pet-revive')!.click()
    await nextTick()
    expect(el.querySelector('.pet-companion.is-dead')).toBeNull()
    expect(testId(el, 'pet-feed')).toBeTruthy()
  })

  it('positions itself from persisted coordinates within the clamp bounds', async () => {
    // happy-dom reports a 0×0 documentElement, so the component clamps to its
    // 320×320 fallback viewport minus the 48px anchor → 272 max per axis.
    const { el } = await mountCompanion({ storedState: { x: 222, y: 160 } })
    const rootEl = el.querySelector<HTMLElement>('.pet-companion')!
    expect(rootEl.style.left).toBe('222px')
    expect(rootEl.style.top).toBe('160px')
  })

  it('closes the panel on Escape', async () => {
    const { el, nextTick } = await mountCompanion()

    testId(el, 'pet-anchor')!.click()
    await nextTick()
    expect(testId(el, 'pet-panel')).toBeTruthy()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(testId(el, 'pet-panel')).toBeNull()
  })

  // happy-dom never synthesizes a follow-up click after pointer events, so
  // each gesture here dispatches one explicitly the way a real browser would.
  it('drag gesture repositions and does not open the panel', async () => {
    const { el, nextTick } = await mountCompanion({ storedState: { x: 100, y: 100 } })

    const anchor = testId(el, 'pet-anchor')!
    anchor.dispatchEvent(pointerEvent('pointerdown', { clientX: 120, clientY: 120 }))
    anchor.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 180 }))
    anchor.dispatchEvent(pointerEvent('pointerup', { clientX: 160, clientY: 180 }))
    anchor.dispatchEvent(new PointerEvent('click', { bubbles: true }))
    await nextTick()

    const rootEl = el.querySelector<HTMLElement>('.pet-companion')!
    // Moved by the drag delta from the persisted (100,100); deadzone-aware.
    expect(rootEl.style.left).toBe(String(100 + (160 - 120)) + 'px')
    expect(rootEl.style.top).toBe(String(100 + (180 - 120)) + 'px')
    expect(testId(el, 'pet-panel')).toBeNull()
  })

  it('a sub-deadzone drag counts as a click and opens the panel', async () => {
    const { el, nextTick } = await mountCompanion({ storedState: { x: 100, y: 100 } })

    const anchor = testId(el, 'pet-anchor')!
    anchor.dispatchEvent(pointerEvent('pointerdown', { clientX: 120, clientY: 120 }))
    anchor.dispatchEvent(pointerEvent('pointermove', { clientX: 122, clientY: 121 }))
    anchor.dispatchEvent(pointerEvent('pointerup', { clientX: 122, clientY: 121 }))
    anchor.dispatchEvent(new PointerEvent('click', { bubbles: true }))
    await nextTick()

    expect(testId(el, 'pet-panel')).toBeTruthy()
  })

  it('disabled follow mode leaves position untouched on document moves', async () => {
    const { el } = await mountCompanion({ storedState: { x: 50, y: 60 } })

    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      isPrimary: true,
      clientX: 300,
      clientY: 300,
    }))

    const rootEl = el.querySelector<HTMLElement>('.pet-companion')!
    expect(rootEl.style.left).toBe('50px')
    expect(rootEl.style.top).toBe('60px')
  })

  it('shows a speech bubble on hover and hides it on leave', async () => {
    const { el, nextTick } = await mountCompanion()
    const anchor = testId(el, 'pet-anchor')!

    anchor.dispatchEvent(new Event('mouseenter'))
    await nextTick()
    const bubble = testId(el, 'pet-speech')
    expect(bubble?.textContent!.length).toBeGreaterThan(0)
    // A fully cared-for pet is happy.
    expect(bubble?.textContent).toContain('happy')

    anchor.dispatchEvent(new Event('mouseleave'))
    await nextTick()
    expect(testId(el, 'pet-speech')).toBeNull()
  })

  it('the bubble picks the most urgent need first', async () => {
    // Water ran dry long ago (clock past its window); it outranks the happy line.
    const { el, nextTick } = await mountCompanion({
      now: () => 1_000_000 + WATER_WINDOW_MS + 60_000,
      storedState: { lastWateredAt: 1_000_000 },
    })

    testId(el, 'pet-anchor')!.dispatchEvent(new Event('mouseenter'))
    await nextTick()
    expect(testId(el, 'pet-speech')!.textContent).toContain('thirsty')
  })

  it('marks a low meter as bad mood', async () => {
    const { el } = await mountCompanion({
      now: () => 1_000_000 + WATER_WINDOW_MS + 60_000,
      storedState: { lastWateredAt: 1_000_000 },
    })
    expect(el.querySelector<HTMLElement>('.pet-companion')!.dataset.mood).toBe('bad')
  })

  it('spawns hearts on double click without opening the panel twice', async () => {
    const { el, nextTick } = await mountCompanion()
    const anchor = testId(el, 'pet-anchor')!

    anchor.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await nextTick()
    expect(el.querySelector('.pet-hearts')).toBeTruthy()

    // Panel state is unchanged by the double-click burst.
    expect(testId(el, 'pet-panel')).toBeNull()
  })

  it('toasts exactly once when feeding crosses a level boundary', async () => {
    const { el, nextTick } = await mountCompanion({
      storedState: { xp: LEVEL_XP_BASE - XP_PER_FEED }, // one feed → level 2
    })

    testId(el, 'pet-anchor')!.click()
    await nextTick()
    testId(el, 'pet-feed')!.click()
    await nextTick()

    expect(toastKnobs.pushToast).toHaveBeenCalledTimes(1)
    expect(String(toastKnobs.pushToast.mock.calls[0][0])).toContain('2')
  })

  it('no toast and no badge when idle', async () => {
    const { el } = await mountCompanion()
    expect(toastKnobs.pushToast).not.toHaveBeenCalled()
    expect(el.querySelector('.pet-badge')).toBeNull()
  })

  it('renders busy and approval badges from props', async () => {
    const { el } = await mountCompanion({ props: { busy: true, approvalCount: 3 } })
    expect(el.querySelector('.pet-badge--busy')).toBeTruthy()
    expect(el.querySelector('.pet-badge--approval')).toBeTruthy()
  })

  it('renames the pet inline and persists the custom name', async () => {
    const { el, nextTick } = await mountCompanion()

    testId(el, 'pet-anchor')!.click()
    await nextTick()
    testId(el, 'pet-name')!.click()
    await nextTick()

    const input = testId(el, 'pet-name-input') as HTMLInputElement | null
    expect(input).toBeTruthy()
    input!.value = 'Mochi'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await nextTick()

    expect(testId(el, 'pet-name')!.textContent).toContain('Mochi')
    expect(JSON.parse(knobs.storage!.getItem(PET_STORAGE_KEY)!).name).toBe('Mochi')
  })

  it('rename starts empty for a default-named pet and Escape cancels in place', async () => {
    const { el, nextTick } = await mountCompanion()
    const anchor = testId(el, 'pet-anchor')!

    anchor.click()
    await nextTick()
    testId(el, 'pet-name')!.click()
    await nextTick()

    // Prefill carries only a custom name — never the localized default.
    expect((testId(el, 'pet-name-input') as HTMLInputElement).value).toBe('')

    testId(el, 'pet-name-input')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape' }),
    )
    await nextTick()
    // Editing ended, but the panel itself stays open and nothing persisted.
    expect(testId(el, 'pet-name-input')).toBeNull()
    expect(testId(el, 'pet-panel')).toBeTruthy()
    expect(knobs.storage!.getItem(PET_STORAGE_KEY)).toBeNull()
  })

  it('rename prefills an existing custom name', async () => {
    const { el, nextTick } = await mountCompanion({ storedState: { name: 'Mochi' } })

    testId(el, 'pet-anchor')!.click()
    await nextTick()
    testId(el, 'pet-name')!.click()
    await nextTick()

    expect((testId(el, 'pet-name-input') as HTMLInputElement).value).toBe('Mochi')
  })

  it('hides the speech bubble while dragging and restores it on release', async () => {
    const { el, nextTick } = await mountCompanion({ storedState: { x: 100, y: 100 } })
    const anchor = testId(el, 'pet-anchor')!

    anchor.dispatchEvent(new Event('mouseenter'))
    await nextTick()
    expect(testId(el, 'pet-speech')).toBeTruthy()

    anchor.dispatchEvent(pointerEvent('pointerdown', { clientX: 120, clientY: 120 }))
    await nextTick()
    expect(testId(el, 'pet-speech')).toBeNull()

    // Same-coordinates release: no move committed; hover resumes afterwards.
    anchor.dispatchEvent(pointerEvent('pointerup', { clientX: 120, clientY: 120 }))
    await nextTick()
    expect(testId(el, 'pet-speech')).toBeTruthy()
  })

  it('resets only after confirmation resolves truthy', async () => {
    const { el, nextTick } = await mountCompanion({ storedState: { xp: 140 } })
    const anchor = testId(el, 'pet-anchor')!

    anchor.click()
    await nextTick()

    confirmKnobs.result = false
    testId(el, 'pet-reset')!.click()
    await Promise.resolve()
    await Promise.resolve()
    await nextTick()
    expect(confirmKnobs.calls[0]?.title.length).toBeGreaterThan(0)
    expect(JSON.parse(knobs.storage!.getItem(PET_STORAGE_KEY)!).xp).toBe(140)

    // The reset flow closes the panel first — reopen for the accept branch.
    anchor.click()
    await nextTick()
    confirmKnobs.result = true
    testId(el, 'pet-reset')!.click()
    await Promise.resolve()
    await Promise.resolve()
    await nextTick()
    expect(JSON.parse(knobs.storage!.getItem(PET_STORAGE_KEY)!).xp).toBe(0)
    // The flow closes the panel; reopen to see the fresh state rendered.
    anchor.click()
    await nextTick()
    expect(testId(el, 'pet-level')!.textContent).toContain('1')
  })
})
