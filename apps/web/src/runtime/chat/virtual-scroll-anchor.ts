export interface VirtualScrollAnchor {
  key: string;
  /** Row top relative to the viewport top. Negative means partly clipped. */
  offset: number;
  /** The scrollTop the offset was measured against. */
  scrollTop: number;
}

/** Capture the first row that still has visible pixels in the viewport. */
export function captureVirtualScrollAnchor<T extends { key: string }>(
  items: readonly T[],
  offsets: readonly number[],
  sizes: readonly number[],
  scrollTop: number,
): VirtualScrollAnchor | null {
  if (items.length === 0) return null;
  let index = 0;
  while (
    index < items.length - 1
    && (offsets[index] ?? 0) + (sizes[index] ?? 0) <= scrollTop
  ) {
    index += 1;
  }
  const item = items[index];
  if (!item) return null;
  return {
    key: item.key,
    offset: (offsets[index] ?? 0) - scrollTop,
    scrollTop,
  };
}

/**
 * Restore the captured row to the same viewport offset after remeasurement.
 *
 * Invariant: the restore only cancels the layout shift. Any scroll that
 * landed between capture and restore (a wheel notch while a streaming row
 * remeasured) is kept, so `currentScrollTop` is the live position, not the
 * captured one.
 */
export function scrollTopForVirtualScrollAnchor<T extends { key: string }>(
  anchor: VirtualScrollAnchor,
  items: readonly T[],
  offsets: readonly number[],
  maxScrollTop: number,
  currentScrollTop: number,
): number | null {
  const index = items.findIndex((item) => item.key === anchor.key);
  if (index < 0) return null;
  const scrolledSinceCapture = currentScrollTop - anchor.scrollTop;
  return Math.min(
    Math.max(0, maxScrollTop),
    Math.max(0, (offsets[index] ?? 0) - anchor.offset + scrolledSinceCapture),
  );
}
