import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { formatElapsed, formatShellElapsed, UNKNOWN_ELAPSED_BELOW_MS } from '../../runtime/chat/format';
import { upstreamActivityAt } from '../../runtime/chat/upstream-activity';

export interface StreamClockSample {
  nowMs?: number;
  lastEventAtMs?: number | null;
}

interface ClockSnapshot {
  nowMs: number;
  lastEventAtMs: number | null;
}

/**
 * One timer per active assistant message. Only the small elapsed-time labels
 * subscribe; the message and its event parser do not rerender on clock ticks.
 */
class StreamClockStore {
  private snapshot: ClockSnapshot = { nowMs: 0, lastEventAtMs: null };
  private listeners = new Set<() => void>();
  private interval: ReturnType<typeof setInterval> | null = null;
  sampledAtMs = 0;

  private read(runId?: string): ClockSnapshot {
    this.snapshot = {
      nowMs: Date.now(),
      lastEventAtMs: upstreamActivityAt(runId),
    };
    return this.snapshot;
  }

  /** Called only when the turn is rebuilt, never for an unrelated parent render. */
  sample(runId?: string): ClockSnapshot {
    const sample = this.read(runId);
    this.sampledAtMs = sample.nowMs;
    return sample;
  }

  start(runId?: string): void {
    this.stop();
    const tick = (): void => {
      this.read(runId);
      for (const listener of this.listeners) listener();
    };
    tick();
    this.interval = setInterval(tick, 1000);
  }

  stop(): void {
    if (this.interval != null) clearInterval(this.interval);
    this.interval = null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ClockSnapshot => this.snapshot;
}

export interface StreamClockContextValue {
  store: StreamClockStore;
  /** The instant at which the current turn's elapsedMs values were built. */
  sampledAtMs: number;
}

const StreamClockContext = createContext<StreamClockContextValue | null>(null);
const EMPTY_SNAPSHOT: ClockSnapshot = { nowMs: 0, lastEventAtMs: null };
const NO_SUBSCRIBE = (): (() => void) => () => {};

export const StreamClockProvider = StreamClockContext.Provider;

export function useAssistantStreamClock(active: boolean, runId?: string): {
  context: StreamClockContextValue | null;
  sample: () => StreamClockSample;
} {
  const store = useMemo(() => new StreamClockStore(), []);
  useEffect(() => {
    if (!active) {
      store.stop();
      return;
    }
    store.start(runId);
    return () => { store.stop(); };
  }, [active, runId, store]);
  return {
    context: active ? {
      store,
      // The provider object is created before useMemo builds the turn. Read the
      // baseline lazily, when subscribers render after that build has sampled it.
      get sampledAtMs() { return store.sampledAtMs; },
    } : null,
    sample: () => active ? store.sample(runId) : {},
  };
}

function useClockSnapshot(): { snapshot: ClockSnapshot; sampledAtMs: number } | null {
  const context = useContext(StreamClockContext);
  const snapshot = useSyncExternalStore(
    context?.store.subscribe ?? NO_SUBSCRIBE,
    context?.store.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    context?.store.getSnapshot ?? (() => EMPTY_SNAPSHOT),
  );
  return context ? { snapshot, sampledAtMs: context.sampledAtMs } : null;
}

function advancedElapsed(
  elapsedMs: number | null | undefined,
  live: boolean | number | undefined,
  clock: { snapshot: ClockSnapshot; sampledAtMs: number } | null,
): number | null | undefined {
  if (!clock || live == null || live === false) return elapsedMs;
  const delta = Math.max(0, clock.snapshot.nowMs - clock.sampledAtMs);
  const baseMs = typeof live === 'number' ? live : (elapsedMs ?? 0);
  if (elapsedMs == null && baseMs + delta < UNKNOWN_ELAPSED_BELOW_MS) return null;
  return baseMs + delta;
}

/** A text-only clock subscriber. Static and historical rows do not subscribe. */
export function LiveElapsed({
  elapsedMs,
  live = false,
  shell = false,
}: {
  elapsedMs: number | null | undefined;
  live?: boolean | number;
  shell?: boolean;
}): ReactNode {
  const context = useContext(StreamClockContext);
  if (!context || live == null || live === false) return (shell ? formatShellElapsed : formatElapsed)(elapsedMs);
  return <LiveElapsedText elapsedMs={elapsedMs} live={live} shell={shell} />;
}

function LiveElapsedText({ elapsedMs, live, shell }: {
  elapsedMs: number | null | undefined;
  live: boolean | number;
  shell: boolean;
}): ReactNode {
  const clock = useClockSnapshot();
  return (shell ? formatShellElapsed : formatElapsed)(advancedElapsed(elapsedMs, live, clock));
}

/** Used by the thinking token/elapsed slot, which also depends on clock age. */
export function useLiveStreamClock(): {
  nowMs: number | null;
  elapsedMs: (value: number | null | undefined, live?: boolean | number) => number | null | undefined;
} {
  const clock = useClockSnapshot();
  return {
    nowMs: clock?.snapshot.nowMs ?? null,
    elapsedMs: (value, live = false) => advancedElapsed(value, live, clock),
  };
}

/**
 * Boolean selector for the first-output fallback. The store still ticks, but
 * React skips the enclosing shell render until this threshold actually flips.
 */
export function useStreamClockAtLeast(
  elapsedMs: number | null | undefined,
  live: boolean | number | undefined,
  thresholdMs: number,
): boolean {
  const context = useContext(StreamClockContext);
  return useSyncExternalStore(
    context?.store.subscribe ?? NO_SUBSCRIBE,
    () => (advancedElapsed(elapsedMs, live, context ? {
      snapshot: context.store.getSnapshot(),
      sampledAtMs: context.sampledAtMs,
    } : null) ?? 0) >= thresholdMs,
    () => (elapsedMs ?? 0) >= thresholdMs,
  );
}
