import { useState } from 'react';
import { CARD_STATUS } from '../ai/generator';

// The results table of a run: one row per card, expandable into everything the
// pipeline wrote. This is the screen a learner judges the run by, so a card's
// state is legible at a glance (ready / open issues / failed / still working)
// and the open issues are spelled out rather than hidden behind a count.

const STATUS_LABEL = {
  [CARD_STATUS.pending]: 'Queued',
  [CARD_STATUS.working]: 'Working',
  [CARD_STATUS.ready]: 'Ready',
  [CARD_STATUS.flagged]: 'Check',
  [CARD_STATUS.failed]: 'Failed',
};

const FILTERS = [
  ['all', 'All'],
  [CARD_STATUS.ready, 'Ready'],
  [CARD_STATUS.flagged, 'Needs a look'],
  [CARD_STATUS.failed, 'Failed'],
];

function CardDetail({ card }) {
  const definition = card.l2_definition ?? card.definition_en;
  const translations = card.l1_translations ?? card.main_translations_es ?? [];
  const synonyms = card.l2_synonyms ?? card.synonyms_en ?? [];
  const distractors = card.l2_cloze_distractors ?? card.cloze_distractors_en ?? [];

  return (
    <div className="ai-card__detail">
      {definition ? (
        <p className="ai-card__definition">
          <span className="st-chip st-chip--muted">{card.part_of_speech}</span> {definition}
        </p>
      ) : null}

      {(card.examples ?? []).length > 0 ? (
        <ul className="ai-card__examples">
          {card.examples.map((pair, idx) => (
            <li key={idx}>
              <span className="ai-card__example-en">{pair.l2 ?? pair.en}</span>
              <span className="ai-card__example-es">{pair.l1 ?? pair.es}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="ai-card__meta">
        {translations.length > 0 ? (
          <div><dt>Translations</dt><dd>{translations.join(' · ')}</dd></div>
        ) : null}
        {synonyms.length > 0 ? (
          <div><dt>Synonyms</dt><dd>{synonyms.join(' · ')}</dd></div>
        ) : null}
        {(card.collocations ?? []).length > 0 ? (
          <div><dt>Collocations</dt><dd>{card.collocations.join(' · ')}</dd></div>
        ) : null}
        {distractors.length > 0 ? (
          <div><dt>Word bank</dt><dd>{distractors.join(' · ')}</dd></div>
        ) : null}
      </dl>

      {card._issues?.length ? (
        <ul className="ai-card__issues">
          {card._issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function GeneratedCardList({ job }) {
  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState(null);

  const cards = job.cards ?? [];
  if (cards.length === 0) return null;

  const visible = filter === 'all' ? cards : cards.filter((card) => card._status === filter);

  return (
    <section className="panel st-section" aria-labelledby="ai-cards-title">
      <div className="ai-run__log-head">
        <h2 className="st-section__title" id="ai-cards-title">Cards</h2>
        <div className="ai-filters" role="tablist" aria-label="Filter cards">
          {FILTERS.map(([id, label]) => {
            const count = id === 'all' ? cards.length : cards.filter((card) => card._status === id).length;
            if (count === 0 && id !== 'all') return null;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                className={`ai-tab${filter === id ? ' ai-tab--active' : ''}`}
                onClick={() => setFilter(id)}
              >
                {label} <span className="ai-tab__count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <ul className="ai-card-list">
        {visible.map((card) => {
          const prompt = card.l1_text ?? card.prompt_l1;
          const answer = card.l2_text ?? card.answer_l2;
          const key = `${prompt}|${answer}`;
          const isOpen = openId === key;
          return (
            <li key={key} className={`ai-card ai-card--${card._status}`}>
              <button
                type="button"
                className="ai-card__row"
                aria-expanded={isOpen}
                onClick={() => setOpenId(isOpen ? null : key)}
              >
                <span className="ai-card__status" aria-hidden="true" />
                <span className="ai-card__text">
                  <span className="ai-card__prompt">{prompt}</span>
                  <span className="ai-card__answer">{answer}</span>
                </span>
                <span className="ai-card__tags">
                  {card.section_name ? <span className="st-chip st-chip--muted">{card.section_name}</span> : null}
                  <span className="ai-card__state">{STATUS_LABEL[card._status]}</span>
                </span>
              </button>
              {isOpen ? <CardDetail card={card} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default GeneratedCardList;
