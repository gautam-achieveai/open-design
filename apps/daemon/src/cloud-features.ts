// Retired Cloud endpoints remain explicit failures for older clients.
import type { RequestHandler } from 'express';
import { CLOUD_AGENT_ID, type AppConfigPrefs } from '@open-design/contracts';
import { sendApiError } from './http/api-errors.js';

export const CLOUD_FEATURES_DISABLED_MESSAGE =
  'Cloud support has been removed. Choose a local agent or an independently configured provider.';

/** Paths (relative to `/api`) that only make sense with OpenDesign Cloud. */
const CLOUD_ONLY_PATHS = [
  /^\/integrations\/vela(?:\/|$)/,
  /^\/amr(?:\/|$)/,
  /^\/workspace\/(?:invite|billing|resources|projects|members|events|active)(?:\/|$)/,
  /^\/workspaces(?:\/|$)/,
  /^\/touchpoints\/(?:test|production)-runtime(?:\/|$)/,
];

export function isCloudOnlyApiPath(path: string): boolean {
  return CLOUD_ONLY_PATHS.some((pattern) => pattern.test(path));
}

/** Mount on `/api`. Saved feature switches cannot restore retired providers. */
export function cloudFeaturesGate(_readConfig?: () => Promise<Pick<AppConfigPrefs, 'cloudFeatures'>>): RequestHandler {
  return (req, res, next) => {
    if (!isCloudOnlyApiPath(req.path)) return next();
    sendApiError(res, 410, 'CLOUD_FEATURES_DISABLED', CLOUD_FEATURES_DISABLED_MESSAGE);
  };
}

/** The detected agents the user may pick: only supported local runtimes. */
export function offeredAgents<T extends { id: string }>(
  agents: T[],
  _config: Pick<AppConfigPrefs, 'cloudFeatures'>,
): T[] {
  return agents.filter((agent) => agent.id !== CLOUD_AGENT_ID);
}
