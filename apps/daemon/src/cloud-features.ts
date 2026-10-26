// OpenDesign Cloud is off unless the user turns it on (app config
// `cloudFeatures`). While it is off the daemon does not offer the cloud
// runtime and refuses the calls that start a cloud session or act on a cloud
// team; local agents, projects, workspaces and connectors are untouched.
import type { RequestHandler } from 'express';
import { CLOUD_AGENT_ID, cloudFeaturesEnabled, type AppConfigPrefs } from '@open-design/contracts';
import { sendApiError } from './http/api-errors.js';

export const CLOUD_FEATURES_DISABLED_MESSAGE =
  'OpenDesign Cloud is turned off. Turn it on in Settings → Labs, or run: od config set cloudFeatures true';

/** Paths (relative to `/api`) that only make sense with OpenDesign Cloud. */
const CLOUD_ONLY_PATHS = [
  /^\/integrations\/vela\/login$/,
  /^\/amr(?:\/|$)/,
  /^\/workspace\/(?:invite|billing)(?:\/|$)/,
];

export function isCloudOnlyApiPath(path: string): boolean {
  return CLOUD_ONLY_PATHS.some((pattern) => pattern.test(path));
}

/** Mount on `/api`. Reads the config per request, so the switch applies without a restart. */
export function cloudFeaturesGate(readConfig: () => Promise<Pick<AppConfigPrefs, 'cloudFeatures'>>): RequestHandler {
  return (req, res, next) => {
    if (!isCloudOnlyApiPath(req.path)) return next();
    readConfig().then((config) => {
      if (cloudFeaturesEnabled(config)) return next();
      sendApiError(res, 403, 'CLOUD_FEATURES_DISABLED', CLOUD_FEATURES_DISABLED_MESSAGE);
    }, next);
  };
}

/** The detected agents the user may pick: the cloud runtime only when cloud is on. */
export function offeredAgents<T extends { id: string }>(
  agents: T[],
  config: Pick<AppConfigPrefs, 'cloudFeatures'>,
): T[] {
  return cloudFeaturesEnabled(config) ? agents : agents.filter((agent) => agent.id !== CLOUD_AGENT_ID);
}
