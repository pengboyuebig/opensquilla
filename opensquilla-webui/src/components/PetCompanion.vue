<template>
  <div
    ref="rootRef"
    class="pet-companion"
    :class="{ 'is-dead': pet.isDead.value, 'is-dragging': drag.active }"
    :data-mood="mood"
    :style="rootStyle"
    data-testid="pet-companion"
  >
    <button
      ref="anchorRef"
      type="button"
      class="pet-anchor"
      :class="{ 'is-grabbing': drag.active }"
      :aria-label="t('pet.statusLabel')"
      :aria-expanded="panelOpen"
      data-testid="pet-anchor"
      @pointerdown="onPointerDown"
      @pointermove="onDragPointerMove"
      @pointerup="onDragPointerUp"
      @pointercancel="onDragCancel"
      @lostpointercapture="onDragCancel"
      @click="onAnchorClick"
      @dblclick="onDblClick"
      @mouseenter="speechOpen = true"
      @mouseleave="speechOpen = false"
      @focus="speechOpen = true"
      @blur="speechOpen = false"
    >
      <span class="pet-avatar" aria-hidden="true">{{ avatar }}</span>
      <span v-if="xpBurst > 0" class="pet-xp-burst" aria-hidden="true">+{{ xpBurst }}</span>
      <span v-if="hearts > 0" class="pet-hearts" aria-hidden="true">{{ '♥'.repeat(hearts) }}</span>
      <span v-if="busy && !pet.isDead.value" class="pet-badge pet-badge--busy" aria-hidden="true"></span>
      <span v-if="approvalCount > 0" class="pet-badge pet-badge--approval" aria-hidden="true">!</span>
    </button>

    <!-- Hover/keyboard-focus speech bubble. Decorative: the panel carries the
         same facts for assistive tech, so this stays aria-hidden. -->
    <div
      v-if="speechOpen && !drag.active && !panelOpen"
      class="pet-speech"
      aria-hidden="true"
      data-testid="pet-speech"
    >
      {{ moodText }}
    </div>

    <div
      v-if="panelOpen"
      class="pet-panel"
      :class="`pet-panel--${panelPlacement}`"
      role="group"
      :aria-label="t('pet.panelLabel')"
      data-testid="pet-panel"
    >
      <header class="pet-panel__head">
        <template v-if="!renaming">
          <button
            type="button"
            class="pet-panel__name pet-panel__name--edit"
            :title="t('pet.renameLabel')"
            data-testid="pet-name"
            @click="startRenaming"
          >{{ displayName }}</button>
        </template>
        <input
          v-else
          ref="nameInputRef"
          v-model="nameDraft"
          class="pet-panel__name-input"
          :maxlength="PET_NAME_MAX_LENGTH"
          :aria-label="t('pet.renameLabel')"
          data-testid="pet-name-input"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.stop.prevent="cancelRename"
          @blur="commitRename"
        />
        <span class="pet-panel__level" data-testid="pet-level">
          {{ t('pet.levelLabel', { level: pet.level.value }) }}
        </span>
      </header>

      <div
        class="pet-xp"
        role="progressbar"
        :aria-valuemin="0"
        :aria-valuemax="pet.levelInfo.value.needed"
        :aria-valuenow="pet.levelInfo.value.intoLevel"
        :aria-label="t('pet.xpBarLabel')"
      >
        <div class="pet-xp__fill" :style="{ width: xpPercent }"></div>
      </div>
      <p class="pet-xp__text" data-testid="pet-xp-text">
        {{ maxed ? t('pet.xpMaxed') : t('pet.xpLabel', { into: pet.levelInfo.value.intoLevel, needed: pet.levelInfo.value.needed }) }}
      </p>

      <ul class="pet-needs">
        <li
          v-for="meter in meters"
          :key="meter.key"
          class="pet-need"
          :data-tone="meter.tone"
        >
          <span class="pet-need__label">{{ meter.label }}</span>
          <div
            class="pet-need__bar"
            role="progressbar"
            :aria-valuemin="0"
            :aria-valuemax="meter.windowMs"
            :aria-valuenow="meter.remaining"
            :aria-valuetext="meter.text"
            :aria-label="meter.label"
          >
            <div class="pet-need__fill" :style="{ width: meter.pct }"></div>
          </div>
          <span class="pet-need__value" :data-testid="`pet-meter-${meter.key}`">{{ meter.text }}</span>
        </li>
      </ul>

      <div class="pet-panel__actions">
        <button
          v-if="!pet.isDead.value"
          type="button"
          class="btn btn--sm pet-action"
          data-testid="pet-feed"
          :disabled="pet.feedCooldownRemainingMs.value > 0"
          :title="t('pet.careCooldown')"
          @click="onFeed"
        >
          {{ t('pet.feed') }}
        </button>
        <button
          v-if="!pet.isDead.value"
          type="button"
          class="btn btn--sm pet-action"
          data-testid="pet-drink"
          :disabled="pet.waterXpCooldownRemainingMs.value > 0"
          :title="t('pet.careCooldown')"
          @click="onDrink"
        >
          {{ t('pet.drink') }}
        </button>
        <button
          v-if="!pet.isDead.value"
          type="button"
          class="btn btn--sm pet-action"
          data-testid="pet-rest"
          :disabled="pet.restXpCooldownRemainingMs.value > 0"
          :title="t('pet.careCooldown')"
          @click="onRest"
        >
          {{ t('pet.rest') }}
        </button>
        <button
          type="button"
          class="btn btn--sm pet-action"
          :aria-pressed="pet.followEnabled.value"
          data-testid="pet-follow-toggle"
          @click="onToggleFollow"
        >
          {{ pet.followEnabled.value ? t('pet.followOff') : t('pet.followOn') }}
        </button>
        <button
          v-if="pet.isDead.value"
          type="button"
          class="btn btn--sm pet-action pet-action--revive"
          data-testid="pet-revive"
          @click="onRevive"
        >
          {{ t('pet.revive') }}
        </button>
      </div>

      <div class="pet-panel__foot">
        <button
          type="button"
          class="btn btn--sm btn--ghost pet-reset"
          data-testid="pet-reset"
          @click="onReset"
        >
          {{ t('pet.reset') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  usePet,
  PET_NAME_MAX_LENGTH,
  REST_WINDOW_MS,
  WATER_WINDOW_MS,
  XP_PER_DRINK,
  XP_PER_FEED,
  XP_PER_REST,
} from '@/composables/usePet'
import { useToasts } from '@/composables/useToasts'
import { useConfirm } from '@/composables/useConfirm'

// Movement smaller than this is a click, not a reposition — mirrors the
// sidebar resizer's deadzone so a resting hand never both drags and opens.
const PET_DRAG_DEADZONE = 4

/** Starvation fraction below which the pet reads as visibly hungry. */
const HUNGRY_FRACTION = 0.3

const props = defineProps<{
  /** Any session task queued/running — drives the busy badge. */
  busy?: boolean
  /** Pending approval count — drives the attention badge. */
  approvalCount?: number
}>()

const { busy = false, approvalCount = 0 } = props

const pet = usePet()
const { t } = useI18n()
const { pushToast } = useToasts()
const { confirm } = useConfirm()

const rootRef = ref<HTMLElement | null>(null)
const anchorRef = ref<HTMLElement | null>(null)

const panelOpen = ref(false)
const xpBurst = ref(0)
let xpBurstTimer: ReturnType<typeof setTimeout> | null = null

const speechOpen = ref(false)
const hearts = ref(0)
let heartsTimer: ReturnType<typeof setTimeout> | null = null

// Responsive reduced-motion: follows live matchMedia changes instead of a
// one-shot setup snapshot.
const reducedMotion = ref(
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false,
)
let reducedMotionMql: MediaQueryList | null = null
let reducedMotionHandler: ((e: MediaQueryListEvent) => void) | null = null

function viewportSize(): { width: number; height: number } {
  if (typeof document === 'undefined') return { width: 1280, height: 800 }
  return {
    width: Math.max(document.documentElement.clientWidth, 320),
    height: Math.max(document.documentElement.clientHeight, 320),
  }
}

/** Keep the anchor inside the viewport; the panel may flip around it but the
 * grab target must always stay reachable. */
function clampToViewport(x: number, y: number): { x: number; y: number } {
  const { width, height } = viewportSize()
  const size = anchorRef.value ?? rootRef.value
  const w = size?.offsetWidth || 48
  const h = size?.offsetHeight || 48
  return {
    x: Math.min(Math.max(x, 0), Math.max(width - w, 0)),
    y: Math.min(Math.max(y, 0), Math.max(height - h, 0)),
  }
}

const rootStyle = computed(() => {
  const p = clampToViewport(pet.position.value.x, pet.position.value.y)
  return { left: `${Math.round(p.x)}px`, top: `${Math.round(p.y)}px` }
})

const avatar = computed(() => {
  if (pet.isDead.value) return '💀'
  if (pet.level.value >= 8) return '🐔'
  if (pet.level.value >= 3) return '🐤'
  return '🐣'
})

type Mood = 'dead' | 'bad' | 'ok' | 'great'

const mood = computed<Mood>(() => {
  if (pet.isDead.value) return 'dead'
  const fractions = [
    pet.starvationRemainingMs.value / pet.starvationMs,
    pet.waterRemainingMs.value / WATER_WINDOW_MS,
    pet.restRemainingMs.value / REST_WINDOW_MS,
  ]
  if (fractions.some((f) => f <= 0.2)) return 'bad'
  if (fractions.every((f) => f > 0.5)) return 'great'
  return 'ok'
})

const displayName = computed(() => pet.name.value || t('pet.name'))

// Speech-bubble line, chosen by urgency (death > thirsty > hungry > tired).
const moodText = computed(() => {
  if (pet.isDead.value) return t('pet.hungerStarved')
  if (pet.needsWater.value) return t('pet.moodThirsty')
  if (pet.starvationRemainingMs.value / pet.starvationMs < HUNGRY_FRACTION) return t('pet.moodHungry')
  if (pet.restRemainingMs.value / REST_WINDOW_MS < HUNGRY_FRACTION) return t('pet.moodTired')
  return t('pet.moodHappy')
})

const maxed = computed(() =>
  pet.level.value >= 50
  && pet.levelInfo.value.intoLevel >= pet.levelInfo.value.needed)

const xpPercent = computed(() => {
  const { intoLevel, needed } = pet.levelInfo.value
  if (needed <= 0) return '100%'
  const pct = Math.min(100, Math.round((intoLevel / needed) * 100))
  return `${maxed.value ? 100 : pct}%`
})

type NeedTone = 'ok' | 'warn' | 'danger' | 'empty'

function toneFor(remainingMs: number, windowMs: number): NeedTone {
  if (remainingMs <= 0) return 'empty'
  const fraction = remainingMs / windowMs
  if (fraction <= 0.2) return 'danger'
  if (fraction <= 0.5) return 'warn'
  return 'ok'
}

function countdownText(
  remainingMs: number,
  hoursKey: string,
  minutesKey: string,
  emptyText: string,
): string {
  if (remainingMs <= 0) return emptyText
  const totalMinutes = Math.floor(remainingMs / 60_000)
  if (totalMinutes >= 60) {
    return t(hoursKey, { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 })
  }
  return t(minutesKey, { minutes: totalMinutes })
}

const meters = computed(() => {
  const dead = pet.isDead.value
  const foodRemaining = pet.starvationRemainingMs.value
  const waterRemaining = pet.waterRemainingMs.value
  const restRemaining = pet.restRemainingMs.value
  return [
    {
      key: 'food',
      label: t('pet.hungerLabel'),
      remaining: foodRemaining,
      windowMs: pet.starvationMs,
      tone: (dead ? 'dead' : toneFor(foodRemaining, pet.starvationMs)) as NeedTone | 'dead',
      pct: `${Math.round((foodRemaining / pet.starvationMs) * 100)}%`,
      text: countdownText(foodRemaining, 'pet.hungerTimeHours', 'pet.hungerTimeMinutes', t('pet.hungerStarved')),
    },
    {
      key: 'water',
      label: t('pet.waterLabel'),
      remaining: waterRemaining,
      windowMs: WATER_WINDOW_MS,
      tone: (dead ? 'dead' : toneFor(waterRemaining, WATER_WINDOW_MS)) as NeedTone | 'dead',
      pct: `${Math.round((waterRemaining / WATER_WINDOW_MS) * 100)}%`,
      text: waterRemaining > 0 ? t('pet.stateFull') : t('pet.thirstyNow'),
    },
    {
      key: 'rest',
      label: t('pet.restLabel'),
      remaining: restRemaining,
      windowMs: REST_WINDOW_MS,
      tone: (dead ? 'dead' : toneFor(restRemaining, REST_WINDOW_MS)) as NeedTone | 'dead',
      pct: `${Math.round((restRemaining / REST_WINDOW_MS) * 100)}%`,
      text: restRemaining > 0 ? t('pet.stateFull') : t('pet.tiredNow'),
    },
  ]
})

// Estimate only — used to pick above/below placement before measuring.
// Three care meters + actions + footer make the panel taller than the old
// single-line hunger readout; a generous estimate just biases placement.
const PANEL_ESTIMATED_HEIGHT = 360

const panelPlacement = computed<'above' | 'below'>(() => {
  const top = clampToViewport(pet.position.value.x, pet.position.value.y).y
  return top > PANEL_ESTIMATED_HEIGHT + 24 ? 'above' : 'below'
})

// ── Drag ────────────────────────────────────────────────────────────────
const drag = reactive({
  active: false,
  moved: false,
  pointerId: -1,
  startX: 0,
  startY: 0,
  originX: 0,
  originY: 0,
  latestX: 0,
  latestY: 0,
})

let dragFrame = 0
let suppressNextClick = false

function isSupportedPointer(event: PointerEvent): boolean {
  return event.isPrimary !== false
  && event.button === 0
  && (event.pointerType === 'mouse' || event.pointerType === 'pen')
}

function capturePointer(target: HTMLElement, pointerId: number) {
  try {
    target.setPointerCapture?.(pointerId)
  } catch {
    // The originating pointer may already have ended.
  }
}

function releasePointer(target: HTMLElement | null, pointerId: number) {
  if (!target || pointerId < 0) return
  try {
    if (!target.hasPointerCapture || target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture?.(pointerId)
    }
  } catch {
    // Losing capture is already an accepted terminal state for this gesture.
  }
}

function requestFrame(callback: () => void): number {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback)
  }
  return window.setTimeout(callback, 0)
}

