import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampPeekWidth,
  loadPeekWidth,
  maxPeekWidth,
  PEEK_DEFAULT,
  PEEK_MIN,
  savePeekWidth,
} from './peek-width.ts';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('peek width', () => {
  it('keeps the gutter free, but never goes below the minimum', () => {
    expect(maxPeekWidth(1400)).toBe(1160);
    expect(maxPeekWidth(500)).toBe(PEEK_MIN);
  });

  it('clamps to the minimum and the maximum', () => {
    expect(clampPeekWidth(100, 1000)).toBe(PEEK_MIN);
    expect(clampPeekWidth(1200, 1000)).toBe(1000);
    expect(clampPeekWidth(640.6, 1000)).toBe(641);
    expect(clampPeekWidth(700, 200)).toBe(PEEK_MIN);
    expect(clampPeekWidth(Number.NaN, 1000)).toBe(PEEK_DEFAULT);
  });

  it('saves and loads a width, and the default clears it', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    expect(loadPeekWidth()).toBe(PEEK_DEFAULT);
    savePeekWidth(820);
    expect(loadPeekWidth()).toBe(820);
    savePeekWidth(PEEK_DEFAULT);
    expect(storage.length).toBe(0);
  });

  it('ignores junk and unavailable storage', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('poietic-issues.peek-width', 'wide');
    expect(loadPeekWidth()).toBe(PEEK_DEFAULT);
    storage.setItem('poietic-issues.peek-width', '12');
    expect(loadPeekWidth()).toBe(PEEK_DEFAULT);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadPeekWidth()).toBe(PEEK_DEFAULT);
    expect(() => savePeekWidth(700)).not.toThrow();
  });
});
