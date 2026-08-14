import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { listTar, safeEntryName, writeTar } from '../dist/files/tar.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tar-test-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, bytes: Buffer): Promise<{ name: string; path: string; size: number }> {
  const path = join(dir, name.replace(/\//g, '_'));
  await writeFile(path, bytes);
  return { name, path, size: bytes.length };
}

describe('safeEntryName', () => {
  it('keeps an ordinary relative path', () => {
    assert.equal(safeEntryName('holiday/beach.jpg', 'x'), 'holiday/beach.jpg');
  });

  it('refuses to let an archive escape where it is extracted', () => {
    // These names come from webkitRelativePath, which the client controls.
    assert.equal(safeEntryName('../../etc/passwd', 'x'), 'etc/passwd');
    assert.equal(safeEntryName('/etc/passwd', 'x'), 'etc/passwd');
    assert.equal(safeEntryName('a/../../b.txt', 'x'), 'a/b.txt');
    assert.equal(safeEntryName('./a//b.txt', 'x'), 'a/b.txt');
  });

  it('falls back when nothing usable is left', () => {
    assert.equal(safeEntryName('..', 'file-3'), 'file-3');
    assert.equal(safeEntryName('', 'file-3'), 'file-3');
  });
});

describe('tar', () => {
  it('round-trips names and sizes', async () => {
    const entries = [
      await file('one.txt', Buffer.from('hello')),
      await file('photos/two.bin', randomBytes(1000)),
      await file('photos/nested/three.bin', randomBytes(513)),
    ];
    const path = join(dir, 'round.tar');
    await writeTar(entries, path);

    const listed = await listTar(path);
    assert.deepEqual(
      listed.map((item) => ({ name: item.name, size: item.size })),
      [
        { name: 'one.txt', size: 5 },
        { name: 'photos/two.bin', size: 1000 },
        { name: 'photos/nested/three.bin', size: 513 },
      ],
    );
  });

  it('reports offsets that actually point at the bytes', async () => {
    // The listing is what per-entry extraction reads from, so an offset that
    // is off by a block hands back somebody else's file.
    const payloads = [randomBytes(300), randomBytes(1024), randomBytes(7)];
    const entries = [
      await file('a.bin', payloads[0]),
      await file('b.bin', payloads[1]),
      await file('c.bin', payloads[2]),
    ];
    const path = join(dir, 'offsets.tar');
    await writeTar(entries, path);

    const archive = await readFile(path);
    for (const [index, item] of (await listTar(path)).entries()) {
      assert.deepEqual(archive.subarray(item.offset, item.offset + item.size), payloads[index]);
    }
  });

  it('pads every entry to a whole block and ends with two empty ones', async () => {
    const path = join(dir, 'padding.tar');
    const size = await writeTar([await file('odd.bin', randomBytes(1))], path);

    assert.equal(size % 512, 0);
    assert.equal(size, 512 + 512 + 1024);
    const archive = await readFile(path);
    assert.ok(archive.subarray(archive.length - 1024).every((byte) => byte === 0));
  });

  it('splits a path longer than 100 characters across the prefix field', async () => {
    const deep = `${'directory/'.repeat(12)}photo.jpg`;
    assert.ok(deep.length > 100);
    const path = join(dir, 'deep.tar');
    await writeTar([await file(deep, Buffer.from('x'))], path);

    assert.equal((await listTar(path))[0].name, deep);
  });

  it('refuses a path it cannot represent instead of truncating it', async () => {
    const absurd = `${'a'.repeat(120)}/${'b'.repeat(120)}`;
    await assert.rejects(
      writeTar([await file(absurd, Buffer.from('x'))], join(dir, 'absurd.tar')),
      /path too long/,
    );
  });

  it('rejects something that is not a tar', async () => {
    const path = join(dir, 'not.tar');
    await writeFile(path, randomBytes(2048));
    await assert.rejects(listTar(path), /not a tar archive/);
  });

  it('handles an empty archive', async () => {
    const path = join(dir, 'empty.tar');
    await writeTar([], path);
    assert.deepEqual(await listTar(path), []);
  });

  it('produces an archive the system tar agrees with', async (t) => {
    // The real test of a format written by hand is whether anything else can
    // read it. If tar is missing, that is not a failure of this code.
    if (spawnSync('tar', ['--version'], { stdio: 'ignore' }).status !== 0) {
      return t.skip('tar not installed');
    }

    const payload = randomBytes(2048);
    const entries = [await file('holiday/beach.jpg', payload), await file('notes.txt', Buffer.from('hi'))];
    const path = join(dir, 'system.tar');
    await writeTar(entries, path);

    const listing = spawnSync('tar', ['-tf', path], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trim().split('\n'), ['holiday/beach.jpg', 'notes.txt']);

    const out = await mkdtemp(join(dir, 'extract-'));
    const extract = spawnSync('tar', ['-xf', path, '-C', out], { encoding: 'utf8' });
    assert.equal(extract.status, 0, extract.stderr);
    assert.deepEqual(await readFile(join(out, 'holiday/beach.jpg')), payload);
  });
});
