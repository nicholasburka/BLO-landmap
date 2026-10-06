import 'dotenv/config'
import { randomBytes } from 'crypto'
import { pathToFileURL } from 'url'
import readline from 'readline'
import { closeLibraryDb, initLibraryDb, libraryQuery, writeAudit } from '../services/libraryDb.js'
import { MIN_PASSWORD_LENGTH, hashPassword } from '../services/passwords.js'

/**
 * Admin user-management CLI — with no email flows anywhere, this is the ONLY
 * way accounts are created and passwords reset (phase 5, P5-3).
 *
 *   npm run users -- create <username> [--role admin|internal]
 *   npm run users -- reset-password <username>
 *   npm run users -- disable <username>
 *   npm run users -- enable <username>
 *   npm run users -- list
 *
 * Command functions are exported for tests (driven against pg-mem);
 * main() owns argv parsing, prompting, and process exit codes.
 */

const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,64}$/

export type Role = 'admin' | 'internal'

export interface UserRow {
  username: string
  role: Role
  disabled: boolean
  created_at: Date
}

function assertUsername(username: string): void {
  if (!USERNAME_RE.test(username)) {
    throw new Error(
      `invalid username ${JSON.stringify(username)} — use 2–64 characters: letters, digits, . _ -`,
    )
  }
}

/** Create an account. Throws on duplicate username or invalid input. */
export async function createUser(username: string, role: Role, password: string): Promise<void> {
  assertUsername(username)
  if (role !== 'admin' && role !== 'internal') throw new Error(`invalid role "${role}"`)
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  const hash = await hashPassword(password)
  try {
    await libraryQuery(
      `INSERT INTO library_users (username, password_hash, role) VALUES ($1, $2, $3)`,
      [username, hash, role],
    )
  } catch (err: any) {
    if (err?.code === '23505' || /unique|duplicate/i.test(err?.message || '')) {
      throw new Error(`user "${username}" already exists`)
    }
    throw err
  }
  await writeAudit({ actor: 'cli', action: 'user.create', target: username, detail: { role } })
}

async function requireUser(username: string): Promise<{ id: number }> {
  const res = await libraryQuery(`SELECT id FROM library_users WHERE username = $1`, [username])
  if (!res.rows[0]) throw new Error(`no such user "${username}"`)
  return { id: Number(res.rows[0].id) }
}

/** Set a new password and revoke every live session — a reset is usually a
 *  "something is wrong" moment, so old sessions shouldn't survive it. */
export async function resetPassword(username: string, password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  const { id } = await requireUser(username)
  const hash = await hashPassword(password)
  await libraryQuery(`UPDATE library_users SET password_hash = $1 WHERE id = $2`, [hash, id])
  await libraryQuery(`UPDATE library_sessions SET revoked = TRUE WHERE user_id = $1`, [id])
  await writeAudit({ actor: 'cli', action: 'user.reset-password', target: username })
}

/** Disable (offboard) or re-enable an account. Disabling also revokes all
 *  live sessions so the very next request 401s. */
export async function setDisabled(username: string, disabled: boolean): Promise<void> {
  const { id } = await requireUser(username)
  await libraryQuery(`UPDATE library_users SET disabled = $1 WHERE id = $2`, [disabled, id])
  if (disabled) {
    await libraryQuery(`UPDATE library_sessions SET revoked = TRUE WHERE user_id = $1`, [id])
  }
  await writeAudit({ actor: 'cli', action: disabled ? 'user.disable' : 'user.enable', target: username })
}

/** All accounts — never returns hashes. */
export async function listUsers(): Promise<UserRow[]> {
  const res = await libraryQuery(
    `SELECT username, role, disabled, created_at FROM library_users ORDER BY username`,
  )
  return res.rows.map(r => ({
    username: r.username,
    role: r.role,
    disabled: Boolean(r.disabled),
    created_at: new Date(r.created_at),
  }))
}

/** Generated passwords: 16 chars of base64url — comfortably past the argon2
 *  + rate-limit brute-force horizon, short enough to relay to a teammate. */
export function generatePassword(): string {
  return randomBytes(12).toString('base64url')
}

/** Hidden-input prompt. Empty answer → caller generates a password. */
function promptHidden(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    // Mute echo while still accepting input — standard readline hack.
    ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {}
    process.stdout.write(question)
    rl.question('', answer => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function obtainPassword(): Promise<string> {
  const typed = await promptHidden('Password (hidden; leave empty to generate): ')
  if (typed) return typed
  const generated = generatePassword()
  console.log(`Generated password (shown once, store it now): ${generated}`)
  return generated
}

function usage(): void {
  console.log(`Usage:
  npm run users -- create <username> [--role admin|internal]
  npm run users -- reset-password <username>
  npm run users -- disable <username>
  npm run users -- enable <username>
  npm run users -- list`)
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
      case 'create': {
        const username = rest[0]
        if (!username) throw new Error('username required')
        const roleFlag = rest.indexOf('--role')
        const role = (roleFlag >= 0 ? rest[roleFlag + 1] : 'internal') as Role
        const password = await obtainPassword()
        await createUser(username, role, password)
        console.log(`Created ${role} user "${username}".`)
        return 0
      }
      case 'reset-password': {
        const username = rest[0]
        if (!username) throw new Error('username required')
        const password = await obtainPassword()
        await resetPassword(username, password)
        console.log(`Password reset for "${username}"; all their sessions revoked.`)
        return 0
      }
      case 'disable':
      case 'enable': {
        const username = rest[0]
        if (!username) throw new Error('username required')
        await setDisabled(username, command === 'disable')
        console.log(`${command === 'disable' ? 'Disabled' : 'Enabled'} "${username}".`)
        return 0
      }
      case 'list': {
        const users = await listUsers()
        if (users.length === 0) {
          console.log('No users. Create one with: npm run users -- create <username>')
          return 0
        }
        for (const u of users) {
          console.log(
            `${u.username.padEnd(24)} ${u.role.padEnd(8)} ${(u.disabled ? 'disabled' : 'active').padEnd(8)} ${u.created_at.toISOString()}`,
          )
        }
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

// Only run when executed directly (tsx src/cli/users.ts), not when imported
// by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code))
}
