import express, { Router } from 'express'
import type { Request, Response } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { oauthAuthorizeRateLimit, oauthRegisterRateLimit, oauthTokenRateLimit } from '../middleware/rateLimit.js'
import { isAllowedOrigin } from '../middleware/origins.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { SESSION_COOKIE, getSessionUser, type InternalUser } from '../services/internalSessions.js'
import {
  GRANT_TYPES,
  MAX_REDIRECT_URIS,
  OAUTH_SCOPES,
  REFRESH_TOKEN_PREFIX,
  SCOPE_DESCRIPTIONS,
  claimAuthorizationCode,
  claimRefreshToken,
  clientAllowsRedirect,
  consentCsrfMatches,
  consentCsrfToken,
  createAuthorizationCode,
  createPendingAuthorize,
  deletePendingAuthorize,
  findAuthorizationCode,
  findToken,
  getClient,
  getPendingAuthorize,
  isFamilyRevoked,
  issueTokenPair,
  listGrants,
  mcpResource,
  oauthIssuer,
  parseScopes,
  registerClient,
  resourceMatches,
  revokeFamily,
  revokeGrant,
  revokeTokenById,
  validateClientName,
  validateCodeChallenge,
  validateRedirectUri,
  verifyCodeVerifier,
  type OAuthClient,
  type OAuthScope,
  type PendingAuthorize,
} from '../services/oauthStore.js'

/**
 * OAuth 2.1 authorization server (P5-51) — what lets ChatGPT's custom
 * connectors and Claude's remote connectors reach /mcp. Both refuse to carry
 * a personal token; both will discover this server from the 401 on /mcp,
 * register themselves, and walk an authorization-code + PKCE flow.
 *
 * Implements: RFC 9728 (protected-resource metadata), RFC 8414 (authorization
 * server metadata), RFC 7591 (dynamic client registration), RFC 7636 (PKCE,
 * S256 only), RFC 8707 (resource indicators), RFC 7009 (revocation), and the
 * MCP authorization spec (2025-06-18).
 *
 * Two decisions shape everything below:
 *
 *  - **The consent screen is server-rendered here, not in the SPA.** The SPA
 *    lives on another origin and holds no session the API can trust for an
 *    approval; a same-origin page under the strict helmet CSP (no inline
 *    script, exactly like /dashboard) is the smallest trustworthy surface for
 *    "do you approve this app?".
 *
 *  - **The login detour never carries a URL.** The SPA's login page returns
 *    only to a path on its own origin, so an authorize request that arrives
 *    logged-out is parked server-side and the browser is sent to
 *    `/account?oauth=<opaque id>`. There is therefore no attacker-supplied
 *    URL anywhere in the login round trip — no open redirect to build.
 *
 * Failure handling follows RFC 6749 §4.1.2.1: anything wrong with the CLIENT
 * or the REDIRECT URI renders an error page, because redirecting on those is
 * how a bad redirect_uri becomes an open redirect. Everything else redirects
 * with `error=` and the client's `state`.
 */

const router = Router()

/** Form bodies for the OAuth endpoints. Mounted per-route rather than
 *  app-wide: nothing else on this API accepts form encoding, and the parser
 *  should not become a new surface for the rest of the routes. */
const form = express.urlencoded({ extended: false, limit: '16kb' })

/** Bounds on echoed/stored client input. `state` is opaque to us and comes
 *  straight back in a redirect, so it is length-capped rather than parsed. */
const STATE_MAX = 512
const CODE_MAX = 512

// --- small helpers ----------------------------------------------------------

/**
 * Read one query/body parameter. `null` means "present but not a single
 * string" — a repeated parameter (`?scope=read&scope=write`), which is a
 * parameter-pollution attempt, not a client we should try to understand.
 */
function param(source: unknown, name: string): string | undefined | null {
  if (!source || typeof source !== 'object') return undefined
  const raw = (source as Record<string, unknown>)[name]
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return null
  return raw
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape every value interpolated into the server-rendered pages. Client
 *  names and scope labels are attacker-controlled at registration time. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ESCAPES[ch] ?? ch)
}

