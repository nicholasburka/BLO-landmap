<script setup lang="ts">
/**
 * Account (phase 5). Identity, your own password (P5-76), and the API tokens
 * an MCP client authenticates with (P5-50): a token is the only way to reach
 * the library read tools from outside the browser session, so minting one
 * lives with the account, not inside the library UI.
 */
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '@/composables/useAuth'
import { changePassword, validatePasswordChange } from '@/lib/account'
import { friendlyError } from '@/lib/errors'
import {
  authorizationContinueUrl,
  createApiToken,
  getPendingAuthorization,
  listApiTokens,
  listOAuthGrants,
  revokeApiToken,
  revokeOAuthGrant,
  validateTokenName,
  type ApiTokenSummary,
  type MintedApiToken,
  type OAuthGrantSummary,
  type PendingAuthorization,
} from '@/lib/apiTokens'

const route = useRoute()
const router = useRouter()
const { internalUser, logoutInternal } = useAuth()
const loggingOut = ref(false)

async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  await logoutInternal()
  router.replace('/')
}

// --- Change password (P5-76) ----------------------------------------------

const currentPassword = ref('')
const nextPassword = ref('')
const confirmPassword = ref('')
const passwordError = ref<string | null>(null)
const passwordNotice = ref<string | null>(null)
const changingPassword = ref(false)

async function submitPasswordChange() {
  if (changingPassword.value) return
  // A previous success must not still be on screen while a new attempt runs.
  passwordNotice.value = null
  const problem = validatePasswordChange(
    currentPassword.value,
    nextPassword.value,
    confirmPassword.value,
  )
  if (problem) {
    passwordError.value = problem
    return
  }
  changingPassword.value = true
  passwordError.value = null
  try {
    const { signedOutOthers } = await changePassword(currentPassword.value, nextPassword.value)
    // Say what actually happened: claiming other sessions were signed out
    // when there were none is the kind of small lie that makes people stop
    // trusting the sentence when it matters.
    passwordNotice.value =
      signedOutOthers > 0
        ? 'Password changed. Other sessions were signed out.'
        : 'Password changed.'
    currentPassword.value = ''
    nextPassword.value = ''
    confirmPassword.value = ''
  } catch (err) {
    // The server's messages are written to be shown as-is.
    passwordError.value = friendlyError(err, 'Failed to change the password.')
  } finally {
    changingPassword.value = false
  }
}

// --- API tokens -----------------------------------------------------------

const tokens = ref<ApiTokenSummary[]>([])
const loadingTokens = ref(false)
const tokenError = ref<string | null>(null)
const newTokenName = ref('')
/** P5-52: this token may also use the MCP write tools. Off by default — a
 *  read-only token is the safer thing to paste into a config file, and asking
 *  for more should be a deliberate tick. */
const allowWrites = ref(false)
const creating = ref(false)
/** Held only long enough to show the secret once; never persisted anywhere. */
const minted = ref<MintedApiToken | null>(null)
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
/** Which row has a revoke in flight — one at a time keeps the list honest. */
const revokingId = ref<number | null>(null)

async function loadTokens() {
  loadingTokens.value = true
  tokenError.value = null
  try {
    tokens.value = await listApiTokens()
  } catch (err) {
    tokenError.value = friendlyError(err, 'Failed to load tokens.')
  } finally {
    // Always clears, so a failure shows the error rather than a stuck spinner.
    loadingTokens.value = false
  }
}

onMounted(() => {
  // Anonymous visitors never see the card, and the endpoint would 401 anyway.
  if (internalUser.value) {
    void loadTokens()
    void loadGrants()
    void loadPending()
  }
})

