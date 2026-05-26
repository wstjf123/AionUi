/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IProvider } from '@/common/config/storage';
import { isNewApiPlatform } from '@/common/utils/platformConstants';

let kickedOff = false;

function normalize(list: Array<string | { id: string; name: string }>): string[] {
  const out: string[] = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id === 'string' && id.length > 0) out.push(id);
  }
  return out;
}

function sameModels(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = (xs: string[]): string[] => [...xs].sort();
  const sa = sorted(a);
  const sb = sorted(b);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

/**
 * Background-refresh model lists for every new-api provider once per session.
 * For each provider, re-fetches `/v1/models` (via the existing fetchModelList
 * IPC) and writes back when the result differs from the stored models. Errors
 * are swallowed — this is best-effort.
 */
export function refreshNewApiProviderModels(providers: IProvider[]): void {
  if (kickedOff) return;
  if (!providers.length) return;
  kickedOff = true;

  void (async () => {
    for (const provider of providers) {
      if (!isNewApiPlatform(provider.platform)) continue;
      if (!provider.api_key || !provider.base_url) continue;
      try {
        const res = await ipcBridge.mode.fetchModelList.invoke({
          platform: provider.platform,
          base_url: provider.base_url,
          api_key: provider.api_key,
        });
        if (!res?.models) continue;
        const fresh = normalize(res.models);
        if (fresh.length === 0) continue;
        if (sameModels(fresh, provider.models)) continue;
        await ipcBridge.mode.updateProvider.invoke({
          id: provider.id,
          models: fresh,
        });
      } catch (error) {
        console.warn('[new-api] background model refresh failed:', provider.id, error);
      }
    }
  })();
}

// Test hook to reset the once-per-session guard between vitest runs.
export function __resetForTest(): void {
  kickedOff = false;
}