const PAGE_CSS = `
  :root { color-scheme: light }
  body { margin: 0; padding: 40px 20px; background: #f6f3ec; color: #1b1b1b;
         font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 460px; margin: 0 auto; background: #fff; border: 1px solid #e2dcd0;
         border-radius: 10px; padding: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  h1 { margin: 0 0 12px; font-size: 1.35rem; font-weight: 600; }
  p { margin: 0 0 14px; }
  .muted { color: #6b6459; font-size: 13px; }
  ul { margin: 0 0 18px; padding-left: 20px; }
  li { margin-bottom: 6px; }
  .actions { display: flex; gap: 10px; margin-top: 20px; }
  button { padding: 9px 18px; font-size: 14px; font-weight: 600; border-radius: 6px; cursor: pointer; }
  .allow { color: #fff; background: #2f5d3a; border: 1px solid #2f5d3a; }
  .deny { color: #1b1b1b; background: transparent; border: 1px solid #d8d1c4; }
  code { word-break: break-all; font-size: 13px; }
  .host { margin: 4px 0 14px; font-size: 1.05rem; font-weight: 600; }
  .host code { word-break: break-all; font-size: 1.05rem; }
  /* The band exists to slow a person down: every client here registered
     itself, so "this looks official" is never evidence of anything. */
  .warning { margin: 18px 0 0; padding: 12px 14px; border: 1px solid #d9b25f;
             border-left-width: 4px; border-radius: 6px; background: #fdf6e3; font-size: 13px; }
  .warning strong { display: block; margin-bottom: 4px; }
`

/**
 * Every page this router renders. No script at all — not inline, not linked —
 * so it satisfies the strict helmet CSP and there is nothing on the consent
 * screen that could be made to act on the user's behalf.
 *
 * `formAction` widens form-action to the client's registered redirect origin.
 * The POST target is same-origin, but its 302 lands on the client; browsers
 * disagree about whether form-action is re-checked across a redirect, and a
 * blocked redirect would silently break the flow. The origin comes from an
 * already-exact-matched registered URI, so nothing attacker-chosen is added.
 */
/**
 * A bare scheme + host [+ port]. `form-action` is a CSP directive VALUE, and a
 * ';' — which is legal in a URL host — would start a whole new directive
 * inside the header. The origin comes from an exact-matched registered URI,
 * but a header is not a place to trust a parser: anything that is not plainly
 * an origin is dropped, costing that one client a widened form-action rather
 * than letting it write CSP.
 */
const BARE_ORIGIN = /^https?:\/\/[A-Za-z0-9.\-:[\]]+$/

function renderPage(res: Response, status: number, title: string, body: string, formAction?: string): void {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    // A consent screen must never be framable: an invisible iframe over a
    // decoy page is exactly how an Allow button gets clicked by accident.
    "frame-ancestors 'none'",
    `form-action 'self'${formAction ? ` ${formAction}` : ''}`,
  ].join('; ')
  res
    .status(status)
    .type('html')
    .set('Content-Security-Policy', csp)
    .set('X-Frame-Options', 'DENY')
    .set('Referrer-Policy', 'no-referrer')
    .set('Cache-Control', 'no-store')
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body><main>${body}</main></body>
</html>`)
}

/** The page shown for anything that must NOT be redirected — a bad client, a
 *  bad redirect_uri, an expired request. Deliberately unspecific about which. */
function errorPage(res: Response, status: number, message: string): void {
  renderPage(
    res,
    status,
    'Authorization error',
    `<h1>Authorization error</h1><p>${escapeHtml(message)}</p>
     <p class="muted">Nothing was approved. Start the connection again from the app that sent you here.</p>`,
  )
}

/** JSON error in the RFC 6749 §5.2 shape. Descriptions stay generic: a token
 *  endpoint that explains exactly which check failed is an oracle. */
function oauthError(res: Response, status: number, error: string, description?: string): void {
  res.status(status).set('Cache-Control', 'no-store').json({
    error,
    ...(description ? { error_description: description } : {}),
  })
}

/**
 * Redirect back to the client with an error, per RFC 6749 §4.1.2.1. Only ever
 * called with a redirect_uri that exactly matched a registered one.
 *
 * `iss` is RFC 9207: a client that talks to more than one authorization
 * server can only tell whose answer this is if the answer says so, and a
 * mix-up attack works by feeding one server's response to another.
 */
function redirectError(
  res: Response,
  redirectUri: string,
  error: string,
  state: string | null,
  issuer: string,
): void {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  if (state) url.searchParams.set('state', state)
  url.searchParams.set('iss', issuer)
  res.set('Cache-Control', 'no-store').redirect(302, url.href)
}

/** The host of a redirect URI — the part of it that says where a code
 *  actually goes, and the only part worth putting in front of a human or
 *  into an audit row. */
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host
  } catch {
    return ''
  }
}

/**
 * "registered 2 minutes ago". A timestamp tells a person nothing at the
 * moment they are deciding; an age tells them whether this is the app they
 * just set up or one that has been sitting there since March.
 */
export function registrationAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'at an unknown time'
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  const plural = (value: number, unit: string) => `${value} ${unit}${value === 1 ? '' : 's'} ago`
  if (seconds < 60) return plural(seconds, 'second')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return plural(hours, 'hour')
  return plural(Math.floor(hours / 24), 'day')
}

interface Configured {
  issuer: string
  resource: string
}

/** OAuth needs both a configured public issuer and the library store. Without
 *  either, the endpoints say so rather than half-working. */
function configured(res: Response, html = false): Configured | null {
  const issuer = oauthIssuer()
  if (!issuer || !isLibraryEnabled()) {
    if (html) errorPage(res, 503, 'This server is not set up for app connections.')
    else oauthError(res, 503, 'temporarily_unavailable', 'OAuth is not configured on this server')
    return null
  }
  return { issuer, resource: mcpResource(issuer) }
}

/** The SPA's origin — where a human logs in. Origin only, so a misconfigured
 *  value with a path or query cannot bend the login URL. */
function siteOrigin(): string | null {
  const raw = (process.env.PUBLIC_SITE_URL || '').trim()
  if (!raw) return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

// --- metadata (RFC 9728 / RFC 8414) ----------------------------------------

/** Metadata is public and stable; an hour of caching saves a round trip on
 *  every connector handshake and leaks nothing (it holds no user data). */
const METADATA_CACHE = 'public, max-age=3600'

function protectedResourceMetadata(_req: Request, res: Response): void {
  const cfg = configured(res)
  if (!cfg) return
  res.set('Cache-Control', METADATA_CACHE).json({
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
  })
}

// RFC 9728 inserts the resource's path after the well-known segment, which is
// the form MCP clients request; the bare path is served too for clients that
// only know the simpler shape.
router.get('/.well-known/oauth-protected-resource', protectedResourceMetadata)
router.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata)

router.get('/.well-known/oauth-authorization-server', (_req, res) => {
  const cfg = configured(res)
  if (!cfg) return
  res.set('Cache-Control', METADATA_CACHE).json({
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
    token_endpoint: `${cfg.issuer}/oauth/token`,
    registration_endpoint: `${cfg.issuer}/oauth/register`,
    revocation_endpoint: `${cfg.issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: [...GRANT_TYPES],
    code_challenge_methods_supported: ['S256'],
    // Every client here is public: there is no secret to authenticate with,
    // which is why PKCE is mandatory rather than an option.
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...OAUTH_SCOPES],
  })
})

