import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { requestPasswordReset } from '../api';
import AuthBrandPanel from '../components/AuthBrandPanel';

function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setIsLoading(true);
      setError('');
      await requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError(err.message || t('auth.reset_email_failed'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-split">
      <AuthBrandPanel
        quote={t('auth.brand_quote_forgot')}
        tagline={t('auth.brand_tagline')}
      />

      <div className="login-split__right">
        {sent ? (
          <>
            <h1 className="login-heading">{t('auth.check_inbox')}</h1>
            <p className="login-body">
              {t('auth.reset_email_sent', { email })}
            </p>
            <Link to="/login" className="login-cta">{t('nav.back_to_login')}</Link>
          </>
        ) : (
          <>
            <h1 className="login-heading">{t('auth.reset_password_heading')}</h1>
            <p className="login-subheading">{t('auth.reset_password_subheading')}</p>

            {error && <p className="login-error">{error}</p>}

            <form onSubmit={handleSubmit} className="login-form-heron">
              <label className="login-label-mono" htmlFor="forgot-email">{t('auth.email')}</label>
              <input
                id="forgot-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('auth.email_placeholder')}
                className="login-input-heron"
                required
              />

              <button type="submit" className="login-cta" disabled={isLoading}>
                {isLoading ? t('auth.sending_reset') : t('auth.send_reset_link')}
              </button>
            </form>

            <p className="login-signup-prompt">
              {t('auth.remembered_it')} <Link to="/login" className="login-signup-link">{t('nav.back_to_login')}</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default ForgotPasswordPage;
