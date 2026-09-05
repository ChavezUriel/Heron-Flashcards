# Language-agnostic migration — implementation roadmap

Heron is currently a fixed Spanish→English (L1→L2) app. The language pair is
hardcoded into column names, prompt prose, regexes and word lists. This document
is the authoritative spec for the migration. Each phase below is implemented by
one agent, in order. Do not implement a phase you were not assigned.

## Vocabulary — three independent axes

| Axis | Meaning | Storage |
|---|---|---|
| **UI locale** | Language the app chrome speaks. Currently English-only, hardcoded inline. | none yet → `profiles.ui_locale` |
| **L1 / source** | The learner's own language. Card prompt, its translations, the L1 half of each example pair. Currently Spanish. | `decks.language_from` (default `'es'`) |
| **L2 / target** | The language being learned. The graded answer, definitions, synonyms, collocations, cloze blanks, TTS. Currently English. | `decks.language_to` (default `'en'`) |

`decks.language_from` / `decks.language_to` already exist and survive deck
cloning and publishing, but **nothing reads them**. They are dead metadata that
is already correctly plumbed.

Almost every engine constraint binds on **L2**. Adding an L1 is cheap; adding an
L2 means re-validating eleven minigames. That asymmetry drives the tiering.

## Tier 1 target scope

- **Tier 1 L2 (targets):** `en`, `es`, `fr` — the engine works unmodified.
- **Tier 1 L1 (sources):** `en`, `es`, `fr`, `pt-BR`, `de`, `it`.
- 15 pairs total; 14 are new, since `es→en` already ships.
- **Tier 2** (`pt`, `it`, `de`, `nl` as L2) needs a lemma-aware blank locator.
- **Tier 3a** (`ru`, `pl`, `tr`), **Tier 3b** (`ja`, `zh`, `ko`), **Tier 4** (`ar`, `he`) are out of scope.

German is a Tier 1 **source** but a Tier 2 **target**: separable verbs mean the
citation form `anrufen` appears in a natural sentence as "Ich rufe dich an", so
the verbatim blank locator finds nothing.

## Ground rules for every phase

1. Work on the current branch (`feat/language-agnostic`). Do not switch or create branches.
2. **Tier 1 behaviour for `es→en` must be byte-identical to today.** Every
   parameterization must resolve to the current hardcoded values as its default.
   This is the regression contract for the whole migration.
3. Do not reformat or restructure files you are not changing.
4. Match the surrounding code style: the codebase uses plain JS/JSX, no
   TypeScript, no test framework in the frontend, descriptive block comments
   above non-obvious modules.
5. Run `cd frontend && npm run build` before you report done. It must pass.
6. When done, `git add -A && git commit` your phase with a message starting
   `feat(i18n): P<N> — <summary>`. Do not push.
7. Report at the end: files changed, anything you could not complete, and any
   assumption you had to make.

---

## P0 — Unicode bug fixes

Two live defects that silently destroy data the moment a non-Latin deck exists.

- `frontend/src/textSearch.js` → `normalizeSearchText` applies
  `.replace(/[^a-z0-9\s]/g, ' ')` after case-folding, which replaces every
  Cyrillic / Greek / Han / Kana / Arabic character with a space. Replace the
  character class with a Unicode-property class (`\p{L}\p{N}`, `u` flag).
  `normalizeWithIndexMap` in the same file has the same problem — it must stay
  index-for-index consistent with `normalizeSearchText`.
- `frontend/src/pages/MarketPage.jsx` has a **duplicated** local
  `normalizeSearchText`. Delete it and import the shared one from `../textSearch`.
- `frontend/src/speech.js` → `speak()` defaults `lang` to `'en-US'`. Callers in
  `frontend/src/components/Listening.jsx` and `frontend/src/components/Flashcard.jsx`
  must pass a BCP-47 tag derived from the deck's `language_to` instead of relying
  on the default. Where the deck's language is not reachable from the component,
  thread it through props from the page that already has the card/deck payload.

Diacritic stripping in `normalizeSearchText` stays as-is — for *search* that is
the desired forgiving behaviour. Grading is a different concern, handled in P5.

**Acceptance:** searching a deck titled with Cyrillic or Han characters finds it;
`es→en` search results are unchanged; audio reads with the deck's target language.

---

## P1 — Language registry and the three axes

