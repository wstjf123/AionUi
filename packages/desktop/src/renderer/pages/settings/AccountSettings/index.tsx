/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Form, Input, Message, Modal, Progress, Spin } from '@arco-design/web-react';
import { Key, Logout, User, Wallet } from '@icon-park/react';
import { ipcBridge } from '@/common';
import type { IProvider } from '@/common/config/storage';
import { isNewApiPlatform } from '@/common/utils/platformConstants';
import type { NewApiBalanceResult, NewApiSelfProfile } from '@/common/types/provider/newApi';
import { useAuth } from '@/renderer/hooks/context/AuthContext';
import {
  deleteProviderAccount,
  getProviderAccount,
  listProviderAccounts,
} from '@/renderer/services/newApiAccountStore';
import SettingsPageWrapper from '../components/SettingsPageWrapper';

interface PasswordForm {
  current: string;
  next: string;
  confirm: string;
}

const formatAmount = (amount: number): string => {
  if (amount >= 100) return amount.toFixed(2);
  if (amount >= 1) return amount.toFixed(3);
  return amount.toFixed(4);
};

const AccountSettings: React.FC = () => {
  const { t } = useTranslation();
  const { refresh } = useAuth();
  const [message, messageContext] = Message.useMessage();
  const [providers, setProviders] = useState<IProvider[]>([]);
  const [profile, setProfile] = useState<NewApiSelfProfile | null>(null);
  const [balance, setBalance] = useState<NewApiBalanceResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [pwForm, setPwForm] = useState<PasswordForm>({ current: '', next: '', confirm: '' });

  // Pick the first new-api provider that has account info captured in
  // localStorage. Same user logged into multiple groups will appear as
  // multiple providers — we operate on the first and group them by user_id
  // for logout below.
  const primary = useMemo(() => {
    for (const p of providers) {
      if (!isNewApiPlatform(p.platform)) continue;
      const account = getProviderAccount(p.id);
      if (account?.access_token) return { provider: p, account };
    }
    return null;
  }, [providers]);

  const loadProviders = useCallback(async () => {
    const list = await ipcBridge.mode.listProviders.invoke();
    setProviders(Array.isArray(list) ? list : []);
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (!primary) {
      setProfile(null);
      setBalance(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setProfileError(null);
    void (async () => {
      const [selfRes, balanceRes] = await Promise.all([
        ipcBridge.newApiAuth.getSelf.invoke({
          base_url: primary.provider.base_url,
          access_token: primary.account.access_token,
        }),
        ipcBridge.newApiAuth.fetchBalance.invoke({
          base_url: primary.provider.base_url,
          api_key: primary.provider.api_key,
        }),
      ]);
      if (cancelled) return;
      if (selfRes.success && selfRes.user) {
        setProfile(selfRes.user);
      } else {
        setProfileError(t(`settings.account.errors.${selfRes.code ?? 'unknown'}`));
      }
      setBalance(balanceRes);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [primary, t]);

  const sameAccountProviderIds = useMemo<string[]>(() => {
    if (!primary) return [];
    const uid = primary.account.user_id;
    const accounts = listProviderAccounts();
    const ids: string[] = [];
    for (const p of providers) {
      if (!isNewApiPlatform(p.platform)) continue;
      const acc = accounts[p.id];
      if (acc?.user_id === uid) ids.push(p.id);
    }
    return ids;
  }, [primary, providers]);

  const handleLogout = useCallback(async () => {
    setLogoutBusy(true);
    try {
      const idsToDelete =
        sameAccountProviderIds.length > 0 ? sameAccountProviderIds : primary ? [primary.provider.id] : [];
      for (const id of idsToDelete) {
        await ipcBridge.mode.deleteProvider.invoke({ id });
        deleteProviderAccount(id);
      }
      await refresh();
    } finally {
      setLogoutBusy(false);
      setLogoutOpen(false);
    }
  }, [primary, refresh, sameAccountProviderIds]);

  const passwordError = useMemo<string | null>(() => {
    if (!pwForm.current || !pwForm.next || !pwForm.confirm) return null;
    if (pwForm.next !== pwForm.confirm) return t('settings.account.password.mismatch');
    return null;
  }, [pwForm, t]);

  const passwordSubmittable = pwForm.current && pwForm.next && pwForm.confirm && !passwordError;

  const handleChangePassword = useCallback(async () => {
    if (!primary) return;
    if (!passwordSubmittable) return;
    setPasswordBusy(true);
    try {
      const res = await ipcBridge.newApiAuth.updatePassword.invoke({
        base_url: primary.provider.base_url,
        access_token: primary.account.access_token,
        username: primary.account.username,
        display_name: primary.account.display_name,
        original_password: pwForm.current,
        new_password: pwForm.next,
      });
      if (!res.success) {
        message.error(t(`settings.account.errors.${res.code ?? 'unknown'}`));
        return;
      }
      message.success(t('settings.account.password.successHint'));
      setPasswordOpen(false);
      setPwForm({ current: '', next: '', confirm: '' });
      // The sk-... api_key keeps working after a password change, but the
      // access_token may rotate on next login — recommend re-auth.
      for (const id of sameAccountProviderIds) {
        await ipcBridge.mode.deleteProvider.invoke({ id });
        deleteProviderAccount(id);
      }
      await refresh();
    } finally {
      setPasswordBusy(false);
    }
  }, [message, passwordSubmittable, primary, pwForm, refresh, sameAccountProviderIds, t]);

  const renderProfileCard = () => {
    if (!primary) {
      return (
        <div className='bg-1 border border-b-base rounded-12px p-32px text-center'>
          <User theme='outline' size={32} className='text-t-tertiary' />
          <div className='mt-12px text-14px text-t-secondary'>{t('settings.account.needRelogin')}</div>
          <div className='mt-16px'>
            <Button type='primary' onClick={() => setLogoutOpen(true)}>
              {t('settings.account.logout')}
            </Button>
          </div>
        </div>
      );
    }

    if (loading) {
      return (
        <div className='bg-1 border border-b-base rounded-12px p-48px flex items-center justify-center'>
          <Spin />
        </div>
      );
    }

    const username = profile?.username ?? primary.account.username;
    const displayName = profile?.display_name ?? primary.account.display_name ?? username;
    const group = profile?.group ?? '—';
    const quota = profile?.quota ?? 0;
    const used = profile?.used_quota ?? 0;
    const total = quota + used;
    const usedPercent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

    return (
      <div className='bg-1 border border-b-base rounded-12px p-24px'>
        <div className='flex items-center gap-16px mb-24px'>
          <div className='size-56px rounded-full bg-fill-3 flex items-center justify-center'>
            <User theme='outline' size={28} className='text-t-secondary' />
          </div>
          <div className='flex flex-col gap-2px'>
            <div className='text-18px font-semibold text-t-primary'>{displayName}</div>
            {displayName !== username && <div className='text-12px text-t-tertiary'>@{username}</div>}
            {profile?.email && <div className='text-12px text-t-tertiary'>{profile.email}</div>}
          </div>
        </div>

        {profileError && <div className='mb-16px text-12px text-warning'>{profileError}</div>}

        <div className='grid grid-cols-2 gap-16px mb-24px'>
          <InfoRow label={t('settings.account.username')} value={username} />
          <InfoRow label={t('settings.account.group')} value={group} />
          <InfoRow
            label={t('settings.account.balance')}
            value={renderBalance(balance, t)}
            icon={<Wallet theme='outline' size={14} />}
          />
          <InfoRow
            label={t('settings.account.usedQuota')}
            value={total > 0 ? `${used.toLocaleString()} / ${total.toLocaleString()}` : '—'}
          />
        </div>

        {total > 0 && (
          <div className='mb-24px'>
            <Progress percent={usedPercent} size='small' status={usedPercent >= 90 ? 'warning' : 'normal'} />
          </div>
        )}

        <div className='flex flex-wrap gap-12px'>
          <Button type='primary' icon={<Key theme='outline' size={14} />} onClick={() => setPasswordOpen(true)}>
            {t('settings.account.changePassword')}
          </Button>
          <Button status='danger' icon={<Logout theme='outline' size={14} />} onClick={() => setLogoutOpen(true)}>
            {t('settings.account.logout')}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <SettingsPageWrapper>
      {messageContext}
      <h1 className='text-22px font-semibold text-t-primary m-0 mb-16px'>{t('settings.account.title')}</h1>
      {renderProfileCard()}

      <Modal
        title={t('settings.account.password.title')}
        visible={passwordOpen}
        onCancel={() => {
          if (passwordBusy) return;
          setPasswordOpen(false);
          setPwForm({ current: '', next: '', confirm: '' });
        }}
        onOk={() => {
          void handleChangePassword();
        }}
        confirmLoading={passwordBusy}
        okButtonProps={{ disabled: !passwordSubmittable }}
        okText={t('settings.account.changePassword')}
      >
        <Form layout='vertical'>
          <Form.Item label={t('settings.account.password.current')} layout='vertical'>
            <Input.Password
              value={pwForm.current}
              onChange={(v) => setPwForm((f) => ({ ...f, current: v }))}
              autoComplete='current-password'
              disabled={passwordBusy}
            />
          </Form.Item>
          <Form.Item label={t('settings.account.password.new')} layout='vertical'>
            <Input.Password
              value={pwForm.next}
              onChange={(v) => setPwForm((f) => ({ ...f, next: v }))}
              autoComplete='new-password'
              disabled={passwordBusy}
            />
          </Form.Item>
          <Form.Item label={t('settings.account.password.confirm')} layout='vertical'>
            <Input.Password
              value={pwForm.confirm}
              onChange={(v) => setPwForm((f) => ({ ...f, confirm: v }))}
              autoComplete='new-password'
              disabled={passwordBusy}
            />
          </Form.Item>
          {passwordError && <div className='text-12px text-warning'>{passwordError}</div>}
        </Form>
      </Modal>

      <Modal
        title={t('settings.account.logoutConfirmTitle')}
        visible={logoutOpen}
        onCancel={() => {
          if (logoutBusy) return;
          setLogoutOpen(false);
        }}
        onOk={() => {
          void handleLogout();
        }}
        confirmLoading={logoutBusy}
        okButtonProps={{ status: 'danger' }}
        okText={t('settings.account.logout')}
      >
        <div className='text-14px text-t-secondary'>{t('settings.account.logoutConfirmBody')}</div>
      </Modal>
    </SettingsPageWrapper>
  );
};

const InfoRow: React.FC<{ label: string; value: React.ReactNode; icon?: React.ReactNode }> = ({
  label,
  value,
  icon,
}) => (
  <div className='flex flex-col gap-4px'>
    <div className='flex items-center gap-4px text-12px text-t-tertiary'>
      {icon}
      <span>{label}</span>
    </div>
    <div className='text-14px text-t-primary font-medium break-all'>{value}</div>
  </div>
);

const renderBalance = (balance: NewApiBalanceResult | null, t: (k: string) => string): React.ReactNode => {
  if (!balance) return '—';
  if (!balance.success) return t('settings.newApiLogin.balanceError');
  if (balance.unlimited) return t('settings.newApiLogin.balanceUnlimited');
  if (typeof balance.amount === 'number') return formatAmount(balance.amount);
  return '—';
};

export default AccountSettings;
