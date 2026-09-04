import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PROVIDERS, PROVIDER_IDS, getProvider, maskKey } from '../ai/providers';
import { loadCredentials, saveCredential, clearCredential } from '../ai/keyStore';
import { listProviderModels, testLlmConnection } from '../ai/llmClient';

// Provider + key + model, in one panel. Used by the deck builder and by
// Settings → AI providers; both edit the same stored credentials, so a key
// entered in one place is available in the other.
//
// The panel writes to the key store as the user types (debounced) rather than
// hiding the key behind a Save button — a half-typed key is never usable
// anyway, and this way a run started tomorrow still has it.
function AiProviderPanel({ providerId, onProviderChange, onCredentialChange }) {
  const { t } = useTranslation();
  const [credentials, setCredentials] = useState(() => loadCredentials());
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState({ status: 'idle', message: '' });
  const [models, setModels] = useState(null);
  const [modelsState, setModelsState] = useState({ status: 'idle', message: '' });
  const saveTimer = useRef(null);

  const provider = getProvider(providerId);
  const credential = credentials[providerId];

  // Let the parent (and the run) see credential edits without re-reading storage.
  useEffect(() => {
    onCredentialChange?.(credential);
  }, [credential, onCredentialChange]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  function updateCredential(patch) {
    const next = { ...credential, ...patch, providerId };
    setCredentials((current) => ({ ...current, [providerId]: next }));
    setTestState({ status: 'idle', message: '' });
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveCredential(next), 400);
  }

  function handleForget() {
    clearCredential(providerId);
    setCredentials(loadCredentials());
    setTestState({ status: 'idle', message: '' });
    setModels(null);
  }

  async function handleTest() {
    setTestState({ status: 'working', message: '' });
    try {
      const result = await testLlmConnection(credential);
      setTestState({
        status: 'ok',
        message: `${result.providerLabel} answered as ${result.model} in ${(result.latencyMs / 1000).toFixed(1)}s${result.routedThroughProxy ? ' (via the relay)' : ''}.`,
      });
    } catch (error) {
      setTestState({ status: 'error', message: error.message });
    }
  }

  async function handleLoadModels() {
    setModelsState({ status: 'working', message: '' });
    try {
      const list = await listProviderModels(credential);
      setModels(list);
      setModelsState({
        status: list.length ? 'ok' : 'error',
        message: list.length ? t('provider.models_available', { count: list.length }) : t('provider.no_models_returned'),
      });
    } catch (error) {
      setModelsState({ status: 'error', message: error.message });
    }
  }

  const modelOptions = useMemo(() => {
    const suggested = provider.models ?? [];
    return [...new Set([...(models ?? []), ...suggested])];
  }, [models, provider.models]);

  const hasKey = Boolean(credential.apiKey);

  return (
    <div className="ai-provider">
      <div className="ai-provider__grid" role="radiogroup" aria-label={t('provider.title')}>
        {PROVIDER_IDS.map((id) => {
          const option = PROVIDERS[id];
          const stored = credentials[id];
          const isActive = id === providerId;
          return (
            <button
              type="button"
              key={id}
              role="radio"
              aria-checked={isActive}
              className={`ai-provider__option${isActive ? ' ai-provider__option--active' : ''}`}
              onClick={() => onProviderChange(id)}
            >
              <span className="ai-provider__option-head">
                <span className="ai-provider__option-name">{option.label}</span>
                {stored.apiKey ? (
                  <span className="st-chip">{t('provider.key_saved')}</span>
                ) : (
                  <span className="st-chip st-chip--muted">{t('provider.no_key')}</span>
                )}
              </span>
              <span className="ai-provider__option-blurb">{option.blurb}</span>
            </button>
          );
        })}
      </div>

      <div className="st-form__grid">
        <label className="st-field">
          <span className="st-field__label">{t('provider.api_key_for_provider', { label: provider.label })}</span>
          <div className="ai-provider__key">
            <input
              className="st-input"
              type={showKey ? 'text' : 'password'}
              value={credential.apiKey}
              onChange={(event) => updateCredential({ apiKey: event.target.value })}
              placeholder={provider.keyHint}
              autoComplete="off"
              spellCheck="false"
            />
            <button
              type="button"
              className="button button--secondary st-button--compact"
              onClick={() => setShowKey((current) => !current)}
              disabled={!hasKey}
            >
              {showKey ? t('provider.hide_key') : t('provider.show_key')}
            </button>
          </div>
          <span className="ai-provider__hint">
            {hasKey ? (
              <>
                {t('provider.stored_key_hint', {
                  scope: credential.scope === 'session' ? t('provider.scope_session') : t('provider.scope_device'),
                  masked: maskKey(credential.apiKey),
                })}{' '}
                <button type="button" className="ai-link" onClick={handleForget}>{t('provider.forget_key')}</button>
              </>
            ) : (
              <>
                {t('provider.paste_key_hint')}{' '}
                <a href={provider.keysUrl} target="_blank" rel="noreferrer">{t('provider.get_key_link', { label: provider.label })}</a>
              </>
            )}
          </span>
        </label>

        <label className="st-field">
          <span className="st-field__label">{t('provider.model_label')}</span>
          <input
            className="st-input"
            list={`ai-models-${providerId}`}
            value={credential.model}
            onChange={(event) => updateCredential({ model: event.target.value })}
            placeholder={provider.defaultModel}
            spellCheck="false"
          />
          <datalist id={`ai-models-${providerId}`}>
            {modelOptions.map((model) => <option key={model} value={model} />)}
          </datalist>
          <span className="ai-provider__hint">
            <button
              type="button"
              className="ai-link"
              onClick={handleLoadModels}
              disabled={!hasKey || modelsState.status === 'working'}
            >
              {modelsState.status === 'working' ? t('provider.loading_models') : t('provider.load_models')}
            </button>
            {modelsState.message ? <> — {modelsState.message}</> : null}
          </span>
        </label>
      </div>

      <div className="st-actions">
        <button
          type="button"
          className="button button--secondary st-button--compact"
          onClick={handleTest}
          disabled={!hasKey || testState.status === 'working'}
        >
          {testState.status === 'working' ? t('provider.testing') : t('provider.test_connection')}
        </button>
        {testState.status === 'ok' ? <span className="st-success">{testState.message}</span> : null}
        {testState.status === 'error' ? <span className="st-error">{testState.message}</span> : null}
      </div>

      <details className="ai-details">
        <summary>{t('provider.advanced_summary')}</summary>
        <div className="ai-details__body">
          <div className="st-row">
            <div className="st-row__info">
              <span className="st-row__label">{t('provider.keep_key_label')}</span>
              <span className="st-row__meta">
                {t('provider.keep_key_meta')}
              </span>
            </div>
            <label className="st-switch">
              <input
                type="checkbox"
                checked={credential.scope !== 'session'}
                onChange={(event) => updateCredential({ scope: event.target.checked ? 'device' : 'session' })}
                aria-label={t('provider.keep_key_label')}
              />
              <span className="st-switch__track" aria-hidden="true" />
            </label>
          </div>

          <div className="st-row">
            <div className="st-row__info">
              <span className="st-row__label">{t('provider.proxy_label')}</span>
              <span className="st-row__meta">
                {provider.direct
                  ? t('provider.proxy_direct_meta')
                  : t('provider.proxy_relay_meta', { label: provider.label })}
              </span>
            </div>
            <label className="st-switch">
              <input
                type="checkbox"
                checked={credential.useProxy}
                disabled={!provider.direct}
                onChange={(event) => updateCredential({ useProxy: event.target.checked })}
                aria-label={t('provider.proxy_label')}
              />
              <span className="st-switch__track" aria-hidden="true" />
            </label>
          </div>

          <label className="st-field">
            <span className="st-field__label">{t('provider.custom_url_label')}</span>
            <input
              className="st-input"
              value={credential.baseUrl}
              onChange={(event) => updateCredential({ baseUrl: event.target.value })}
              placeholder={provider.baseUrl}
              spellCheck="false"
            />
            <span className="ai-provider__hint">
              {t('provider.base_url_hint')}
            </span>
          </label>
        </div>
      </details>
    </div>
  );
}

export default AiProviderPanel;
