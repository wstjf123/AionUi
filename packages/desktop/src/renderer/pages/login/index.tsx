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
import { NEW_API_DEFAULT_BASE_URL, NEW_API_PLATFORM_ID } from '@/common/utils/platformConstants';
import type { NewApiGroup } from '@/common/types/provider/newApi';
import './LoginPage.css';

type MessageState = {
  type: 'error' | 'success';
  text: string;
};

const REMEMBER_ME_KEY = 'rememberMe';
const REMEMBERED_USERNAME_KEY = 'rememberedUsername';
const REMEMBERED_PASSWORD_KEY = 'rememberedPassword';

// Simple obfuscation for stored credentials (not cryptographically secure, but prevents plain text storage)
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

const LoginPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { status, refresh } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [message, setMessage] = useState<MessageState | null>(null);
  const [loading, setLoading] = useState(false);

  // step: 'credentials' (form) → 'groups' (after login, pick a group) → done
  const [step, setStep] = useState<'credentials' | 'groups'>('credentials');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [groups, setGroups] = useState<NewApiGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>('');

  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const messageTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.body.classList.add('login-page-active');
    return () => {
      document.body.classList.remove('login-page-active');
      if (messageTimer.current) {
        window.clearTimeout(messageTimer.current);
      }
    };
  }, []);

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
    window.setTimeout(() => {
      usernameRef.current?.focus();
    }, 0);

    return () => {
      if (messageTimer.current) {
        window.clearTimeout(messageTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (status === 'authenticated') {
      void navigate('/guid', { replace: true });
    }
  }, [navigate, status]);

  const clearMessageLater = useCallback(() => {
    if (messageTimer.current) {
      window.clearTimeout(messageTimer.current);
    }
    messageTimer.current = window.setTimeout(() => {
      setMessage((prev) => (prev?.type === 'success' ? prev : null));
    }, 5000);
  }, []);

  const showMessage = useCallback(
    (next: MessageState) => {
      setMessage(next);
      if (next.type === 'error') {
        clearMessageLater();
      }
    },
    [clearMessageLater]
  );

  const supportedLanguages = useMemo<{ code: string; label: string }[]>(
    () => [
      { code: 'zh-CN', label: '简体中文' },
      { code: 'zh-TW', label: '繁體中文' },
      { code: 'ja-JP', label: '日本語' },
      { code: 'ko-KR', label: '한국어' },
      { code: 'tr-TR', label: 'Türkçe' },
      { code: 'uk-UA', label: 'Українська' },
      { code: 'en-US', label: 'English' },
    ],
    []
  );

  const handleLanguageChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextLanguage = event.target.value;
    changeLanguage(nextLanguage).catch((error: Error) => {
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

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const trimmedUsername = username.trim();

      if (!trimmedUsername || !password) {
        showMessage({ type: 'error', text: t('login.errors.empty') });
        return;
      }

      setLoading(true);
      setMessage(null);

      try {
        const loginRes = await ipcBridge.newApiAuth.login.invoke({
          username: trimmedUsername,
          password,
        });
        if (!loginRes.success || !loginRes.session_id) {
          showMessage({
            type: 'error',
            text: errorTextForCode(loginRes.code, loginRes.message ?? t('login.errors.unknown')),
          });
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
          showMessage({
            type: 'error',
            text: errorTextForCode(groupsRes.code, groupsRes.message ?? t('login.errors.unknown')),
          });
          return;
        }
        const list = groupsRes.groups ?? [];
        setGroups(list);
        setSelectedGroup(list[0]?.name ?? '');
        setStep('groups');
      } finally {
        setLoading(false);
      }
    },
    [errorTextForCode, password, rememberMe, showMessage, t, username]
  );

  const handleConfirmGroup = useCallback(async () => {
    if (!sessionId || !selectedGroup) return;
    setLoading(true);
    setMessage(null);
    try {
      const provRes = await ipcBridge.newApiAuth.provision.invoke({
        session_id: sessionId,
        group: selectedGroup,
      });
      if (!provRes.success || !provRes.data) {
        showMessage({
          type: 'error',
          text: errorTextForCode(provRes.code, provRes.message ?? t('login.errors.unknown')),
        });
        return;
      }

      const data = provRes.data;
      const modelProtocols: Record<string, string> = {};
      for (const m of data.models) {
        modelProtocols[m] = detectNewApiProtocol(m);
      }

      try {
        await ipcBridge.mode.createProvider.invoke({
          id: uuid(),
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
        showMessage({ type: 'error', text: t('settings.newApiLogin.errors.unknown') });
        return;
      }

      void ipcBridge.newApiAuth.logout.invoke({ session_id: sessionId });

      showMessage({
        type: 'success',
        text: t('settings.newApiLogin.provisionSuccess', { group: data.group }),
      });

      await refresh();
    } finally {
      setLoading(false);
    }
  }, [errorTextForCode, refresh, selectedGroup, sessionId, showMessage, t]);

  const handleBackToCredentials = useCallback(() => {
    if (sessionId) {
      void ipcBridge.newApiAuth.logout.invoke({ session_id: sessionId });
    }
    setSessionId(null);
    setGroups([]);
    setSelectedGroup('');
    setStep('credentials');
    setMessage(null);
  }, [sessionId]);

  if (status === 'checking') {
    return <AppLoader />;
  }

  return (
    <div className='login-page'>
      <div className='login-page__card'>
        <label className='login-page__lang-select-wrapper' htmlFor='lang-select'>
          <select
            id='lang-select'
            className='login-page__lang-select'
            value={i18n.language}
            onChange={handleLanguageChange}
          >
            {supportedLanguages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
        </label>

        <div className='login-page__header'>
          <div className='login-page__logo'>
            <img src={loginLogo} alt={t('login.brand')} />
          </div>
          <h1 className='login-page__title'>{t('login.brand')}</h1>
          <p className='login-page__subtitle'>
            {step === 'credentials'
              ? t('settings.newApiLogin.endpointHint', { url: NEW_API_DEFAULT_BASE_URL })
              : t('settings.newApiLogin.groupHint')}
          </p>
        </div>

        {step === 'credentials' && (
          <form className='login-page__form' onSubmit={handleSubmit}>
            <div className='login-page__form-item'>
              <label className='login-page__label' htmlFor='username'>
                {t('login.username')}
              </label>
              <div className='login-page__input-wrapper'>
                <svg
                  className='login-page__input-icon'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  aria-hidden='true'
                >
                  <path d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' />
                  <circle cx='12' cy='7' r='4' />
                </svg>
                <input
                  ref={usernameRef}
                  id='username'
                  name='username'
                  className='login-page__input'
                  placeholder={t('login.usernamePlaceholder')}
                  autoComplete='username'
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  aria-required='true'
                />
              </div>
            </div>

            <div className='login-page__form-item'>
              <label className='login-page__label' htmlFor='password'>
                {t('login.password')}
              </label>
              <div className='login-page__input-wrapper'>
                <svg
                  className='login-page__input-icon'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  aria-hidden='true'
                >
                  <rect x='3' y='11' width='18' height='11' rx='2' ry='2' />
                  <path d='M7 11V7a5 5 0 0 1 10 0v4' />
                </svg>
                <input
                  ref={passwordRef}
                  id='password'
                  name='password'
                  type={passwordVisible ? 'text' : 'password'}
                  className='login-page__input'
                  placeholder={t('login.passwordPlaceholder')}
                  autoComplete='current-password'
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-required='true'
                />
                <button
                  type='button'
                  className='login-page__toggle-password'
                  onClick={() => setPasswordVisible((prev) => !prev)}
                  aria-label={passwordVisible ? t('login.hidePassword') : t('login.showPassword')}
                >
                  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'>
                    {passwordVisible ? (
                      <>
                        <path d='M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24' />
                        <line x1='1' y1='1' x2='23' y2='23' />
                      </>
                    ) : (
                      <>
                        <path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' />
                        <circle cx='12' cy='12' r='3' />
                      </>
                    )}
                  </svg>
                </button>
              </div>
            </div>

            <div className='login-page__checkbox'>
              <input
                type='checkbox'
                id='remember-me'
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
              />
              <label htmlFor='remember-me'>{t('login.rememberMe')}</label>
            </div>

            <button type='submit' className='login-page__submit' disabled={loading}>
              {loading && (
                <svg className='login-page__spinner' viewBox='0 0 24 24' width='18' height='18'>
                  <circle
                    cx='12'
                    cy='12'
                    r='10'
                    stroke='currentColor'
                    strokeWidth='3'
                    fill='none'
                    strokeDasharray='50'
                    strokeDashoffset='25'
                    strokeLinecap='round'
                  />
                </svg>
              )}
              <span>{loading ? t('login.submitting') : t('login.submit')}</span>
            </button>

            <div
              role='alert'
              aria-live='polite'
              className={`login-page__message ${message ? 'login-page__message--visible' : ''} ${message ? (message.type === 'success' ? 'login-page__message--success' : 'login-page__message--error') : ''}`}
              hidden={!message}
            >
              {message?.text}
            </div>
          </form>
        )}

        {step === 'groups' && (
          <div className='login-page__form'>
            <div className='login-page__form-item'>
              <label className='login-page__label' htmlFor='group-select'>
                {t('settings.newApiLogin.group')}
              </label>
              {groups.length === 0 ? (
                <div className='login-page__message login-page__message--visible login-page__message--error'>
                  {t('settings.newApiLogin.noGroups')}
                </div>
              ) : (
                <div className='login-page__input-wrapper'>
                  <select
                    id='group-select'
                    className='login-page__input'
                    value={selectedGroup}
                    onChange={(event) => setSelectedGroup(event.target.value)}
                  >
                    {groups.map((g) => (
                      <option key={g.name} value={g.name}>
                        {g.name}
                        {g.desc ? ` — ${g.desc}` : ''}
                        {g.ratio ? ` (${g.ratio})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <button
              type='button'
              className='login-page__submit'
              disabled={loading || !selectedGroup}
              onClick={handleConfirmGroup}
            >
              {loading && (
                <svg className='login-page__spinner' viewBox='0 0 24 24' width='18' height='18'>
                  <circle
                    cx='12'
                    cy='12'
                    r='10'
                    stroke='currentColor'
                    strokeWidth='3'
                    fill='none'
                    strokeDasharray='50'
                    strokeDashoffset='25'
                    strokeLinecap='round'
                  />
                </svg>
              )}
              <span>{loading ? t('login.submitting') : t('settings.newApiLogin.useGroup')}</span>
            </button>

            <button
              type='button'
              className='login-page__toggle-password'
              style={{ position: 'static', marginTop: 8, alignSelf: 'flex-start' }}
              onClick={handleBackToCredentials}
              disabled={loading}
            >
              <span>{t('settings.newApiLogin.switchAccount')}</span>
            </button>

            <div
              role='alert'
              aria-live='polite'
              className={`login-page__message ${message ? 'login-page__message--visible' : ''} ${message ? (message.type === 'success' ? 'login-page__message--success' : 'login-page__message--error') : ''}`}
              hidden={!message}
            >
              {message?.text}
            </div>
          </div>
        )}

        <div className='login-page__footer'>
          <div className='login-page__footer-content'>
            <span>{t('login.footerPrimary')}</span>
            <span className='login-page__footer-divider'>•</span>
            <span>{t('login.footerSecondary')}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
