/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NewApiAccount } from '@/common/types/provider/newApi';

/**
 * Per-provider account info captured at login. Lives in localStorage because
 * the backend `/api/providers` wire contract doesn't model it — the provider
 * row only carries the api_key, but `/api/user/self` and password-change need
 * the user's access_token. Keying by provider id keeps multiple groups under
 * the same account separable (each login creates its own provider row).
 */

const STORAGE_KEY = 'newApiProviderAccounts';

type Store = Record<string, NewApiAccount>;

function read(): Store {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Store;
  } catch {
    // fall through
  }
  return {};
}

function write(store: Store): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage may be unavailable or full; account info is best-effort
  }
}

export function saveProviderAccount(providerId: string, account: NewApiAccount): void {
  const store = read();
  store[providerId] = account;
  write(store);
}

export function getProviderAccount(providerId: string): NewApiAccount | undefined {
  return read()[providerId];
}

export function deleteProviderAccount(providerId: string): void {
  const store = read();
  if (!(providerId in store)) return;
  delete store[providerId];
  write(store);
}

export function listProviderAccounts(): Store {
  return read();
}
