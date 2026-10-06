import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'

/**
 * P5-51 security review, finding 1: nothing could disable a self-registered
 * OAuth client. This is the operator's lever — the audit row and the token
 * sweep are the parts that matter in an incident.
 */

process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const store = await import('../services/oauthStore.js')
const { listOAuthClients, disableOAuthClient, formatClientLine } = await import('./oauthClients.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const RESOURCE = 'https://api.example.com/mcp'
let userId = 0

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  const res = await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', 'x', 'internal') RETURNING id`,
  )
  userId = Number((res.rows[0] as { id: unknown }).id)
})

afterEach(async () => {
  await closeLibraryDb()
})

async function aClient(clientName = 'ChatGPT') {
  return store.registerClient({
    clientName,
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    grantTypes: ['authorization_code', 'refresh_token'],
    scopes: ['read'],
  })
}

describe('oauth-clients list', () => {
  it('shows id, name, creation, live token count and disabled state', async () => {
    const client = await aClient()
    await store.issueTokenPair({ userId, clientId: client.clientId, scopes: ['read'], resource: RESOURCE })
    const rows = await listOAuthClients()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ clientId: client.clientId, clientName: 'ChatGPT', liveTokens: 2, disabledAt: null })

    const line = formatClientLine(rows[0])
    expect(line).toContain(client.clientId)
    expect(line).toContain('ChatGPT')
    expect(line).toContain('2 tokens')
    expect(line).toContain('active')
  })

  it('marks a disabled client and never prints token material', async () => {
    const client = await aClient()
    const issued = await store.issueTokenPair({ userId, clientId: client.clientId, scopes: ['read'], resource: RESOURCE })
    await disableOAuthClient(client.clientId)
    const [row] = await listOAuthClients()
    expect(row.disabledAt).toBeTruthy()
    const line = formatClientLine(row)
    expect(line).toContain('disabled')
    expect(line).not.toContain(issued.accessToken)
    expect(line).not.toContain('blo_')
  })
})

describe('oauth-clients disable', () => {
  it('cuts off every live token for that client and audits the action as the CLI', async () => {
    const client = await aClient()
    const issued = await store.issueTokenPair({ userId, clientId: client.clientId, scopes: ['read'], resource: RESOURCE })

    const result = await disableOAuthClient(client.clientId)
    expect(result).toMatchObject({ clientName: 'ChatGPT', tokensRevoked: 2, alreadyDisabled: false })
    expect(await store.getOAuthAccessPrincipal(issued.accessToken, RESOURCE)).toBeNull()

    const audit = (await libraryQuery(`SELECT actor, action, target, detail FROM library_audit`)).rows as {
      actor: string
      action: string
      target: string
      detail: unknown
    }[]
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor: 'cli', action: 'oauth.client_disable', target: client.clientId })
    const detail = typeof audit[0].detail === 'string' ? JSON.parse(audit[0].detail) : audit[0].detail
    expect(detail).toEqual({ client: 'ChatGPT', tokensRevoked: 2 })
    expect(JSON.stringify(audit)).not.toContain(issued.accessToken)
  })

  it('errors on an unknown client id rather than reporting a successful disable', async () => {
    await expect(disableOAuthClient('made-up')).rejects.toThrow(/no such client/)
    expect((await libraryQuery(`SELECT id FROM library_audit`)).rows).toHaveLength(0)
  })
})
