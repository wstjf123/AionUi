/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { NEW_API_DEFAULT_BASE_URL } from '@/common/utils/platformConstants';
import type {
  NewApiAccount,
  NewApiBalanceRequest,
  NewApiBalanceResult,
  NewApiGroup,
  NewApiGroupsResult,
  NewApiLoginRequest,
  NewApiLoginResult,
  NewApiProvisionRequest,
  NewApiProvisionResult,
  NewApiSelfProfile,
  NewApiSelfRequest,
  NewApiSelfResult,
  NewApiSessionRequest,
  NewApiUpdatePasswordRequest,
  NewApiUpdatePasswordResult,
} from '@/common/types/provider/newApi';

interface SessionEntry {
  cookie: string;
  userId: number;
  username: string;
  displayName?: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

const sessions = new Map<string, SessionEntry>();

const HEADERS_FOR_API = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

function makeSessionId(): string {
  // crypto.randomUUID is available in Node 18+ / Electron's main process.
  return `nai_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function getSession(sessionId: string): SessionEntry | null {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return entry;
}

function joinUrl(path: string): string {
  return `${NEW_API_DEFAULT_BASE_URL.replace(/\/+$/, '')}${path}`;
}

function extractSessionCookie(setCookieHeaders: string[]): string {
  // Set-Cookie may contain multiple values joined with ", " (gin uses
  // gin-contrib/sessions which sets a single cookie named "session"). We
  // normalize by parsing each header and emitting a `name=value` pair.
  const pairs: string[] = [];
  for (const raw of setCookieHeaders) {
    const first = raw.split(';')[0]?.trim();
    if (first) pairs.push(first);
  }
  return pairs.join('; ');
}

function readSetCookie(response: Response): string[] {
  // Node's undici exposes getSetCookie(); fall back to splitting the joined
  // header for older runtimes (split on commas not preceded by an expires-style
  // weekday).
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const joined = response.headers.get('set-cookie');
  if (!joined) return [];
  return joined.split(/,(?=[^;]+?=)/g).map((s) => s.trim());
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function pickMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return fallback;
}

export async function login(req: NewApiLoginRequest): Promise<NewApiLoginResult> {
  const username = req.username?.trim() ?? '';
  const password = req.password ?? '';
  if (!username || !password) {
    return { success: false, code: 'invalid_credentials', message: 'Username and password are required.' };
  }

  let response: Response;
  try {
    response = await fetch(joinUrl('/api/user/login'), {
      method: 'POST',
      headers: HEADERS_FOR_API,
      body: JSON.stringify({ username, password }),
    });
  } catch (error) {
    return {
      success: false,
      code: 'network_error',
      message: (error as Error).message ?? 'Network error',
    };
  }

  const body = await readJson(response);

  if (response.status === 429) {
    return { success: false, code: 'rate_limited', message: pickMessage(body, 'Too many attempts.') };
  }
  if (response.status >= 500) {
    return { success: false, code: 'server_error', message: pickMessage(body, 'Server error.') };
  }

  if (!response.ok || !body || typeof body !== 'object') {
    return { success: false, code: 'unknown', message: pickMessage(body, `Login failed (${response.status}).`) };
  }

  const envelope = body as { success?: boolean; message?: string; data?: Record<string, unknown> };
  if (!envelope.success || !envelope.data) {
    const msg = pickMessage(body, 'Login failed.');
    if (/2fa/i.test(msg) || envelope.data?.require_2fa === true) {
      return { success: false, code: 'requires_2fa', message: msg };
    }
    if (/disabled|password.*disabled|不允许/i.test(msg)) {
      return { success: false, code: 'password_login_disabled', message: msg };
    }
    return { success: false, code: 'invalid_credentials', message: msg };
  }

  const setCookies = readSetCookie(response);
  const cookie = extractSessionCookie(setCookies);
  if (!cookie) {
    return { success: false, code: 'unknown', message: 'Login succeeded but session cookie was missing.' };
  }

  const data = envelope.data;
  const userId = Number(data.id);
  const resolvedUsername = String(data.username ?? username);
  const displayName = typeof data.display_name === 'string' ? data.display_name : undefined;
  const sessionId = makeSessionId();
  sessions.set(sessionId, {
    cookie,
    userId,
    username: resolvedUsername,
    displayName,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  return {
    success: true,
    session_id: sessionId,
    user: {
      id: userId,
      username: resolvedUsername,
      display_name: displayName,
      role: typeof data.role === 'number' ? data.role : undefined,
    },
  };
}

export async function fetchGroups(req: NewApiSessionRequest): Promise<NewApiGroupsResult> {
  const session = getSession(req.session_id);
  if (!session) {
    return { success: false, code: 'session_expired', message: 'Session expired. Please log in again.' };
  }

  let response: Response;
  try {
    response = await fetch(joinUrl('/api/user/self/groups'), {
      method: 'GET',
      headers: { ...HEADERS_FOR_API, Cookie: session.cookie, 'New-Api-User': String(session.userId) },
    });
  } catch (error) {
    return { success: false, code: 'network_error', message: (error as Error).message ?? 'Network error' };
  }

  if (response.status === 401) {
    sessions.delete(req.session_id);
    return { success: false, code: 'session_expired', message: 'Session expired. Please log in again.' };
  }
  if (response.status >= 500) {
    return { success: false, code: 'server_error', message: `Server error (${response.status}).` };
  }

  const body = await readJson(response);
  if (!body || typeof body !== 'object') {
    return { success: false, code: 'unknown', message: 'Unexpected response from server.' };
  }
  const envelope = body as { success?: boolean; data?: Record<string, { ratio?: unknown; desc?: unknown }> };
  if (!envelope.success || !envelope.data) {
    return { success: false, code: 'unknown', message: pickMessage(body, 'Failed to load groups.') };
  }

  const groups: NewApiGroup[] = Object.entries(envelope.data).map(([name, info]) => ({
    name,
    desc: typeof info?.desc === 'string' ? info.desc : '',
    ratio: typeof info?.ratio === 'string' ? info.ratio : info?.ratio == null ? '' : String(info.ratio),
  }));

  return { success: true, groups };
}

interface TokenSearchItem {
  id?: number;
  name?: string;
  group?: string;
  key?: string;
}

async function findTokenByName(session: SessionEntry, name: string): Promise<TokenSearchItem | null> {
  const url = joinUrl(`/api/token/search?keyword=${encodeURIComponent(name)}`);
  const response = await fetch(url, {
    method: 'GET',
    headers: { ...HEADERS_FOR_API, Cookie: session.cookie, 'New-Api-User': String(session.userId) },
  });
  if (!response.ok) return null;
  const body = await readJson(response);
  if (!body || typeof body !== 'object') return null;
  const envelope = body as { success?: boolean; data?: { items?: TokenSearchItem[] } | TokenSearchItem[] };
  if (!envelope.success) return null;

  const items: TokenSearchItem[] = Array.isArray(envelope.data)
    ? envelope.data
    : Array.isArray(envelope.data?.items)
      ? envelope.data!.items!
      : [];

  return items.find((t) => t.name === name) ?? null;
}

async function fetchTokenKey(session: SessionEntry, tokenId: number): Promise<string | null> {
  const response = await fetch(joinUrl(`/api/token/${tokenId}/key`), {
    method: 'POST',
    headers: { ...HEADERS_FOR_API, Cookie: session.cookie, 'New-Api-User': String(session.userId) },
  });
  if (!response.ok) return null;
  const body = await readJson(response);
  if (!body || typeof body !== 'object') return null;
  const envelope = body as { success?: boolean; data?: { key?: unknown } };
  if (!envelope.success) return null;
  const key = envelope.data?.key;
  return typeof key === 'string' ? key : null;
}

/**
 * Fetch (or regenerate) the personal access_token for the logged-in user.
 *
 * ⚠️ `GET /api/user/token` REPLACES any previous access_token the user had
 * issued — there is no "read current" endpoint server-side. If the same user
 * has a token in use elsewhere (CLI, another device), our login invalidates
 * it. That's a known compromise of this flow; users are warned implicitly by
 * needing to re-login on any other client they had connected.
 */
async function fetchAccessToken(session: SessionEntry): Promise<string | null> {
  try {
    const response = await fetch(joinUrl('/api/user/token'), {
      method: 'GET',
      headers: { ...HEADERS_FOR_API, Cookie: session.cookie, 'New-Api-User': String(session.userId) },
    });
    if (!response.ok) return null;
    const body = await readJson(response);
    if (!body || typeof body !== 'object') return null;
    const envelope = body as { success?: boolean; data?: unknown };
    if (!envelope.success) return null;
    return typeof envelope.data === 'string' && envelope.data.length > 0 ? envelope.data : null;
  } catch {
    return null;
  }
}

async function fetchModelsByKey(baseUrl: string, key: string): Promise<string[]> {
  // Use the OpenAI-compatible `/v1/models` endpoint so the list reflects what
  // the freshly-provisioned token can actually call (group-filtered), instead
  // of every model the user account can see across groups.
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: key.startsWith('sk-') ? `Bearer ${key}` : `Bearer sk-${key}`,
    },
  });
  if (!response.ok) return [];
  const body = await readJson(response);
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export async function provision(req: NewApiProvisionRequest): Promise<NewApiProvisionResult> {
  const session = getSession(req.session_id);
  if (!session) {
    return { success: false, code: 'session_expired', message: 'Session expired. Please log in again.' };
  }
  const group = req.group?.trim();
  if (!group) {
    return { success: false, code: 'unknown', message: 'Group is required.' };
  }

  const tokenName = `aionui-${group}-${Date.now()}`;

  let createResp: Response;
  try {
    createResp = await fetch(joinUrl('/api/token/'), {
      method: 'POST',
      headers: { ...HEADERS_FOR_API, Cookie: session.cookie, 'New-Api-User': String(session.userId) },
      body: JSON.stringify({
        name: tokenName,
        remain_quota: 500000,
        unlimited_quota: true,
        expired_time: -1,
        model_limits_enabled: false,
        model_limits: '',
        allow_ips: '',
        group,
        cross_group_retry: false,
      }),
    });
  } catch (error) {
    return { success: false, code: 'network_error', message: (error as Error).message ?? 'Network error' };
  }

  if (createResp.status === 401) {
    sessions.delete(req.session_id);
    return { success: false, code: 'session_expired', message: 'Session expired. Please log in again.' };
  }

  const createBody = await readJson(createResp);
  if (
    !createResp.ok ||
    !(createBody && typeof createBody === 'object' && (createBody as { success?: boolean }).success)
  ) {
    return {
      success: false,
      code: 'token_create_failed',
      message: pickMessage(createBody, 'Failed to create token.'),
    };
  }

  const found = await findTokenByName(session, tokenName);
  if (!found || typeof found.id !== 'number') {
    return { success: false, code: 'token_lookup_failed', message: 'Token created but not found in listing.' };
  }

  const key = await fetchTokenKey(session, found.id);
  if (!key) {
    return { success: false, code: 'token_lookup_failed', message: 'Failed to read token key.' };
  }

  let models: string[] = [];
  try {
    models = await fetchModelsByKey(NEW_API_DEFAULT_BASE_URL, key);
  } catch {
    return { success: false, code: 'models_failed', message: 'Failed to load models for the user.' };
  }

  // Best-effort: pull an access_token so the Account settings page can call
  // `/api/user/self` later without re-prompting for the password. Login still
  // succeeds even if this step fails — Account management just won't be wired.
  const accessToken = await fetchAccessToken(session);
  const account: NewApiAccount | undefined = accessToken
    ? {
        user_id: session.userId,
        username: session.username,
        display_name: session.displayName,
        access_token: accessToken,
      }
    : undefined;

  return {
    success: true,
    data: {
      base_url: NEW_API_DEFAULT_BASE_URL,
      api_key: key,
      models,
      group,
      token_name: tokenName,
      account,
    },
  };
}

export async function logout(req: NewApiSessionRequest): Promise<void> {
  const session = sessions.get(req.session_id);
  sessions.delete(req.session_id);
  if (!session) return;
  try {
    await fetch(joinUrl('/api/user/logout'), {
      method: 'GET',
      headers: { ...HEADERS_FOR_API, Cookie: session.cookie, 'New-Api-User': String(session.userId) },
    });
  } catch {
    // Best-effort logout; the in-memory entry is already gone.
  }
}

/**
 * Query a New API instance for the balance attached to a given API key.
 * Backend handler: controller.GetSubscription. Endpoint accepts the regular
 * `Authorization: Bearer sk-...` token; we just forward what the user has.
 */
export async function fetchBalance(req: NewApiBalanceRequest): Promise<NewApiBalanceResult> {
  const baseUrl = (req.base_url ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    return { success: false, code: 'unknown', message: 'Missing base URL.' };
  }
  const apiKey = (req.api_key ?? '').trim();
  if (!apiKey) {
    return { success: false, code: 'invalid_credentials', message: 'Missing API key.' };
  }
  // The api_key field can hold multiple keys separated by newlines; the
  // dashboard endpoint only accepts one, so use the first.
  const firstKey = apiKey.split(/[\r\n]+/)[0]?.trim() ?? '';
  if (!firstKey) {
    return { success: false, code: 'invalid_credentials', message: 'Missing API key.' };
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/dashboard/billing/subscription`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: firstKey.startsWith('sk-') ? `Bearer ${firstKey}` : `Bearer sk-${firstKey}`,
      },
    });
  } catch (error) {
    return { success: false, code: 'network_error', message: (error as Error).message ?? 'Network error' };
  }

  if (response.status === 401) {
    return { success: false, code: 'invalid_credentials', message: 'Unauthorized.' };
  }
  if (response.status >= 500) {
    return { success: false, code: 'server_error', message: `Server error (${response.status}).` };
  }

  const body = await readJson(response);
  if (!body || typeof body !== 'object') {
    return { success: false, code: 'unknown', message: 'Unexpected response from server.' };
  }
  const envelope = body as {
    error?: { message?: string; type?: string };
    soft_limit_usd?: number;
    hard_limit_usd?: number;
    system_hard_limit_usd?: number;
    access_until?: number;
  };
  if (envelope.error) {
    return {
      success: false,
      code: 'invalid_credentials',
      message: envelope.error.message ?? 'Failed to query balance.',
    };
  }
  // The "*_USD" naming is a leftover from the OpenAI-compatible response
  // shape; new-api may serve any quota display unit (USD/CNY/tokens).
  // We expose the raw amount and let the renderer format it.
  const amount = typeof envelope.hard_limit_usd === 'number' ? envelope.hard_limit_usd : 0;
  // 100000000 is the sentinel for unlimited tokens (see controller/billing.go).
  const unlimited = amount >= 99_999_999;
  return {
    success: true,
    amount: unlimited ? undefined : amount,
    expires_at: envelope.access_until,
    unlimited,
  };
}