function cancelFrame(frame: number) {
  if (!frame) return
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(frame)
  } else {
    window.clearTimeout(frame)
  }
}

function stopFollowing() {
  followFrameActive = false
  cancelAnimationFrameIfRunning()
}

function cancelAnimationFrameIfRunning() {
  if (followRafId !== null) {
    cancelFrame(followRafId)
    followRafId = null
  }
}

function onPointerDown(event: PointerEvent) {
  if (drag.active || !isSupportedPointer(event)) return
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  event.preventDefault()

  drag.active = true
  drag.moved = false
  drag.pointerId = event.pointerId
  drag.startX = event.clientX
  drag.startY = event.clientY
  drag.latestX = event.clientX
  drag.latestY = event.clientY
  const current = clampToViewport(pet.position.value.x, pet.position.value.y)
  drag.originX = current.x
  drag.originY = current.y

  stopFollowing()
  capturePointer(target, event.pointerId)
}

function onDragPointerMove(event: PointerEvent) {
  if (!drag.active || event.pointerId !== drag.pointerId) return
  drag.latestX = event.clientX
  drag.latestY = event.clientY
  if (dragFrame) return
  dragFrame = requestFrame(() => {
    dragFrame = 0
    applyDragPosition()
  })
}

function applyDragPosition() {
  if (!drag.active) return
  const dx = drag.latestX - drag.startX
  const dy = drag.latestY - drag.startY
  if (!drag.moved && Math.hypot(dx, dy) < PET_DRAG_DEADZONE) return
  drag.moved = true
  suppressNextClick = true
  const next = clampToViewport(drag.originX + dx, drag.originY + dy)
  // Stream previews through shared refs; commit once on release.
  pet.setPosition(next, { persist: false })
}