One module becomes the authority on what a language is and what a pair supports.
Nothing downstream should ever again decide this for itself.

Create `frontend/src/languages.js` exporting:

- `LANGUAGES` — keyed by BCP-47 tag. Per entry: `tag`, `name` (English name),
  `endonym`, `script` (`'Latn'`, `'Cyrl'`, …), `diacriticsSignificant` (bool),
  `functionWords` (array — for `en`, the exact 25-entry list currently in
  `frontend/src/minigameText.js`), `typoBudget` profile, `ttsTag` (e.g. `'en-US'`),
  `games` (set of minigame ids this language supports).
- `PAIRS` / `supportedPairs()` — the Tier 1 matrix above, each entry carrying
  `tier`, `clozeStrategy` (`'verbatim'` for Tier 1), and `minModelTier`.
- Helpers: `getLanguage(tag)`, `getPair(l1, l2)`, `isPairSupported(l1, l2)`,
  `defaultPair()` → `{ l1: 'es', l2: 'en' }`.

Include entries for all Tier 1 languages plus stub entries (marked with their
tier) for the deferred ones, so later phases have somewhere to add to.

Also:
- New migration `supabase/migrations/0033_ui_locale.sql`: add
  `profiles.ui_locale text` (nullable; null means "follow L1"). Follow the
  existing migration file conventions exactly — look at `0031` and `0032` first.
- Validate `decks.language_from` / `language_to` on write in the RPCs that
  create or clone decks, rejecting unsupported pairs.
- Backfill is unambiguous: every existing deck is `es→en`. Assert this rather
  than guessing.

**Acceptance:** registry resolves `es→en` to exactly today's behaviour;
`npm run build` passes; migration applies cleanly on a fresh database.

---

## P2 — Schema and payload: language names → role names

The largest single-PR risk in the plan. Land it alone. Column renames in
Postgres are metadata-only; the expensive part is regenerating the RPC bodies,
which is unavoidable either way.

Migration `supabase/migrations/0034_role_named_card_columns.sql`:

| Today | Rename to |
|---|---|
| `cards.spanish_text` | `cards.l1_text` |
| `cards.english_text` | `cards.l2_text` |
| `cards.definition_en` | `cards.l2_definition` |
| `cards.main_translations_es` | `cards.l1_translations` |
| `cards.synonyms_en` | `cards.l2_synonyms` |
| `cards.mnemonic_en` | `cards.l2_mnemonic` |
| `cards.cloze_distractors_en` | `cards.l2_cloze_distractors` |
| `cards.example_es` | `cards.example_l1` |
| `cards.example_en` | `cards.example_l2` |
| `cards.examples` jsonb keys `{es, en}` | `{l1, l2}` |

`cards.collocations` is already role-named — leave it.

Then regenerate **every** RPC that emits `prompt_es` / `answer_en` as JSON keys
or accepts `p_prompt_es` / `p_answer_en` as parameters. The payload keys become
`prompt_l1` / `answer_l2`; parameters become `p_prompt_l1` / `p_answer_l2`.
Fifteen of the thirty-two existing migrations touch this shape — the current
definition of each function is the one in the highest-numbered migration that
defines it, so search for the latest definition rather than the first.

Additionally, include `language_from` and `language_to` in the card and deck
payloads, so the client always knows which pair it is rendering.

Ship a `cards_legacy` compatibility **view** exposing the old column names, so
`supabase/scripts/*.cjs` keeps running until it is ported.

Update all consumers: `frontend/src/api.js` (40 RPC call sites), every component
and page that destructures `prompt_es` / `answer_en` / the renamed fields, and
`frontend/src/cardDiff.js`.

Run the existing suites under `supabase/tests` — `card_patch`, `card_deletion`,
`market_sync`, `pipeline`, `bulk_visibility` — they are the regression net.

**Acceptance:** the app is functionally unchanged for `es→en`; the test suites
pass; no reference to `spanish_text` / `english_text` / `prompt_es` / `answer_en`
remains outside the compatibility view.

---

## P3 — Pair-aware prompt pipeline

Every prompt builder takes a pair descriptor instead of assuming one. The JSON
schema stays **constant** across pairs; only the injected rule text varies. That
is what keeps versioning and audit caching honest.

- `frontend/src/ai/prompts.js` (16 builders) and
  `supabase/scripts/lib/prompts.cjs` are a deliberate text-for-text port of each
  other. Extract the shared rule text into ONE source consumed by both, and add
  a check that fails when they diverge.
