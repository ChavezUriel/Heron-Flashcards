import React from 'react';
import { useTranslation } from 'react-i18next';

function AuthBrandPanel({ quote, tagline }) {
  const { t } = useTranslation();
  const displayQuote = quote || t('auth.brand_quote');
  const displayTagline = tagline || t('auth.brand_tagline');

  return (
    <div className="login-split__left">
      <div className="login-brand">
        <div className="login-brand__icon">
          <div className="login-brand__diamond" />
        </div>
        <span className="login-brand__name">Heron</span>
      </div>
      <div>
        <p className="login-quote">{displayQuote}</p>
        <p className="login-tagline">{displayTagline}</p>
      </div>
    </div>
  );
}

export default AuthBrandPanel;
