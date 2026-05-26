/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { fetchBalance, fetchGroups, getSelf, login, logout, provision, updatePassword } from './client';

/**
 * Wire the New API account-login IPC handlers. Owned by the service so it
 * stays cohesive — `initAllBridges()` calls in from process/bridge/index.ts.
 */
export function initNewApiAuthBridge(): void {
  ipcBridge.newApiAuth.login.provider(async (params) => login(params));
  ipcBridge.newApiAuth.fetchGroups.provider(async (params) => fetchGroups(params));
  ipcBridge.newApiAuth.provision.provider(async (params) => provision(params));
  ipcBridge.newApiAuth.logout.provider(async (params) => logout(params));
  ipcBridge.newApiAuth.fetchBalance.provider(async (params) => fetchBalance(params));
  ipcBridge.newApiAuth.getSelf.provider(async (params) => getSelf(params));
  ipcBridge.newApiAuth.updatePassword.provider(async (params) => updatePassword(params));
}
