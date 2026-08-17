import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { headerDisagreesWith } from '../dist/jobs/verify.processor.js';

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function check(over: Partial<Parameters<typeof headerDisagreesWith>[1]> = {}) {
  return {
    name: 'bundle.tar',
    payloadLength: 1000,
    gzipped: false,
    sha256: HASH,
    groupsChecked: 8,
    totalGroups: 412,
    ...over,
  };
}

describe('headerDisagreesWith', () => {
  it('accepts a header that matches the row', () => {
    assert.equal(headerDisagreesWith({ sha256: HASH, size: 1000 }, check()), null);
  });

  it('refuses a hash that is not the one stored', () => {
    const complaint = headerDisagreesWith({ sha256: OTHER, size: 1000 }, check());
    assert.match(String(complaint), /hash mismatch/);
  });

  it('refuses a length that disagrees when the bytes were stored uncompressed', () => {
    const complaint = headerDisagreesWith({ sha256: HASH, size: 2000 }, check());
    assert.match(String(complaint), /length mismatch/);
  });

  it('does not compare lengths at all when the container gzipped the payload', () => {
    // The regression this pins. `payloadLength` is the length of the stream, so
    // a gzipped container reports the compressed size while the row holds the
    // original — measured on x6LtjqFWP8Q, 637,111,296 bytes of tar stored as
    // 636,555,008. Comparing them refused a file whose hash had just agreed and
    // whose eight sampled groups had all decoded.
    const gzipped = check({ gzipped: true, payloadLength: 636555008 });
    assert.equal(headerDisagreesWith({ sha256: HASH, size: 637111296 }, gzipped), null);
  });

  it('still checks the hash of a gzipped container', () => {
    const gzipped = check({ gzipped: true, payloadLength: 636555008, sha256: OTHER });
    assert.match(String(headerDisagreesWith({ sha256: HASH, size: 637111296 }, gzipped)), /hash/);
  });

  it('skips the length check on a row that has no size yet', () => {
    // An imported row knows nothing until its first read back.
    assert.equal(headerDisagreesWith({ sha256: HASH, size: 0 }, check()), null);
  });
});
