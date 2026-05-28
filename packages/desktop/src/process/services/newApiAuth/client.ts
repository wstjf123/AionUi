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
  NewApiRegisterRequest,
  NewApiRegisterResult,
  NewApiSelfProfile,
  NewApiAccessTokenResult,
  NewApiSendVerificationRequest,
  NewApiSendVerificationResult,
  NewApiSessionRequest,
  NewApiSelfResult,
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
 * Fetch the user's profile (group, quota, used_quota, etc.) via session
 * cookie. This avoids the access_token rotation trap of GET /api/user/token,
 * which silently invalidates any previously-issued token. The new-api
 * UserAuth middleware accepts session-cookie auth on /api/user/self, so we
 * can take the snapshot at login time and stash it locally for AccountSettings
 * to read offline.
 */
async function fetchUserSelf(session: SessionEntry): Promise<NewApiSelfProfile | null> {
  try {
    const response = await fetch(joinUrl('/api/user/self'), {
      method: 'GET',
      headers: { ...HEADERS_FOR_API, Cookie: session.cookie, 'New-Api-User': String(session.userId) },
    });
    if (!response.ok) return null;
    const body = await readJson(response);
    if (!body || typeof body !== 'object') return null;
    const envelope = body as { success?: boolean; data?: Record<string, unknown> };
    if (!envelope.success || !envelope.data) return null;
    const data = envelope.data;
    const id = Number(data.id);
    const username = typeof data.username === 'string' ? data.username : null;
    if (!Number.isFinite(id) || !username) return null;
    const display_name = typeof data.display_name === 'string' ? data.display_name : undefined;
    const email = typeof data.email === 'string' ? data.email : undefined;
    const role = typeof data.role === 'number' ? data.role : undefined;
    const group = typeof data.group === 'string' ? data.group : '';
    const quota = typeof data.quota === 'number' ? data.quota : 0;
    const used_quota = typeof data.used_quota === 'number' ? data.used_quota : 0;
    const request_count = typeof data.request_count === 'number' ? data.request_count : 0;
    return { id, username, display_name, email, role, group, quota, used_quota, request_count };
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

  // Snapshot the user's profile via session cookie. AccountSettings reads
  // it directly so it never needs to re-authenticate against /api/user/self.
  const profile = await fetchUserSelf(session);
  const account: NewApiAccount = {
    user_id: session.userId,
    username: session.username,
    display_name: session.displayName,
    profile: profile ?? undefined,
  };

  return {
    success: true,
    data: {
      base_url: NEW_API_DEFAULT_BASE_URL,
      api_key: key,
      models,
      group,
      token_name: tokenName,
      account,
      session_id: req.session_id,
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
 * Issue a fresh access_token via `GET /api/user/token`. The endpoint
 * rotates: any previously-issued token gets revoked. Used only by the
 * change-password flow which needs a short-lived token to call
 * `PUT /api/user/self` and discards both the session and the token
 * immediately after.
 */
export async function issueAccessToken(req: NewApiSessionRequest): Promise<NewApiAccessTokenResult> {
  const session = getSession(req.session_id);
  if (!session) {
    return { success: false, code: 'session_expired', message: 'Session expired.' };
  }
  try {
    const response = await fetch(joinUrl('/api/user/token'), {
      method: 'GET',
      headers: { ...HEADERS_FOR_API, Cookie: session.cookie, 'New-Api-User': String(session.userId) },
    });
    if (!response.ok) {
      return { success: false, code: 'unknown', message: `HTTP ${response.status}` };
    }
    const body = await readJson(response);
    if (!body || typeof body !== 'object') {
      return { success: false, code: 'unknown', message: 'Unexpected response.' };
    }
    const envelope = body as { success?: boolean; data?: unknown; message?: string };
    if (!envelope.success || typeof envelope.data !== 'string' || envelope.data.length === 0) {
      return { success: false, code: 'unknown', message: pickMessage(body, 'Failed to issue access token.') };
    }
    return { success: true, access_token: envelope.data };
  } catch (error) {
    return { success: false, code: 'unknown', message: (error as Error).message ?? 'Network error' };
  }
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

export async function refreshUserProfile(req: NewApiSessionRequest): Promise<NewApiSelfResult> {
  const session = getSession(req.session_id);
  if (!session) {
    return { success: false, code: 'session_expired' };
  }
  const profile = await fetchUserSelf(session);
  if (!profile) {
    return { success: false, code: 'unknown', message: 'Failed to fetch user profile.' };
  }
  return { success: true, user: profile };
}

function mapRegisterError(message: string): NewApiRegisterResult['code'] {
  // Map the server's i18n-flavored error strings back to stable codes the
  // renderer can translate without trusting upstream copy. The matches are
  // intentionally broad — new-api returns the *localized* message that
  // matches whichever Accept-Language the server picked.
  if (/already exists|已存在|已被使用|已被注册|이미.*존재|すでに/i.test(message)) return 'user_exists';
  if (/verification.*code|验证码|인증.*코드/i.test(message)) return 'verification_code_error';
  if (/email.*verification|邮箱验证|이메일.*인증/i.test(message)) return 'email_verification_required';
  if (/register.*disabled|注册.*关闭|注册.*禁用|회원가입.*비활성/i.test(message)) return 'register_disabled';
  if (/password.*register.*disabled|密码注册.*关闭/i.test(message)) return 'password_register_disabled';
  return 'unknown';
}

export async function register(req: NewApiRegisterRequest): Promise<NewApiRegisterResult> {
  const username = req.username?.trim() ?? '';
  const password = req.password ?? '';
  // The new-api validator enforces 8-20 chars for password and max 20 for
  // username. We pre-check the obvious cases to give a fast error without a
  // round-trip; the server still validates authoritatively.
  if (!username || !password) {
    return { success: false, code: 'invalid_params', message: 'Username and password are required.' };
  }
  if (password.length < 8 || password.length > 20) {
    return { success: false, code: 'invalid_params', message: 'Password must be 8-20 characters.' };
  }
  if (username.length > 20) {
    return { success: false, code: 'invalid_params', message: 'Username must be at most 20 characters.' };
  }

  const body: Record<string, unknown> = { username, password };
  if (req.email) body.email = req.email.trim();
  if (req.verification_code) body.verification_code = req.verification_code.trim();
  if (req.aff_code) body.aff_code = req.aff_code.trim();

  let response: Response;
  try {
    response = await fetch(joinUrl('/api/user/register'), {
      method: 'POST',
      headers: HEADERS_FOR_API,
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { success: false, code: 'network_error', message: (error as Error).message ?? 'Network error' };
  }

  if (response.status === 429) {
    return { success: false, code: 'rate_limited', message: 'Too many attempts.' };
  }
  if (response.status >= 500) {
    return { success: false, code: 'server_error', message: `Server error (${response.status}).` };
  }

  const responseBody = await readJson(response);
  if (!responseBody || typeof responseBody !== 'object') {
    return { success: false, code: 'unknown', message: `Registration failed (${response.status}).` };
  }
  const envelope = responseBody as { success?: boolean; message?: string };
  if (!envelope.success) {
    const message = pickMessage(responseBody, 'Registration failed.');
    return { success: false, code: mapRegisterError(message), message };
  }
  return { success: true };
}

export async function sendEmailVerification(req: NewApiSendVerificationRequest): Promise<NewApiSendVerificationResult> {
  const email = req.email?.trim() ?? '';
  if (!email || !/.+@.+\..+/.test(email)) {
    return { success: false, code: 'invalid_email', message: 'Invalid email address.' };
  }

  let response: Response;
  try {
    response = await fetch(joinUrl(`/api/verification?email=${encodeURIComponent(email)}`), {
      method: 'GET',
      headers: HEADERS_FOR_API,
    });
  } catch (error) {
    return { success: false, code: 'network_error', message: (error as Error).message ?? 'Network error' };
  }

  if (response.status === 429) {
    return { success: false, code: 'rate_limited', message: 'Too many requests. Please wait.' };
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
    return { success: false, code: 'unknown', message: pickMessage(body, 'Failed to send verification code.') };
  }
  return { success: true };
}

// Test hook: clear sessions between vitest runs.
export function __resetSessionsForTest(): void {
  sessions.clear();
}
