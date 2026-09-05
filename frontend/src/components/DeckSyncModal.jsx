import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyDeckSync, fetchDeckSyncStatus } from '../api';
import { cardTitle, diffCardContent } from '../cardDiff';

// Selection keys mirror the apply_deck_sync item shapes.
function keyForItem(kind, item) {
  if (kind === 'add') return `add:${item.base_card.card_id}`;
  if (kind === 'update') return `update:${item.base_card.card_id}`;
  if (kind === 'remove') return `remove:${item.user_card.card_id}`;
  return 'deck_meta';
}

function changeForKey(key) {
  const [type, id] = key.split(':');
  if (type === 'add' || type === 'update') return { type, base_card_id: Number(id) };
  if (type === 'remove') return { type, card_id: Number(id) };
  return { type: 'deck_meta' };
}

function defaultSelection(status) {
  const keys = [];
  for (const item of status.added) keys.push(keyForItem('add', item));
  // Conflicting updates (you edited the card too) start unchecked so a sync
  // never silently overwrites local work.
  for (const item of status.changed) {
    if (!item.locally_modified) keys.push(keyForItem('update', item));
  }
  for (const item of status.removed) keys.push(keyForItem('remove', item));
  if (status.deck_meta) keys.push('deck_meta');
  return new Set(keys);
}

function SectionHeader({ title, count, sectionKeys, selected, onToggleAll }) {
  const allSelected = sectionKeys.length > 0 && sectionKeys.every((key) => selected.has(key));
  return (
    <div className="sync-section__head">
      <label className="sync-check">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => onToggleAll(sectionKeys, !allSelected)}
        />
        <span className="sync-section__title">{title}</span>
      </label>
      <span className="sync-section__count">{count}</span>
    </div>
  );
}

function DiffRows({ rows }) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <ul className="sync-diff">
      {rows.map((row) => (
        <li key={row.key}>
          <span className="sync-diff__label">{row.label}</span>
          <span className="sync-diff__values">
            <del>{row.from || '—'}</del>
            <span aria-hidden="true" className="sync-diff__arrow">→</span>
            <ins>{row.to || '—'}</ins>
          </span>
        </li>
      ))}
    </ul>
  );
}

