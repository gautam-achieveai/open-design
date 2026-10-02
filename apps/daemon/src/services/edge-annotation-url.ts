const AUTH_HOSTS = [
  'login.microsoftonline.com', 'login.live.com', 'login.windows.net',
  'login.microsoft.com', 'account.microsoft.com', 'mysignins.microsoft.com',
  'login.microsoftonline.us', 'login.chinacloudapi.cn',
  'accounts.google.com', 'sts.windows.net',
];
const AUTH_PATH = /(?:^|\/)(?:oauth2?|authorize|saml2?|callback|token)(?:\/|$)/i;
const CREDENTIAL_KEY = /(?:token|code|secret|password|passwd|key|credential|signature|sig|assertion|state|nonce|ticket|sso|authorization|session|jwt|bearer)/i;
const CREDENTIAL_VALUE = /(?:eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+|\b(?:sk-|gh[opsur]_|AKIA)[A-Za-z0-9_-]{16,}\b|bearer\s+\S+)/i;

export function eligibleEdgeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    const allowed = url.protocol === 'https:' || url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!allowed || url.username || url.password || AUTH_HOSTS.some((host) =>
      url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    return url.origin;
  } catch { return null; }
}

/** Canonical allowed URL; reject if a caller failed to remove any credential field. */
export function reviewedEdgePageUrl(raw: string, origin: string): string | null {
  if (typeof raw !== 'string' || raw.length > 8192 || !eligibleEdgeOrigin(raw)) return null;
  try {
    const url = new URL(raw);
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== origin || /%[0-9a-f]{2}/i.test(path)
      || AUTH_PATH.test(path) || CREDENTIAL_VALUE.test(path)) return null;
    if ([...url.searchParams].some(([key, value]) => /%[0-9a-f]{2}/i.test(key)
      || /%[0-9a-f]{2}/i.test(value) || CREDENTIAL_KEY.test(key) || CREDENTIAL_VALUE.test(value))) return null;
    if (url.hash) {
      const fragment = decodeURIComponent(url.hash.slice(1));
      if (/%[0-9a-f]{2}/i.test(fragment) || CREDENTIAL_VALUE.test(fragment)
        || fragment.split(/[&?]/).some((part) =>
        CREDENTIAL_KEY.test(part.split('=', 1)[0] || ''))) return null;
    }
    return url.href;
  } catch { return null; }
}
