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

export type NewApiLoginResult =
  | {
      success: true;
      session_id: string;
      user: NewApiLoginUser;
    }
  | {
      success: false;
      code: NewApiLoginErrorCode;
      message: string;
    };

export interface NewApiSessionRequest {
  session_id: string;
}

export interface NewApiGroup {
  name: string;
  desc: string;
  ratio: string;
}

export type NewApiGroupsResult =
  | { success: true; groups: NewApiGroup[] }
  | { success: false; code: 'session_expired' | 'network_error' | 'server_error' | 'unknown'; message: string };

export interface NewApiProvisionRequest extends NewApiSessionRequest {
  group: string;
}

export interface NewApiProvisionPayload {
  base_url: string;
  api_key: string;
  models: string[];
  group: string;
  token_name: string;
}

export type NewApiProvisionResult =
  | { success: true; data: NewApiProvisionPayload }
  | {
      success: false;
      code: 'session_expired' | 'token_create_failed' | 'token_lookup_failed' | 'models_failed' | 'network_error' | 'server_error' | 'unknown';
      message: string;
    };
