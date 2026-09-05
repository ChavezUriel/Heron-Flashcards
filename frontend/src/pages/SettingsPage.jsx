import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '../supabaseClient';
import {
  deleteAccount,
  ensureEmailIdentity,
  exportAccountData,
  fetchMe,
  fetchUserIdentities,
  hasPassword as fetchHasPassword,
  linkGoogleIdentity,
  requestPasswordReset,
  unlinkUserIdentity,
  updateNickname,
  updatePassword,
} from '../api';
import GoogleButton from '../components/GoogleButton';
import {
  isNotificationSupported,
  loadReminderSettings,
  requestNotificationPermission,
  saveReminderSettings,
} from '../notifications';
import { loadPracticeSettings, savePracticeSettings } from '../practiceSettings';
import { loadDepthStat, resetDepthStat } from '../depthStat';
import AiProviderPanel from '../components/AiProviderPanel';
import { loadBuilderPrefs, saveBuilderPrefs } from '../ai/keyStore';
import { useLocale, SUPPORTED_LOCALES } from '../context/LocaleContext';
import { getLanguage } from '../languages';
import CustomSelect from '../components/CustomSelect';

// OAuth failures (e.g. Google linking) come back appended to the redirect URL.
function readOAuthErrorFromUrl() {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const searchParams = new URLSearchParams(window.location.search);
  return hashParams.get('error_description') || searchParams.get('error_description') || '';
}

function AccountSection({ me, onNicknameSaved }) {
  const { t } = useTranslation();
  const { profileLocale, setProfileLocale, formatDate } = useLocale();
  const [nickname, setNickname] = useState(me.full_name);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [localeStatus, setLocaleStatus] = useState('idle');
  const [localeError, setLocaleError] = useState('');

  const trimmedNickname = nickname.trim();
  const isDirty = trimmedNickname !== me.full_name;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!trimmedNickname || !isDirty) {
      return;
    }
    setStatus('saving');
    setError('');
    try {
      await updateNickname(trimmedNickname);
      onNicknameSaved(trimmedNickname);
      setStatus('saved');
    } catch (saveError) {
      setError(saveError.message);
      setStatus('error');
    }
  }

  const memberSince = me.created_at
    ? formatDate(me.created_at, { year: 'numeric', month: 'long' })
    : null;

  return (
    <section className="panel st-section" aria-labelledby="st-account-title">
      <div>
        <h2 className="st-section__title" id="st-account-title">{t('settings.account.title')}</h2>
        <p className="st-section__hint">
          {t('settings.account.signed_in_as')} <strong>{me.email}</strong>
          {memberSince ? ` · ${t('settings.account.member_since', { date: memberSince })}` : ''}.
        </p>
      </div>

      <form className="st-form" onSubmit={handleSubmit}>
        <label className="st-field">
          <span className="st-field__label">{t('settings.account.nickname_label')}</span>
          <input
            className="st-input"
            type="text"
            value={nickname}
            onChange={(event) => {
              setNickname(event.target.value);
              setStatus('idle');
            }}
            maxLength={60}
            autoComplete="nickname"
            required
          />
        </label>
        <div className="st-actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={status === 'saving' || !trimmedNickname || !isDirty}
          >
            {status === 'saving' ? t('settings.account.saving') : t('settings.account.save_nickname')}
          </button>
          {status === 'saved' ? <span className="st-success">{t('settings.account.nickname_updated')}</span> : null}
          {status === 'error' ? <span className="st-error">{error}</span> : null}
        </div>
      </form>

      <div className="st-form" style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))', paddingTop: '1.5rem' }}>
        <div className="st-field">
          <span className="st-field__label">{t('settings.account.language_label')}</span>
          <CustomSelect
            value={profileLocale || ''}
            onChange={async (nextVal) => {
              const nextLocale = nextVal || null;
              setLocaleStatus('saving');
              setLocaleError('');
              try {
                await setProfileLocale(nextLocale);
                setLocaleStatus('saved');
              } catch (err) {
                setLocaleError(err?.message || 'Failed to update UI language');
                setLocaleStatus('error');
              }
            }}
            placeholder={t('settings.account.language_follow_deck')}
            options={[
              { value: '', label: t('settings.account.language_follow_deck') },
              ...SUPPORTED_LOCALES.map((loc) => {
                const lang = getLanguage(loc);
                const label = lang ? (lang.endonym !== lang.name ? `${lang.name} (${lang.endonym})` : lang.name) : loc;
                return { value: loc, label };
              }),
            ]}
            ariaLabel={t('settings.account.language_label')}
          />
          <span className="st-section__hint" style={{ marginTop: '0.25rem' }}>
            {!profileLocale
              ? t('settings.account.language_auto_hint')
              : t('settings.account.language_explicit_hint')}
          </span>
        </div>
        {localeStatus === 'saved' ? <span className="st-success">{t('settings.account.language_updated')}</span> : null}
        {localeStatus === 'error' ? <span className="st-error">{localeError}</span> : null}
      </div>
    </section>
  );
}