// --- dynamic client registration (RFC 7591) --------------------------------

router.post('/oauth/register', oauthRegisterRateLimit, async (req, res, next) => {
  const cfg = configured(res)
  if (!cfg) return
  try {
    const body = (req.body ?? {}) as Record<string, unknown>

    const name = validateClientName(body.client_name)
    if ('error' in name) {
      oauthError(res, 400, 'invalid_client_metadata', name.error)
      return
    }

    const rawUris = body.redirect_uris
    if (!Array.isArray(rawUris) || rawUris.length === 0) {
      oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris is required')
      return
    }
    if (rawUris.length > MAX_REDIRECT_URIS) {
      oauthError(res, 400, 'invalid_redirect_uri', `at most ${MAX_REDIRECT_URIS} redirect_uris`)
      return
    }
    const redirectUris: string[] = []
    for (const raw of rawUris) {
      const checked = validateRedirectUri(raw)
      if ('error' in checked) {
        oauthError(res, 400, 'invalid_redirect_uri', checked.error)
        return
      }
      if (!redirectUris.includes(checked.uri)) redirectUris.push(checked.uri)
    }

    // Public clients only. A client that asks to authenticate with a secret is
    // asking for something this server will never store, so it is refused
    // rather than silently downgraded.
    const authMethod = body.token_endpoint_auth_method
    if (authMethod !== undefined && authMethod !== 'none') {
      oauthError(res, 400, 'invalid_client_metadata', 'only token_endpoint_auth_method "none" is supported')
      return
    }

    const rawGrants = body.grant_types
    let grantTypes: string[] = [...GRANT_TYPES]
    if (rawGrants !== undefined) {
      if (!Array.isArray(rawGrants) || rawGrants.some(g => typeof g !== 'string')) {
        oauthError(res, 400, 'invalid_client_metadata', 'grant_types must be an array of strings')
        return
      }
      const unsupported = (rawGrants as string[]).filter(g => !(GRANT_TYPES as readonly string[]).includes(g))
      if (unsupported.length) {
        oauthError(res, 400, 'invalid_client_metadata', 'unsupported grant_types')
        return
      }
      grantTypes = rawGrants as string[]
    }

    const responseTypes = body.response_types
    if (responseTypes !== undefined) {
      if (!Array.isArray(responseTypes) || responseTypes.some(t => t !== 'code')) {
        oauthError(res, 400, 'invalid_client_metadata', 'only the "code" response type is supported')
        return
      }
    }

    // A client that names no scope is asking for the minimum, not for
    // everything: `write` is granted only when it is requested out loud.
    const scopes = parseScopes(body.scope, ['read'])
    if ('error' in scopes) {
      oauthError(res, 400, 'invalid_client_metadata', 'unsupported scope')
      return
    }

    const client = await registerClient({
      clientName: name.name,
      redirectUris,
      grantTypes,
      scopes: scopes.scopes,
    })

    // Registration is unauthenticated by design (that is the point of RFC
    // 7591), so it is audited: the row is how an operator later sees who has
    // been registering connectors.
    void writeAudit({
      actor: 'oauth',
      action: 'oauth.register',
      target: client.clientId,
      // A count and the first host, not the URIs themselves: a redirect URI is
      // attacker-supplied and can carry a query string, and the audit log is
      // read by humans and shipped to log sinks. The host is what an operator
      // actually judges a registration by.
      detail: {
        client: client.clientName,
        redirectUris: client.redirectUris.length,
        redirectHost: redirectHost(client.redirectUris[0] ?? ''),
      },
    })

    res.status(201).set('Cache-Control', 'no-store').json({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: client.scopes.join(' '),
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
    })
  } catch (err) {
    next(err)
  }
})

