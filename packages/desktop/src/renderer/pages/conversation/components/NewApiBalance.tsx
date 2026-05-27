/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wallet } from '@icon-park/react';
import { Button, Tooltip } from '@arco-design/web-react';
import type { IProvider } from '@/common/config/storage';
import { isNewApiPlatform } from '@/common/utils/platformConstants';
import useSWR from 'swr';
import { PROVIDERS_SWR_KEY, fetchProviders } from '@/renderer/hooks/agent/useModelProviderList';
import { getProviderAccount, saveProviderAccount } from '@/renderer/services/newApiAccountStore';
import { ipcBridge } from '@/common';

const QUOTA_PER_UNIT = 500_000;

const formatAmount = (amount: number): string => {
  if (amount >= 100) return amount.toFixed(2);
  if (amount >= 1) return amount.toFixed(3);
  return amount.toFixed(4);
};

const NewApiBalance: React.FC = () => {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const [localProfile, setLocalProfile] = useState<{ quota: number; used_quota: number } | null>(null);

  const { data: providers } = useSWR<IProvider[]>(PROVIDERS_SWR_KEY, fetchProviders, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });

  const provider = providers?.find((p) => isNewApiPlatform(p.platform));
  const account = provider ? getProviderAccount(provider.id) : undefined;
  const profile = localProfile ?? account?.profile;

  const handleRefresh = useCallback(async () => {
    if (!provider || !account?.session_id || refreshing) return;
    setRefreshing(true);
    try {
      const res = await ipcBridge.newApiAuth.refreshUserProfile.invoke({ session_id: account.session_id });
      if (res.success && res.user) {
        setLocalProfile(res.user);
        saveProviderAccount(provider.id, { ...account, profile: res.user });
      }
    } finally {
      setRefreshing(false);
    }
  }, [provider, account, refreshing]);

  if (!provider) {
    return null;
  }

  let label: string;
  if (!profile) {
    label = '—';
  } else {
    const remainingUnits = (profile.quota - profile.used_quota) / QUOTA_PER_UNIT;
    label = `$${formatAmount(Math.max(0, remainingUnits))}`;
  }

  const canRefresh = !!account?.session_id;

  return (
    <Tooltip
      content={canRefresh ? t('settings.newApiLogin.balanceTooltip') : t('settings.newApiLogin.balanceSnapshotTip')}
    >
      <Button
        size='small'
        type='outline'
        loading={refreshing}
        icon={<Wallet theme='outline' size={14} />}
        onClick={canRefresh ? handleRefresh : undefined}
        style={canRefresh ? { cursor: 'pointer' } : { cursor: 'default' }}
      >
        <span>{label}</span>
      </Button>
    </Tooltip>
  );
};

export default NewApiBalance;
