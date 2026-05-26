/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wallet, Refresh } from '@icon-park/react';
import { Button, Tooltip } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import type { NewApiBalanceResult } from '@/common/types/provider/newApi';
import { isNewApiPlatform } from '@/common/utils/platformConstants';

interface NewApiBalanceProps {
  provider?: IProvider | TProviderWithModel;
}

const formatAmount = (amount: number): string => {
  if (amount >= 100) return amount.toFixed(2);
  if (amount >= 1) return amount.toFixed(3);
  return amount.toFixed(4);
};

const NewApiBalance: React.FC<NewApiBalanceProps> = ({ provider }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<NewApiBalanceResult | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!provider || !isNewApiPlatform(provider.platform) || !provider.api_key || !provider.base_url) {
      setState(null);
      return;
    }
    setLoading(true);
    try {
      const res = await ipcBridge.newApiAuth.fetchBalance.invoke({
        base_url: provider.base_url,
        api_key: provider.api_key,
      });
      setState(res);
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!provider || !isNewApiPlatform(provider.platform)) {
    return null;
  }

  let label: string;
  if (loading && !state) {
    label = t('settings.newApiLogin.balanceLoading');
  } else if (!state) {
    label = '—';
  } else if (!state.success) {
    label = t('settings.newApiLogin.balanceError');
  } else if (state.unlimited) {
    label = t('settings.newApiLogin.balanceUnlimited');
  } else if (typeof state.amount === 'number') {
    label = formatAmount(state.amount);
  } else {
    label = '—';
  }

  return (
    <Tooltip content={t('settings.newApiLogin.balanceTooltip')}>
      <Button
        size='small'
        type='outline'
        onClick={() => {
          void refresh();
        }}
        disabled={loading}
        icon={
          loading ? (
            <Refresh theme='outline' size={14} className='animate-spin' />
          ) : (
            <Wallet theme='outline' size={14} />
          )
        }
      >
        <span className='font-medium mr-4px'>{t('settings.newApiLogin.balanceLabel')}</span>
        <span>{label}</span>
      </Button>
    </Tooltip>
  );
};

export default NewApiBalance;