// --- authorize --------------------------------------------------------------

/** Resolve the session cookie without the API's CSRF header requirement —
 *  these are browser navigations and form posts, not XHR. */
async function sessionFrom(req: Request): Promise<{ user: InternalUser; token: string } | null> {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE]
  if (typeof token !== 'string' || !token) return null
  const user = await getSessionUser(token)
  return user ? { user, token } : null
}

router.get('/oauth/authorize', oauthAuthorizeRateLimit, async (req, res, next) => {
  const cfg = configured(res, true)
  if (!cfg) return
  try {
    // Order matters. Client and redirect_uri are checked FIRST and failures
    // render a page: redirecting to an unverified redirect_uri would turn this
    // endpoint into an open redirect, which is the classic way an
    // authorization server becomes a phishing tool.
    const clientId = param(req.query, 'client_id')
    const redirectUri = param(req.query, 'redirect_uri')
    if (!clientId || !redirectUri) {
      errorPage(res, 400, 'That authorization request is missing its client or redirect address.')
      return
    }
    const client = await getClient(clientId)
    if (!client || !clientAllowsRedirect(client, redirectUri)) {
      errorPage(res, 400, 'That application is not registered, or asked to return to an address it never registered.')
      return
    }

    // From here the redirect_uri is trusted, so errors go back to the client.
    const stateRaw = param(req.query, 'state')
    if (stateRaw === null || (stateRaw !== undefined && stateRaw.length > STATE_MAX)) {
      redirectError(res, redirectUri, 'invalid_request', null, cfg.issuer)
      return
    }
    const state = stateRaw ?? null

    if (param(req.query, 'response_type') !== 'code') {
      redirectError(res, redirectUri, 'unsupported_response_type', state, cfg.issuer)
      return
    }
    if (!client.grantTypes.includes('authorization_code')) {
      redirectError(res, redirectUri, 'unauthorized_client', state, cfg.issuer)
      return
    }

    const method = param(req.query, 'code_challenge_method')
    // `null` from param() is a REPEATED parameter. It must stay distinct from
    // "absent" all the way down: collapsing the two with `?? undefined` would
    // let `?scope=read&scope=write` slip past as the default scope.
    const challenge =
      method === null
        ? { error: 'repeated parameter' }
        : validateCodeChallenge(param(req.query, 'code_challenge'), method)
    if ('error' in challenge) {
      // PKCE is not optional: without it a stolen code is a usable code.
      redirectError(res, redirectUri, 'invalid_request', state, cfg.issuer)
      return
    }

    const scopeRaw = param(req.query, 'scope')
    if (scopeRaw === null) {
      redirectError(res, redirectUri, 'invalid_request', state, cfg.issuer)
      return
    }
    const scopes = parseScopes(scopeRaw, ['read'])
    // Supported by this server AND registered by this client: a connector that
    // registered read-only cannot talk its way up to write at authorize time.
    if ('error' in scopes || scopes.scopes.some(s => !client.scopes.includes(s))) {
      redirectError(res, redirectUri, 'invalid_scope', state, cfg.issuer)
      return
    }

    // RFC 8707: a token must be minted for one resource. A client asking for
    // some other audience is refused rather than quietly given ours.
    const resourceRaw = param(req.query, 'resource')
    if (resourceRaw === null || (resourceRaw !== undefined && !resourceMatches(resourceRaw, cfg.resource))) {
      redirectError(res, redirectUri, 'invalid_target', state, cfg.issuer)
      return
    }

    const pending: PendingAuthorize = {
      clientId: client.clientId,
      redirectUri,
      scopes: scopes.scopes,
      state,
      codeChallenge: challenge.challenge,
      resource: cfg.resource,
    }
    const pendingId = await createPendingAuthorize(pending)

    const session = await sessionFrom(req)
    if (!session) {
      const site = siteOrigin()
      if (!site) {
        errorPage(res, 503, 'This server is not set up to sign people in for app connections.')
        return
      }
      // The only thing that crosses to the login page is an opaque id, and the
      // return path is a fixed literal on the SPA's own origin — there is no
      // caller-supplied URL in this redirect to abuse.
      const target = `${site}/login?redirect=${encodeURIComponent(`/account?oauth=${pendingId}`)}`
      res.set('Cache-Control', 'no-store').redirect(302, target)
      return
    }

    renderConsent(res, client, pending, pendingId, session)
  } catch (err) {
    next(err)
  }
})