function finishDrag(commit: boolean) {
  if (!drag.active) return
  applyDragPosition()
  drag.active = false
  cancelFrame(dragFrame)
  dragFrame = 0
  releasePointer(anchorRef.value, drag.pointerId)
  drag.pointerId = -1
  if (commit && drag.moved) pet.setPosition({ ...pet.position.value })
}

function onDragPointerUp(event: PointerEvent) {
  if (!drag.active || event.pointerId !== drag.pointerId) return
  finishDrag(true)
}

function onDragCancel() {
  finishDrag(false)
}

function onAnchorClick() {
  if (suppressNextClick) {
    suppressNextClick = false
    return
  }
  panelOpen.value = !panelOpen.value
}

// ── Follow-the-cursor mode ──────────────────────────────────────────────
let followRafId: number | null = null
let followFrameActive = false
const followTarget = { x: 0, y: 0 }

const FOLLOW_OFFSET_X = 20
const FOLLOW_OFFSET_Y = 20
const FOLLOW_LERP = 0.18
const FOLLOW_SNAP_DISTANCE = 0.5

function onDocumentPointerMove(event: PointerEvent) {
  if (!pet.followEnabled.value || drag.active || panelOpen.value) return
  if (!event.isPrimary) return
  const next = clampToViewport(
    event.clientX + FOLLOW_OFFSET_X,
    event.clientY + FOLLOW_OFFSET_Y,
  )
  followTarget.x = next.x
  followTarget.y = next.y

  if (reducedMotion.value) {
    pet.setPosition(next, { persist: false })
    return
  }
  startFollowLoop()
}

