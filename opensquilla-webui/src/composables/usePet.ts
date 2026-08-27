import { computed, ref } from 'vue'

// Browser-local desktop-pet state: position on screen, mouse-follow toggle,
// growth (XP/level) and the feeding clock that decides starvation. Nothing
// here touches session or gateway state — the pet survives across routes and
// reconnects entirely from localStorage, following the same strict-hydrate /
// swallow-write-failure pattern as the other renderer-local preferences.

export type PetStorageLike = Pick<Storage, 'getItem' | 'setItem'>

export interface PetPosition {
  x: number
  y: number
}

export interface PetLevelInfo {
  level: number
  /** XP already earned toward the next level. */
  intoLevel: number
  /** XP required to advance from the current level (`needed` at max = full). */
  needed: number
}

interface StoredPetState {
  version: 2
  x: number
  y: number
  followEnabled: boolean
  xp: number
  lastFedAt: number
  lastWateredAt: number
  lastRestedAt: number
  /** Last feeding that granted XP; absent/0 in records from before the
   * feed cooldown, which simply means the cooldown has long expired. */
  lastFeedXpAt?: number
  /** Optional custom name; absent records fall back to the locale default. */
  name?: string
}

/** Hard cap for a custom pet name. */
export const PET_NAME_MAX_LENGTH = 24

export const PET_STORAGE_KEY = 'opensquilla-pet-v1'

/** XP granted per feeding. */
export const XP_PER_FEED = 25
export const XP_PER_DRINK = 10
export const XP_PER_REST = 15
/** XP needed to advance grows linearly with the current level. */
export const LEVEL_XP_BASE = 100
export const MAX_PET_LEVEL = 50
export const DEFAULT_STARVATION_MS = 24 * 60 * 60 * 1000
/** Thirst drains faster than hunger; energy sits in between. */
export const WATER_WINDOW_MS = 8 * 60 * 60 * 1000
export const REST_WINDOW_MS = 16 * 60 * 60 * 1000
/** Minimum spacing between XP-granting feeds — feeding always resets the
 * hunger clock, but spam-clicking must not farm unlimited XP. */
export const FEED_COOLDOWN_MS = 30 * 60 * 1000
const AUTO_REFRESH_INTERVAL_MS = 30_000

/** Hard sanity bounds for stored coordinates; the owning component applies
 * pixel-perfect clamping against its measured footprint. */
const STORED_COORD_MAX = 100_000

/** Total XP once every level is maxed; further gains are capped here. */
export const MAX_TOTAL_XP = (() => {
  let total = 0
  for (let level = 1; level < MAX_PET_LEVEL; level += 1) total += level * LEVEL_XP_BASE
  return total
})()

function browserStorage(): PetStorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizedCount(value: unknown): number {
  const numeric = finiteNumber(value)
  return numeric === null || numeric < 0 ? 0 : Math.min(Math.floor(numeric), Number.MAX_SAFE_INTEGER)
}

export function levelInfoForXp(totalXp: number): PetLevelInfo {
  let level = 1
  let remaining = Math.max(0, Math.floor(totalXp))
  while (level < MAX_PET_LEVEL) {
    const need = level * LEVEL_XP_BASE
    if (remaining < need) return { level, intoLevel: remaining, needed: need }
    remaining -= need
    level += 1
  }
  // Maxed out: report a full bar so progress renders complete.
  const need = (MAX_PET_LEVEL - 1) * LEVEL_XP_BASE
  return { level: MAX_PET_LEVEL, intoLevel: need, needed: need }
}

function readStoredPetState(storage: PetStorageLike | null, nowTs: number): StoredPetState | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(PET_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>

    const x = finiteNumber(record.x)
    const y = finiteNumber(record.y)
    const lastFedAt = finiteNumber(record.lastFedAt)
    // A corrupt coordinate or clock makes the whole record untrustworthy —
    // start over rather than resurrecting a half-valid pet.
    if (x === null || y === null || lastFedAt === null) return null

    // v1 records predate the water/rest clocks; a migrated pet counts as
    // freshly cared for so it never wakes up already thirsty or tired.
    let lastWateredAt: number
    let lastRestedAt: number
    if (record.version === 1) {
      lastWateredAt = nowTs
      lastRestedAt = nowTs
    } else if (record.version === 2) {
      const watered = finiteNumber(record.lastWateredAt)
      const rested = finiteNumber(record.lastRestedAt)
      if (watered === null || rested === null) return null
      lastWateredAt = watered
      lastRestedAt = rested
    } else {
      return null
    }

    // Optional field: pre-cooldown v2 records simply have no XP-clock yet.
    const lastFeedXpAt = finiteNumber(record.lastFeedXpAt)
    // Optional custom name, sanitized defensively.
    const rawName = typeof record.name === 'string' ? record.name.trim().slice(0, PET_NAME_MAX_LENGTH) : ''

    return {
      version: 2,
      x: Math.min(Math.max(x, 0), STORED_COORD_MAX),
      y: Math.min(Math.max(y, 0), STORED_COORD_MAX),
      followEnabled: record.followEnabled === true,
      xp: normalizedCount(record.xp),
      lastFedAt,
      lastWateredAt,
      lastRestedAt,
      lastFeedXpAt: lastFeedXpAt && lastFeedXpAt > 0 ? lastFeedXpAt : undefined,
      ...(rawName ? { name: rawName } : {}),
    }
  } catch {
    return null
  }
}