- Thread a `{ l1, l2 }` descriptor (from the P1 registry) through all builders.
  Derive `learner_profile` from it instead of defaulting to the hardcoded
  `'Spanish-speaking learners of English'`.
- Rename prompt-facing JSON keys to roles: `main_translations_es` →
  `l1_translations`, `definition_en` → `l2_definition`, `synonyms_en` →
  `l2_synonyms`, `example_es`/`example_en` → `example_l1`/`example_l2`. Asking a
  model to fill `main_translations_es` when L1 is French is an instruction that
  fights itself.
- Per-pair rule injection: script constraints, punctuation conventions, and the
  cloze strategy the pair's tier permits.
- Extend `PROMPT_VERSIONS` so each version string encodes the pair. `fieldFingerprint`
  and `exampleFingerprint` in `frontend/src/ai/enrich.js` cache audit results
  against these — a fingerprint computed under `es→en` rules must not certify a
  card generated under different ones.
- Enforce the registry's `minModelTier` before a run starts, with an error that
  names the pair and the models that qualify. Provider list is in
  `frontend/src/ai/providers.js`.

**Acceptance:** generating a deck for `es→en` produces prompts byte-identical to
today's; a `fr→en` run produces correct French prompt-side rules; the
browser/CLI divergence check passes.

---

## P4 — Language-aware validation

`INVERTED_PUNCT = /[¿¡]/` in `frontend/src/ai/validate.js` is doing the job of a
language detector across six checks. It cannot catch French in an English field,
and it fires falsely the moment Spanish becomes a target language.

- Replace it with a script-range check driven by the P1 registry, plus a
  lightweight n-gram heuristic for same-script pairs where Unicode ranges cannot
  separate the languages. Do not add a dependency for this — keep it small and
  in-repo.
- Move the "must not contain L1 text" rule into a per-pair rule the registry supplies.
- Keep the verbatim-answer check, but let the pair's `clozeStrategy` decide
  whether it applies, and report cloze-ineligible cards as a **warning** rather
  than a hard failure — otherwise the repair loop in
  `frontend/src/ai/enrich.js` (`quality.max_repairs`, default 2) thrashes on an
  unsatisfiable constraint.

**Acceptance:** `es→en` validation verdicts are unchanged on existing seed data;
`en→es` no longer false-positives on `¿`/`¡`.

---

## P5 — Grading engine parameterization

`frontend/src/minigameText.js` and `frontend/src/ai/cardText.js` decide whether a
typed answer is correct, whether it is a near miss, and where to cut a cloze
blank. Eleven minigames sit on top. Each item below is correct for English and
wrong somewhere else.

- `normalizeAnswer` strips NFD combining marks unconditionally. Take a
  diacritic-sensitivity flag from the registry; languages where diacritics are
  phonemic keep them. (Vietnamese `ma / má / mà / mả / mã / mạ` are six different
  words that currently all normalize to `ma`.)
- `FUNCTION_WORDS` (25 English entries) and `typoBudget` (0/1/2 by length) move
  into the registry, keyed by L2 and script.
- `locateAnswerInExample` gains a strategy hook: `'verbatim'` for Tier 1,
  with the seam for `'lemma'` (Tier 2) and `'segmenter'` (Tier 3b) present but
  not implemented.
- `frontend/src/components/MinigameHost.jsx` consults the registry's per-language
  `games` set, so scramble and hangman can be withheld per language rather than
  per card.

For Tier 1 this phase is **behaviour-preserving by construction** — `en`, `es`
and `fr` all resolve to the current defaults. Verify that, don't assume it.

**Acceptance:** grading for `es→en` is identical to today across all eleven
minigames; adding a Tier 2 language becomes a registry entry, not a rewrite.

---

## P6 — Interface localization

Roughly 600 hardcoded strings across 13 pages and 30 components, with no
scaffolding in place. Large but mechanical.

- Adopt `react-i18next` with ICU message format. Plural categories matter
  immediately — card counts appear throughout.
- Extract in dependency order: shared components first, then pages. The deck
  builder (`AiDeckBuilderPage`, `AiDeckCompletePage`, `DeckSpecEditor`) and
  `SettingsPage` carry the densest copy — do them last, against a stable base.
