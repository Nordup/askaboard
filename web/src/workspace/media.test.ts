import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteMedia, loadMedia, saveMedia } from './media';

describe('session-scoped image media', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('does not expose a board crop stored by another session', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await saveMedia('session-a', 'crop-1', 'aGVsbG8=');
    await saveMedia('session-b', 'crop-1', 'd29ybGQ=');
    expect(await loadMedia('session-a', 'crop-1')).toBe('aGVsbG8=');
    expect(await loadMedia('session-b', 'crop-1')).toBe('d29ybGQ=');
    expect(await loadMedia('session-c', 'crop-1')).toBeNull();
    await deleteMedia('session-a', 'crop-1');
    expect(await loadMedia('session-a', 'crop-1')).toBeNull();
    expect(await loadMedia('session-b', 'crop-1')).toBe('d29ybGQ=');
  });
});
