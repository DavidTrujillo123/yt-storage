import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dispositionOf, parseRange } from '../dist/files/serve.js';

describe('parseRange', () => {
  it('reads an explicit window', () => {
    assert.deepEqual(parseRange('bytes=0-1023', 5000), { start: 0, end: 1023 });
    assert.deepEqual(parseRange('bytes=100-199', 5000), { start: 100, end: 199 });
  });

  it('treats an open end as the rest of the file — which is how a download resumes', () => {
    assert.deepEqual(parseRange('bytes=4096-', 5000), { start: 4096, end: 4999 });
  });

  it('clamps an end past the last byte instead of promising bytes that are not there', () => {
    assert.deepEqual(parseRange('bytes=4000-999999', 5000), { start: 4000, end: 4999 });
  });

  it('counts a suffix range back from the end', () => {
    assert.deepEqual(parseRange('bytes=-500', 5000), { start: 4500, end: 4999 });
    // Longer than the file is the whole file, not a negative offset.
    assert.deepEqual(parseRange('bytes=-99999', 5000), { start: 0, end: 4999 });
  });

  it('rejects a start past the end rather than answering with everything', () => {
    assert.equal(parseRange('bytes=5000-', 5000), 'unsatisfiable');
    assert.equal(parseRange('bytes=6000-7000', 5000), 'unsatisfiable');
    // An empty file has no byte 0 to ask for.
    assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
  });

  it('ignores what it cannot serve, so the answer is a whole body and not an error', () => {
    assert.equal(parseRange(undefined, 5000), null);
    assert.equal(parseRange('bytes=0-99,200-299', 5000), null, 'multi-range');
    assert.equal(parseRange('items=0-99', 5000), null, 'a unit that is not bytes');
    assert.equal(parseRange('bytes=-', 5000), null);
  });
});

describe('dispositionOf', () => {
  it('carries the real name in filename* and a safe one in filename', () => {
    const header = dispositionOf('[Daemon Anime] Berserk 2016 - 01 [Akira].mp4', false);
    assert.equal(
      header,
      'attachment; filename="[Daemon Anime] Berserk 2016 - 01 [Akira].mp4"; ' +
        "filename*=UTF-8''%5BDaemon%20Anime%5D%20Berserk%202016%20-%2001%20%5BAkira%5D.mp4",
    );
  });

  it('keeps an accented name readable rather than saving it percent-encoded', () => {
    const header = dispositionOf('foto ñandú.jpg', false);
    // The fallback loses the accents; the encoded form is what a browser uses.
    assert.match(header, /filename="foto _and_\.jpg"/);
    assert.match(header, /filename\*=UTF-8''foto%20%C3%B1and%C3%BA\.jpg$/);
  });

  it('never lets a quote end the quoted string early', () => {
    assert.match(dispositionOf('a "quoted" name.txt', false), /filename="a _quoted_ name\.txt"/);
    assert.match(dispositionOf('back\\slash.txt', false), /filename="back_slash\.txt"/);
  });

  it('sends only the leaf, so a path inside a bundle cannot suggest a directory', () => {
    assert.match(dispositionOf('fotos/2026/verano.jpg', true), /^inline; filename="verano\.jpg"/);
  });
});
