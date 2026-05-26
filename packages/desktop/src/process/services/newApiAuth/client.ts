/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { NEW_API_DEFAULT_BASE_URL } from '@/common/utils/platformConstants';
import type {
  NewApiGroup,
  NewApiGroupsResult,
  NewApiLoginRequest,
  NewApiLoginResult,
  NewApiProvisionRequest,
  NewApiProvisionResult,
  NewApiSessionRequest,
} from '@/common/types/provider/newApi';

interface SessionEntry {
  cookie: string;
  userId: number;
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
  const sessionId = makeSessionId();
  sessions.set(sessionId, {
    cookie,
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  return {
    success: true,
    session_id: sessionId,
    user: {
      id: userId,
      username: String(data.username ?? username),
      display_name: typeof data.display_name === 'string' ? data.display_name : undefined,
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

async function fetchUserModels(session: SessionEntry): Promise<string[]> {
  const response = await fetch(joinUrl('/api/user/models'), {
    method: 'GET',
    headers: { ...HEADERS_FOR_API, Cookie: session.cookie, 'New-Api-User': String(session.userId) },
  });
  if (!response.ok) return [];
  const body = await readJson(response);
  if (!body || typeof body !== 'object') return [];
  const envelope = body as { success?: boolean; data?: unknown };
  if (!envelope.success) return [];
  if (Array.isArray(envelope.data)) {
    return envelope.data.filter((x): x is string => typeof x === 'string');
  }
  return [];
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
    models = await fetchUserModels(session);
  } catch {
    return { success: false, code: 'models_failed', message: 'Failed to load models for the user.' };
  }

  return {
    success: true,
    data: {
      base_url: NEW_API_DEFAULT_BASE_URL,
      api_key: key,
      models,
      group,
      token_name: tokenName,
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

// Test hook: clear sessions between vitest runs.
export function __resetSessionsForTest(): void {
  sessions.clear();
}
