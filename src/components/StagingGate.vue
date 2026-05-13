<template>
  <!-- Only renders when the staging-gate build flag is set on this
       deploy. On prod the flag is unset and the entire component
       disappears at compile time via the v-if. -->
  <div v-if="enabled" class="staging-gate">
    <!-- Status pill when already staging-tier — confirmation that the
         cap is bypassed for this session. -->
    <button
      v-if="sessionTier === 'staging'"
      class="staging-gate-pill staging-gate-pill--active"
      type="button"
      @click="signOutOfStaging"
      title="Sign out of staging tier (returns to normal capped session)"
    >
      ✓ Staging tier
    </button>

    <!-- Trigger when normal-tier — opens the password input. -->
    <button
      v-else-if="!open"
      class="staging-gate-pill"
      type="button"
      @click="open = true"
      title="Enter the staging password to bypass the daily usage cap (for PM testing)"
    >
      Staging access
    </button>

    <!-- Password prompt panel. -->
    <form v-else class="staging-gate-form" @submit.prevent="onSubmit">
      <input
        ref="inputRef"
        v-model="password"
        type="password"
        class="staging-gate-input"
        placeholder="Staging password"
        autocomplete="off"
        spellcheck="false"
        :disabled="submitting"
      />
      <button
        type="submit"
        class="staging-gate-submit"
        :disabled="submitting || !password.trim()"
      >
        {{ submitting ? '…' : 'Unlock' }}
      </button>
      <button
        type="button"
        class="staging-gate-cancel"
        :disabled="submitting"
        @click="cancel"
        aria-label="Cancel"
      >×</button>
      <p v-if="error" class="staging-gate-error">{{ error }}</p>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { useAuth } from '@/composables/useAuth'

const enabled = import.meta.env.VITE_STAGING_GATE_ENABLED === 'true'

const { sessionTier, upgradeWithPassword, clearAuth } = useAuth()

const open = ref(false)
const password = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)

watch(open, async (v) => {
  if (v) {
    await nextTick()
    inputRef.value?.focus()
  }
})

async function onSubmit() {
  if (submitting.value) return
  submitting.value = true
  error.value = null
  const result = await upgradeWithPassword(password.value)
  submitting.value = false
  if (result.ok) {
    password.value = ''
    open.value = false
  } else {
    error.value = result.error ?? 'Sign-in failed.'
  }
}

function cancel() {
  password.value = ''
  error.value = null
  open.value = false
}

/** Sign-out of staging tier — wipes the token, anonymous session
 *  re-mints automatically. Lets a PM verify normal-tier behavior. */
function signOutOfStaging() {
  clearAuth()
}
</script>

<style scoped>
.staging-gate {
  position: fixed;
  bottom: 12px;
  right: 12px;
  z-index: 50;
  font-family: ui-sans-serif, system-ui, sans-serif;
}

.staging-gate-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--blo-stone, #6b6560);
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(17, 17, 17, 0.06);
  transition: color 0.15s, border-color 0.15s;
}
.staging-gate-pill:hover {
  color: var(--blo-ink, #111);
  border-color: var(--blo-stone-soft, #9a948e);
}
.staging-gate-pill--active {
  color: var(--blo-green-deep, #1f7a2e);
  border-color: var(--blo-green-deep, #1f7a2e);
  background: rgba(31, 122, 46, 0.06);
}

.staging-gate-form {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: white;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  box-shadow: 0 2px 6px rgba(17, 17, 17, 0.08);
  position: relative;
}
.staging-gate-input {
  width: 180px;
  padding: 4px 8px;
  font: inherit;
  font-size: 12px;
  border: none;
  outline: none;
  background: transparent;
}
.staging-gate-submit {
  padding: 4px 10px;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  color: white;
  background: var(--blo-ink, #111);
  border: none;
  border-radius: 999px;
  cursor: pointer;
}
.staging-gate-submit:disabled {
  background: var(--blo-stone-soft, #9a948e);
  cursor: not-allowed;
}
.staging-gate-cancel {
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 14px;
  color: var(--blo-stone, #6b6560);
  background: transparent;
  border: none;
  border-radius: 999px;
  cursor: pointer;
}
.staging-gate-cancel:hover {
  color: var(--blo-ink, #111);
}
.staging-gate-error {
  position: absolute;
  bottom: -22px;
  right: 0;
  margin: 0;
  font-size: 10.5px;
  color: #c0392b;
  white-space: nowrap;
}
</style>
