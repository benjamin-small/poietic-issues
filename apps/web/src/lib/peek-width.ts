/** The issue peek panel's width: dragged by its left border, remembered per browser (a convenience, never shared). */

export const PEEK_DEFAULT = 600;
export const PEEK_MIN = 360;
/** Room always left for the list or board beside the panel. */
export const PEEK_GUTTER = 240;
/** Arrow-key step on the resize handle. */
export const PEEK_STEP = 32;

const KEY = 'poietic-issues.peek-width';

/** The largest width that still leaves the gutter in a container this wide, never below the minimum. */
export function maxPeekWidth(containerWidth: number): number {
  return Math.max(PEEK_MIN, Math.round(containerWidth - PEEK_GUTTER));
}

/** A width clamped to `[PEEK_MIN, max]`, rounded to whole pixels. */
export function clampPeekWidth(width: number, max: number): number {
  if (!Number.isFinite(width)) return PEEK_DEFAULT;
  return Math.round(Math.min(Math.max(width, PEEK_MIN), Math.max(max, PEEK_MIN)));
}

/** The saved width, or the default when none is saved or storage is unavailable. */
export function loadPeekWidth(): number {
  try {
    const saved = Number(localStorage.getItem(KEY));
    return saved >= PEEK_MIN ? Math.round(saved) : PEEK_DEFAULT;
  } catch {
    return PEEK_DEFAULT;
  }
}

/** Saves a width; the default clears the saved value. */
export function savePeekWidth(width: number): void {
  try {
    if (width === PEEK_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(width));
  } catch {
    // storage unavailable: the width applies for this page only
  }
}