async function createToken() {
  if (creating.value) return
  const problem = validateTokenName(newTokenName.value)
  if (problem) {
    tokenError.value = problem
    return
  }
  creating.value = true
  tokenError.value = null
  try {
    const created = await createApiToken(newTokenName.value, allowWrites.value)
    minted.value = created
    copyState.value = 'idle'
    // Prepend rather than refetch: the server orders newest first, and the
    // mint response already carries everything a summary row needs.
    tokens.value = [
      {
        id: created.id,
        name: created.name,
        scopes: created.scopes,
        createdAt: created.createdAt,
        lastUsedAt: null,
      },
      ...tokens.value,
    ]
    newTokenName.value = ''
    // Reset the tick too: the next token starts from the safe default rather
    // than inheriting a decision made about a different one.
    allowWrites.value = false
  } catch (err) {
    tokenError.value = friendlyError(err, 'Failed to create token.')
  } finally {
    creating.value = false
  }
}

async function revoke(id: number) {
  if (revokingId.value !== null) return
  revokingId.value = id
  tokenError.value = null
  try {
    await revokeApiToken(id)
    tokens.value = tokens.value.filter(token => token.id !== id)
    // Don't leave a dead secret on screen if it was just revoked.
    if (minted.value?.id === id) minted.value = null
  } catch (err) {
    tokenError.value = friendlyError(err, 'Failed to revoke token.')
  } finally {
    revokingId.value = null
  }
}

// --- OAuth connections (P5-51) --------------------------------------------

const grants = ref<OAuthGrantSummary[]>([])
const loadingGrants = ref(false)
const grantError = ref<string | null>(null)
const revokingGrantId = ref<string | null>(null)

/** The app waiting on approval, when a connector sent the user through login. */
const pending = ref<PendingAuthorization | null>(null)
const pendingId = ref<string | null>(null)

async function loadGrants() {
  loadingGrants.value = true
  grantError.value = null
  try {
    grants.value = await listOAuthGrants()
  } catch (err) {
    grantError.value = friendlyError(err, 'Failed to load connected apps.')
  } finally {
    loadingGrants.value = false
  }
}

/**
 * `?oauth=<id>` is where the API's login detour lands. The id is only ever
 * used to build a URL back to the API, so it is checked against the shape the
 * server issues (base64url) rather than trusted from the address bar.
 */
async function loadPending() {
  const raw = route.query.oauth
  const id = typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null
  if (!id) return
  pendingId.value = id
  try {
    pending.value = await getPendingAuthorization(id)
  } catch {
    // An expired or already-finished request is the ordinary case; the card
    // simply does not appear rather than shouting about it.
    pending.value = null
  }
}

function continueUrl(): string {
  return pendingId.value ? authorizationContinueUrl(pendingId.value) : ''
}

async function disconnect(id: string) {
  if (revokingGrantId.value !== null) return
  revokingGrantId.value = id
  grantError.value = null
  try {
    await revokeOAuthGrant(id)
    grants.value = grants.value.filter(grant => grant.id !== id)
  } catch (err) {
    grantError.value = friendlyError(err, 'Failed to disconnect.')
  } finally {
    revokingGrantId.value = null
  }
}

async function copySecret() {
  if (!minted.value) return
  try {
    // navigator.clipboard is absent in jsdom and in insecure contexts — the
    // secret stays visible for manual selection, so failing is not fatal.
    await navigator.clipboard.writeText(minted.value.token)
    copyState.value = 'copied'
  } catch {
    copyState.value = 'failed'
  }
}

function dismissSecret() {
  minted.value = null
  copyState.value = 'idle'
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString()
}

function lastUsedLabel(token: ApiTokenSummary): string {
  return token.lastUsedAt ? `last used ${formatDate(token.lastUsedAt)}` : 'never used'
}
</script>

