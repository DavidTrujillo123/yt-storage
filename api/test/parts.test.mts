import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parentState, type PartState } from '../dist/files/files.service.js';
import { containerTitle, containerDescription, parseContainerVideo } from '../dist/youtube/youtube.service.js';

const part = (over: Partial<PartState> = {}): PartState => ({
  status: 'READY',
  progress: 100,
  error: null,
  partIndex: 0,
  ...over,
});

/**
 * A file too long for one video is stored as several, and the row the operator
 * watches is a summary of them. Getting that summary wrong is invisible until a
 * download fails, which is exactly the failure this project exists to avoid.
 */
describe('the state a split file shows', () => {
  it('is READY only when every part is', () => {
    assert.equal(parentState([part(), part({ partIndex: 1 })]).status, 'READY');
    assert.equal(
      parentState([part(), part({ partIndex: 1, status: 'PROCESSING', progress: 0 })]).status,
      'PROCESSING',
    );
  });

  it('shows the stage the slowest part is at', () => {
    const state = parentState([
      part({ status: 'READY' }),
      part({ partIndex: 1, status: 'UPLOADING', progress: 40 }),
      part({ partIndex: 2, status: 'ENCODING', progress: 10 }),
    ]);
    assert.equal(state.status, 'ENCODING');
  });

  it('fails as a whole the moment one part fails, and names which', () => {
    const state = parentState([
      part(),
      part({ partIndex: 1, status: 'FAILED', error: 'quota exhausted' }),
      part({ partIndex: 2, status: 'PROCESSING' }),
    ]);
    assert.equal(state.status, 'FAILED');
    assert.match(state.error ?? '', /part 2: quota exhausted/);
  });

  it('averages progress, counting a stored part as done', () => {
    // A READY part can sit at any percent — the number is per stage — so
    // reading it raw would show a finished file as half done.
    const state = parentState([
      part({ status: 'READY', progress: 12 }),
      part({ partIndex: 1, status: 'UPLOADING', progress: 50 }),
    ]);
    assert.equal(state.progress, 75);
  });
});

describe('what a container video is called', () => {
  const meta = { fileId: '207d0e00-b89f-44f5-854a-7f5e0d446b0d', sha256: 'a'.repeat(64) };

  it('wears the file name, numbered when the file is split', () => {
    assert.equal(containerTitle({ ...meta, name: 'Cursos Virtuales' }), 'Cursos Virtuales');
    assert.equal(
      containerTitle({ ...meta, name: 'Cursos Virtuales', part: { index: 0, count: 7 } }),
      'Cursos Virtuales p1',
    );
    assert.equal(
      containerTitle({ ...meta, name: 'Cursos Virtuales', part: { index: 6, count: 7 } }),
      'Cursos Virtuales p7',
    );
  });

  it('survives a rename, because identity is in the description', () => {
    const before = parseContainerVideo({
      videoId: 'x',
      title: 'cursos_virtuales p2',
      description: containerDescription({ ...meta, name: 'cursos_virtuales', part: { index: 1, count: 7 } }),
      publishedAt: null,
    });
    const after = parseContainerVideo({
      videoId: 'x',
      title: 'Cursos Virtuales p2',
      description: containerDescription({ ...meta, name: 'Cursos Virtuales', part: { index: 1, count: 7 } }),
      publishedAt: null,
    });

    assert.equal(before?.fileId, meta.fileId);
    assert.equal(after?.fileId, meta.fileId, 'the id does not move when the title does');
    assert.equal(after?.name, 'Cursos Virtuales');
    assert.deepEqual(after?.part, { index: 1, count: 7 });
  });

  it('still reads every video uploaded before titles were names', () => {
    // The old shape: the id in the title, no id line in the description. A
    // channel full of these must keep importing.
    const parsed = parseContainerVideo({
      videoId: 'x',
      title: `yt-storage ${meta.fileId}`,
      description: ['yt-storage container. Not video content.', 'file: old.bin', `sha256: ${meta.sha256}`].join('\n'),
      publishedAt: null,
    });

    assert.equal(parsed?.fileId, meta.fileId);
    assert.equal(parsed?.name, 'old.bin');
    assert.equal(parsed?.part, undefined);
  });

  it('is still not fooled by a video that is not ours', () => {
    assert.equal(
      parseContainerVideo({ videoId: 'x', title: 'holiday', description: 'the beach', publishedAt: null }),
      null,
    );
  });
});