/** After logging in, the account page links back here. Re-validates from
 *  scratch: the pending row is data, not a decision already made. */
router.get('/oauth/authorize/continue/:id', oauthAuthorizeRateLimit, async (req, res, next) => {
  const cfg = configured(res, true)
  if (!cfg) return
  try {
    // Coerced rather than trusted: a path parameter is a string here, but the
    // value is only ever compared, hashed, or escaped into a page — never
    // interpolated into SQL or a URL without encodeURIComponent.
    const pendingId = String(req.params.id ?? '')
    const pending = await getPendingAuthorize(pendingId)
    if (!pending) {
      errorPage(res, 400, 'That authorization request has expired.')
      return
    }
    const client = await getClient(pending.clientId)
    if (!client || !clientAllowsRedirect(client, pending.redirectUri) || !resourceMatches(pending.resource, cfg.resource)) {
      errorPage(res, 400, 'That application is no longer registered for this request.')
      return
    }
    const session = await sessionFrom(req)
    if (!session) {
      const site = siteOrigin()
      if (!site) {
        errorPage(res, 503, 'This server is not set up to sign people in for app connections.')
        return
      }
      res
        .set('Cache-Control', 'no-store')
        .redirect(302, `${site}/login?redirect=${encodeURIComponent(`/account?oauth=${pendingId}`)}`)
      return
    }
    renderConsent(res, client, pending, pendingId, session)
  } catch (err) {
    next(err)
  }
})

/**
 * The consent screen. Everything on it exists because of one fact: EVERY
 * client here registered itself, unauthenticated, seconds ago (RFC 7591), so
 * the page must give a human enough to judge it —
 *  - which account is about to be handed over (a shared machine, or a second
 *    login, is otherwise invisible);
 *  - the redirect HOST, on its own line, because the host is the only part of
 *    a redirect that says where the code actually goes, and a long path
 *    pushes it out of sight;
 *  - that nobody has vetted this app, and when it appeared. "Registered 2
 *    minutes ago" is what makes "I just set this up" checkable.
 */
function renderConsent(
  res: Response,
  client: OAuthClient,
  pending: PendingAuthorize,
  pendingId: string,
  session: { user: InternalUser; token: string },
): void {
  const scopeItems = pending.scopes
    .map(scope => `<li>${escapeHtml(SCOPE_DESCRIPTIONS[scope] ?? scope)}</li>`)
    .join('')
  const csrf = consentCsrfToken(session.token, pendingId)
  const host = redirectHost(pending.redirectUri)
  const body = `
    <h1>${escapeHtml(client.clientName)} wants access</h1>
    <p class="muted">You are signed in as <strong>${escapeHtml(session.user.username)}</strong>.</p>
    <p>It is asking to connect to your Black Land Ownership library account and:</p>
    <ul>${scopeItems}</ul>
    <p class="muted">It will send you back to</p>
    <p class="host"><code>${escapeHtml(host)}</code></p>
    <p class="muted">Full address: <code>${escapeHtml(pending.redirectUri)}</code>.
      You can disconnect it at any time from your account page.</p>
    <div class="warning">
      <strong>This application registered itself.</strong>
      It was registered ${escapeHtml(registrationAge(client.createdAt))} and has not been reviewed by the
      Black Land Ownership team — the name above is its own claim.
      Only continue if you set this connection up yourself just now.
    </div>
    <form method="post" action="/oauth/authorize/decision">
      <input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}" />
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
      <div class="actions">
        <button class="allow" type="submit" name="decision" value="allow">Allow</button>
        <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      </div>
    </form>`
  let formAction: string | undefined
  try {
    const origin = new URL(pending.redirectUri).origin
    formAction = BARE_ORIGIN.test(origin) ? origin : undefined
  } catch {
    formAction = undefined
  }
  renderPage(res, 200, `Authorize ${client.clientName}`, body, formAction)
}