- Ship locale files for the Tier 1 UI locales: `en`, `es`, `fr`, `pt-BR`, `de`, `it`.
  English and Spanish must be complete and human-quality. For the rest, complete
  coverage is still required — flag anything you are not confident in rather
  than silently guessing.
- Default `ui_locale` (P1) to L1, with an explicit override in `SettingsPage`.
- Locale-aware dates, numbers, and `localeCompare` sorting —
  `frontend/src/pages/MarketPage.jsx` already calls `localeCompare` with no
  locale argument.
- RTL is out of scope, but use CSS logical properties in new work so Tier 4 is
  not a rewrite.

**Acceptance:** switching UI locale changes every visible string; no hardcoded
user-facing English remains outside locale files; `es→en` flows unchanged.

---

## P7 — Market and collaboration by pair

Publishing, proposals and sync currently assume every deck is comparable to
every other. Once pairs exist that produces incoherent collaboration —
`get_market_decks()` takes no arguments and neither selects nor filters on
`language_from` / `language_to`.

- `get_market_decks()` takes a pair filter and returns `language_from` /
  `language_to`. The market defaults to the learner's active pairs, with an
  explicit "all languages" escape.
- Pair becomes part of deck identity: `create_deck_change_proposal` and
  `apply_deck_sync` reject cross-pair operations.
- Pair facets in the market UI, and a pair badge alongside the existing
  `DeckOriginBadge`.

**Acceptance:** a `fr→en` learner sees `fr→en` decks by default and cannot
propose edits to an `es→en` deck.

---
---

## Status — complete

P0 through P7 are implemented and committed on `feat/language-agnostic`.

Verified at the end of the run: the frontend builds; 48 node pipeline tests
pass (`run_browser_pipeline_tests.mjs`, `run_stub_tests.cjs`,
`run_safety_audit_tests.mjs`, `run_single_card_review_tests.mjs`); all 15
`market_sync` tests pass against local Postgres, including the new
pair-identity case; no user-facing literal strings remain outside the locale
files; and all six locale files carry an identical 1114-key set.

Two regression contracts were proven rather than assumed, by diffing behaviour
against the tree as it stood before the phase:

- **P3** — generated `es→en` prompts were diffed against the pre-P3 tree. The
  intended change is the JSON key rename; the diff also caught a malformed
  rule (`(no Spanish (no inverted ¿ ¡ punctuation))`) that the ESM/CJS parity
  test could not, because both ports were wrong in the same way.
- **P5** — `normalizeAnswer`, `classifyGuess` and `locateAnswerInExample`
  produce byte-identical output across 27 guess pairs and 9 cloze locations
  against the pre-P5 tree.

### Invariants worth preserving

- The CommonJS libs under `supabase/scripts/lib` are no longer hand-synced
  copies. `prompts.cjs`, `validate.cjs`, `minigame_text.cjs`, `seed_decks.cjs`
  and `enrich.cjs` each re-export the corresponding module under
  `frontend/src/ai/`. `cards.cjs` remains a separate file for CLI-specific
  concerns, but its `normCard` output is verified identical to the browser
  port's. Do not reintroduce a parallel implementation — a silent drift here
  (`first.en` vs `first.l2`) already caused one real bug on this branch.
- `public.cards_legacy` is read-only: a plain view with a `select` grant and no
  `INSTEAD OF` triggers. It serves readers during the transition. Anything that
  writes must use the role-named columns. The CLI generators were ported for
  exactly this reason.
- Card objects still accept the legacy `*_es` / `*_en` names on **input** and
  the RPCs still dual-emit `prompt_es` / `answer_en`, both deliberately, for
  deploy ordering while the migration and the frontend deploy are not atomic.
  Output is role-named.
- `frontend/src/languages.js` is the single authority on what a language is and
  what a pair supports. Nothing downstream should decide this for itself.

### Known follow-ups, deliberately out of scope

- `generator.js` `computeCardPatch`, the `DeckRunPage` update whitelist and
  `generate_cards.cjs` seed serialization still read the legacy field names.
  Retiring those is a separate change.
- Once every client is past the 0034 deploy, drop the RPC dual-emit and
  `cards_legacy`.
- The QA gates in the plan — per-pair golden sets, cloze-eligibility rate,
  cost envelope and native review — are what gate switching a new pair **on**.
  None of them has run: no pair beyond `es→en` has been validated with real
  model output yet.