function SecuritySection({ me, identities, hasPassword, onIdentitiesChanged, onPasswordChanged }) {
  const { t } = useTranslation();
  const googleIdentity = identities.find((identity) => identity.provider === 'google');
  const emailIdentity = identities.find((identity) => identity.provider === 'email');
  // A password is a valid second way to sign in even when Supabase never created
  // an `email` identity for it, so it also permits unlinking Google.
  const canUnlinkGoogle = Boolean(googleIdentity) && (hasPassword || identities.length > 1);

  const [linkError, setLinkError] = useState('');
  const [isLinking, setIsLinking] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);

  const [passwordForm, setPasswordForm] = useState({ password: '', confirmPassword: '' });
  const [passwordStatus, setPasswordStatus] = useState('idle');
  const [passwordError, setPasswordError] = useState('');
  const [resetStatus, setResetStatus] = useState('idle');

  async function handleLinkGoogle() {
    setLinkError('');
    setIsLinking(true);
    try {
      // Redirects to Google on success, so we normally never reach the end.
      await linkGoogleIdentity();
    } catch (linkFailure) {
      setLinkError(linkFailure.message);
      setIsLinking(false);
    }
  }

  async function handleUnlinkGoogle() {
    setLinkError('');
    setIsUnlinking(true);
    try {
      // GoTrue refuses to unlink unless the account keeps >= 2 identities. A
      // Google-first user with a password has no `email` identity, so create it
      // first — this makes the password a real, standalone way to sign in.
      if (!emailIdentity && hasPassword) {
        await ensureEmailIdentity();
        await onIdentitiesChanged();
      }
      await unlinkUserIdentity(googleIdentity);
      await onIdentitiesChanged();
    } catch (unlinkFailure) {
      setLinkError(unlinkFailure.message);
    } finally {
      setIsUnlinking(false);
    }
  }

  async function handlePasswordSubmit(event) {
    event.preventDefault();
    if (passwordForm.password !== passwordForm.confirmPassword) {
      setPasswordError(t('auth.passwords_dont_match'));
      setPasswordStatus('error');
      return;
    }
    setPasswordStatus('saving');
    setPasswordError('');
    try {
      await updatePassword(passwordForm.password);
      setPasswordForm({ password: '', confirmPassword: '' });
      setPasswordStatus('saved');
      // Supabase does not create an `email` identity when a Google-first user
      // sets a password, so add one — this enables email sign-in and later
      // Google unlinking. Best-effort: never fail a saved password over it.
      try {
        await ensureEmailIdentity();
      } catch {
        // ignore — the password was still saved
      }
      await Promise.all([onIdentitiesChanged(), onPasswordChanged()]);
    } catch (updateFailure) {
      setPasswordError(updateFailure.message);
      setPasswordStatus('error');
    }
  }

  async function handleSendResetEmail() {
    setResetStatus('sending');
    try {
      await requestPasswordReset(me.email);
      setResetStatus('sent');
    } catch {
      setResetStatus('error');
    }
  }

  return (
    <section className="panel st-section" aria-labelledby="st-security-title">
      <div>
        <h2 className="st-section__title" id="st-security-title">{t('settings.security.title')}</h2>
        <p className="st-section__hint">{t('settings.security.hint')}</p>
      </div>

      <ul className="st-identity-list">
        <li className="st-identity">
          <div className="st-identity__info">
            <span className="st-identity__name">{t('settings.security.email_password')}</span>
            <span className="st-identity__meta">
              {hasPassword ? me.email : t('settings.security.not_set_up')}
            </span>
          </div>
          {hasPassword
            ? <span className="st-chip">{t('settings.security.active')}</span>
            : <span className="st-chip st-chip--muted">{t('settings.security.off')}</span>}
        </li>
        <li className="st-identity">
          <div className="st-identity__info">
            <span className="st-identity__name">{t('settings.security.google')}</span>
            <span className="st-identity__meta">
              {googleIdentity ? (googleIdentity.identity_data?.email || t('settings.security.connected')) : t('settings.security.not_linked')}
            </span>
          </div>
          {googleIdentity ? (
            <div className="st-actions">
              <span className="st-chip">{t('settings.security.linked')}</span>
              <button
                type="button"
                className="button button--secondary st-button--compact"
                onClick={handleUnlinkGoogle}
                disabled={!canUnlinkGoogle || isUnlinking}
              >
                {isUnlinking ? t('settings.security.unlinking') : t('settings.security.unlink')}
              </button>
            </div>
          ) : (
            <GoogleButton onClick={handleLinkGoogle} label={isLinking ? t('settings.security.redirecting') : t('settings.security.link_google')} />
          )}
        </li>
      </ul>
      {googleIdentity && !canUnlinkGoogle ? (
        <p className="st-note">{t('settings.security.google_only_note')}</p>
      ) : null}
      {linkError ? <p className="st-error">{linkError}</p> : null}

      <form className="st-form" onSubmit={handlePasswordSubmit}>
        <div>
          <h3 className="st-subtitle">{hasPassword ? t('settings.security.change_password_title') : t('settings.security.set_password_title')}</h3>
          {!hasPassword ? (
            <p className="st-section__hint">
              {t('settings.security.google_add_password_hint')}
            </p>
          ) : null}
        </div>
        <div className="st-form__grid">
          <label className="st-field">
            <span className="st-field__label">{t('settings.security.new_password_label')}</span>
            <input
              className="st-input"
              type="password"
              value={passwordForm.password}
              onChange={(event) => setPasswordForm((current) => ({ ...current, password: event.target.value }))}
              placeholder={t('settings.security.password_placeholder')}
              minLength={6}
              autoComplete="new-password"
              required
            />
          </label>
          <label className="st-field">
            <span className="st-field__label">{t('settings.security.confirm_password_label')}</span>
            <input
              className="st-input"
              type="password"
              value={passwordForm.confirmPassword}
              onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))}
              placeholder={t('settings.security.confirm_password_placeholder')}
              minLength={6}
              autoComplete="new-password"
              required
            />
          </label>
        </div>
        <div className="st-actions">
          <button type="submit" className="button button--primary" disabled={passwordStatus === 'saving'}>
            {passwordStatus === 'saving' ? t('settings.security.updating') : hasPassword ? t('settings.security.update_password') : t('settings.security.set_password')}
          </button>
          <button
            type="button"
            className="st-link-button"
            onClick={handleSendResetEmail}
            disabled={resetStatus === 'sending' || resetStatus === 'sent'}
          >
            {resetStatus === 'sent'
              ? t('settings.security.reset_link_sent', { email: me.email })
              : resetStatus === 'sending'
                ? t('settings.security.sending_reset')
                : t('settings.security.or_email_reset')}
          </button>
        </div>
        {passwordStatus === 'saved' ? <p className="st-success">{t('settings.security.password_updated')}</p> : null}
        {passwordStatus === 'error' ? <p className="st-error">{passwordError}</p> : null}
        {resetStatus === 'error' ? <p className="st-error">{t('settings.security.could_not_send_reset')}</p> : null}
      </form>
    </section>
  );
}

