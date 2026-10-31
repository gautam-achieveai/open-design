import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BrowserPerformanceNativeChallenge } from '@open-design/contracts';

/** This purpose is separate from the existing CLI-mintable import token. */
export function verifyNativePerformanceDecision(secret: Buffer | null, challenge: BrowserPerformanceNativeChallenge,
  decision: 'approve' | 'deny', value: unknown): boolean {
  if (!secret || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 2 || payload.bindingDigest !== challenge.bindingDigest
    || typeof payload.signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.signature)) return false;
  const expected = createHmac('sha256', secret).update(JSON.stringify([
    'od.capture-throttle.native-decision.v1', challenge.approvalId, decision, challenge.bindingDigest,
  ])).digest();
  const actual = Buffer.from(payload.signature, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
