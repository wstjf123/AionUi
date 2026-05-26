/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import loginLogo from '@renderer/assets/logos/brand/app.png';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage } from '@/renderer/services/i18n';
import { useNavigate } from 'react-router-dom';
import AppLoader from '@renderer/components/layout/AppLoader';
import { useAuth } from '../../hooks/context/AuthContext';
import { ipcBridge } from '@/common';
import { uuid } from '@/common/utils';
import { detectNewApiProtocol } from '@/renderer/utils/model/modelPlatforms';
import { saveProviderAccount } from '@/renderer/services/newApiAccountStore';
import { NEW_API_DEFAULT_BASE_URL, NEW_API_PLATFORM_ID } from '@/common/utils/platformConstants';
import type { NewApiGroup } from '@/common/types/provider/newApi';
import { Button, Checkbox, Form, Input, Message, Select } from '@arco-design/web-react';

const REMEMBER_ME_KEY = 'rememberMe';
const REMEMBERED_USERNAME_KEY = 'rememberedUsername';
const REMEMBERED_PASSWORD_KEY = 'rememberedPassword';

// Simple obfuscation for stored credentials. Not cryptographically secure, but
// keeps plaintext credentials out of localStorage on the disk.
const obfuscate = (text: string): string => {
  const encoded = btoa(encodeURIComponent(text));
  return encoded.split('').toReversed().join('');
};

const deobfuscate = (text: string): string => {
  try {
    const reversed = text.split('').toReversed().join('');
    return decodeURIComponent(atob(reversed));
  } catch {
    return '';
  }
};

const SUPPORTED_LANGUAGES: { code: string; label: string }[] = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'ko-KR', label: '한국어' },
  { code: 'tr-TR', label: 'Türkçe' },
  { code: 'uk-UA', label: 'Українська' },
  { code: 'en-US', label: 'English' },
];

const LoginPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { status, refresh, markLoggedIn } = useAuth();
  const [message, messageContext] = Message.useMessage();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);

  // 'credentials' → username/password form. 'groups' → group picker post-login.
  const [step, setStep] = useState<'credentials' | 'groups'>('credentials');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [groups, setGroups] = useState<NewApiGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>('');

  const initialFocusDone = useRef(false);

  useEffect(() => {
    document.title = t('login.pageTitle');
  }, [t]);

  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);

  useEffect(() => {
    const isRememberMe = localStorage.getItem(REMEMBER_ME_KEY) === 'true';
    if (isRememberMe) {
      const storedUsername = localStorage.getItem(REMEMBERED_USERNAME_KEY);
      const storedPassword = localStorage.getItem(REMEMBERED_PASSWORD_KEY);
      if (storedUsername) setUsername(deobfuscate(storedUsername));
      if (storedPassword) setPassword(deobfuscate(storedPassword));
      setRememberMe(true);
    }
    initialFocusDone.current = true;
  }, []);

  useEffect(() => {
    if (status === 'authenticated') {
      void navigate('/guid', { replace: true });
    }
  }, [navigate, status]);

  const handleLanguageChange = useCallback((next: string) => {
    changeLanguage(next).catch((error: Error) => {
      console.error('Failed to change language:', error);
    });
  }, []);

  const errorTextForCode = useCallback(
    (code: string | undefined, fallback: string): string => {
      const key = `settings.newApiLogin.errors.${code ?? 'unknown'}`;
      const translated = t(key);
      if (translated !== key) return translated;
      return fallback;
    },
    [t]
  );

  const handleLogin = useCallback(async () => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password) {
      message.error(t('login.errors.empty'));
      return;
    }

    setLoading(true);
    try {
      const loginRes = await ipcBridge.newApiAuth.login.invoke({
        username: trimmedUsername,
        password,
      });
      if (!loginRes.success || !loginRes.session_id) {
        message.error(errorTextForCode(loginRes.code, loginRes.message ?? t('login.errors.unknown')));
        return;
      }

      if (rememberMe) {
        localStorage.setItem(REMEMBER_ME_KEY, 'true');
        localStorage.setItem(REMEMBERED_USERNAME_KEY, obfuscate(trimmedUsername));
        localStorage.setItem(REMEMBERED_PASSWORD_KEY, obfuscate(password));
      } else {
        localStorage.removeItem(REMEMBER_ME_KEY);
        localStorage.removeItem(REMEMBERED_USERNAME_KEY);
        localStorage.removeItem(REMEMBERED_PASSWORD_KEY);
      }

      setSessionId(loginRes.session_id);

      const groupsRes = await ipcBridge.newApiAuth.fetchGroups.invoke({ session_id: loginRes.session_id });
      if (!groupsRes.success) {
        message.error(errorTextForCode(groupsRes.code, groupsRes.message ?? t('login.errors.unknown')));
        return;
      }
      const list = groupsRes.groups ?? [];
      setGroups(list);
      setSelectedGroup(list[0]?.name ?? '');
      setStep('groups');
    } finally {
      setLoading(false);
    }
  }, [errorTextForCode, message, password, rememberMe, t, username]);

  const handleConfirmGroup = useCallback(async () => {
    if (!sessionId || !selectedGroup) return;
    setLoading(true);
    try {
      const provRes = await ipcBridge.newApiAuth.provision.invoke({
        session_id: sessionId,
        group: selectedGroup,
      });
      if (!provRes.success || !provRes.data) {
        message.error(errorTextForCode(provRes.code, provRes.message ?? t('login.errors.unknown')));
        return;
      }

      const data = provRes.data;
      const modelProtocols: Record<string, string> = {};
      for (const m of data.models) {
        modelProtocols[m] = detectNewApiProtocol(m);
      }

      const providerId = uuid();
      try {
        await ipcBridge.mode.createProvider.invoke({
          id: providerId,
          platform: NEW_API_PLATFORM_ID,
          name: `New API · ${data.group}`,
          base_url: data.base_url,
          api_key: data.api_key,
          models: data.models,
          model_protocols: modelProtocols,
          enabled: true,
        });
      } catch (error) {
        console.error('Failed to create provider:', error);
        message.error(t('settings.newApiLogin.errors.unknown'));
        return;
      }

      // Stash account info locally — the providers API doesn't persist it.
      if (data.account) {
        saveProviderAccount(providerId, data.account);
      }

      void ipcBridge.newApiAuth.logout.invoke({ session_id: sessionId });

      message.success(t('settings.newApiLogin.provisionSuccess', { group: data.group }));
      markLoggedIn();
      await refresh();
    } finally {
      setLoading(false);
    }
  }, [errorTextForCode, message, refresh, selectedGroup, sessionId, t]);

  const handleBackToCredentials = useCallback(() => {
    if (sessionId) {
      void ipcBridge.newApiAuth.logout.invoke({ session_id: sessionId });
    }
    setSessionId(null);
    setGroups([]);
    setSelectedGroup('');
    setStep('credentials');
  }, [sessionId]);

  const subtitle = useMemo(
    () =>
      step === 'credentials'
        ? t('settings.newApiLogin.endpointHint', { url: NEW_API_DEFAULT_BASE_URL })
        : t('settings.newApiLogin.groupHint'),
    [step, t]
  );

  if (status === 'checking') {
    return <AppLoader />;
  }

  return (
    <div className='flex items-center justify-center min-h-100vh bg-base p-16px'>
      {messageContext}
      <div className='relative w-100% max-w-380px bg-1 border border-b-base rounded-12px shadow-lg p-32px'>
        <div className='absolute top-16px right-16px'>
          <Select
            size='mini'
            value={i18n.language}
            onChange={handleLanguageChange}
            style={{ width: 110 }}
            aria-label={t('login.languageToggle')}
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <Select.Option key={lang.code} value={lang.code}>
                {lang.label}
              </Select.Option>
            ))}
          </Select>
        </div>

        <div className='flex flex-col items-center gap-8px mb-24px'>
          <img src={loginLogo} alt={t('login.brand')} className='w-56px h-56px object-contain' />
          <h1 className='text-20px font-semibold text-t-primary m-0'>{t('login.brand')}</h1>
          <p className='text-12px text-t-secondary text-center m-0 leading-relaxed'>{subtitle}</p>
        </div>

        {step === 'credentials' && (
          <Form layout='vertical'>
            <Form.Item label={t('login.username')} layout='vertical'>
              <Input
                value={username}
                onChange={setUsername}
                placeholder={t('login.usernamePlaceholder')}
                autoComplete='username'
                disabled={loading}
                onPressEnter={() => {
                  if (!loading) void handleLogin();
                }}
              />
            </Form.Item>
            <Form.Item label={t('login.password')} layout='vertical'>
              <Input.Password
                value={password}
                onChange={setPassword}
                placeholder={t('login.passwordPlaceholder')}
                autoComplete='current-password'
                disabled={loading}
                onPressEnter={() => {
                  if (!loading) void handleLogin();
                }}
              />
            </Form.Item>
            <div className='mb-16px'>
              <Checkbox checked={rememberMe} onChange={setRememberMe} disabled={loading}>
                {t('login.rememberMe')}
              </Checkbox>
            </div>
            <Button type='primary' long loading={loading} onClick={() => void handleLogin()}>
              {loading ? t('login.submitting') : t('login.submit')}
            </Button>
          </Form>
        )}

        {step === 'groups' && (
          <div>
            <Form.Item
              label={t('settings.newApiLogin.group')}
              layout='vertical'
              extra={<span className='text-11px text-t-secondary'>{t('settings.newApiLogin.groupHint')}</span>}
            >
              <Select
                value={selectedGroup || undefined}
                onChange={setSelectedGroup}
                placeholder={t('settings.newApiLogin.groupPlaceholder')}
                disabled={loading || groups.length === 0}
                notFoundContent={t('settings.newApiLogin.noGroups')}
              >
                {groups.map((g) => (
                  <Select.Option key={g.name} value={g.name}>
                    <div className='flex items-center justify-between gap-12px'>
                      <span className='font-medium'>{g.name}</span>
                      <span className='text-11px text-t-secondary truncate'>
                        {g.desc || '-'}
                        {g.ratio ? ` · ${g.ratio}` : ''}
                      </span>
                    </div>
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
            <div className='flex gap-8px'>
              <Button
                type='primary'
                loading={loading}
                disabled={!selectedGroup}
                onClick={() => void handleConfirmGroup()}
                long
              >
                {t('settings.newApiLogin.useGroup')}
              </Button>
              <Button onClick={handleBackToCredentials} disabled={loading}>
                {t('settings.newApiLogin.switchAccount')}
              </Button>
            </div>
          </div>
        )}

        <div className='mt-24px pt-16px border-t border-b-base text-center text-11px text-t-tertiary'>
          <span>{t('login.footerPrimary')}</span>
          <span className='mx-8px'>•</span>
          <span>{t('login.footerSecondary')}</span>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
