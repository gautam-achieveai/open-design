import { describe, expect, it } from "vitest";

import { analyzeRendering } from "../../src/main/browser-devtools.js";

const main = { pid: 1, tid: 7 };
const task = (ts: number, durMs: number) => ({ name: "RunTask", ph: "X", ...main, ts, dur: durMs * 1000 });
const layout = (ts: number) => ({ name: "Layout", ph: "X", ...main, ts, dur: 10 });
const frame = (ts: number) => ({ name: "DrawFrame", ph: "I", pid: 1, tid: 9, ts });
const quiet = { animations: [], droppedEvents: 0, durationMs: 1_000, events: [], page: { loaf: [], shifts: [] } };

describe("rendering report", () => {
  it("names layout shift, long tasks, thrash, and repainting animations in plain verdicts", () => {
    const events = [
      { name: "thread_name", ph: "M", ...main, args: { name: "CrRendererMain" } },
      task(1_000, 180),
      ...Array.from({ length: 300 }, (_, index) => layout(1_100 + index * 100)),
      task(400_000, 4),
      ...Array.from({ length: 60 }, (_, index) => frame(index * 16_700)),
    ];
    const report = analyzeRendering({
      animations: [{ name: "spin", element: "#spin", properties: ["left"], costlyProperties: ["left"] }],
      droppedEvents: 0,
      durationMs: 1_000,
      events,
      page: { loaf: [], shifts: [{ value: 0.2, hadRecentInput: false, sources: [{ element: "#banner" }] }] },
      visible: true,
    });
    const verdicts = (report.verdicts as string[]).join("\n");
    expect(verdicts).toContain("CLS 0.2");
    expect(verdicts).toContain("#banner");
    expect(verdicts).toContain("longest 180 ms");
    expect(verdicts).toContain("one task ran 300 layouts");
    expect(verdicts).toContain('"spin" on #spin animates left');
    expect(report.frames).toMatchObject({ drawn: 60, fps: 60, slowFrames: 0 });
  });

  it("says frame numbers mean nothing when the tab was hidden, and reports a clean run as clean", () => {
    const hidden = analyzeRendering({ ...quiet, visible: false });
    expect(hidden.verdicts).toEqual([expect.stringContaining("not visible")]);
    expect(hidden.frames).toMatchObject({ fps: null });
    expect(analyzeRendering({ ...quiet, visible: true }).verdicts).toEqual(["No rendering problems found during the recording."]);
  });

  it("ignores shifts right after user input, as CLS does", () => {
    const report = analyzeRendering({
      ...quiet,
      page: { loaf: [], shifts: [{ value: 0.5, hadRecentInput: true, sources: [] }] },
      visible: true,
    });
    expect(report.layoutShifts).toMatchObject({ cls: 0 });
  });
});
