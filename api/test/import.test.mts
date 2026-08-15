import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  containerDescription,
  containerTitle,
  parseContainerVideo,
} from '../dist/youtube/youtube.service.js';

interface ChannelVideo {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string | null;
}

const fileId = '9fae6159-6c2b-4c0a-aae1-62782ea05b72';
const sha256 = 'a'.repeat(64);

function video(over: Partial<ChannelVideo> = {}): ChannelVideo {
  return {
    videoId: 'dQw4w9WgXcQ',
    title: containerTitle(fileId),
    description: containerDescription({ name: 'holiday.tar', sha256 }),
    publishedAt: '2026-08-14T05:42:53Z',
    ...over,
  };
}

describe('parseContainerVideo', () => {
  it('reads back exactly what an upload writes', () => {
    // The two halves are the same file's exports on purpose: a change to the
    // description that forgets the parser fails here rather than on the day
    // someone needs their catalogue back.
    assert.deepEqual(parseContainerVideo(video()), {
      fileId,
      name: 'holiday.tar',
      sha256,
    });
  });

  it('keeps a filename containing spaces, colons and the word file', () => {
    const name = 'file: notes 2026: final.txt';
    const parsed = parseContainerVideo(video({ description: containerDescription({ name, sha256 }) }));
    assert.equal(parsed?.name, name);
  });

  it('refuses a video that is not ours rather than guessing at it', () => {
    // Everything here is left alone and reported: a row invented for someone's
    // holiday clip would store a hash the decoder later refuses, which reads as
    // a corrupted file rather than as a video that was never a container.
    assert.equal(parseContainerVideo(video({ title: 'Cumpleaños de la abuela' })), null);
    assert.equal(parseContainerVideo(video({ title: 'yt-storage', description: '' })), null);
    assert.equal(parseContainerVideo(video({ description: 'yt-storage container.' })), null);
    assert.equal(
      parseContainerVideo(video({ description: 'file: x.txt\nsha256: not-a-hash' })),
      null,
    );
  });

  it('refuses a truncated hash, which is the failure that would look fine', () => {
    // A short hash parses as a string and stores as a string; nothing notices
    // until a download compares it against 64 real characters.
    const description = containerDescription({ name: 'x.bin', sha256: 'a'.repeat(63) });
    assert.equal(parseContainerVideo(video({ description })), null);
  });

  it('accepts an uppercase hash and stores it lowercase', () => {
    // yt-dlp and the codec both write lowercase; a description edited by hand
    // is the only source of the other case, and the catalogue compares strings.
    const description = containerDescription({ name: 'x.bin', sha256: 'A'.repeat(64) });
    assert.equal(parseContainerVideo(video({ description }))?.sha256, 'a'.repeat(64));
  });

  it('tolerates the extra lines YouTube or a person may add below', () => {
    const description = `${containerDescription({ name: 'x.bin', sha256 })}\n\nuploaded by yt-storage`;
    assert.equal(parseContainerVideo(video({ description }))?.name, 'x.bin');
  });
});