function startFollowLoop() {
  if (followFrameActive) return
  followFrameActive = true
  stepFollow()
}

function stepFollow() {
  if (!followFrameActive) return
  const current = pet.position.value
  const next = {
    x: current.x + (followTarget.x - current.x) * FOLLOW_LERP,
    y: current.y + (followTarget.y - current.y) * FOLLOW_LERP,
  }
  const distance = Math.hypot(followTarget.x - next.x, followTarget.y - next.y)
  if (distance <= FOLLOW_SNAP_DISTANCE) {
    pet.setPosition({ x: followTarget.x, y: followTarget.y }, { persist: false })
    followFrameActive = false
    followRafId = null
    return
  }
  pet.setPosition(next, { persist: false })
  followRafId = requestFrame(stepFollow)
}

// ── Panel actions ───────────────────────────────────────────────────────
function showXpBurst(amount: number) {
  xpBurst.value = amount
  if (xpBurstTimer !== null) clearTimeout(xpBurstTimer)
  xpBurstTimer = setTimeout(() => {
    xpBurst.value = 0
    xpBurstTimer = null
  }, 700)
}

/** Run a care action; on success show its XP burst and toast a level-up. */
function performCare(action: () => boolean, burst: number) {
  const levelBefore = pet.level.value
  if (!action()) return
  showXpBurst(burst)
  if (pet.level.value > levelBefore) {
    pushToast(t('pet.levelUp', { level: pet.level.value }), { tone: 'ok' })
  }
}