function NotificationsSection() {
  const { t } = useTranslation();
  const supported = isNotificationSupported();
  const [reminderSettings, setReminderSettings] = useState(() => loadReminderSettings());
  const [permission, setPermission] = useState(supported ? Notification.permission : 'unsupported');

  async function handleToggleReminder() {
    if (reminderSettings.enabled) {
      const nextSettings = { ...reminderSettings, enabled: false };
      setReminderSettings(nextSettings);
      saveReminderSettings(nextSettings);
      return;
    }

    const nextPermission = await requestNotificationPermission();
    setPermission(nextPermission);
    if (nextPermission !== 'granted') {
      return;
    }

    const nextSettings = { ...reminderSettings, enabled: true };
    setReminderSettings(nextSettings);
    saveReminderSettings(nextSettings);
  }

  return (
    <section className="panel st-section" aria-labelledby="st-notifications-title">
      <div>
        <h2 className="st-section__title" id="st-notifications-title">{t('settings.notifications.title')}</h2>
        <p className="st-section__hint">{t('settings.notifications.hint')}</p>
      </div>

      <div className="st-row">
        <div className="st-row__info">
          <span className="st-row__label">{t('settings.notifications.daily_reminder_label')}</span>
          <span className="st-row__meta">
            {t('settings.notifications.daily_reminder_meta')}
          </span>
        </div>
        <label className="st-switch">
          <input
            type="checkbox"
            checked={reminderSettings.enabled}
            onChange={handleToggleReminder}
            disabled={!supported}
            aria-label={t('settings.notifications.toggle_reminder_aria')}
          />
          <span className="st-switch__track" aria-hidden="true" />
        </label>
      </div>

      {!supported ? (
        <p className="st-note">{t('settings.notifications.unsupported')}</p>
      ) : null}
      {supported && permission === 'denied' ? (
        <p className="st-note">
          {t('settings.notifications.denied')}
        </p>
      ) : null}
    </section>
  );
}

