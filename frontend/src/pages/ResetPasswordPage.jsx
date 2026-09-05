import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '../supabaseClient';
import { updatePassword } from '../api';
import AuthBrandPanel from '../components/AuthBrandPanel';

function ResetPasswordPage() {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [hasRecoverySession, setHasRecoverySession] = useState(false);
  const [formData, setFormData] = useState({ password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // supabase-js parses the recovery token from the URL and establishes a
    // short-lived session (detectSessionInUrl + PASSWORD_RECOVERY event).
    supabase.auth.getSession().then(({ data }) => {
      setHasRecoverySession(Boolean(data.session));
      setReady(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) {
        setHasRecoverySession(true);
        setReady(true);
      }
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const handleChange = (e) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.password !== formData.confirmPassword) {
      setError(t('auth.passwords_dont_match'));
      return;
    }
    try {
      setIsLoading(true);
      setError('');
      await updatePassword(formData.password);
      setDone(true);
    } catch (err) {
      setError(err.message || t('auth.update_password_failed'));
    } finally {
      setIsLoading(false);
    }
  };

  let body;
  if (!ready) {
    body = (
      <>
        <h1 className="login-heading">{t('auth.one_moment')}</h1>
        <p className="login-body">{t('auth.validating_link')}</p>
      </>
    );
  } else if (done) {
    body = (
      <>
        <h1 className="login-heading">{t('auth.password_updated')}</h1>
        <p className="login-body">{t('auth.password_updated_body')}</p>
        <Link to="/" className="login-cta">{t('auth.go_to_decks')}</Link>
      </>
    );
  } else if (!hasRecoverySession) {
    body = (
      <>
        <h1 className="login-heading">{t('auth.link_expired')}</h1>
        <p className="login-body">{t('auth.link_expired_body')}</p>
        <Link to="/forgot-password" className="login-cta">{t('auth.request_new_link')}</Link>
      </>
    );
  } else {
    body = (
      <>
        <h1 className="login-heading">{t('auth.set_new_password_heading')}</h1>
        <p className="login-subheading">{t('auth.set_new_password_subheading')}</p>

        {error && <p className="login-error">{error}</p>}

        <form onSubmit={handleSubmit} className="login-form-heron">
          <label className="login-label-mono" htmlFor="reset-password">{t('auth.new_password')}</label>
          <input
            id="reset-password"
            type="password"
            name="password"
            value={formData.password}
            onChange={handleChange}
            placeholder={t('auth.password_min_placeholder')}
            className="login-input-heron"
            required
            minLength="6"
          />

          <label className="login-label-mono" htmlFor="reset-confirm">{t('auth.confirm_password')}</label>
          <input
            id="reset-confirm"
            type="password"
            name="confirmPassword"
            value={formData.confirmPassword}
            onChange={handleChange}
            placeholder={t('auth.confirm_password_placeholder')}
            className="login-input-heron"
            required
            minLength="6"
          />

          <button type="submit" className="login-cta" disabled={isLoading}>
            {isLoading ? t('auth.updating_password') : t('auth.update_password_cta')}
          </button>
        </form>
      </>
    );
  }

  return (
    <div className="login-split">
      <AuthBrandPanel
        quote={t('auth.brand_quote_reset')}
        tagline={t('auth.brand_tagline')}
      />

      <div className="login-split__right">
        {body}
      </div>
    </div>
  );
}

export default ResetPasswordPage;