function onFeed() {
  performCare(() => pet.feed(), XP_PER_FEED)
}

function onDrink() {
  performCare(() => pet.drink(), XP_PER_DRINK)
}

function onRest() {
  performCare(() => pet.rest(), XP_PER_REST)
}

function onDblClick() {
  hearts.value = 3
  if (heartsTimer !== null) clearTimeout(heartsTimer)
  heartsTimer = setTimeout(() => {
    hearts.value = 0
    heartsTimer = null
  }, 900)
}

// ── Rename ──────────────────────────────────────────────────────────────
const renaming = ref(false)
const nameDraft = ref('')
const nameInputRef = ref<HTMLInputElement | null>(null)

function startRenaming() {
  // Prefill only an existing custom name — committing untouched text must not
  // freeze the localized default into storage.
  nameDraft.value = pet.name.value
  renaming.value = true
  void focusNameInput()
}

async function focusNameInput() {
  await nextTick()
  nameInputRef.value?.focus({ preventScroll: true })
  nameInputRef.value?.select()
}

function commitRename() {
  if (!renaming.value) return
  renaming.value = false
  const next = nameDraft.value.trim()
  if (!next) return // empty draft keeps everything as-is
  pet.rename(next)
}

function cancelRename() {
  renaming.value = false
}

// ── Reset ───────────────────────────────────────────────────────────────
async function onReset() {
  speechOpen.value = false
  closePanel()
  const yes = await confirm({
    title: t('pet.resetConfirmTitle'),
    body: t('pet.resetConfirmBody'),
    primaryLabel: t('pet.resetConfirmPrimary'),
  })
  if (yes) pet.resetPetState()
}