const MINIGAME_FREQUENCY_OPTIONS = [
  { value: 'off', label: 'Off — classic flashcard only' },
  { value: 'light', label: 'Light' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'heavy', label: 'Heavy' },
];

// Presentation metadata for each game key in settings.minigames.games. `counts`
// drives the Tier-A "Counts toward scheduling" vs practice-only badge. Keys added
// here as each rollout phase ships a game; unknown keys fall back to the raw key.
const MINIGAME_META = {
  type_translation: {
    label: 'Type the translation',
    description: 'Type the English for the Spanish prompt. Correct or wrong, it grades the card just like a swipe.',
    counts: true,
  },
  recall_from_definition: {
    label: 'Recall from definition',
    description: 'Read the English definition and type the word it describes. Like a swipe, it grades the card.',
    counts: true,
  },
  cloze_free: {
    label: 'Fill in the blank',
    description: 'Type the missing word in an example sentence. You produce the answer from memory, so it grades the card like a swipe.',
    counts: true,
  },
  multiple_choice: {
    label: 'Multiple choice',
    description: 'Pick the English translation from a few options. A wrong pick reschedules the card, but a correct pick never changes when it’s next due.',
    counts: false,
  },
  word_bank_cloze: {
    label: 'Word-bank cloze',
    description: 'Pick the missing word in an example sentence from a bank of options. A wrong pick reschedules the card; a correct pick never changes when it’s next due.',
    counts: false,
  },
  reverse_mc: {
    label: 'Reverse multiple choice',
    description: 'See the English answer and pick the matching Spanish word. A wrong pick reschedules the card; a correct pick never changes when it’s next due.',
    counts: false,
  },
  memory_grid: {
    label: 'Memory grid',
    description: 'Match Spanish words to their English answers in a quick warm-up or cool-down. Purely for fun — it never changes your schedule.',
    counts: false,
  },
  synonym_match: {
    label: 'Synonym match',
    description: 'In a cool-down, pick the words that share a meaning with an answer. Builds your vocabulary-depth stat — a different skill that never changes when a card is next due.',
    counts: false,
  },
  speed_round: {
    label: 'Speed round',
    description: 'A fast burst of multiple-choice questions between rounds. Just for practice — it never changes when a card is next due.',
    counts: false,
  },
  scramble: {
    label: 'Word scramble',
    description: 'Unscramble the letters of a word as a quick cool-down. Purely for fun — it never changes your schedule.',
    counts: false,
  },
  hangman: {
    label: 'Hangman',
    description: 'Guess a word letter by letter as a cool-down. Purely for fun — it never changes your schedule.',
    counts: false,
  },
  listening: {
    label: 'Listening',
    description: 'Hear a brand-new word read aloud, then reveal how it’s spelled. Practice only — it never changes when a card is next due.',
    counts: false,
  },
};

function MinigamesSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(() => loadPracticeSettings());
  const [depthStat, setDepthStat] = useState(() => loadDepthStat());
  const minigames = settings.minigames;
  const gameEntries = Object.entries(minigames.games ?? {});

  function handleResetDepth() {
    setDepthStat(resetDepthStat());
  }

  // Persist the whole practice-settings blob so the other practice settings
  // (block sizes, focus mode, …) survive alongside the minigame changes.
  function persistMinigames(nextMinigames) {
    setSettings((current) => {
      const nextSettings = { ...current, minigames: nextMinigames };
      savePracticeSettings(nextSettings);
      return nextSettings;
    });
  }

  return (
    <section className="panel st-section" aria-labelledby="st-minigames-title">
      <div>
        <h2 className="st-section__title" id="st-minigames-title">{t('settings.minigames.title')}</h2>
        <p className="st-section__hint">
          {t('settings.minigames.hint')}
        </p>
      </div>

      <div className="st-row">
        <div className="st-row__info">
          <span className="st-row__label">{t('settings.minigames.enable_label')}</span>
          <span className="st-row__meta">
            {t('settings.minigames.enable_meta')}
          </span>
        </div>
        <label className="st-switch">
          <input
            type="checkbox"
            checked={minigames.enabled}
            onChange={() => persistMinigames({ ...minigames, enabled: !minigames.enabled })}
            aria-label={t('settings.minigames.toggle_minigames_aria')}
          />
          <span className="st-switch__track" aria-hidden="true" />
        </label>
      </div>

      <div className="st-field">
        <span className="st-field__label">{t('settings.minigames.frequency_label')}</span>
        <CustomSelect
          value={minigames.frequency}
          onChange={(frequency) => persistMinigames({ ...minigames, frequency })}
          disabled={!minigames.enabled}
          options={MINIGAME_FREQUENCY_OPTIONS.map((option) => ({
            value: option.value,
            label:
              option.value === 'off'
                ? t('settings.minigames.freq_off')
                : option.value === 'light'
                ? t('settings.minigames.freq_light')
                : option.value === 'balanced'
                ? t('settings.minigames.freq_balanced')
                : t('settings.minigames.freq_heavy'),
          }))}
          ariaLabel={t('settings.minigames.frequency_label')}
        />
      </div>

      <div>
        <h3 className="st-subtitle">{t('settings.minigames.games_subtitle')}</h3>
        {gameEntries.length === 0 ? (
          <p className="st-note">
            {t('settings.minigames.no_games')}
          </p>
        ) : (
          <ul className={`st-minigame-list${minigames.enabled ? '' : ' st-minigame-list--disabled'}`}>
            {gameEntries.map(([key, isOn]) => {
              const meta = MINIGAME_META[key] ?? { label: key, description: '', counts: false };
              const gameLabel = t(`settings.minigames.meta.${key}_label`, { defaultValue: meta.label });
              const gameDesc = t(`settings.minigames.meta.${key}_desc`, { defaultValue: meta.description });
              return (
                <li className="st-row" key={key}>
                  <div className="st-row__info">
                    <span className="st-row__label">{gameLabel}</span>
                    {gameDesc ? <span className="st-row__meta">{gameDesc}</span> : null}
                    <span className={`st-chip st-minigame-badge${meta.counts ? '' : ' st-chip--muted'}`}>
                      {meta.counts ? t('settings.minigames.counts_badge') : t('settings.minigames.practice_only_badge')}
                    </span>
                  </div>
                  <label className="st-switch">
                    <input
                      type="checkbox"
                      checked={Boolean(isOn)}
                      disabled={!minigames.enabled}
                      onChange={() =>
                        persistMinigames({
                          ...minigames,
                          games: { ...minigames.games, [key]: !isOn },
                        })
                      }
                      aria-label={t('settings.minigames.toggle_game_aria', { name: gameLabel })}
                    />
                    <span className="st-switch__track" aria-hidden="true" />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="st-depth">
        <h3 className="st-subtitle">{t('settings.minigames.depth_subtitle')}</h3>
        {depthStat.rounds > 0 ? (
          <>
            <p className="st-section__hint">
              {t('settings.minigames.depth_hint', { matched: depthStat.matched, rounds: depthStat.rounds })}
            </p>
            <div className="st-actions">
              <button type="button" className="button button--secondary st-button--compact" onClick={handleResetDepth}>
                {t('settings.minigames.reset_depth_btn')}
              </button>
            </div>
          </>
        ) : (
          <p className="st-section__hint">
            {t('settings.minigames.depth_hint_empty')}
          </p>
        )}
      </div>
    </section>
  );
}

// Provider keys live here as well as in the builder — both edit the same store,
// so a key added on either screen is available on the other.
function AiSection() {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState(() => loadBuilderPrefs());

  return (
    <section className="panel st-section" aria-labelledby="st-ai-title">
      <div>
        <h2 className="st-section__title" id="st-ai-title">{t('settings.ai.title')}</h2>
        <p className="st-section__hint">
          {t('settings.ai.hint')}
        </p>
      </div>

      <AiProviderPanel
        providerId={prefs.providerId}
        onProviderChange={(providerId) => {
          const next = { ...prefs, providerId };
          setPrefs(next);
          saveBuilderPrefs(next);
        }}
      />

      <div className="st-actions">
        <Link className="button button--primary st-button--compact" to="/decks/new">{t('settings.ai.build_deck_btn')}</Link>
      </div>
    </section>
  );
}

function DataSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  async function handleExport() {
    setStatus('working');
    setError('');
    try {
      const data = await exportAccountData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `heron-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setStatus('done');
    } catch (exportError) {
      setError(exportError.message);
      setStatus('error');
    }
  }

  return (
    <section className="panel st-section" aria-labelledby="st-data-title">
      <div>
        <h2 className="st-section__title" id="st-data-title">{t('settings.data.title')}</h2>
        <p className="st-section__hint">
          {t('settings.data.hint')}
        </p>
      </div>
      <div className="st-actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={handleExport}
          disabled={status === 'working'}
        >
          {status === 'working' ? t('settings.data.preparing') : t('settings.data.export_btn')}
        </button>
        {status === 'done' ? <span className="st-success">{t('settings.data.downloaded')}</span> : null}
        {status === 'error' ? <span className="st-error">{error}</span> : null}
      </div>
    </section>
  );
}

function DangerSection({ email }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  const isConfirmed = confirmText.trim().toUpperCase() === 'DELETE';

  async function handleDeleteAccount() {
    setStatus('deleting');
    setError('');
    try {
      await deleteAccount();
      try {
        // The server session died with the account; only clear local state.
        await supabase.auth.signOut({ scope: 'local' });
      } catch {
        /* already signed out */
      }
      navigate('/login', { replace: true });
    } catch (deleteError) {
      setError(deleteError.message);
      setStatus('idle');
    }
  }

  return (
    <section className="panel st-section st-section--danger" aria-labelledby="st-danger-title">
      <div>
        <h2 className="st-section__title st-section__title--danger" id="st-danger-title">{t('settings.danger.title')}</h2>
        <p className="st-section__hint">
          {t('settings.danger.hint', { email })}
        </p>
      </div>

      {isConfirmOpen ? (
        <div className="st-confirm">
          <label className="st-field">
            <span className="st-field__label">{t('settings.danger.confirm_label')}</span>
            <input
              className="st-input"
              type="text"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={t('settings.danger.confirm_placeholder')}
              autoComplete="off"
            />
          </label>
          <div className="st-actions">
            <button
              type="button"
              className="button button--danger"
              onClick={handleDeleteAccount}
              disabled={!isConfirmed || status === 'deleting'}
            >
              {status === 'deleting' ? t('settings.danger.deleting') : t('settings.danger.permanently_delete')}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setIsConfirmOpen(false);
                setConfirmText('');
                setError('');
              }}
              disabled={status === 'deleting'}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="st-actions">
          <button type="button" className="button button--danger" onClick={() => setIsConfirmOpen(true)}>
            {t('settings.danger.delete_account_btn')}
          </button>
        </div>
      )}
      {error ? <p className="st-error">{error}</p> : null}
    </section>
  );
}

// Stroke icons for the settings sidebar, matching the app's 24×24 currentColor style.
const ICON_PROPS = {
  viewBox: '0 0 24 24',
  width: 18,
  height: 18,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const SECTION_ICONS = {
  account: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5" />
    </svg>
  ),
  security: (
    <svg {...ICON_PROPS}>
      <path d="M12 3 5 6v5c0 4.4 3 7.7 7 9 4-1.3 7-4.6 7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  notifications: (
    <svg {...ICON_PROPS}>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10.5 20a1.5 1.5 0 0 0 3 0" />
    </svg>
  ),
  minigames: (
    <svg {...ICON_PROPS}>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
  data: (
    <svg {...ICON_PROPS}>
      <path d="M12 4v9" />
      <path d="m8.5 10 3.5 3.5 3.5-3.5" />
      <path d="M5 15v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
    </svg>
  ),
  ai: (
    <svg {...ICON_PROPS}>
      <path d="M12 3.5 13.7 8l4.5 1.7-4.5 1.7L12 15.9l-1.7-4.5L5.8 9.7 10.3 8z" />
      <path d="M17.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  ),
  danger: (
    <svg {...ICON_PROPS}>
      <path d="M12 4.5 3.5 19a1 1 0 0 0 .9 1.5h15.2a1 1 0 0 0 .9-1.5z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  ),
};

// Drives the sidebar order/labels; each id maps to a renderer in SettingsPage.
const SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'security', label: 'Sign-in & security' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'minigames', label: 'Minigames' },
  { id: 'ai', label: 'AI deck builder' },
  { id: 'data', label: 'Your data' },
  { id: 'danger', label: 'Danger zone', danger: true },
];

function SettingsPage() {
  const { t } = useTranslation();
  const [me, setMe] = useState(null);
  const [identities, setIdentities] = useState([]);
  const [passwordSet, setPasswordSet] = useState(false);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [activeSection, setActiveSection] = useState('account');
  // Read once per mount; the params disappear on the next in-app navigation.
  const [oauthError] = useState(readOAuthErrorFromUrl);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [nextMe, nextIdentities] = await Promise.all([fetchMe(), fetchUserIdentities()]);
        // The has_password RPC is the source of truth, but fall back to the old
        // identity heuristic so the page still loads if it isn't deployed yet.
        let nextHasPassword;
        try {
          nextHasPassword = await fetchHasPassword();
        } catch {
          nextHasPassword = nextIdentities.some((identity) => identity.provider === 'email');
        }
        if (!cancelled) {
          setMe(nextMe);
          setIdentities(nextIdentities);
          setPasswordSet(nextHasPassword);
          setStatus('ready');
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus('error');
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshIdentities() {
    setIdentities(await fetchUserIdentities());
  }

  async function refreshPasswordState() {
    setPasswordSet(await fetchHasPassword());
  }

  if (status === 'loading') {
    return <p className="h-empty-state">{t('settings.loading')}</p>;
  }

  if (status === 'error') {
    return <p className="h-empty-state h-empty-state--error">{t('settings.load_error', { error })}</p>;
  }

  function renderSection() {
    switch (activeSection) {
      case 'account':
        return (
          <AccountSection
            me={me}
            onNicknameSaved={(name) => setMe((current) => ({ ...current, full_name: name }))}
          />
        );
      case 'security':
        return (
          <SecuritySection
            me={me}
            identities={identities}
            hasPassword={passwordSet}
            onIdentitiesChanged={refreshIdentities}
            onPasswordChanged={refreshPasswordState}
          />
        );
      case 'notifications':
        return <NotificationsSection />;
      case 'minigames':
        return <MinigamesSection />;
      case 'ai':
        return <AiSection />;
      case 'data':
        return <DataSection />;
      case 'danger':
        return <DangerSection email={me.email} />;
      default:
        return null;
    }
  }

  return (
    <div className="st-page">
      <div className="st-header">
        <p className="st-kicker">{t('settings.kicker')}</p>
        <h1 className="st-header__title">{t('settings.title')}</h1>
      </div>

      {oauthError ? (
        <p className="st-banner st-banner--error">{t('settings.oauth_error', { error: oauthError })}</p>
      ) : null}

      <div className="st-layout">
        <nav className="st-nav panel" aria-label={t('settings.nav_aria')}>
          {SECTIONS.map((section) => {
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                className={`st-nav__item${isActive ? ' st-nav__item--active' : ''}${
                  section.danger ? ' st-nav__item--danger' : ''
                }`}
                onClick={() => setActiveSection(section.id)}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className="st-nav__icon" aria-hidden="true">{SECTION_ICONS[section.id]}</span>
                <span>{t(`settings.sections.${section.id}`)}</span>
              </button>
            );
          })}
        </nav>

        <div className="st-content">{renderSection()}</div>
      </div>
    </div>
  );
}

export default SettingsPage;
