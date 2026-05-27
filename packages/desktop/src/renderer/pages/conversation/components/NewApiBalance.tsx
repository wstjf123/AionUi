/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Wallet } from '@icon-park/react';
import { Button, Tooltip } from '@arco-design/web-react';
import type { IProvider } from '@/common/config/storage';
import { isNewApiPlatform } from '@/common/utils/platformConstants';
import useSWR from 'swr';
import { PROVIDERS_SWR_KEY, fetchProviders } from '@/renderer/hooks/agent/useModelProviderList';
import { getProviderAccount } from '@/renderer/services/newApiAccountStore';

// new-api stores quota in 1/QuotaPerUnit USD (default QuotaPerUnit = 500000),
// so for a USD display the user's remaining "credit" = (quota - used_quota) /
// 500000. This widget intentionally reads from the login-time snapshot stashed
// in localStorage rather than calling /dashboard/billing/subscription —
// that endpoint reflects the unlimited group token we provision, not the user's
// account balance, and would always return "unlimited".
const QUOTA_PER_UNIT = 500_000;

const formatAmount = (amount: number): string => {
  if (amount >= 100) return amount.toFixed(2);
  if (amount >= 1) return amount.toFixed(3);
  return amount.toFixed(4);
};

const NewApiBalance: React.FC = () => {
  const { t } = useTranslation();

  const { data: providers } = useSWR<IProvider[]>(PROVIDERS_SWR_KEY, fetchProviders, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  const provider = providers?.find((p) => isNewApiPlatform(p.platform));
  const profile = provider ? getProviderAccount(provider.id)?.profile : undefined;

  if (!provider) {
    return null;
  }

  let label: string;
  if (!profile) {
    label = '—';
  } else {
    const remainingUnits = (profile.quota - profile.used_quota) / QUOTA_PER_UNIT;
    label = formatAmount(Math.max(0, remainingUnits));
  }

  return (
    <Tooltip content={t('settings.newApiLogin.balanceTooltip')}>
      <Button size='small' type='outline' icon={<Wallet theme='outline' size={14} />}>
        <span className='font-medium mr-4px'>{t('settings.newApiLogin.balanceLabel')}</span>
        <span>{label}</span>
      </Button>
    </Tooltip>
  );
};

export default NewApiBalance;