<template>
  <div class="account-view">
    <div v-if="internalUser" class="account-stack">
      <div class="account-card">
        <h1>Account</h1>
        <dl>
          <dt>Username</dt>
          <dd>{{ internalUser.username }}</dd>
          <dt>Role</dt>
          <dd>{{ internalUser.role }}</dd>
        </dl>
        <button type="button" :disabled="loggingOut" @click="logout">
          {{ loggingOut ? 'Logging out…' : 'Log out' }}
        </button>
      </div>

      <div v-if="pending" class="account-card consent-card" data-testid="oauth-pending">
        <h2>Finish connecting {{ pending.clientName }}</h2>
        <p class="token-help">
          {{ pending.clientName }} asked to connect to your library. Review what
          it will be allowed to do and approve it on the next screen.
        </p>
        <ul class="consent-scopes">
          <li v-for="label in pending.scopeDescriptions" :key="label">{{ label }}</li>
        </ul>
        <a class="consent-continue" :href="continueUrl()" data-testid="oauth-continue">
          Continue to {{ pending.clientName }} authorization
        </a>
      </div>

      <div class="account-card password-card">
        <h2>Change password</h2>
        <p class="token-help">
          Changing your password signs you out everywhere else — every other
          browser and device. This one stays signed in.
        </p>

        <form class="password-form" data-testid="password-form" @submit.prevent="submitPasswordChange">
          <label for="account-current-password">Current password</label>
          <input
            id="account-current-password"
            v-model="currentPassword"
            type="password"
            class="token-input"
            autocomplete="current-password"
            data-testid="password-current"
          />

          <label for="account-next-password">New password</label>
          <input
            id="account-next-password"
            v-model="nextPassword"
            type="password"
            class="token-input"
            autocomplete="new-password"
            data-testid="password-next"
          />

          <label for="account-confirm-password">Confirm new password</label>
          <input
            id="account-confirm-password"
            v-model="confirmPassword"
            type="password"
            class="token-input"
            autocomplete="new-password"
            data-testid="password-confirm"
          />

          <p v-if="passwordError" class="token-error" role="alert" data-testid="password-error">
            {{ passwordError }}
          </p>
          <p v-if="passwordNotice" class="password-notice" role="status" data-testid="password-success">
            {{ passwordNotice }}
          </p>

          <button type="submit" :disabled="changingPassword" data-testid="password-submit">
            {{ changingPassword ? 'Changing…' : 'Change password' }}
          </button>
        </form>
      </div>

      <div class="account-card token-card">
        <h2>API tokens</h2>
        <p class="token-help">
          A token lets an MCP client read the library on your behalf. Paste this
          into your MCP client — see docs/MCP.md.
        </p>

        <form @submit.prevent="createToken">
          <div class="token-form">
            <input
              v-model="newTokenName"
              type="text"
              class="token-input"
              placeholder="Claude Desktop — laptop"
              aria-label="Token name"
              data-testid="token-name-input"
            />
            <button type="submit" :disabled="creating" data-testid="token-create">
              {{ creating ? 'Creating…' : 'Create token' }}
            </button>
          </div>
          <label class="token-writes">
            <input v-model="allowWrites" type="checkbox" data-testid="token-allow-writes" />
            <span>
              Allow writes
              <span class="token-writes-note">
                The assistant will be able to add notes, append to pages, drop links
                and save views as you. It cannot delete anything, and every write is
                recorded in the activity feed with the name of this token. Leave this
                off unless you want it.
              </span>
            </span>
          </label>
        </form>

        <p v-if="tokenError" class="token-error" data-testid="token-error">{{ tokenError }}</p>

        <div v-if="minted" class="token-secret" data-testid="token-secret">
          <p class="token-secret-label">{{ minted.name }}</p>
          <code class="token-secret-value" data-testid="token-secret-value">{{ minted.token }}</code>
          <p class="token-secret-warning">
            This is the only time this token is shown. Copy it now — it cannot be
            retrieved later.
          </p>
          <div class="token-secret-actions">
            <button type="button" data-testid="token-copy" @click="copySecret">
              {{ copyState === 'copied' ? 'Copied' : 'Copy' }}
            </button>
            <button type="button" data-testid="token-done" @click="dismissSecret">Done</button>
            <span v-if="copyState === 'failed'" class="token-copy-note">
              Copy failed — select the token above.
            </span>
          </div>
        </div>

        <p v-if="loadingTokens" class="token-quiet" data-testid="token-loading">Loading tokens…</p>
        <p v-else-if="!tokens.length" class="token-quiet" data-testid="token-empty">No tokens yet.</p>
        <ul v-else class="token-list">
          <li v-for="token in tokens" :key="token.id" class="token-row" data-testid="token-row">
            <div class="token-row-text">
              <span class="token-row-name" data-testid="token-row-name">{{ token.name }}</span>
              <span class="token-row-meta">
                {{ token.scopes.join(', ') }} · created {{ formatDate(token.createdAt) }} ·
                {{ lastUsedLabel(token) }}
              </span>
            </div>
            <button
              type="button"
              class="token-revoke"
              :disabled="revokingId === token.id"
              data-testid="token-revoke"
              @click="revoke(token.id)"
            >
              {{ revokingId === token.id ? 'Revoking…' : 'Revoke' }}
            </button>
          </li>
        </ul>
      </div>

      <div class="account-card token-card">
        <h2>Connected apps</h2>
        <p class="token-help">
          Apps you have authorized to reach the library on your behalf — a
          ChatGPT or Claude connector, for instance. Disconnecting one stops it
          on its next request.
        </p>

        <p v-if="grantError" class="token-error" data-testid="grant-error">{{ grantError }}</p>

        <p v-if="loadingGrants" class="token-quiet" data-testid="grant-loading">Loading connected apps…</p>
        <p v-else-if="!grants.length" class="token-quiet" data-testid="grant-empty">
          No apps are connected.
        </p>
        <ul v-else class="token-list">
          <li v-for="grant in grants" :key="grant.id" class="token-row" data-testid="grant-row">
            <div class="token-row-text">
              <span class="token-row-name" data-testid="grant-row-name">{{ grant.clientName }}</span>
              <span class="token-row-meta">
                {{ grant.scopes.join(', ') }} · connected {{ formatDate(grant.createdAt) }} ·
                {{ grant.lastUsedAt ? `last used ${formatDate(grant.lastUsedAt)}` : 'never used' }}
              </span>
            </div>
            <button
              type="button"
              class="token-revoke"
              :disabled="revokingGrantId === grant.id"
              data-testid="grant-revoke"
              @click="disconnect(grant.id)"
            >
              {{ revokingGrantId === grant.id ? 'Disconnecting…' : 'Disconnect' }}
            </button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.account-view {
  flex-grow: 1;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 20px 40px;
  background-color: var(--blo-cream);
}

