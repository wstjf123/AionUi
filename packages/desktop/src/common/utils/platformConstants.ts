/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * New API 网关平台标识
 * New API gateway platform identifier
 */
export const NEW_API_PLATFORM_ID = 'new-api';

/**
 * 账号登录入口的固定 base URL
 * Fixed base URL for the New API account-login flow.
 */
export const NEW_API_DEFAULT_BASE_URL = 'https://rl666.top';

/**
 * 检查平台是否为 New API 网关类型
 * Check if platform is New API gateway type
 */
export const isNewApiPlatform = (platform: string): boolean => {
  return platform === NEW_API_PLATFORM_ID;
};