router.post('/oauth/authorize/decision', oauthAuthorizeRateLimit, form, async (req, res, next) => {
  const cfg = configured(res, true)
  if (!cfg) return
  try {
    // Backstop to the CSRF token below, mirroring POST /api/login: a
    // present-but-foreign Origin is refused outright. Absent is allowed
    // because some browsers still omit Origin on a same-origin form post, and
    // the derived CSRF token — which a cross-site page cannot read — is the
    // control this endpoint actually relies on.
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.length > 0 && !isAllowedOrigin(origin, req)) {
      errorPage(res, 403, 'That approval could not be verified. Start the connection again.')
      return
    }

    const pendingId = param(req.body, 'pending_id')
    if (!pendingId) {
      errorPage(res, 400, 'That approval was incomplete.')
      return
    }
    const session = await sessionFrom(req)
    if (!session) {
      errorPage(res, 401, 'Your session has expired. Sign in and start the connection again.')
      return
    }
    // CSRF: the token is derived from this session AND this request id, so a
    // cross-site page cannot forge an approval and a token lifted from one
    // consent screen cannot approve a different app.
    if (!consentCsrfMatches(session.token, pendingId, param(req.body, 'csrf'))) {
      errorPage(res, 403, 'That approval could not be verified. Start the connection again.')
      return
    }

    const pending = await getPendingAuthorize(pendingId)
    if (!pending) {
      errorPage(res, 400, 'That authorization request has expired.')
      return
    }
    const client = await getClient(pending.clientId)
    if (!client || !clientAllowsRedirect(client, pending.redirectUri) || !resourceMatches(pending.resource, cfg.resource)) {
      errorPage(res, 400, 'That application is no longer registered for this request.')
      return
    }

    // One approval, one outcome: consumed before either branch, so a resubmit
    // (back button, double click) cannot mint a second code.
    await deletePendingAuthorize(pendingId)

    if (param(req.body, 'decision') !== 'allow') {
      void writeAudit({
        userId: session.user.id,
        actor: session.user.username,
        action: 'oauth.deny',
        target: client.clientId,
        detail: { client: client.clientName },
      })
      redirectError(res, pending.redirectUri, 'access_denied', pending.state, cfg.issuer)
      return
    }

    const code = await createAuthorizationCode({
      clientId: client.clientId,
      userId: session.user.id,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
    })
    void writeAudit({
      userId: session.user.id,
      actor: session.user.username,
      action: 'oauth.grant',
      target: client.clientId,
      // The client and what it may do — never the code, the token, or a hash.
      detail: { client: client.clientName, scopes: pending.scopes },
    })

    const url = new URL(pending.redirectUri)
    url.searchParams.set('code', code)
    if (pending.state) url.searchParams.set('state', pending.state)
    // RFC 9207, same reason as on the error path.
    url.searchParams.set('iss', cfg.issuer)
    res.set('Cache-Control', 'no-store').redirect(302, url.href)
  } catch (err) {
    next(err)
  }
})

// --- token ------------------------------------------------------------------

function tokenResponse(
  res: Response,
  issued: { accessToken: string; refreshToken: string; expiresIn: number; scopes: OAuthScope[] },
): void {
  res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache').json({
    access_token: issued.accessToken,
    token_type: 'Bearer',
    expires_in: issued.expiresIn,
    refresh_token: issued.refreshToken,
    scope: issued.scopes.join(' '),
  })
}

router.post('/oauth/token', oauthTokenRateLimit, form, async (req, res, next) => {
  const cfg = configured(res)
  if (!cfg) return
  try {
    const grantType = param(req.body, 'grant_type')
    const clientId = param(req.body, 'client_id')
    if (!clientId) {
      oauthError(res, 401, 'invalid_client')
      return
    }
    const client = await getClient(clientId)
    if (!client) {
      oauthError(res, 401, 'invalid_client')
      return
    }

    if (grantType === 'authorization_code') {
      await handleAuthorizationCodeGrant(req, res, client, cfg.resource)
      return
    }
    if (grantType === 'refresh_token') {
      await handleRefreshGrant(req, res, client, cfg.resource)
      return
    }
    oauthError(res, 400, 'unsupported_grant_type')
  } catch (err) {
    next(err)
  }
})