.account-stack {
  width: 100%;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.account-card {
  width: 100%;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  box-shadow: var(--blo-shadow-panel);
  padding: 28px;
}

.account-card h1 {
  margin: 0 0 16px;
  font-family: var(--blo-font-display);
  font-size: 1.5rem;
  font-weight: 500;
  color: var(--blo-ink);
}

.account-card h2 {
  margin: 0 0 8px;
  font-family: var(--blo-font-display);
  font-size: 1.15rem;
  font-weight: 500;
  color: var(--blo-ink);
}

.account-card dl {
  margin: 0 0 20px;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 16px;
  font-size: 14px;
}

.account-card dt {
  font-weight: 600;
  color: var(--blo-stone);
}

.account-card dd {
  margin: 0;
  color: var(--blo-ink);
}

.account-card button {
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-ink);
  background: transparent;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 120ms ease;
}

.account-card button:hover:not(:disabled) {
  background: rgba(17, 17, 17, 0.04);
}

.account-card button:disabled {
  opacity: 0.6;
  cursor: default;
}

.token-help {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--blo-stone);
}

.token-form {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.token-writes {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-bottom: 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--blo-ink);
  cursor: pointer;
}

.token-writes input {
  margin-top: 3px;
  flex: none;
}

.token-writes-note {
  display: block;
  color: var(--blo-stone);
}

.token-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 8px 12px;
  font-size: 14px;
  color: var(--blo-ink);
  background: var(--blo-cream);
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

.token-error {
  margin: 0 0 12px;
  font-size: 13px;
  color: #a8322b;
}

/* --- Change password (P5-76) ----------------------------------------------
   One field per line, the same shape as the login form it mirrors. */
.password-form {
  display: flex;
  flex-direction: column;
}

