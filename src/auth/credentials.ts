import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DustRegion } from './jwt.js'

// Credentials persisted to a file, like the official CLI does when no system
// keychain is available (always the case in a container). Written atomically
// (temp file + rename) with 0600 permissions, into a directory created 0700.
export interface Credentials {
  accessToken: string
  refreshToken: string
  workspaceSid: string
  region: DustRegion
  username?: string
  fullName?: string
  email?: string
  updatedAt: string
}

export class CredentialStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Credentials | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Credentials
      if (!parsed.accessToken || !parsed.refreshToken || !parsed.workspaceSid) {
        return null
      }
      return parsed
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error(
        `Failed to read credentials file: ${(err as Error).message}`,
      )
    }
  }

  async save(credentials: Credentials): Promise<void> {
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(credentials, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.filePath)
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}
