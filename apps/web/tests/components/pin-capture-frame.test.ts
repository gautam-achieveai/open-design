/**
 * Pin pictures show the whole clicked element, and enough page around a tiny,
 * flat or narrow one to recognise it; a mostly-empty picture is trimmed to its
 * content. See `pinCaptureFrame` / `pinCaptureTrim`.
 */
import { describe, expect, it } from 'vitest';

import { pinCaptureFrame, pinCaptureTrim } from '../../src/components/design-browser-tools';

const viewport = { width: 1200, height: 800 };
const contains = (outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number }) =>
  outer.x <= inner.x && outer.y <= inner.y
  && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;

describe('pinCaptureFrame', () => {
  it('keeps a normal element exactly, with no highlight', () => {
    expect(pinCaptureFrame({ x: 100, y: 100, width: 300, height: 200 }, viewport))
      .toEqual({ frame: { x: 100, y: 100, width: 300, height: 200 }, highlight: null });
  });

  it('gives a tiny control its surroundings and marks it', () => {
    const element = { x: 500, y: 300, width: 24, height: 24 };
    const result = pinCaptureFrame(element, viewport)!;
    expect(result.frame).toEqual({ x: 432, y: 262, width: 160, height: 100 });
    expect(result.highlight).toEqual({ x: 68, y: 38, width: 24, height: 24 });
  });

  it('grows a flat bar to at most 3:1 without cutting it', () => {
    const element = { x: 0, y: 0, width: 1200, height: 48 };
    const { frame, highlight } = pinCaptureFrame(element, viewport)!;
    expect(frame).toEqual({ x: 0, y: 0, width: 1200, height: 400 });
    expect(highlight).toEqual({ x: 0, y: 0, width: 1200, height: 48 });
  });

  it('grows a narrow column sideways', () => {
    const { frame } = pinCaptureFrame({ x: 1190, y: 0, width: 10, height: 600 }, viewport)!;
    expect(frame).toEqual({ x: 1000, y: 0, width: 200, height: 600 });
  });

  it('stays inside the viewport and still contains an element at the edge', () => {
    const element = { x: 1180, y: 790, width: 20, height: 10 };
    const { frame } = pinCaptureFrame(element, viewport)!;
    expect(contains({ x: 0, y: 0, ...viewport }, frame)).toBe(true);
    expect(contains(frame, element)).toBe(true);
    expect(frame.width).toBe(160);
    expect(frame.height).toBe(100);
  });

  it('frames only the visible part of a partly scrolled-off element', () => {
    const { frame } = pinCaptureFrame({ x: 100, y: -500, width: 400, height: 900 }, viewport)!;
    expect(frame).toEqual({ x: 100, y: 0, width: 400, height: 400 });
  });

  it('returns null for an element outside the viewport', () => {
    expect(pinCaptureFrame({ x: 0, y: 900, width: 50, height: 50 }, viewport)).toBeNull();
  });
});

function image(width: number, height: number, content?: { x: number; y: number; width: number; height: number }) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  if (content) {
    for (let y = content.y; y < content.y + content.height; y += 1) {
      for (let x = content.x; x < content.x + content.width; x += 1) {
        const i = (y * width + x) * 4;
        data[i] = 20; data[i + 1] = 20; data[i + 2] = 20;
      }
    }
  }
  return { width, height, data };
}

describe('pinCaptureTrim', () => {
  it('trims a mostly-empty picture to its content plus a margin, kept readable', () => {
    const trimmed = pinCaptureTrim(image(800, 600, { x: 50, y: 40, width: 120, height: 30 }));
    expect(trimmed).toEqual({ x: 30, y: 5, width: 160, height: 100 });
  });

  it('keeps a picture whose content fills it', () => {
    expect(pinCaptureTrim(image(300, 200, { x: 10, y: 10, width: 280, height: 180 }))).toBeNull();
  });

  it('counts pale content as content, not background', () => {
    const pale = image(800, 600, { x: 50, y: 40, width: 120, height: 30 });
    for (let i = 0; i < pale.data.length; i += 4) if (pale.data[i] === 20) pale.data.fill(243, i, i + 3);
    expect(pinCaptureTrim(pale)).toEqual({ x: 30, y: 5, width: 160, height: 100 });
  });

  it('keeps a picture with no plain background', () => {
    const busy = image(300, 200, { x: 0, y: 0, width: 300, height: 1 });
    expect(pinCaptureTrim(busy)).toBeNull();
  });

  it('keeps an empty picture whole', () => {
    expect(pinCaptureTrim(image(300, 200))).toBeNull();
  });

  it('scales the margin and minimum size by image pixels per CSS pixel', () => {
    const trimmed = pinCaptureTrim(image(1600, 1200, { x: 100, y: 80, width: 240, height: 60 }), 2);
    expect(trimmed).toEqual({ x: 60, y: 10, width: 320, height: 200 });
  });
});
