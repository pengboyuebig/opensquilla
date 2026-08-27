import { readonly, ref } from 'vue'

export const PET_VISIBLE_STORAGE_KEY = 'opensquilla.petVisible'

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readStoredPreference(): boolean {
  try {
    const saved = storage()?.getItem(PET_VISIBLE_STORAGE_KEY)
    if (!saved) return true
    const parsed = JSON.parse(saved) as { enabled?: unknown }
    return typeof parsed.enabled === 'boolean' ? parsed.enabled : true
  } catch {
    return true
  }
}

// Settings and App share one renderer-local preference so toggling visibility
// updates the floating companion immediately. Kept as a module-level singleton
// like the other appearance preferences.
const enabled = ref(readStoredPreference())

function setEnabled(next: boolean): void {
  enabled.value = Boolean(next)
  try {
    storage()?.setItem(PET_VISIBLE_STORAGE_KEY, JSON.stringify({
      enabled: enabled.value,
    }))
  } catch {
    // Restricted browser contexts still keep the preference for this page.
  }
}

export function usePetVisiblePreference() {
  return {
    enabled: readonly(enabled),
    setEnabled,
  }
}
