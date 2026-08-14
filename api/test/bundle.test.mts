import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bundleName, toEntries } from '../dist/files/bundle.js';

const part = (originalname: string, size = 10) => ({ originalname, path: `/tmp/${size}`, size });

describe('toEntries', () => {
  it('keeps the folder structure the browser sent', () => {
    const entries = toEntries([part('holiday/beach.jpg'), part('holiday/raw/beach.dng')]);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['holiday/beach.jpg', 'holiday/raw/beach.dng'],
    );
  });

  it('sanitises names that would escape the extraction directory', () => {
    assert.equal(toEntries([part('../../etc/passwd')])[0].name, 'etc/passwd');
  });

  it('suffixes duplicates instead of losing a file', () => {
    // Two files collapsing into one is data loss nobody notices until it
    // matters, so a clash is renamed rather than overwritten.
    const entries = toEntries([part('a.jpg'), part('a.jpg'), part('a.jpg'), part('b')]);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['a.jpg', 'a-2.jpg', 'a-3.jpg', 'b'],
    );
  });

  it('names a part that has no usable name at all', () => {
    assert.equal(toEntries([part('..')])[0].name, 'file-1');
  });

  it('carries the source path and size through', () => {
    assert.deepEqual(toEntries([{ originalname: 'x.bin', path: '/tmp/abc', size: 42 }]), [
      { name: 'x.bin', path: '/tmp/abc', size: 42 },
    ]);
  });
});

describe('bundleName', () => {
  const day = new Date('2026-08-14T10:00:00Z');

  it('uses the folder the files came from', () => {
    assert.equal(bundleName(['holiday/a.jpg', 'holiday/b.jpg'], undefined, day), 'holiday.tar');
  });

  it('falls back to the date for a loose selection', () => {
    assert.equal(bundleName(['a.jpg', 'b.jpg'], undefined, day), 'bundle-2026-08-14.tar');
    assert.equal(bundleName(['one/a.jpg', 'two/b.jpg'], undefined, day), 'bundle-2026-08-14.tar');
  });

  it('prefers a requested name and gives it the extension', () => {
    assert.equal(bundleName(['a.jpg'], 'photos', day), 'photos.tar');
    assert.equal(bundleName(['a.jpg'], 'photos.tar', day), 'photos.tar');
    assert.equal(bundleName(['a.jpg'], '  ', day), 'bundle-2026-08-14.tar');
  });

  it('does not let a requested name carry a path', () => {
    // It becomes the stored name and a Content-Disposition filename.
    assert.equal(bundleName(['a.jpg'], '../../evil', day), 'evil.tar');
    assert.equal(bundleName(['a.jpg'], '/etc/passwd', day), 'passwd.tar');
    assert.equal(bundleName(['a.jpg'], '..', day), 'bundle-2026-08-14.tar');
  });
});
