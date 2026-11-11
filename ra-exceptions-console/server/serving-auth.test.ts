import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServingAuth, resetServingAuthCache } from './serving-auth';

const KEYS = ['DATABRICKS_HOST', 'DATABRICKS_CLIENT_ID', 'DATABRICKS_CLIENT_SECRET', 'DATABRICKS_TOKEN'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetServingAuthCache();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('getServingAuth', () => {
  it('returns null without a host', async () => {
    process.env.DATABRICKS_TOKEN = 'pat';
    expect(await getServingAuth()).toBeNull();
  });

  it('prefers app SP OAuth M2M over DATABRICKS_TOKEN and caches the token', async () => {
    process.env.DATABRICKS_HOST = 'demo-workspace.example.com';
    process.env.DATABRICKS_CLIENT_ID = 'cid';
    process.env.DATABRICKS_CLIENT_SECRET = 'secret';
    process.env.DATABRICKS_TOKEN = 'pat-should-not-be-used';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'sp-token', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = await getServingAuth();
    const b = await getServingAuth();
    expect(a).toEqual({ host: 'https://demo-workspace.example.com', headers: { Authorization: 'Bearer sp-token' } });
    expect(b?.headers.Authorization).toBe('Bearer sp-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://demo-workspace.example.com/oidc/v1/token');
  });

  it('falls back to DATABRICKS_TOKEN for local dev', async () => {
    process.env.DATABRICKS_HOST = 'https://demo-workspace.example.com/';
    process.env.DATABRICKS_TOKEN = 'pat';
    expect(await getServingAuth()).toEqual({
      host: 'https://demo-workspace.example.com',
      headers: { Authorization: 'Bearer pat' },
    });
  });

  it('throws when the SP token request fails', async () => {
    process.env.DATABRICKS_HOST = 'https://demo-workspace.example.com';
    process.env.DATABRICKS_CLIENT_ID = 'cid';
    process.env.DATABRICKS_CLIENT_SECRET = 'secret';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(getServingAuth()).rejects.toThrow(/401/);
  });
});