.password-form label {
  font-size: 12px;
  font-weight: 600;
  color: var(--blo-ink-soft);
  margin-bottom: 4px;
}

/* The shared field look, but not the token form's row growth. */
.password-form .token-input {
  flex: none;
  margin-bottom: 16px;
}

.password-form button {
  align-self: flex-start;
}

.password-notice {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--blo-green-deep);
}

.token-secret {
  margin: 0 0 16px;
  padding: 14px;
  background: var(--blo-cream);
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.token-secret-label {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--blo-stone);
}

.token-secret-value {
  display: block;
  font-size: 13px;
  word-break: break-all;
  color: var(--blo-ink);
}

.token-secret-warning {
  margin: 10px 0 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--blo-stone);
}

.token-secret-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.token-copy-note {
  font-size: 12px;
  color: var(--blo-stone);
}

.token-quiet {
  margin: 0;
  font-size: 13px;
  color: var(--blo-stone-soft);
}

.token-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.token-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--blo-cream-divider);
}

.token-row:first-child {
  border-top: none;
}

.token-row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.token-row-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-ink);
}

.token-row-meta {
  font-size: 12px;
  color: var(--blo-stone);
}

.token-revoke {
  flex: 0 0 auto;
}

/* The pending-authorization card leads the page: someone arriving here from a
   connector has exactly one thing to do, and it should not look like a note. */
.consent-card {
  border-color: var(--blo-green-deep);
}

.consent-scopes {
  margin: 0 0 16px;
  padding-left: 20px;
  font-size: 13px;
  color: var(--blo-ink);
}

.consent-scopes li {
  margin-bottom: 4px;
}

.consent-continue {
  display: inline-block;
  padding: 9px 16px;
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  background: var(--blo-green-deep);
  border-radius: 6px;
  text-decoration: none;
}

.consent-continue:hover {
  background: var(--blo-green);
}

/* --- P5-60 (mobile pass) --------------------------------------------------
   12vh of empty cream above the card is a desktop luxury; on a phone it puts
   the one thing you came for below the fold. Token and grant rows stack so
   the name, its meta and the Revoke button each get a full line. */
@media (max-width: 640px) {
  .account-view {
    padding: 20px 12px 40px;
  }

  /* The same guard every internal page carries; token and app names are
     user-supplied, so their content must not be able to widen the page. */
  .account-view,
  .account-card,
  .token-row-text {
    min-width: 0;
    max-width: 100%;
  }

  /* `width: 100%` already stops this exceeding its container, and its 520 px
     cap still matters between 520 and 640 px — so it takes the shrink guard
     only. */
  .account-stack {
    min-width: 0;
  }

  .account-card {
    padding: 18px 16px;
  }

  .account-card h1 {
    font-size: clamp(20px, 6.5vw, 1.5rem);
  }

  .account-card dl {
    font-size: 15px;
  }

  .account-card button {
    min-height: 44px;
  }

  .token-form {
    flex-direction: column;
    align-items: stretch;
  }

  .token-form button {
    width: 100%;
  }

  .password-form button {
    width: 100%;
    align-self: stretch;
  }

  .token-input {
    min-height: 44px;
    /* Below 16 px iOS Safari zooms the page when the field takes focus. */
    font-size: 16px;
  }

  .token-writes {
    font-size: 14px;
  }

  .token-writes input {
    width: 20px;
    height: 20px;
    margin-top: 2px;
  }

  .token-row {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  /* Token names and scope lists are user-supplied and can be long; nothing
     here may push the page sideways. */
  .token-row-name,
  .token-row-meta {
    overflow-wrap: anywhere;
  }

  .token-revoke {
    width: 100%;
  }

  .token-help,
  .token-quiet,
  .token-error,
  .password-notice,
  .token-row-meta,
  .token-copy-note,
  .token-secret-warning,
  .consent-scopes {
    font-size: 14px;
  }

  .token-secret-actions {
    flex-wrap: wrap;
  }

  .token-secret-actions button {
    flex: 1 1 120px;
  }

  .consent-continue {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
  }
}
</style>
