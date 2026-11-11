// Serving-endpoint auth for the app backend (RA-APP-SERVING-ENDPOINT-RESOURCES).
//
// In Databricks Apps the runtime injects the app service principal's OAuth M2M
// credentials (DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET) plus DATABRICKS_HOST.
// The SP is granted CAN_QUERY on each supervisor via the `serving_endpoint`
// resources in databricks.yml, so we mint a short-lived workspace token from
// /oidc/v1/token and cache it until shortly before expiry.
//
// DATABRICKS_TOKEN is honoured ONLY as a local-dev fallback (no SP creds present).

export interface ServingAuth {
  host: string;
  headers: Record<string, string>;
}

let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

// Refresh this many ms before the token's stated expiry.
const REFRESH_SKEW_MS = 60_000;

function normalizeHost(raw: string): string {
  const h = raw.replace(/\/+$/, '');
  return /^https?:\/\//.test(h) ? h : `https://${h}`;
}

async function fetchSpToken(host: string, clientId: string, clientSecret: string): Promise<string> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch(`${host}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all-apis' }).toString(),
  });
  if (!resp.ok) {
    throw new Error(`SP token request failed with HTTP ${resp.status}`);
  }
  const json = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('SP token response missing access_token');
  const ttlMs = (json.expires_in ?? 3600) * 1000;
  cached = { token: json.access_token, expiresAt: Date.now() + ttlMs };
  return json.access_token;
}

/**
 * Resolve host + Authorization header for calling a serving endpoint.
 * Returns null when no usable credentials are configured (route should 503).
 */
export async function getServingAuth(): Promise<ServingAuth | null> {
  const rawHost = process.env.DATABRICKS_HOST;
  if (!rawHost) return null;
  const host = normalizeHost(rawHost);

  const clientId = process.env.DATABRICKS_CLIENT_ID;
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
  if (clientId && clientSecret) {
    if (cached && cached.expiresAt - REFRESH_SKEW_MS > Date.now()) {
      return { host, headers: { Authorization: `Bearer ${cached.token}` } };
    }
    if (!inflight) {
      inflight = fetchSpToken(host, clientId, clientSecret).finally(() => {
        inflight = null;
      });
    }
    const token = await inflight;
    return { host, headers: { Authorization: `Bearer ${token}` } };
  }

  // Local development only (e.g. `npm run dev` with a PAT in .env).
  const pat = process.env.DATABRICKS_TOKEN;
  if (pat) return { host, headers: { Authorization: `Bearer ${pat}` } };
  return null;
}

/** Test hook: clear the cached SP token. */
export function resetServingAuthCache(): void {
  cached = null;
  inflight = null;
}
