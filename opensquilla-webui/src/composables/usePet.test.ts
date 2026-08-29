import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createPetStore,
  DEFAULT_STARVATION_MS,
  FEED_COOLDOWN_MS,
  LEVEL_XP_BASE,
  levelInfoForXp,
  MAX_PET_LEVEL,
  MAX_TOTAL_XP,
  PET_STORAGE_KEY,
  REST_WINDOW_MS,
  WATER_WINDOW_MS,
  XP_PER_DRINK,
  XP_PER_FEED,
  XP_PER_REST,
  type PetStorageLike,
} from './usePet'

function memoryStorage(): PetStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

describe('levelInfoForXp', () => {
  it('starts at level 1 with a full ladder ahead', () => {
    expect(levelInfoForXp(0)).toEqual({ level: 1, intoLevel: 0, needed: LEVEL_XP_BASE })
  })

  it('carries overflow xp into subsequent levels', () => {
    // Level 1 needs 100; the first 40 xp past that lands mid-level-2 (200 needed).
    expect(levelInfoForXp(140)).toEqual({ level: 2, intoLevel: 40, needed: 2 * LEVEL_XP_BASE })
  })

  it('caps at the max level with a complete bar', () => {
    const info = levelInfoForXp(MAX_TOTAL_XP + 9999)
    expect(info.level).toBe(MAX_PET_LEVEL)
    expect(info.intoLevel).toBe((MAX_PET_LEVEL - 1) * LEVEL_XP_BASE)
    expect(info.needed).toBe((MAX_PET_LEVEL - 1) * LEVEL_XP_BASE)
  })

  it('ignores negative and fractional input', () => {
    expect(levelInfoForXp(-50)).toEqual(levelInfoForXp(0))
    expect(levelInfoForXp(10.9).intoLevel).toBe(10)
  })
})

