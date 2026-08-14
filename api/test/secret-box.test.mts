import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
// Against the build, not the sources: the API compiles to CommonJS with
// extensionless imports, which Node cannot load from a .ts file directly.
// `pnpm test` builds first.
import { SecretBox } from '../dist/common/secret-box.js';

const key = () => randomBytes(32).toString('base64');

describe('SecretBox', () => {
  it('round-trips text and bytes', () => {
    const box = new SecretBox(key());
    assert.equal(box.open(box.seal('1//0abcdef-refresh-token')).toString(), '1//0abcdef-refresh-token');

    const jar = randomBytes(4096);
    assert.deepEqual(box.open(box.seal(jar)), jar);
  });

  it('never produces the same ciphertext twice', () => {
    const box = new SecretBox(key());
    assert.notDeepEqual(box.seal('same input'), box.seal('same input'));
  });

  it('refuses a key that is not 32 bytes', () => {
    assert.throws(() => new SecretBox(''), /SECRET_KEY is not set/);
    assert.throws(() => new SecretBox(randomBytes(16).toString('base64')), /must decode to 32 bytes/);
  });

  it('will not open a value sealed with another key', () => {
    const sealed = new SecretBox(key()).seal('someone else’s refresh token');
    assert.throws(() => new SecretBox(key()).open(sealed));
  });

  it('rejects tampering rather than returning altered bytes', () => {
    // GCM is authenticated on purpose: a cookie jar or refresh token that came
    // back subtly different would be used against a live Google account.
    const box = new SecretBox(key());
    for (const index of [0, 12, 40]) {
      const sealed = box.seal(randomBytes(64));
      sealed[index] ^= 0xff;
      assert.throws(() => box.open(sealed));
    }
  });

  it('rejects a truncated value', () => {
    const box = new SecretBox(key());
    assert.throws(() => box.open(box.seal('x').subarray(0, 20)), /truncated/);
  });
});
