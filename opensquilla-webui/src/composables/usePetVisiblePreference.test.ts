// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Module-level singleton preference: each case re-imports a fresh module.
async function freshPreference() {
  vi.resetModules()
  return import('./usePetVisiblePreference')
}

const KEY = 'opensquilla.petVisible'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('usePetVisiblePreference', () => {
  it('defaults to visible when nothing is stored', async () => {
    const { usePetVisiblePreference } = await freshPreference()
    const pref = usePetVisiblePreference()
    expect(pref.enabled.value).toBe(true)
  })

  it('persists a toggle and hydrates it on next load', async () => {
    let { usePetVisiblePreference } = await freshPreference()
    let pref = usePetVisiblePreference()
    expect(pref.enabled.value).toBe(true)

    pref.setEnabled(false)
    expect(pref.enabled.value).toBe(false)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ enabled: false })

    // Fresh module hydrates the stored choice.
    ;({ usePetVisiblePreference } = await freshPreference())
    pref = usePetVisiblePreference()
    expect(pref.enabled.value).toBe(false)
  })

  it('falls back to visible on corrupt or shape-mismatched data', async () => {
    localStorage.setItem(KEY, '{not json')
    let { usePetVisiblePreference } = await freshPreference()
    expect(usePetVisiblePreference().enabled.value).toBe(true)

    localStorage.setItem(KEY, JSON.stringify({ enabled: 'yes' }))
    ;({ usePetVisiblePreference } = await freshPreference())
    expect(usePetVisiblePreference().enabled.value).toBe(true)
  })

  it('survives storage write failures', async () => {
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    try {
      const { usePetVisiblePreference } = await freshPreference()
      const pref = usePetVisiblePreference()
      expect(() => pref.setEnabled(false)).not.toThrow()
      expect(pref.enabled.value).toBe(false)
    } finally {
      Storage.prototype.setItem = setItem
    }
  })
})