function selfHeaders(accessToken: string): Record<string, string> {
  // new-api's middleware.UserAuth accepts the raw access_token in the
  // Authorization header (no "Bearer " prefix). Sending Bearer would make it
  // look like a relay sk-... key instead.
  return { ...HEADERS_FOR_API, Authorization: accessToken };
}

/**
 * Fetch the current user's profile using the persisted access_token.
 * Backed by `/api/user/self` — auth is via Authorization header, no cookie.
 */
export async function getSelf(req: NewApiSelfRequest): Promise<NewApiSelfResult> {
  const baseUrl = (req.base_url ?? '').replace(/\/+$/, '');
  const accessToken = (req.access_token ?? '').trim();
  if (!baseUrl || !accessToken) {
    return { success: false, code: 'session_expired', message: 'Missing credentials.' };
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/user/self`, {
      method: 'GET',
      headers: selfHeaders(accessToken),
    });
  } catch (error) {
    return { success: false, code: 'network_error', message: (error as Error).message ?? 'Network error' };
  }

  if (response.status === 401) {
    return { success: false, code: 'session_expired', message: 'Session expired. Please sign in again.' };
  }
  if (response.status >= 500) {
    return { success: false, code: 'server_error', message: `Server error (${response.status}).` };
  }

  const body = await readJson(response);
  if (!body || typeof body !== 'object') {
    return { success: false, code: 'unknown', message: 'Unexpected response from server.' };
  }
  const envelope = body as { success?: boolean; data?: Record<string, unknown>; message?: string };
  if (!envelope.success || !envelope.data) {
    return { success: false, code: 'unknown', message: pickMessage(body, 'Failed to load profile.') };
  }

  const data = envelope.data;
  const user: NewApiSelfProfile = {
    id: typeof data.id === 'number' ? data.id : Number(data.id ?? 0),
    username: typeof data.username === 'string' ? data.username : '',
    display_name: typeof data.display_name === 'string' ? data.display_name : undefined,
    email: typeof data.email === 'string' ? data.email : undefined,
    role: typeof data.role === 'number' ? data.role : undefined,
    group: typeof data.group === 'string' ? data.group : '',
    quota: typeof data.quota === 'number' ? data.quota : 0,
    used_quota: typeof data.used_quota === 'number' ? data.used_quota : 0,
    request_count: typeof data.request_count === 'number' ? data.request_count : 0,
  };
  return { success: true, user };
}

/**
 * Change the password of the logged-in user via `PUT /api/user/self`.
 * Server requires `username`, `display_name`, `original_password`, `password`
 * — the handler hashes & persists when original_password matches.
 */
export async function updatePassword(req: NewApiUpdatePasswordRequest): Promise<NewApiUpdatePasswordResult> {
  const baseUrl = (req.base_url ?? '').replace(/\/+$/, '');
  const accessToken = (req.access_token ?? '').trim();
  if (!baseUrl || !accessToken) {
    return { success: false, code: 'session_expired', message: 'Missing credentials.' };
  }
  const newPassword = req.new_password ?? '';
  const originalPassword = req.original_password ?? '';
  if (!newPassword || !originalPassword) {
    return { success: false, code: 'invalid_credentials', message: 'Both passwords are required.' };
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/user/self`, {
      method: 'PUT',
      headers: selfHeaders(accessToken),
      body: JSON.stringify({
        username: req.username,
        display_name: req.display_name ?? '',
        original_password: originalPassword,
        password: newPassword,
      }),
    });
  } catch (error) {
    return { success: false, code: 'network_error', message: (error as Error).message ?? 'Network error' };
  }

  if (response.status === 401) {
    return { success: false, code: 'session_expired', message: 'Session expired. Please sign in again.' };
  }
  if (response.status >= 500) {
    return { success: false, code: 'server_error', message: `Server error (${response.status}).` };
  }

  const body = await readJson(response);
  if (!body || typeof body !== 'object') {
    return { success: false, code: 'unknown', message: 'Unexpected response from server.' };
  }
  const envelope = body as { success?: boolean; message?: string };
  if (!envelope.success) {
    const message = pickMessage(body, 'Failed to update password.');
    // The server returns "原密码错误" on a current-password mismatch.
    if (/原密码|original.*password|incorrect/i.test(message)) {
      return { success: false, code: 'invalid_credentials', message };
    }
    return { success: false, code: 'unknown', message };
  }
  return { success: true };
}

// Test hook: clear sessions between vitest runs.
export function __resetSessionsForTest(): void {
  sessions.clear();
}
