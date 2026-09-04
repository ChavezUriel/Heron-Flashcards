import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { register, loginWithGoogle } from '../api';
import AuthBrandPanel from '../components/AuthBrandPanel';

function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [formData, setFormData] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.password !== formData.confirmPassword) {
      setError(t('auth.passwords_dont_match'));
      return;
    }

    try {
      setIsLoading(true);
      setError('');
      const data = await register(formData.email, formData.name, formData.password);
      if (data.session) {
        // Email confirmation is disabled — the user is signed in immediately.
        navigate('/');
      } else {
        // Email confirmation is enabled — swap the form for a confirmation screen.
        setConfirmEmail(formData.email);
      }
    } catch (err) {
      setError(err.message || t('auth.registration_failed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogle = async () => {
    try {
      setError('');
      await loginWithGoogle();
    } catch (err) {
      setError(err.message || t('auth.google_signin_failed'));
    }
  };

  const handleChange = (e) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  return (
    <div className="login-split">
      <AuthBrandPanel
        quote={t('auth.brand_quote_register')}
        tagline={t('auth.brand_tagline')}
      />

      <div className="login-split__right">
        {confirmEmail ? (
          <>
            <h1 className="login-heading">{t('auth.check_inbox')}</h1>
            <p className="login-body">
              {t('auth.confirm_email_body', { email: confirmEmail })}
            </p>
            <Link to="/login" className="login-cta">{t('auth.go_to_login')}</Link>
          </>
        ) : (
        <>
        <h1 className="login-heading">{t('auth.create_account_heading')}</h1>
        <p className="login-subheading">{t('auth.create_account_subheading')}</p>

        {error && <p className="login-error">{error}</p>}

        <form onSubmit={handleSubmit} className="login-form-heron">
          <label className="login-label-mono" htmlFor="register-name">{t('auth.full_name')}</label>
          <input
            id="register-name"
            type="text"
            name="name"
            value={formData.name}
            onChange={handleChange}
            placeholder={t('auth.name_placeholder')}
            className="login-input-heron"
            required
          />

          <label className="login-label-mono" htmlFor="register-email">{t('auth.email')}</label>
          <input
            id="register-email"
            type="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            placeholder={t('auth.email_placeholder')}
            className="login-input-heron"
            required
          />

          <label className="login-label-mono" htmlFor="register-password">{t('auth.password')}</label>
          <input
            id="register-password"
            type="password"
            name="password"
            value={formData.password}
            onChange={handleChange}
            placeholder={t('auth.password_min_placeholder')}
            className="login-input-heron"
            required
            minLength="6"
          />

          <label className="login-label-mono" htmlFor="register-confirm">{t('auth.confirm_password')}</label>
          <input
            id="register-confirm"
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
            {isLoading ? t('auth.creating_account') : t('auth.create_account_cta')}
          </button>
        </form>

        <div className="auth-divider"><span>{t('common.or')}</span></div>

        <button type="button" onClick={handleGoogle} className="button button--google">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.5 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.2-4.8 3.2-7.8Z" />
            <path fill="#34A853" d="M12 23c2.9 0 5.4-1 7.2-2.6l-3.6-2.7c-1 .7-2.3 1.1-3.6 1.1-2.8 0-5.1-1.9-6-4.4H2.3v2.8A11 11 0 0 0 12 23Z" />
            <path fill="#FBBC05" d="M6 14.4a6.6 6.6 0 0 1 0-4.2V7.4H2.3a11 11 0 0 0 0 9.8L6 14.4Z" />
            <path fill="#EA4335" d="M12 5.6c1.6 0 3 .5 4.1 1.6l3.1-3.1A11 11 0 0 0 2.3 7.4L6 10.2c.9-2.6 3.2-4.6 6-4.6Z" />
          </svg>
          {t('auth.continue_with_google')}
        </button>

        <p className="login-signup-prompt">
          {t('auth.already_have_account')} <Link to="/login" className="login-signup-link">{t('auth.sign_in')}</Link>
        </p>
        </>
        )}
      </div>
    </div>
  );
}

export default RegisterPage;
