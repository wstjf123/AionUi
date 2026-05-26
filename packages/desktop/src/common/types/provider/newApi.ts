/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC 合约：New API 账号登录与分组直选
 * IPC contract: New API account login and per-group provisioning.
 *
 * 主进程持有 session cookie；渲染端只看到 sessionId / 业务结果。
 * Cookies live in the main process; the renderer only sees opaque session ids
 * and provisioned credentials.
 */

export interface NewApiLoginRequest {
  username: string;
  password: string;
}

export interface NewApiLoginUser {
  id: number;
  username: string;
  display_name?: string;
  role?: number;
}

export type NewApiLoginErrorCode =
  | 'invalid_credentials'
  | 'password_login_disabled'
  | 'rate_limited'
  | 'requires_2fa'
  | 'network_error'
  | 'server_error'
  | 'unknown';

export interface NewApiLoginResult {
  success: boolean;
  /** Present when success=true */
  session_id?: string;
  /** Present when success=true */
  user?: NewApiLoginUser;
  /** Present when success=false */
  code?: NewApiLoginErrorCode;
  /** Present when success=false */
  message?: string;
}

export interface NewApiSessionRequest {
  session_id: string;
}

export interface NewApiGroup {
  name: string;
  desc: string;
  ratio: string;
}

export type NewApiGroupErrorCode = 'session_expired' | 'network_error' | 'server_error' | 'unknown';

export interface NewApiGroupsResult {
  success: boolean;
  /** Present when success=true */
  groups?: NewApiGroup[];
  /** Present when success=false */
  code?: NewApiGroupErrorCode;
  /** Present when success=false */
  message?: string;
}

export interface NewApiProvisionRequest extends NewApiSessionRequest {
  group: string;
}

/**
 * Account info attached to a new-api provider. Lets the renderer reach
 * `/api/user/self` and `PUT /api/user/self` without prompting for the password
 * again. The access_token is generated via `GET /api/user/token`, which
 * *overwrites* any prior token the user might have issued elsewhere — that's a
 * known compromise of this login flow.
 */
export interface NewApiAccount {
  user_id: number;
  username: string;
  display_name?: string;
  access_token: string;
}

export interface NewApiProvisionPayload {
  base_url: string;
  api_key: string;
  models: string[];
  group: string;
  token_name: string;
  /** Optional — present when `/api/user/token` succeeded after token provisioning. */
  account?: NewApiAccount;
}

export type NewApiProvisionErrorCode =
  | 'session_expired'
  | 'token_create_failed'
  | 'token_lookup_failed'
  | 'models_failed'
  | 'network_error'
  | 'server_error'
  | 'unknown';

export interface NewApiProvisionResult {
  success: boolean;
  /** Present when success=true */
  data?: NewApiProvisionPayload;
  /** Present when success=false */
  code?: NewApiProvisionErrorCode;
  /** Present when success=false */
  message?: string;
}

export interface NewApiBalanceRequest {
  base_url: string;
  api_key: string;
}

export type NewApiBalanceErrorCode = 'invalid_credentials' | 'network_error' | 'server_error' | 'unknown';

export interface NewApiBalanceResult {
  success: boolean;
  /** Display amount (already converted to the configured unit by the server). */
  amount?: number;
  /** "$" / "¥" / "tokens" — derived from amount magnitude / response shape, not authoritative. */
  unit?: string;
  /** When non-zero, the token has an expiry; epoch seconds. */
  expires_at?: number;
  /** True when the upstream reports unlimited quota (very large hard limit). */
  unlimited?: boolean;
  code?: NewApiBalanceErrorCode;
  message?: string;
}

// ---------------------------------------------------------------------------
// Account management — backed by `Authorization: <access_token>` against the
// new-api server. Lets Account settings work without a live cookie session.
// ---------------------------------------------------------------------------

export interface NewApiSelfRequest {
  base_url: string;
  access_token: string;
}

export interface NewApiSelfProfile {
  id: number;
  username: string;
  display_name?: string;
  email?: string;
  role?: number;
  group: string;
  quota: number;
  used_quota: number;
  request_count: number;
}

export type NewApiSelfErrorCode = 'session_expired' | 'network_error' | 'server_error' | 'unknown';

export interface NewApiSelfResult {
  success: boolean;
  /** Present when success=true */
  user?: NewApiSelfProfile;
  /** Present when success=false */
  code?: NewApiSelfErrorCode;
  /** Present when success=false */
  message?: string;
}

export interface NewApiUpdatePasswordRequest {
  base_url: string;
  access_token: string;
  username: string;
  display_name?: string;
  original_password: string;
  new_password: string;
}

export type NewApiUpdatePasswordErrorCode =
  | 'session_expired'
  | 'invalid_credentials'
  | 'network_error'
  | 'server_error'
  | 'unknown';

export interface NewApiUpdatePasswordResult {
  success: boolean;
  code?: NewApiUpdatePasswordErrorCode;
  message?: string;
}
