import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
// Against the build, not the sources: see secret-box.test.mts.
import { KEY_FILE, resolveSecretKey } from '../dist/common/secret-key.js';
import { SecretBox } from '../dist/common/secret-box.js';

const dirs: string[] = [];

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yts-key-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('resolveSecretKey', () => {
  it('generates a key SecretBox accepts', () => {
    const DATA_DIR = freshDataDir();
    const first = resolveSecretKey({ DATA_DIR });

    assert.equal(first.source, 'generated');
    assert.doesNotThrow(() => new SecretBox(first.key));
  });

  it('returns the same key on every later boot', () => {
    const DATA_DIR = freshDataDir();
    const first = resolveSecretKey({ DATA_DIR });
    const second = resolveSecretKey({ DATA_DIR });

    // The whole point: the API and the worker must be able to open what the
    // other one sealed.
    assert.equal(second.key, first.key);
    assert.equal(second.source, 'file');
  });

  it('writes the key private to its owner', () => {
    const DATA_DIR = freshDataDir();
    const { path } = resolveSecretKey({ DATA_DIR });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it('prefers an explicit SECRET_KEY over the file', () => {
    const DATA_DIR = freshDataDir();
    resolveSecretKey({ DATA_DIR });

    const explicit = resolveSecretKey({ DATA_DIR, SECRET_KEY: 'set-by-the-operator' });
    assert.equal(explicit.key, 'set-by-the-operator');
    assert.equal(explicit.source, 'env');
  });

  it('ignores a blank SECRET_KEY rather than passing it on', () => {
    // Compose sends an empty string when the variable is unset, and an empty
    // key would fail deep inside SecretBox instead of here.
    const DATA_DIR = freshDataDir();
    assert.equal(resolveSecretKey({ DATA_DIR, SECRET_KEY: '  ' }).source, 'generated');
  });

  it('yields to a key another process wrote first', () => {
    // Simulates losing the exclusive create: api and worker start together and
    // whichever loses must adopt the winner's key, not its own.
    const DATA_DIR = freshDataDir();
    const winner = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    writeFileSync(join(DATA_DIR, KEY_FILE), `${winner}\n`, { mode: 0o600 });

    const loser = resolveSecretKey({ DATA_DIR });
    assert.equal(loser.key, winner);
    assert.equal(readFileSync(join(DATA_DIR, KEY_FILE), 'utf8').trim(), winner);
  });
});