async function handleAuthorizationCodeGrant(
  req: Request,
  res: Response,
  client: OAuthClient,
  resource: string,
): Promise<void> {
  if (!client.grantTypes.includes('authorization_code')) {
    oauthError(res, 400, 'unauthorized_client')
    return
  }
  const code = param(req.body, 'code')
  const redirectUri = param(req.body, 'redirect_uri')
  const verifier = param(req.body, 'code_verifier')
  if (!code || code.length > CODE_MAX || !redirectUri || !verifier) {
    oauthError(res, 400, 'invalid_request')
    return
  }

  const record = await findAuthorizationCode(code)
  // Unknown, wrong client, wrong redirect: all one answer. Telling them apart
  // would let a thief with a code learn which client and address it belongs to.
  if (!record || record.clientId !== client.clientId || record.redirectUri !== redirectUri) {
    oauthError(res, 400, 'invalid_grant')
    return
  }

  // Expiry and PKCE are checked BEFORE the replay branch, and the order is the
  // security property. A spent code row is kept for the retention window, so
  // running the replay branch first would let anyone holding a stale code —
  // and no verifier — revoke the honest client's live tokens for a week. Only
  // a caller who proves it holds the verifier gets to trigger that.
  if (Date.parse(record.expiresAt) <= Date.now()) {
    oauthError(res, 400, 'invalid_grant')
    return
  }
  if (!verifyCodeVerifier(verifier, record.codeChallenge)) {
    oauthError(res, 400, 'invalid_grant')
    return
  }

  if (record.usedAt) {
    // Replay by someone who DOES hold the verifier. The first exchange's
    // tokens are now suspect — either this caller stole the code and the
    // verifier, or the legitimate client's copy leaked. Both readings end the
    // same way: kill everything that code produced.
    if (record.familyId) await revokeFamily(record.familyId)
    void writeAudit({
      userId: record.userId,
      actor: 'oauth',
      action: 'oauth.reuse',
      target: client.clientId,
      detail: { client: client.clientName, kind: 'authorization_code' },
    })
    oauthError(res, 400, 'invalid_grant')
    return
  }

  const requestedResource = param(req.body, 'resource')
  if (requestedResource === null || (requestedResource !== undefined && !resourceMatches(requestedResource, record.resource))) {
    oauthError(res, 400, 'invalid_target')
    return
  }
  if (!resourceMatches(record.resource, resource)) {
    oauthError(res, 400, 'invalid_target')
    return
  }

  // Atomic claim: two requests racing on one code cannot both be served.
  if (!(await claimAuthorizationCode(record.id))) {
    oauthError(res, 400, 'invalid_grant')
    return
  }

  const issued = await issueTokenPair({
    userId: record.userId,
    clientId: client.clientId,
    scopes: record.scopes,
    resource: record.resource,
    fromCodeId: record.id,
  })
  // The claim and the issue are two statements, not one transaction. A racing
  // replay of this code reads the family id from the code row — which
  // issueTokenPair stamps only AFTER both tokens exist — so if it revoked the
  // family, it revoked these rows, and this check sees it. Handing back a pair
  // that a reuse detection has already killed would undo the revocation.
  if (await cancelIfFamilyRevoked(issued.familyId)) {
    oauthError(res, 400, 'invalid_grant')
    return
  }
  tokenResponse(res, issued)
}

/**
 * Did something revoke this family while the pair was being issued? If so the
 * new pair is revoked too and the caller gets invalid_grant: a revocation that
 * lands mid-issue must not leave a live token behind it.
 */
async function cancelIfFamilyRevoked(familyId: string): Promise<boolean> {
  if (!(await isFamilyRevoked(familyId))) return false
  await revokeFamily(familyId)
  return true
}

