import 'dotenv/config'
import { pathToFileURL } from 'url'
import { closeLibraryDb, initLibraryDb, writeAudit } from '../services/libraryDb.js'
import {
  disableClient,
  listClientSummaries,
  type OAuthClientSummary,
} from '../services/oauthStore.js'

/**
 * OAuth client management CLI (P5-51, added by the security review).
 *
 *   npm run oauth-clients -- list
 *   npm run oauth-clients -- disable <client_id>
 *
 * WHY this exists: registration is unauthenticated by design (RFC 7591), so
 * any caller can create a client row and name it whatever it likes. Until
 * this command there was no way to turn one off — `disabled_at` existed in the
 * schema and nothing ever wrote it. Disabling is an incident action, so it
 * revokes every token that client holds for every user in the same breath;
 * a person cuts off their own connection from the account page instead.
 *
 * Command functions are exported for tests (driven against pg-mem); main()
 * owns argv parsing and exit codes.
 */

export type { OAuthClientSummary }

/** Every registered client, newest first. */
export async function listOAuthClients(): Promise<OAuthClientSummary[]> {
  return listClientSummaries()
}

export interface DisableResult {
  clientName: string
  alreadyDisabled: boolean
  tokensRevoked: number
}

/** Disable one client and audit it. Throws for an unknown id so a typo is
 *  never reported as a successful disable. */
export async function disableOAuthClient(clientId: string): Promise<DisableResult> {
  const result = await disableClient(clientId)
  if (!result) throw new Error(`no such client "${clientId}"`)
  await writeAudit({
    actor: 'cli',
    action: 'oauth.client_disable',
    target: clientId,
    // The client and the damage done — never a token, a hash, or a user list.
    detail: { client: result.clientName, tokensRevoked: result.tokensRevoked },
  })
  return result
}

/** One listing row, in the same column style as `npm run users -- list`. */
export function formatClientLine(client: OAuthClientSummary): string {
  const state = client.disabledAt ? 'disabled' : 'active'
  return [
    client.clientId.padEnd(24),
    client.clientName.slice(0, 32).padEnd(32),
    state.padEnd(8),
    `${client.liveTokens} tokens`.padEnd(12),
    client.createdAt,
  ].join(' ')
}

function usage(): void {
  console.log(`Usage:
  npm run oauth-clients -- list
  npm run oauth-clients -- disable <client_id>`)
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help') {
    usage()
    return command ? 0 : 1
  }

  if (!(await initLibraryDb())) {
    console.error(
      'Cannot reach the library database. Set DATABASE_URL to the same Postgres the server uses.',
    )
    return 1
  }

  try {
    switch (command) {
      case 'list': {
        const clients = await listOAuthClients()
        if (clients.length === 0) {
          console.log('No OAuth clients have registered yet.')
          return 0
        }
        for (const client of clients) console.log(formatClientLine(client))
        return 0
      }
      case 'disable': {
        const clientId = rest[0]
        if (!clientId) throw new Error('client_id required')
        const result = await disableOAuthClient(clientId)
        console.log(
          result.alreadyDisabled
            ? `"${result.clientName}" was already disabled; revoked ${result.tokensRevoked} remaining token(s).`
            : `Disabled "${result.clientName}" and revoked ${result.tokensRevoked} token(s).`,
        )
        return 0
      }
      default:
        console.error(`Unknown command "${command}".`)
        usage()
        return 1
    }
  } catch (err: any) {
    console.error(`Error: ${err?.message || err}`)
    return 1
  } finally {
    await closeLibraryDb()
  }
}

// Only run when executed directly (tsx src/cli/oauthClients.ts), not when
// imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code))
}