function DeckSyncModal({ deckId, onClose, onApplied }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [syncStatus, setSyncStatus] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [lastApplied, setLastApplied] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setStatus('loading');
        setError('');
        const nextStatus = await fetchDeckSyncStatus(deckId);
        if (!cancelled) {
          setSyncStatus(nextStatus);
          setSelected(nextStatus.linked ? defaultSelection(nextStatus) : new Set());
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
    return () => { cancelled = true; };
  }, [deckId]);

  const sections = useMemo(() => {
    if (!syncStatus?.linked) {
      return null;
    }
    return {
      added: syncStatus.added.map((item) => ({ item, key: keyForItem('add', item) })),
      changed: syncStatus.changed.map((item) => ({
        item,
        key: keyForItem('update', item),
        diff: diffCardContent(item.user_card, item.base_card),
      })),
      removed: syncStatus.removed.map((item) => ({ item, key: keyForItem('remove', item) })),
    };
  }, [syncStatus]);

  function toggleKey(key) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleAll(keys, shouldSelect) {
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (shouldSelect) next.add(key); else next.delete(key);
      }
      return next;
    });
  }

  async function handleApply() {
    if (selected.size === 0) {
      return;
    }
    setStatus('applying');
    setError('');
    try {
      const result = await applyDeckSync(deckId, [...selected].map(changeForKey));
      setSyncStatus(result.status);
      setSelected(result.status.linked ? defaultSelection(result.status) : new Set());
      setLastApplied(result.applied);
      setStatus('ready');
      onApplied?.(result);
    } catch (applyError) {
      setError(applyError.message);
      setStatus('ready');
    }
  }

  const totalUpdates = syncStatus?.linked ? syncStatus.total_updates : 0;

  return (
    <div className="details-modal" role="dialog" aria-modal="true" aria-label={t('sync.title')}>
      <button aria-label={t('common.close_dialog')} className="details-modal__backdrop" type="button" onClick={onClose} />
      <div className="details-modal__panel sync-modal__panel">
        <button aria-label={t('common.close_dialog')} className="details-modal__close" type="button" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7 7 17 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            <path d="M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>

        <div className="details-modal__header">
          <p className="flashcard__label">{t('sync.title')}</p>
          <h3>{syncStatus?.linked ? syncStatus.base_deck_title : t('sync.title')}</h3>
        </div>

        {status === 'loading' ? <p className="sync-modal__status">{t('sync.checking')}</p> : null}
        {status === 'error' ? <p className="sync-modal__status sync-modal__status--error">{error}</p> : null}

        {status !== 'loading' && status !== 'error' && syncStatus && !syncStatus.linked ? (
          <p className="sync-modal__status">{t('sync.not_linked')}</p>
        ) : null}

        {sections && (status === 'ready' || status === 'applying') ? (
          totalUpdates === 0 ? (
            <div className="sync-modal__done">
              <p>{t('sync.up_to_date')}</p>
              {lastApplied > 0 ? <p className="sync-modal__done-note">{t('sync.updates_applied', { count: lastApplied })}</p> : null}
            </div>
          ) : (
            <div className="sync-modal__body">
              {error ? <p className="sync-modal__status sync-modal__status--error">{error}</p> : null}

              {sections.added.length > 0 ? (
                <section className="sync-section">
                  <SectionHeader
                    title={t('sync.section_new_cards')}
                    count={sections.added.length}
                    sectionKeys={sections.added.map(({ key }) => key)}
                    selected={selected}
                    onToggleAll={toggleAll}
                  />
                  <ul className="sync-section__list">
                    {sections.added.map(({ item, key }) => (
                      <li key={key} className="sync-row">
                        <label className="sync-check">
                          <input type="checkbox" checked={selected.has(key)} onChange={() => toggleKey(key)} />
                          <span className="sync-row__title">{cardTitle(item.base_card)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {sections.changed.length > 0 ? (
                <section className="sync-section">
                  <SectionHeader
                    title={t('sync.section_updated_cards')}
                    count={sections.changed.length}
                    sectionKeys={sections.changed.map(({ key }) => key)}
                    selected={selected}
                    onToggleAll={toggleAll}
                  />
                  <ul className="sync-section__list">
                    {sections.changed.map(({ item, key, diff }) => (
                      <li key={key} className="sync-row">
                        <label className="sync-check">
                          <input type="checkbox" checked={selected.has(key)} onChange={() => toggleKey(key)} />
                          <span className="sync-row__title">
                            {cardTitle(item.base_card)}
                            {item.locally_modified ? (
                              <span className="sync-chip sync-chip--warn">{t('sync.locally_modified_chip')}</span>
                            ) : null}
                          </span>
                        </label>
                        <DiffRows rows={diff} />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {sections.removed.length > 0 ? (
                <section className="sync-section">
                  <SectionHeader
                    title={t('sync.section_removed')}
                    count={sections.removed.length}
                    sectionKeys={sections.removed.map(({ key }) => key)}
                    selected={selected}
                    onToggleAll={toggleAll}
                  />
                  <p className="sync-section__hint">{t('sync.removed_hint')}</p>
                  <ul className="sync-section__list">
                    {sections.removed.map(({ item, key }) => (
                      <li key={key} className="sync-row">
                        <label className="sync-check">
                          <input type="checkbox" checked={selected.has(key)} onChange={() => toggleKey(key)} />
                          <span className="sync-row__title">{cardTitle(item.user_card)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {syncStatus.deck_meta ? (
                <section className="sync-section">
                  <SectionHeader
                    title={t('sync.section_deck_details')}
                    count={1}
                    sectionKeys={['deck_meta']}
                    selected={selected}
                    onToggleAll={toggleAll}
                  />
                  <ul className="sync-section__list">
                    <li className="sync-row">
                      <label className="sync-check">
                        <input type="checkbox" checked={selected.has('deck_meta')} onChange={() => toggleKey('deck_meta')} />
                        <span className="sync-row__title">{t('common.field')}</span>
                      </label>
                      <ul className="sync-diff">
                        {syncStatus.deck_meta.mine.title !== syncStatus.deck_meta.market.title ? (
                          <li>
                            <span className="sync-diff__label">{t('diff.field_title')}</span>
                            <span className="sync-diff__values">
                              <del>{syncStatus.deck_meta.mine.title}</del>
                              <span aria-hidden="true" className="sync-diff__arrow">→</span>
                              <ins>{syncStatus.deck_meta.market.title}</ins>
                            </span>
                          </li>
                        ) : null}
                        {syncStatus.deck_meta.mine.description !== syncStatus.deck_meta.market.description ? (
                          <li>
                            <span className="sync-diff__label">{t('diff.field_description')}</span>
                            <span className="sync-diff__values">
                              <del>{syncStatus.deck_meta.mine.description}</del>
                              <span aria-hidden="true" className="sync-diff__arrow">→</span>
                              <ins>{syncStatus.deck_meta.market.description}</ins>
                            </span>
                          </li>
                        ) : null}
                      </ul>
                    </li>
                  </ul>
                </section>
              ) : null}
            </div>
          )
        ) : null}

        {sections && totalUpdates > 0 ? (
          <div className="sync-modal__footer">
            <span className="sync-modal__footer-note">
              {selected.size} / {totalUpdates}
            </span>
            <button
              className="button button--primary"
              type="button"
              disabled={selected.size === 0 || status === 'applying'}
              onClick={handleApply}
            >
              {status === 'applying' ? t('sync.applying_updates') : t('sync.apply_updates_btn', { count: selected.size })}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default DeckSyncModal;
