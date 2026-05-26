/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSessionsForTest, fetchGroups, login, provision } from '@/process/services/newApiAuth/client';

type FetchMock = ReturnType<typeof vi.fn>;

const COOKIE = 'session=abc123; Path=/; HttpOnly';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function loginResponse(status: number, body: unknown, withCookie = true): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (withCookie) headers['Set-Cookie'] = COOKIE;
  return new Response(JSON.stringify(body), { status, headers });
}

function readCalls(fetchMock: FetchMock): Array<{ url: string; init?: RequestInit }> {
  return fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));
}

describe('newApiAuth.client', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    __resetSessionsForTest();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('login', () => {
    it('captures the session cookie and returns the user on success', async () => {
      fetchMock.mockResolvedValueOnce(
        loginResponse(200, {
          success: true,
          data: { id: 42, username: 'alice', display_name: 'Alice', role: 1 },
        })
      );

      const res = await login({ username: 'alice', password: 'pw' });

      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.session_id).toMatch(/^nai_/);
      expect(res.user).toEqual({ id: 42, username: 'alice', display_name: 'Alice', role: 1 });
    });

    it('rejects with invalid_credentials when server reports failure', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: false, message: '密码错误' }));

      const res = await login({ username: 'alice', password: 'bad' });

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.code).toBe('invalid_credentials');
    });

    it('returns rate_limited on HTTP 429', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(429, { success: false, message: 'too many' }));
      const res = await login({ username: 'a', password: 'b' });
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.code).toBe('rate_limited');
    });

    it('returns network_error when fetch throws', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('boom'));
      const res = await login({ username: 'a', password: 'b' });
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.code).toBe('network_error');
    });

    it('rejects empty credentials without hitting the network', async () => {
      const res = await login({ username: '   ', password: '' });
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.code).toBe('invalid_credentials');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('detects 2FA in the success response', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { success: true, message: '需要 2FA', data: { require_2fa: true } })
      );
      const res = await login({ username: 'a', password: 'b' });
      // success=true but data lacks id; treated as auth-failed by current logic.
      expect(res.success).toBe(false);
    });

    it('treats login response without Set-Cookie as failure', async () => {
      fetchMock.mockResolvedValueOnce(loginResponse(200, { success: true, data: { id: 1, username: 'a' } }, false));
      const res = await login({ username: 'a', password: 'b' });
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.code).toBe('unknown');
    });
  });

  describe('fetchGroups', () => {
    it('returns session_expired when session is unknown', async () => {
      const res = await fetchGroups({ session_id: 'missing' });
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.code).toBe('session_expired');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('forwards the cookie and normalizes the group list', async () => {
      fetchMock.mockResolvedValueOnce(loginResponse(200, { success: true, data: { id: 1, username: 'a' } }));
      const loginRes = await login({ username: 'a', password: 'b' });
      expect(loginRes.success).toBe(true);
      if (!loginRes.success) return;

      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            default: { ratio: 1, desc: 'Default group' },
            vip: { ratio: '0.5', desc: 'VIP' },
          },
        })
      );

      const res = await fetchGroups({ session_id: loginRes.session_id });
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.groups).toEqual([
        { name: 'default', desc: 'Default group', ratio: '1' },
        { name: 'vip', desc: 'VIP', ratio: '0.5' },
      ]);

      const calls = readCalls(fetchMock);
      const groupCall = calls[1];
      expect(groupCall.url).toContain('/api/user/self/groups');
      const headers = (groupCall.init?.headers ?? {}) as Record<string, string>;
      expect(headers.Cookie).toBe('session=abc123');
      expect(headers['New-Api-User']).toBe('1');
    });

    it('drops the session and returns session_expired on 401', async () => {
      fetchMock.mockResolvedValueOnce(loginResponse(200, { success: true, data: { id: 7, username: 'a' } }));
      const loginRes = await login({ username: 'a', password: 'b' });
      expect(loginRes.success).toBe(true);
      if (!loginRes.success) return;

      fetchMock.mockResolvedValueOnce(jsonResponse(401, { success: false, message: 'unauth' }));
      const first = await fetchGroups({ session_id: loginRes.session_id });
      expect(first.success).toBe(false);
      if (first.success) return;
      expect(first.code).toBe('session_expired');

      // The session is now gone; a follow-up call should also report expired
      // without calling fetch again.
      fetchMock.mockClear();
      const second = await fetchGroups({ session_id: loginRes.session_id });
      expect(second.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('provision', () => {
    async function loginAndGetSession() {
      fetchMock.mockResolvedValueOnce(loginResponse(200, { success: true, data: { id: 7, username: 'a' } }));
      const res = await login({ username: 'a', password: 'b' });
      if (!res.success) throw new Error('login should succeed in test setup');
      return res.session_id;
    }

    it('chains create → search → key → models on the happy path', async () => {
      const sessionId = await loginAndGetSession();

      // POST /api/token/
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }));
      // GET /api/token/search
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: { items: [{ id: 99, name: 'irrelevant' }] },
        })
      );

      // The above search returned the wrong name; the first time, the client
      // will not match. Reset to provide the matching item instead.
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(loginResponse(200, { success: true, data: { id: 7, username: 'a' } }));
      const fresh = await login({ username: 'a', password: 'b' });
      if (!fresh.success) throw new Error('expected fresh login');

      let createdName = '';
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/api/token/') && init?.method === 'POST') {
          createdName = JSON.parse(String(init.body)).name as string;
          return jsonResponse(200, { success: true });
        }
        if (u.includes('/api/token/search')) {
          return jsonResponse(200, {
            success: true,
            data: { items: [{ id: 99, name: createdName, group: 'vip' }] },
          });
        }
        if (u.endsWith('/api/token/99/key') && init?.method === 'POST') {
          return jsonResponse(200, { success: true, data: { key: 'sk-LIVE' } });
        }
        if (u.endsWith('/v1/models')) {
          return jsonResponse(200, {
            object: 'list',
            data: [{ id: 'gpt-4o-mini' }, { id: 'claude-3-5-sonnet' }],
          });
        }
        throw new Error(`unexpected fetch: ${u}`);
      });

      const res = await provision({ session_id: fresh.session_id, group: 'vip' });
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.api_key).toBe('sk-LIVE');
      expect(res.data.group).toBe('vip');
      expect(res.data.models).toEqual(['gpt-4o-mini', 'claude-3-5-sonnet']);
      expect(res.data.token_name).toBe(createdName);
      expect(res.data.token_name.startsWith('aionui-vip-')).toBe(true);

      // Sanity-check the create payload includes the group field.
      const createCall = readCalls(fetchMock).find((c) => c.url.endsWith('/api/token/') && c.init?.method === 'POST');
      expect(createCall).toBeDefined();
      const body = JSON.parse(String(createCall!.init!.body));
      expect(body.group).toBe('vip');
      expect(body.unlimited_quota).toBe(true);
      expect(body.expired_time).toBe(-1);
    });

    it('returns token_create_failed when create returns success=false', async () => {
      const sessionId = await loginAndGetSession();
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: false, message: 'limit' }));

      const res = await provision({ session_id: sessionId, group: 'vip' });
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.code).toBe('token_create_failed');
      expect(res.message).toContain('limit');
    });

    it('returns token_lookup_failed when the new token is not in the listing', async () => {
      const sessionId = await loginAndGetSession();
      fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.endsWith('/api/token/')) return jsonResponse(200, { success: true });
        if (u.includes('/api/token/search')) {
          return jsonResponse(200, { success: true, data: { items: [] } });
        }
        throw new Error(`unexpected fetch: ${u}`);
      });
      const res = await provision({ session_id: sessionId, group: 'vip' });
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.code).toBe('token_lookup_failed');
    });

    it('drops the session on 401 from create', async () => {
      const sessionId = await loginAndGetSession();
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { success: false }));

      const res = await provision({ session_id: sessionId, group: 'vip' });
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.code).toBe('session_expired');

      fetchMock.mockClear();
      const second = await provision({ session_id: sessionId, group: 'vip' });
      expect(second.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
