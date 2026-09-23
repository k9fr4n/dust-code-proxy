import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// The admin commands (`login`, `logout`, `status`) run with
// `docker compose exec` and talk to the already-running server over
// `/internal/*`, which is gated by a shared secret.
//
// When INTERNAL_TOKEN is not provided, the server generates one at startup and
// writes it next to the credentials file, inside the `dust-credentials` volume.
// Commands exec'd into the same container read it back, so the secret never has
// to be configured by hand and is never a well-known default.

export async function readInternalToken(file: string): Promise<string | undefined> {
  try {
    const token = (await readFile(file, 'utf8')).trim()
    return token || undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`Failed to read internal token file: ${(err as Error).message}`)
  }
}

export async function ensureInternalToken(file: string): Promise<string> {
  const existing = await readInternalToken(file)
  if (existing) return existing
  const token = randomBytes(32).toString('hex')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${token}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  return token
}
