import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Finds the key that encrypts every stored credential, generating one on first
 * boot so a bare `docker compose up` works with nothing prepared.
 *
 * Order: an explicit SECRET_KEY, then the file under DATA_DIR, then a fresh 32
 * bytes written there.
 *
 * The API and the worker are separate processes that start at the same moment
 * against one shared data volume, and they must arrive at the *same* key or
 * everything the other one sealed is unreadable. The exclusive create is what
 * decides that race: exactly one process can win `wx`, and the loser reads back
 * what the winner wrote.
 */
export const KEY_FILE = 'secret.key';

export interface SecretKeyResult {
  key: string;
  /** Where it came from, so the caller can warn about a key it did not choose. */
  source: 'env' | 'file' | 'generated';
  path: string;
}

export function resolveSecretKey(env: NodeJS.ProcessEnv = process.env): SecretKeyResult {
  const dataDir = resolve(env.DATA_DIR ?? './data');
  const path = join(dataDir, KEY_FILE);

  const fromEnv = env.SECRET_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env', path };

  const existing = readKey(path);
  if (existing) return { key: existing, source: 'file', path };

  mkdirSync(dirname(path), { recursive: true });
  const generated = randomBytes(32).toString('base64');
  try {
    writeFileSync(path, `${generated}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { key: generated, source: 'generated', path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Another process got there first; its key is the one that counts.
    const winner = readKey(path);
    if (!winner) throw error;
    return { key: winner, source: 'file', path };
  }
}

function readKey(path: string): string | null {
  try {
    const contents = readFileSync(path, 'utf8').trim();
    return contents || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Puts the resolved key back on the environment so ConfigService and everything
 * downstream of it stay unaware that any of this happened. Must run before Nest
 * builds the container.
 */
export function applySecretKey(log: { warn: (message: string) => void }): SecretKeyResult {
  const result = resolveSecretKey();
  process.env.SECRET_KEY = result.key;

  if (result.source === 'generated') {
    log.warn(
      `no SECRET_KEY was set, so one was generated and written to ${result.path}. ` +
        'It encrypts every YouTube credential this instance holds: back it up with the ' +
        'database, and lose it and every connected account has to be set up again.',
    );
  }
  return result;
}