function viewportSize(): { width: number; height: number } {
  if (typeof document === 'undefined') return { width: 1280, height: 800 }
  return {
    width: Math.max(document.documentElement.clientWidth, 320),
    height: Math.max(document.documentElement.clientHeight, 320),
  }
}

export function createPetStore(options: {
  storage?: PetStorageLike | null
  starvationMs?: number
  now?: () => number
} = {}) {
  const storage = options.storage === undefined ? browserStorage() : options.storage
  const starvationMs = options.starvationMs ?? DEFAULT_STARVATION_MS
  const now = options.now ?? (() => Date.now())

  const stored = readStoredPetState(storage, now())
  function freshPosition(): PetPosition {
    const { width, height } = viewportSize()
    return { x: Math.max(width - 96, 12), y: Math.max(height - 180, 12) }
  }
  const defaultPosition = freshPosition()

  const position = ref<PetPosition>(stored ? { x: stored.x, y: stored.y } : defaultPosition)
  const followEnabled = ref<boolean>(stored?.followEnabled ?? false)
  const xp = ref<number>(stored?.xp ?? 0)
  // All three care clocks start "just cared for" so a brand-new pet is full.
  const lastFedAt = ref<number>(stored?.lastFedAt ?? now())
  const lastWateredAt = ref<number>(stored?.lastWateredAt ?? now())
  const lastRestedAt = ref<number>(stored?.lastRestedAt ?? now())
  // XP clock for the feed cooldown; null = never granted (fresh pets can eat).
  const lastFeedXpAt = ref<number | null>(stored?.lastFeedXpAt ?? null)
  // Empty string means "use the locale default name".
  const name = ref<string>(stored?.name ?? '')
  // Driven by tick(); time-derived values re-evaluate whenever it advances so
  // an idle tab still notices the passing of the starvation deadline (the
  // auto-refresh timer catches up on focus/interval).
  const nowTick = ref<number>(now())

  const levelInfo = computed<PetLevelInfo>(() => levelInfoForXp(xp.value))
  const level = computed(() => levelInfo.value.level)
  const isDead = computed(() => nowTick.value - lastFedAt.value >= starvationMs)
  const starvationRemainingMs = computed(() =>
    Math.max(0, starvationMs - (nowTick.value - lastFedAt.value)))
  const waterRemainingMs = computed(() =>
    Math.max(0, WATER_WINDOW_MS - (nowTick.value - lastWateredAt.value)))
  const restRemainingMs = computed(() =>
    Math.max(0, REST_WINDOW_MS - (nowTick.value - lastRestedAt.value)))
  /** ms until the next feeding grants XP again; 0 when ready. */
  const feedCooldownRemainingMs = computed(() => {
    if (lastFeedXpAt.value === null) return 0
    return Math.max(0, FEED_COOLDOWN_MS - (nowTick.value - lastFeedXpAt.value))
  })
  // A need only exists once its meter has run dry — that is what makes the
  // matching care action meaningful instead of a spammable XP button.
  const needsWater = computed(() => waterRemainingMs.value <= 0)
  const needsRest = computed(() => restRemainingMs.value <= 0)

  function persist() {
    if (!storage) return
    const state: StoredPetState = {
      version: 2,
      x: position.value.x,
      y: position.value.y,
      followEnabled: followEnabled.value,
      xp: xp.value,
      lastFedAt: lastFedAt.value,
      lastWateredAt: lastWateredAt.value,
      lastRestedAt: lastRestedAt.value,
      ...(lastFeedXpAt.value !== null ? { lastFeedXpAt: lastFeedXpAt.value } : {}),
      ...(name.value ? { name: name.value } : {}),
    }
    try {
      storage.setItem(PET_STORAGE_KEY, JSON.stringify(state))
    } catch {
      // Storage can be unavailable or full in restricted browser contexts;
      // the companion keeps working from memory for this session.
    }
  }

  /** Advance the internal clock so isDead/hunger reflect reality. */
  function tick() {
    nowTick.value = now()
  }

  let refreshTimer: ReturnType<typeof setInterval> | null = null

  function startAutoRefresh(intervalMs: number = AUTO_REFRESH_INTERVAL_MS) {
    stopAutoRefresh()
    tick()
    refreshTimer = setInterval(tick, intervalMs)
  }

  function stopAutoRefresh() {
    if (refreshTimer !== null) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  /** Feed the pet. Feeding always resets the hunger clock (it is the
   * death-prevention lever, so it can never be gated), but XP is granted at
   * most once per cooldown — spam-clicking must not farm levels. */
  function feed(): boolean {
    tick()
    if (isDead.value) return false
    const ts = now()
    lastFedAt.value = ts
    if (feedCooldownRemainingMs.value <= 0) {
      xp.value = Math.min(xp.value + XP_PER_FEED, MAX_TOTAL_XP)
      lastFeedXpAt.value = ts
      persist()
      return true
    }
    // Within the cooldown the feed still counts as care (clock reset) but
    // earns nothing; skip persisting to avoid churning storage per click.
    return false
  }

  /** Shared body for the gated care actions (drink/rest): only actionable
   * while the matching need exists. */
  function performGatedCare(kind: 'water' | 'rest'): boolean {
    tick()
    if (isDead.value) return false
    const needExists = kind === 'water' ? needsWater.value : needsRest.value
    if (!needExists) return false
    xp.value = Math.min(
      xp.value + (kind === 'water' ? XP_PER_DRINK : XP_PER_REST),
      MAX_TOTAL_XP,
    )
    if (kind === 'water') lastWateredAt.value = now()
    else lastRestedAt.value = now()
    persist()
    return true
  }

  /** Give water; refuses while the pet is still hydrated. */
  function drink(): boolean {
    return performGatedCare('water')
  }

  /** Set a custom name (trimmed, hard-capped); refuses empty input. */
  function rename(next: string): boolean {
    const trimmed = typeof next === 'string' ? next.trim().slice(0, PET_NAME_MAX_LENGTH) : ''
    if (!trimmed) return false
    name.value = trimmed
    persist()
    return true
  }

  /** Wipe everything back to factory defaults: same shape as a brand-new pet,
   * with the saved record overwritten so a reload cannot resurrect it. */
  function resetPetState() {
    position.value = freshPosition()
    followEnabled.value = false
    xp.value = 0
    const ts = now()
    lastFedAt.value = ts
    lastWateredAt.value = ts
    lastRestedAt.value = ts
    lastFeedXpAt.value = null
    name.value = ''
    nowTick.value = ts
    persist()
  }

  /** Let the pet rest; refuses while it still has energy. */
  function rest(): boolean {
    return performGatedCare('rest')
  }

  /** Bring a starved pet back: keep XP/level, restart every care clock and
   * clear the feed cooldown so the first revival feeding earns XP. */
  function revive() {
    const ts = now()
    lastFedAt.value = ts
    lastWateredAt.value = ts
    lastRestedAt.value = ts
    lastFeedXpAt.value = null
    nowTick.value = ts
    persist()
  }

  function setFollow(enabled: boolean) {
    followEnabled.value = enabled === true
    persist()
  }

  /**
   * Update the on-screen anchor. `persist: false` lets the component stream
   * high-frequency drag previews through the shared refs and commit once,
   * on pointer release.
   */
  function setPosition(next: PetPosition, options: { persist?: boolean } = {}) {
    const x = finiteNumber(next?.x)
    const y = finiteNumber(next?.y)
    if (x === null || y === null) return
    position.value = {
      x: Math.min(Math.max(x, 0), STORED_COORD_MAX),
      y: Math.min(Math.max(y, 0), STORED_COORD_MAX),
    }
    if (options.persist !== false) persist()
  }

  return {
    position,
    followEnabled,
    xp,
    level,
    levelInfo,
    isDead,
    starvationMs,
    starvationRemainingMs,
    waterRemainingMs,
    restRemainingMs,
    needsWater,
    needsRest,
    feedCooldownRemainingMs,
    name,
    feed,
    drink,
    rest,
    revive,
    rename,
    resetPetState,
    setFollow,
    setPosition,
    tick,
    startAutoRefresh,
    stopAutoRefresh,
  }
}

export type PetStore = ReturnType<typeof createPetStore>

let singleton: PetStore | null = null

export function usePet(): PetStore {
  if (!singleton) singleton = createPetStore()
  return singleton
}