function onToggleFollow() {
  const enabled = !pet.followEnabled.value
  pet.setFollow(enabled)
  if (!enabled) stopFollowing()
}

function onRevive() {
  pet.revive()
}

function closePanel() {
  panelOpen.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (!panelOpen.value || event.key !== 'Escape') return
  event.stopPropagation()
  closePanel()
  anchorRef.value?.focus({ preventScroll: true })
}

function onWindowResize() {
  // Re-clamp the stored anchor into the shrunken viewport immediately; the
  // computed style binding also clamps every frame as a safety net.
  const clamped = clampToViewport(pet.position.value.x, pet.position.value.y)
  if (
    clamped.x !== pet.position.value.x
    || clamped.y !== pet.position.value.y
  ) {
    pet.setPosition(clamped)
  }
}

onMounted(() => {
  pet.startAutoRefresh()
  document.addEventListener('pointermove', onDocumentPointerMove)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onWindowResize)
  if (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
  ) {
    reducedMotionMql = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotionHandler = (e) => { reducedMotion.value = e.matches }
    if (reducedMotionMql.addEventListener) {
      reducedMotionMql.addEventListener('change', reducedMotionHandler)
    } else if (reducedMotionMql.addListener) {
      reducedMotionMql.addListener(reducedMotionHandler)
    }
    reducedMotion.value = reducedMotionMql.matches
  }
})

onBeforeUnmount(() => {
  pet.stopAutoRefresh()
  document.removeEventListener('pointermove', onDocumentPointerMove)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onWindowResize)
  if (reducedMotionMql && reducedMotionHandler) {
    if (reducedMotionMql.removeEventListener) {
      reducedMotionMql.removeEventListener('change', reducedMotionHandler)
    } else if (reducedMotionMql.removeListener) {
      reducedMotionMql.removeListener(reducedMotionHandler)
    }
  }
  reducedMotionMql = null
  reducedMotionHandler = null
  stopFollowing()
  cancelFrame(dragFrame)
  dragFrame = 0
  if (xpBurstTimer !== null) clearTimeout(xpBurstTimer)
  xpBurstTimer = null
  if (heartsTimer !== null) clearTimeout(heartsTimer)
  heartsTimer = null
})

defineExpose({
  /** Test hook: resolve whether a drag gesture is in progress. */
  isDragging: () => drag.active,
})
</script>