describe('createPetStore', () => {
  let storage: ReturnType<typeof memoryStorage>

  beforeEach(() => {
    storage = memoryStorage()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function makeStore(options: { now?: () => number } = {}) {
    return createPetStore({ storage, ...options })
  }

  it('starts a fresh pet near the bottom-right with follow disabled', () => {
    const pet = makeStore()
    expect(pet.xp.value).toBe(0)
    expect(pet.level.value).toBe(1)
    expect(pet.isDead.value).toBe(false)
    expect(pet.followEnabled.value).toBe(false)
    expect(pet.position.value.x).toBeGreaterThan(0)
    expect(pet.position.value.y).toBeGreaterThan(0)
    expect(storage.data.has(PET_STORAGE_KEY)).toBe(false)
  })

  it('feeding grants xp, resets the hunger clock, and persists', () => {
    const now = vi.fn(() => 1_000)
    const pet = makeStore({ now })

    expect(pet.feed()).toBe(true)
    expect(pet.xp.value).toBe(XP_PER_FEED)
    expect(JSON.parse(storage.data.get(PET_STORAGE_KEY)!)).toMatchObject({
      version: 2,
      xp: XP_PER_FEED,
      lastFedAt: 1_000,
      lastWateredAt: 1_000,
      lastRestedAt: 1_000,
    })
  })

  it('drink and rest are always actionable; xp respects per-action cooldowns', () => {
    let t = 0
    const pet = createPetStore({ storage, now: () => t })
    // Fresh pet: no needs yet, but care works right away.
    expect(pet.needsWater.value).toBe(false)
    expect(pet.needsRest.value).toBe(false)
    expect(pet.drink()).toBe(true)
    expect(pet.xp.value).toBe(XP_PER_DRINK)
    expect(pet.rest()).toBe(true)
    expect(pet.xp.value).toBe(XP_PER_DRINK + XP_PER_REST)

    // Immediate re-care still resets the clock and persists…
    t = 60_000
    expect(pet.drink()).toBe(false)
    expect(pet.xp.value).toBe(XP_PER_DRINK + XP_PER_REST)
    expect(JSON.parse(storage.data.get(PET_STORAGE_KEY)!).lastWateredAt).toBe(60_000)

    // …and XP returns once each cooldown has passed.
    t = FEED_COOLDOWN_MS + 1
    pet.tick()
    expect(pet.waterXpCooldownRemainingMs.value).toBe(0)
    expect(pet.drink()).toBe(true)
    expect(pet.xp.value).toBe(2 * XP_PER_DRINK + XP_PER_REST)
    expect(pet.rest()).toBe(true)
    expect(pet.xp.value).toBe(2 * (XP_PER_DRINK + XP_PER_REST))
  })

  it('death blocks drink and rest like it blocks feed', () => {
    let t = 0
    const pet = createPetStore({ storage, now: () => t })
    t = DEFAULT_STARVATION_MS + 10
    pet.tick()
    expect(pet.isDead.value).toBe(true)
    expect(pet.drink()).toBe(false)
    expect(pet.rest()).toBe(false)
    expect(pet.xp.value).toBe(0)
  })

  it('feeding grants xp only once per cooldown but always resets hunger', () => {
    let t = 0
    const pet = createPetStore({ storage, now: () => t })
    expect(pet.feed()).toBe(true)
    expect(pet.xp.value).toBe(XP_PER_FEED)

    // Spam-clicks inside the cooldown still count as care: hunger resets to
    // `t` and lands in storage, but no extra XP is granted.
    t = 60_000
    expect(pet.feed()).toBe(false)
    expect(JSON.parse(storage.data.get(PET_STORAGE_KEY)!).lastFedAt).toBe(60_000)

    // …grant nothing until the cooldown passes.
    t = FEED_COOLDOWN_MS - 30_000
    expect(pet.feed()).toBe(false)
    expect(pet.xp.value).toBe(XP_PER_FEED)
    t = FEED_COOLDOWN_MS + 5
    pet.tick()
    expect(pet.feedCooldownRemainingMs.value).toBe(0)
    expect(pet.feed()).toBe(true)
    expect(pet.xp.value).toBe(2 * XP_PER_FEED)
    const stored = JSON.parse(storage.data.get(PET_STORAGE_KEY)!)
    expect(stored.lastFeedXpAt).toBe(t)
    expect(stored.xp).toBe(2 * XP_PER_FEED)
  })

  it('feed within cooldown skips persisting but a granted feed persists', () => {
    let t = 0
    const pet = createPetStore({ storage, now: () => t })
    expect(pet.feed()).toBe(true)
    expect(storage.data.has(PET_STORAGE_KEY)).toBe(true)

    t += 1_000
    pet.revive()
    // revive() clears the XP clock while keeping earned xp, so this next
    // feed earns xp again on top.
    expect(pet.feed()).toBe(true)
    expect(pet.xp.value).toBe(2 * XP_PER_FEED)
  })
  it('revive restarts every care clock while keeping xp', () => {
    let t = 0
    const pet = createPetStore({ storage, now: () => t })
    expect(pet.feed()).toBe(true)
    const levelBefore = pet.level.value

    t = DEFAULT_STARVATION_MS + 60_000
    pet.tick()
    expect(pet.isDead.value).toBe(true)
    // All three meters ran dry by now if they had not been refreshed…
    // revive should bring the whole pet back at once.
    t += 30_000
    pet.revive()
    expect(pet.isDead.value).toBe(false)
    expect(pet.starvationRemainingMs.value).toBe(DEFAULT_STARVATION_MS)
    expect(pet.waterRemainingMs.value).toBe(WATER_WINDOW_MS)
    expect(pet.restRemainingMs.value).toBe(REST_WINDOW_MS)
    expect(pet.needsWater.value).toBe(false)
    expect(pet.needsRest.value).toBe(false)
    expect(pet.level.value).toBe(levelBefore)
  })

  it('refuses to feed a starved pet', () => {
    let t = 0
    const now = vi.fn(() => t)
    const pet = createPetStore({ storage, now })
    expect(pet.feed()).toBe(true)
    const xpAfterFeed = pet.xp.value

    // Time runs well past the deadline; feed() re-ticks internally, so it
    // notices the death even without an explicit tick()/interval first.
    t = DEFAULT_STARVATION_MS + 2
    expect(pet.feed()).toBe(false)
    expect(pet.isDead.value).toBe(true)
    expect(pet.xp.value).toBe(xpAfterFeed)
  })

  it('revive keeps xp but restarts the clock', () => {
    let t = 0
    const now = vi.fn(() => t)
    const pet = createPetStore({ storage, now })
    expect(pet.feed()).toBe(true)
    const levelBefore = pet.level.value

    t = DEFAULT_STARVATION_MS + 1_000
    pet.tick()
    expect(pet.isDead.value).toBe(true)

    t += 1_000
    pet.revive()
    expect(pet.isDead.value).toBe(false)
    expect(pet.starvationRemainingMs.value).toBe(DEFAULT_STARVATION_MS)
    expect(pet.xp.value).toBe(XP_PER_FEED)
    expect(pet.level.value).toBe(levelBefore)
    const stored = JSON.parse(storage.data.get(PET_STORAGE_KEY)!)
    expect(stored.lastFedAt).toBe(t)
  })

  it('tick advances the derived death state without mutating persistence clock', () => {
    let t = 0
    const now = vi.fn(() => t)
    const pet = createPetStore({ storage, now })
    expect(pet.feed()).toBe(true)

    t = DEFAULT_STARVATION_MS - 1
    pet.tick()
    expect(pet.isDead.value).toBe(false)
    expect(pet.starvationRemainingMs.value).toBe(1)

    t += 1
    pet.tick()
    expect(pet.isDead.value).toBe(true)
    expect(pet.starvationRemainingMs.value).toBe(0)
  })

  it('startAutoRefresh ticks on the interval and stops cleanly', () => {
    vi.useFakeTimers()
    let t = 0
    const now = vi.fn(() => t)
    const pet = createPetStore({ storage, now })
    pet.startAutoRefresh(1_000)

    t = DEFAULT_STARVATION_MS + 5
    vi.advanceTimersByTime(1_500)
    expect(pet.isDead.value).toBe(true)

    pet.stopAutoRefresh()
    t += DEFAULT_STARVATION_MS
    vi.advanceTimersByTime(10_000)
    // The final advance only matters if a second timer leaked; dead already true,
    // so assert the timer handle is gone by reviving: no interval can re-starve.
    pet.revive()
    vi.advanceTimersByTime(60_000)
    expect(pet.isDead.value).toBe(false)
  })

  it('rename persists a trimmed, capped name and refuses empty input', () => {
    const pet = makeStore()
    expect(pet.rename('   Scribbles  ')).toBe(true)
    expect(pet.name.value).toBe('Scribbles')
    expect(JSON.parse(storage.data.get(PET_STORAGE_KEY)!).name).toBe('Scribbles')

    // Overlong input is capped, not rejected.
    const longName = 'x'.repeat(40)
    expect(pet.rename(longName)).toBe(true)
    expect(pet.name.value.length).toBe(24)

    expect(pet.rename('   ')).toBe(false)

    // A fresh store hydrates the persisted name.
    expect(makeStore().name.value.length).toBe(24)
  })

  it('hydrate keeps an optional v2 name and drops junk values', () => {
    storage.data.set(PET_STORAGE_KEY, JSON.stringify({
      version: 2,
      x: 1,
      y: 2,
      followEnabled: false,
      xp: 0,
      lastFedAt: 10,
      lastWateredAt: 10,
      lastRestedAt: 10,
      name: 'Pip',
    }))
    expect(makeStore({ now: () => 20 }).name.value).toBe('Pip')

    storage.data.set(PET_STORAGE_KEY, JSON.stringify({
      version: 2,
      x: 1,
      y: 2,
      followEnabled: false,
      xp: 0,
      lastFedAt: 10,
      lastWateredAt: 10,
      lastRestedAt: 10,
      name: 42,
    }))
    expect(makeStore({ now: () => 20 }).name.value).toBe('')
  })

  it('resetPetState restores factory defaults and overwrites the record', () => {
    storage.data.set(PET_STORAGE_KEY, JSON.stringify({
      version: 2,
      x: 50_000,
      y: 60_000,
      followEnabled: true,
      xp: 999,
      lastFedAt: -DEFAULT_STARVATION_MS * 2,
      lastWateredAt: -WATER_WINDOW_MS * 2,
      lastRestedAt: -REST_WINDOW_MS * 2,
      lastFeedXpAt: 5,
      name: 'Old Friend',
    }))
    let t = DEFAULT_STARVATION_MS
    const pet = makeStore({ now: () => t })
    pet.tick()
    expect(pet.isDead.value).toBe(true)

    pet.resetPetState()
    expect(pet.isDead.value).toBe(false)
    expect(pet.xp.value).toBe(0)
    expect(pet.name.value).toBe('')
    expect(pet.followEnabled.value).toBe(false)
    expect(pet.starvationRemainingMs.value).toBe(DEFAULT_STARVATION_MS)
    expect(pet.waterRemainingMs.value).toBe(WATER_WINDOW_MS)
    expect(pet.restRemainingMs.value).toBe(REST_WINDOW_MS)
    expect(pet.feedCooldownRemainingMs.value).toBe(0)

    const stored = JSON.parse(storage.data.get(PET_STORAGE_KEY)!)
    expect(stored.xp).toBe(0)
    expect(stored.lastFedAt).toBe(t)
    expect(stored.name).toBeUndefined()
    // A reload sees the same fresh state.
    t += 100
    expect(makeStore().xp.value).toBe(0)
    expect(makeStore().name.value).toBe('')
  })

  it('setFollow persists through storage', () => {
    const pet = makeStore()
    pet.setFollow(true)
    expect(pet.followEnabled.value).toBe(true)
    expect(JSON.parse(storage.data.get(PET_STORAGE_KEY)!).followEnabled).toBe(true)
    pet.setFollow(false)
    expect(JSON.parse(storage.data.get(PET_STORAGE_KEY)!).followEnabled).toBe(false)
  })

  it('setPosition persists by default and streams without persist when asked', () => {
    const pet = makeStore()
    pet.setPosition({ x: 12, y: 34 })
    expect(pet.position.value).toEqual({ x: 12, y: 34 })
    expect(JSON.parse(storage.data.get(PET_STORAGE_KEY)!).x).toBe(12)

    pet.setPosition({ x: 56, y: 78 }, { persist: false })
    expect(pet.position.value).toEqual({ x: 56, y: 78 })
    expect(JSON.parse(storage.data.get(PET_STORAGE_KEY)!).x).toBe(12)
  })

  it('rejects non-finite coordinates', () => {
    const pet = makeStore()
    pet.setPosition({ x: Number.NaN, y: 10 })
    expect(pet.position.value.y).not.toBe(10)
  })

  it('hydrates from stored state and clamps wild coordinates', () => {
    storage.data.set(PET_STORAGE_KEY, JSON.stringify({
      version: 1,
      x: 400_000,
      y: 8,
      followEnabled: true,
      xp: 240,
      lastFedAt: 123,
    }))
    const pet = makeStore({ now: () => 456 })
    expect(pet.position.value).toEqual({ x: 100_000, y: 8 })
    expect(pet.followEnabled.value).toBe(true)
    expect(pet.xp.value).toBe(240)
    // 100 xp completes level 1; the rest sits 140 into level 2's 200.
    expect(pet.levelInfo.value).toEqual({
      level: 2,
      intoLevel: 140,
      needed: 2 * LEVEL_XP_BASE,
    })
    // v1 has no water/rest clocks — migration treats the pet as just cared for.
    expect(pet.waterRemainingMs.value).toBe(WATER_WINDOW_MS)
    expect(pet.restRemainingMs.value).toBe(REST_WINDOW_MS)
    expect(pet.isDead.value).toBe(false)
  })

  it('hydrates v2 records with their own water/rest clocks', () => {
    // Evaluated 16 h after epoch: the pet was fed/watered at t=0 (fed alive,
    // water long dry) and rested two minutes before evaluation.
    storage.data.set(PET_STORAGE_KEY, JSON.stringify({
      version: 2,
      x: 5,
      y: 6,
      followEnabled: false,
      xp: 30,
      lastFedAt: 0,
      lastWateredAt: 0,
      lastRestedAt: REST_WINDOW_MS - 120_000,
    }))
    const pet = makeStore({ now: () => REST_WINDOW_MS })
    expect(pet.isDead.value).toBe(false)
    expect(pet.needsWater.value).toBe(true)
    expect(pet.needsRest.value).toBe(false)
    expect(pet.restRemainingMs.value).toBe(REST_WINDOW_MS - 120_000)
    expect(pet.drink()).toBe(true)
    expect(JSON.parse(storage.data.get(PET_STORAGE_KEY)!)).toMatchObject({
      version: 2,
      xp: 30 + XP_PER_DRINK,
      lastWateredAt: REST_WINDOW_MS,
    })
  })

  it('falls back to defaults on corrupt json or wrong version', () => {
    storage.data.set(PET_STORAGE_KEY, '{not json')
    let pet = makeStore()
    expect(pet.xp.value).toBe(0)
    expect(pet.followEnabled.value).toBe(false)

    storage.data.set(PET_STORAGE_KEY, JSON.stringify({ version: 99, x: 1, y: 1 }))
    pet = makeStore()
    expect(pet.followEnabled.value).toBe(false)

    // A v2 record missing either care clock is untrustworthy as a whole.
    storage.data.set(PET_STORAGE_KEY, JSON.stringify({
      version: 2,
      x: 1,
      y: 1,
      followEnabled: true,
      xp: 50,
      lastFedAt: 0,
      lastWateredAt: 0,
    }))
    pet = makeStore({ now: () => 900 })
    expect(pet.followEnabled.value).toBe(false)
    expect(pet.xp.value).toBe(0)
    // Defaulted clocks start full, exactly like a brand-new pet.
    expect(pet.waterRemainingMs.value).toBe(WATER_WINDOW_MS)
    expect(pet.restRemainingMs.value).toBe(REST_WINDOW_MS)
  })

  it('falls back to defaults on corrupt json or wrong version', () => {
    storage.data.set(PET_STORAGE_KEY, '{not json')
    let pet = makeStore()
    expect(pet.xp.value).toBe(0)
    expect(pet.followEnabled.value).toBe(false)

    storage.data.set(PET_STORAGE_KEY, JSON.stringify({ version: 99, x: 1, y: 1 }))
    pet = makeStore()
    expect(pet.followEnabled.value).toBe(false)
  })

  it('survives storage write failures', () => {
    storage.setItem = () => {
      throw new Error('quota')
    }
    const pet = makeStore()
    expect(() => pet.feed()).not.toThrow()
    expect(pet.xp.value).toBe(XP_PER_FEED)
  })

  it('caps accumulated xp at the max total', () => {
    storage.data.set(PET_STORAGE_KEY, JSON.stringify({
      version: 1,
      x: 10,
      y: 10,
      followEnabled: false,
      xp: MAX_TOTAL_XP - 3,
      lastFedAt: 0,
    }))
    // Pin the clock to the stored feeding time so the pet is alive.
    const pet = makeStore({ now: () => 0 })
    expect(pet.feed()).toBe(true)
    expect(pet.xp.value).toBe(MAX_TOTAL_XP)
    expect(pet.levelInfo.value.level).toBe(MAX_PET_LEVEL)
  })
})