async function handleRefreshGrant(
  req: Request,
  res: Response,
  client: OAuthClient,
  resource: string,
): Promise<void> {
  if (!client.grantTypes.includes('refresh_token')) {
    oauthError(res, 400, 'unauthorized_client')
    return
  }
  const refreshToken = param(req.body, 'refresh_token')
  if (!refreshToken || refreshToken.length > CODE_MAX) {
    oauthError(res, 400, 'invalid_request')
    return
  }
  const record = await findToken(refreshToken, 'refresh')
  if (!record || record.clientId !== client.clientId) {
    oauthError(res, 400, 'invalid_grant')
    return
  }
  if (record.usedAt) {
    // A rotated refresh token presented again means a copy is loose. Revoking
    // the family logs out the thief AND the legitimate client, which is the
    // point: the user re-authorizes, and the stolen copy is worthless.
    await revokeFamily(record.familyId)
    void writeAudit({
      userId: record.userId,
      actor: 'oauth',
      action: 'oauth.reuse',
      target: client.clientId,
      detail: { client: client.clientName, kind: 'refresh_token' },
    })
    oauthError(res, 400, 'invalid_grant')
    return
  }
  if (record.revokedAt || Date.parse(record.expiresAt) <= Date.now()) {
    oauthError(res, 400, 'invalid_grant')
    return
  }
  if (!resourceMatches(record.resource, resource)) {
    oauthError(res, 400, 'invalid_target')
    return
  }

  // A refresh may narrow scope but never widen it.
  const scopeRaw = param(req.body, 'scope')
  if (scopeRaw === null) {
    oauthError(res, 400, 'invalid_request')
    return
  }
  const requested = parseScopes(scopeRaw, record.scopes)
  if ('error' in requested || requested.scopes.some(s => !record.scopes.includes(s))) {
    oauthError(res, 400, 'invalid_scope')
    return
  }

  if (!(await claimRefreshToken(record.id))) {
    oauthError(res, 400, 'invalid_grant')
    return
  }

  const issued = await issueTokenPair({
    userId: record.userId,
    clientId: client.clientId,
    scopes: requested.scopes,
    resource: record.resource,
    familyId: record.familyId,
  })
  // Same window as the code path: between claiming the old refresh token and
  // inserting the new pair, a replay elsewhere — or Disconnect on the account
  // page — can revoke this family. The rotation would otherwise hand out a
  // live token that the revocation was meant to kill.
  if (await cancelIfFamilyRevoked(issued.familyId)) {
    oauthError(res, 400, 'invalid_grant')
    return
  }
  void writeAudit({
    userId: record.userId,
    actor: 'oauth',
    action: 'oauth.refresh',
    target: client.clientId,
    detail: { client: client.clientName, scopes: requested.scopes },
  })
  tokenResponse(res, issued)
}

// --- revocation (RFC 7009) --------------------------------------------------

router.post('/oauth/revoke', oauthTokenRateLimit, form, async (req, res, next) => {
  const cfg = configured(res)
  if (!cfg) return
  try {
    const token = param(req.body, 'token')
    const clientId = param(req.body, 'client_id')
    // RFC 7009 §2.2: an invalid or unknown token is a successful revocation.
    // Answering anything else turns this endpoint into a token oracle.
    if (!token || token.length > CODE_MAX) {
      res.status(200).set('Cache-Control', 'no-store').end()
      return
    }

    const kind = token.startsWith(REFRESH_TOKEN_PREFIX) ? 'refresh' : 'access'
    const record = await findToken(token, kind)
    // Only the client the token was issued to may revoke it.
    if (record && (!clientId || record.clientId === clientId)) {
      if (kind === 'refresh') await revokeFamily(record.familyId)
      else await revokeTokenById(record.id)
      const client = await getClient(record.clientId)
      void writeAudit({
        userId: record.userId,
        actor: 'oauth',
        action: 'oauth.revoke',
        target: record.clientId,
        detail: { client: client?.clientName ?? 'unknown', kind },
      })
    }
    res.status(200).set('Cache-Control', 'no-store').end()
  } catch (err) {
    next(err)
  }
})

// --- account page: pending request + connected apps -------------------------

router.use('/api/library/oauth', requireInternalUser, internalRateLimit)

/** What the account page needs to show "Continue to <app>": the name of the
 *  app waiting, from the database rather than from the URL. */
router.get('/api/library/oauth/pending/:id', async (req, res, next) => {
  try {
    const pending = await getPendingAuthorize(String(req.params.id ?? ''))
    if (!pending) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const client = await getClient(pending.clientId)
    if (!client) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({
      clientName: client.clientName,
      scopes: pending.scopes,
      scopeDescriptions: pending.scopes.map(s => SCOPE_DESCRIPTIONS[s] ?? s),
      // The same two facts the consent page leads with, so the account page's
      // "Continue to <app>" card can show them before the person clicks
      // through: when this client appeared, and where it will send them.
      registeredAt: client.createdAt,
      redirectHost: redirectHost(pending.redirectUri),
    })
  } catch (err) {
    next(err)
  }
})

router.get('/api/library/oauth/grants', async (_req, res, next) => {
  try {
    const user = res.locals.internalUser as InternalUser
    res.json({ grants: await listGrants(user.id) })
  } catch (err) {
    next(err)
  }
})

router.delete('/api/library/oauth/grants/:id', async (req, res, next) => {
  try {
    const user = res.locals.internalUser as InternalUser
    const familyId = String(req.params.id ?? '')
    const revoked = await revokeGrant(user.id, familyId)
    if (!revoked) {
      res.status(404).json({ error: 'not found' })
      return
    }
    void writeAudit({
      userId: user.id,
      actor: user.username,
      action: 'oauth.revoke',
      target: familyId,
      detail: { client: revoked.clientName, via: 'account' },
    })
    res.json({ revoked: true })
  } catch (err) {
    next(err)
  }
})

export default router
