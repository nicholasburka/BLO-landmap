<script setup lang="ts">
/**
 * Internal login (phase 5, P5-4). Deliberately generic on failure —
 * "Invalid credentials" and nothing more specific, matching the API's
 * bare 401s.
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '@/composables/useAuth'

const router = useRouter()
const { loginInternal } = useAuth()

const username = ref('')
const password = ref('')
const error = ref<string | null>(null)
const submitting = ref(false)

/**
 * Where to land after a successful login. `?redirect=` is attacker-supplied —
 * the OAuth connector flow (P5-51) puts a real one there, and a phishing mail
 * could put anything — so only an in-app path is honoured.
 *
 * The browser already refuses to replaceState across origins, but "the browser
 * would have caught it" is not a control we should be relying on. A leading
 * `//` (or `/\`) is the case worth naming: it looks like a path and resolves
 * as a protocol-relative URL to somebody else's site.
 */
function safeRedirect(raw: unknown): string {
  // An internal user who asked for nothing in particular lands on the
  // knowledge base, not the public map.
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/kb'
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/kb'
  return raw
}

async function submit() {
  if (submitting.value || !username.value || !password.value) return
  submitting.value = true
  error.value = null
  const result = await loginInternal(username.value, password.value)
  submitting.value = false
  if (result.ok) {
    router.replace(safeRedirect(router.currentRoute.value.query.redirect))
  } else {
    error.value = result.error ?? 'Invalid credentials'
    password.value = ''
  }
}
</script>

<template>
  <div class="login-view">
    <form class="login-card" @submit.prevent="submit">
      <h1>Log in</h1>
      <p class="login-hint">Internal team access. The public map does not require an account.</p>

      <label for="login-username">Username</label>
      <input
        id="login-username"
        v-model="username"
        type="text"
        autocomplete="username"
        autocapitalize="none"
        spellcheck="false"
        required
      />

      <label for="login-password">Password</label>
      <input
        id="login-password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
      />

      <p v-if="error" class="login-error" role="alert">{{ error }}</p>

      <button type="submit" :disabled="submitting || !username || !password">
        {{ submitting ? 'Logging in…' : 'Log in' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-view {
  flex-grow: 1;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 20px 40px;
  background-color: var(--blo-cream);
}

.login-card {
  width: 100%;
  max-width: 360px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  box-shadow: var(--blo-shadow-panel);
  padding: 28px 28px 24px;
  display: flex;
  flex-direction: column;
}

.login-card h1 {
  margin: 0 0 4px;
  font-family: var(--blo-font-display);
  font-size: 1.5rem;
  font-weight: 500;
  color: var(--blo-ink);
}

.login-hint {
  margin: 0 0 20px;
  font-size: 13px;
  color: var(--blo-stone);
}

.login-card label {
  font-size: 12px;
  font-weight: 600;
  color: var(--blo-ink-soft);
  margin-bottom: 4px;
}

.login-card input {
  margin-bottom: 16px;
  padding: 8px 12px;
  font-size: 14px;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  background: var(--blo-cream);
  color: var(--blo-ink);
}

.login-card input:focus {
  outline: 2px solid var(--blo-orange-ring);
  outline-offset: 0;
}

.login-error {
  margin: 0 0 12px;
  font-size: 13px;
  color: #c0392b;
}

.login-card button {
  padding: 9px 16px;
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  background: var(--blo-green-deep);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 120ms ease;
}

.login-card button:hover:not(:disabled) {
  background: var(--blo-green);
}

.login-card button:disabled {
  opacity: 0.6;
  cursor: default;
}

/* P5-60: the form was already close; it needed thumb-sized fields, a button
   the full width of the card, and less empty space above it on a short
   screen. */
@media (max-width: 640px) {
  .login-view {
    padding: 8vh 16px 40px;
  }

  /* The same guard every internal page carries. */
  .login-view {
    min-width: 0;
    max-width: 100%;
  }

  /* `width: 100%` already stops the card exceeding its container, and its
     360 px cap still matters up to 640 px — shrink guard only. */
  .login-card {
    min-width: 0;
  }

  .login-card {
    padding: 22px 18px 20px;
  }

  .login-hint {
    font-size: 14px;
  }

  .login-card label {
    font-size: 13px;
  }

  .login-card input {
    min-height: 44px;
    /* Below 16 px iOS Safari zooms the page when the field takes focus. */
    font-size: 16px;
  }

  .login-card button {
    min-height: 44px;
  }

  .login-error {
    font-size: 14px;
  }
}
</style>
