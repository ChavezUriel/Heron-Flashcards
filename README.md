# Heron

A quiet way to learn languages. Heron is a spaced-repetition flashcard app built
on **Supabase**: an FSRS scheduler decides when each card comes back, eight
optional minigames vary how a card is answered, learners generate their own
decks with AI using their own provider key, and a deck market lets people share
decks, pull updates, and propose edits back to the maintainer.

The engine is language-agnostic. Tier 1 covers English, Spanish and French as
target languages, with English, Spanish, French, Portuguese, German and Italian
as source languages. The interface ships in six locales.

## Stack

- **Frontend:** React + Vite, talking directly to Supabase.
- **Auth:** Supabase Auth (email/password, password recovery, Google SSO).
- **Database + API:** Supabase Postgres. All application logic lives in PL/pgSQL
  RPC functions guarded by Row-Level Security — there is no separate API server.

> The original FastAPI + SQLite backend has been **removed** in favor of Supabase
> (still in git history). The AI deck generator has been reimplemented as a Node
> CLI on Ollama — see [Generating & enriching decks with AI](#generating--enriching-decks-with-ai-ollama).

## Architecture

```
React (supabase-js)
   │  auth: signUp / signInWithPassword / OAuth / resetPasswordForEmail
   │  data: supabase.rpc('get_home_decks'), ('submit_review'), …
   ▼
Supabase
   ├─ Auth (auth.users)                → users, sessions, OAuth, recovery
   ├─ Postgres tables (+ RLS)          → profiles, decks, cards, card_progress,
   │                                      practice_sessions, practice_session_cards
   └─ SECURITY DEFINER RPC functions   → faithful port of every old endpoint
                                          + the smart-practice algorithm
```

Each former FastAPI endpoint is now a Postgres function that returns the same
JSON shape the frontend already consumed, so the page components were untouched —
only `src/api.js` (now calls `supabase.rpc`) and the auth pages changed.

| Old endpoint | RPC function |
| --- | --- |
| `GET /api/decks` | `get_home_decks()` |
| `GET /api/decks/market` | `get_market_decks()` |
| `GET /api/decks/{id}/review` | `get_review_card(p_deck_id)` |
| `GET /api/decks/{id}/progress` | `get_deck_progress(p_deck_id)` |
| `GET /api/decks/{id}/preview` | `get_deck_preview(p_deck_id)` |
| `POST /api/reviews` | `submit_review(p_card_id, p_result)` |
| `PATCH /api/cards/{id}/visibility` | `update_card_visibility(...)` |
| `PATCH /api/cards/{id}` | `update_card(...)` |
| `PATCH /api/decks/{id}/home-selection` | `update_deck_home_selection(...)` |
| `PATCH /api/decks/{id}/smart-practice-inclusion` | `update_deck_smart_practice_inclusion(...)` |
| `POST /api/practice/sessions` | `start_smart_practice_session(...)` |
| `GET /api/practice/sessions/{id}` | `get_smart_practice_session(p_session_id)` |
| `POST /api/practice/sessions/{id}/reviews` | `submit_smart_practice_review(...)` |

## Database setup

The schema, RLS policies, RPC functions, and grants live in
[`supabase/migrations/`](supabase/migrations) and have already been applied to
the project. To reproduce on another project, apply them in order
(`0001` → `0005`), then load the starter decks (see below).

The starter decks (10 global decks, ~1,066 cards) are compiled from the source
data in [`supabase/seed_data/`](supabase/seed_data) into
[`supabase/seed.sql`](supabase/seed.sql):

```powershell
# regenerate seed.sql from supabase/seed_data/*.json (only needed if the source changes)
node supabase/scripts/generate_seed.cjs

# load the global starter decks (idempotent — safe to re-run)
psql "<your Supabase connection string>" -f supabase/seed.sql
```

Get the connection string from the Supabase dashboard → **Connect** → "Session
pooler" (or "Direct connection"). The seed is idempotent: decks use
`on conflict (slug) do nothing` and cards are only inserted into empty decks.

### Refreshing edits to existing starter cards

`seed.sql` is insert-only — re-running it won't update cards that already exist
(matched by `(slug, lower(spanish_text), lower(english_text))`). To push
**edits** to existing cards or deck metadata, use
[`generate_update.cjs`](supabase/scripts/generate_update.cjs), which emits
`UPDATE` statements into [`supabase/seed_updates.sql`](supabase/seed_updates.sql):

```powershell
# regenerate seed_updates.sql from supabase/seed_data/*.json (only needed if the source changes)
node supabase/scripts/generate_update.cjs

# overwrite metadata on existing cards + decks (safe to re-run)
psql "<your Supabase connection string>" -f supabase/seed_updates.sql
```

It only updates rows matched by `(deck slug, lower(spanish), lower(english))`
and never inserts or deletes, so user review progress (`card_progress`,
`practice_session_cards`) is untouched. Identity columns (`spanish_text`/
`english_text`), `is_enabled`, and `generation_*` are left alone, and
`mnemonic_en`, `cloze_distractors_en`, and `examples` only overwrite when the
incoming card has a value — pushing un-enriched seed data won't wipe existing
mnemonics, curated cloze options, or example pair sets. Both compiled files
reference the `cloze_distractors_en` and `examples` columns, so apply
migrations `0018` + `0019` before loading them.

For a batch of edits that also adds new cards or decks, run both in this order:

```powershell
node supabase/scripts/generate_seed.cjs     # inserts new decks + new card pairs
node supabase/scripts/generate_update.cjs   # overwrites metadata on existing cards
psql "<your Supabase connection string>" -f supabase/seed.sql
psql "<your Supabase connection string>" -f supabase/seed_updates.sql
```

Neither script handles **removed** card pairs — those linger in the database
until deleted manually (which cascades to that card's `card_progress` and
`practice_session_cards` rows, so verify before deleting). Renaming a card's
`spanish_text`/`english_text` is effectively a remove + add.

## Building a deck with AI, inside the app

Learners can generate their **own** decks from `/decks/new` using their own
provider key (OpenCode Zen, OpenAI, Claude, or Gemini). They describe the deck,
review a specification as a form or as YAML, start the run, and watch it card by
card on `/decks/runs/:id` before saving it to their decks.

It runs the same three-stage pipeline as the CLI below (blueprint → word sets →
per-card enrichment with the example and cloze audits), ported to the browser in
[`frontend/src/ai/`](frontend/src/ai). Keys stay in the user's browser; no
migration and no service key are needed, because the deck and its cards are
written under the existing per-user RLS policies.

Full write-up: [docs/ai-deck-builder.md](docs/ai-deck-builder.md).

## Generating & enriching decks with AI (Ollama)

[`supabase/scripts/generate_cards.cjs`](supabase/scripts/generate_cards.cjs)
generates new decks and enriches existing ones using a local
[Ollama](https://ollama.com) model (`gpt-oss:20b`). Because the model is light,
each card is built with several small, focused prompts (draft → lexical →
equivalents → examples → synonyms → cloze distractors) and validated, with only
the failing sub-prompt re-run on repair. Output is written to
`supabase/seed_data/*.json`, so the normal `generate_seed.cjs → seed.sql` flow
applies it — no service key needed.

On top of the deterministic validators (`lib/validate.cjs`), two LLM-as-judge
audits gate every card (`lib/enrich.cjs`):

- **Example audit** — each of the card's 3+ example sentence pairs must fit the
  deck's theme AND imply the answer when it is blanked out (no generic frames
  like "I like ____"); every `example_en` must contain the answer verbatim so
  the fill-in-the-blank games can blank it.
- **Cloze solve audit** — a blind "examiner" prompt solves every blanked
  sentence given the answer + the curated `cloze_distractors_en` options,
  without knowing which is correct; options the examiner accepts are dropped or
  regenerated, so **only the real answer fits the blank**.

Audit passes are recorded per card under `_audits` in the seed JSON (with a
content fingerprint), so re-runs skip everything that already passed and only
spend model time where content or prompt versions changed.

```powershell
# prerequisites: Ollama running locally + the model pulled
ollama pull gpt-oss:20b

# create a new deck from a topic spec (see supabase/scripts/specs/example.json)
node supabase/scripts/generate_cards.cjs generate --spec supabase/scripts/specs/example.json

# fill missing metadata on an existing seed_data deck (draft -> enriched)
node supabase/scripts/generate_cards.cjs enrich --slug travel --only-missing

# validate a deck and report quality issues (add --repair to fix in place)
node supabase/scripts/generate_cards.cjs review --slug basics

# then recompile and load
node supabase/scripts/generate_seed.cjs
psql "<your Supabase connection string>" -f supabase/seed.sql
```

Useful flags: `--preview` (print, don't write), `--limit N` (cap cards for cheap
test runs), `--max-repairs N` (repair attempts per card). Override the endpoint
or model with the `OLLAMA_BASE_URL` / `OLLAMA_MODEL` environment variables.

### Updating every deck to the current feature set

When a new card feature ships (a new field, a new audit, a new minigame
requirement), run [`update_cards.cjs`](supabase/scripts/update_cards.cjs) — it
walks **all** seed decks, reports which cards are missing which feature, and
brings exactly those cards up to date through the same pipeline:

```powershell
# report per-deck/per-feature gaps — no model calls, no writes
node supabase/scripts/update_cards.cjs --dry-run

# update everything, then recompile seed.sql + seed_updates.sql
node supabase/scripts/update_cards.cjs --compile

# narrower runs
node supabase/scripts/update_cards.cjs --decks travel,basics --limit 20
node supabase/scripts/update_cards.cjs --features examples,cloze-options
```

Current feature registry: `fields` (lexical/equivalents/synonyms), `examples`
(3+ blankable example pairs, migration `0019`), `cloze-options` (curated
word-bank cloze distractors, migration `0018`), `example-audit`, and
`cloze-audit`. To add a feature later: teach `lib/validate.cjs` (shape) and/or
`lib/prompts.cjs` + `lib/enrich.cjs` (prompt/audit) about it, add one entry to
the `FEATURES` registry in `update_cards.cjs`, then run the script and apply
`supabase/seed_updates.sql`. Progress is checkpointed into the seed JSON every
few cards, so an interrupted run resumes with no lost work.

Pipeline tests (no Ollama / no database needed for the first; the second needs
local PostgreSQL 18 binaries):

```powershell
node supabase/tests/pipeline/run_stub_tests.cjs      # enrichment/audit loop, stubbed model
bash supabase/tests/minigame_distractors/run.sh      # migrations 0018/0019 on a throwaway cluster
```

## Required Supabase dashboard configuration

A few things must be configured in the dashboard (they are not code):

1. **Auth URLs** — Authentication → URL Configuration:
   - **Site URL:** your app origin (e.g. `http://localhost:5173` for dev, or your
     deployed URL).
   - **Redirect URLs:** add `http://localhost:5173/**` and your production
     `https://.../**`. Password-reset links redirect to `/reset-password`; OAuth
     returns to the app origin — both must be allow-listed.
2. **Google SSO** — Authentication → Providers → Google: enable it and paste a
   Google Cloud OAuth **Client ID** and **Client Secret**. Add Supabase's
   callback URL (`https://<ref>.supabase.co/auth/v1/callback`) as an authorized
   redirect URI in Google Cloud.
3. **Email confirmation** — Authentication → Providers → Email → "Confirm email":
   - **On (recommended for production):** after sign-up the user must click the
     confirmation email before logging in. The register page shows a "check your
     email" message in this case.
   - **Off:** sign-up logs the user in immediately (matches the old app's
     instant-register behavior).

## Run the frontend

```powershell
cd frontend
npm install
copy .env.example .env   # then fill in your values
npm run dev
```

`frontend/.env` needs:

```
VITE_SUPABASE_URL=https://<your-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...   # publishable key (or legacy anon key)
```

The publishable/anon key is designed to be shipped in the client bundle; RLS and
the `authenticated`-only RPC grants are what protect the data.

## Auth flows

- **Register:** `/register` → `supabase.auth.signUp` (full name stored in user
  metadata; a `profiles` row is created by a DB trigger).
- **Login:** `/login` → `supabase.auth.signInWithPassword`, or **Continue with
  Google**.
- **Forgot password:** `/forgot-password` → `resetPasswordForEmail`; the emailed
  link lands on `/reset-password`, which calls `supabase.auth.updateUser`.
- **Single sign-on:** Google via `signInWithOAuth`.

## Deploying to Vercel

The frontend is a static Vite SPA. [`frontend/vercel.json`](frontend/vercel.json)
adds the SPA-fallback rewrite so deep links (e.g. the `/reset-password` link from
a recovery email) resolve on refresh.

1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. **Root Directory:** `frontend` (the Vite preset auto-detects build
   `npm run build` and output `dist`).
3. **Environment Variables** (Production + Preview):
   - `VITE_SUPABASE_URL` = `https://mrvgvltjqararcrswrho.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = your publishable key (`sb_publishable_...`)
4. Deploy, then take the resulting URL (e.g. `https://your-app.vercel.app`) and:
   - **Supabase** → Authentication → URL Configuration: set **Site URL** to that
     origin and add `https://your-app.vercel.app/**` to **Redirect URLs**
     (required for password-reset and OAuth redirects).
   - **Google Cloud** OAuth client (if using SSO): add the origin to authorized
     JavaScript origins.
5. Smoke-test: register, log in, run a forgot-password round-trip, and hard-refresh
   `/market` to confirm the SPA fallback.

Pushes to the default branch auto-deploy; PRs get preview URLs (add those preview
domains to Supabase Redirect URLs too if you want auth to work on previews).

## Notes

- The original FastAPI + SQLite backend was removed in favor of Supabase (still
  in git history). Starter-deck source data lives in
  [`supabase/seed_data/`](supabase/seed_data) and compiles to `seed.sql` via
  [`generate_seed.cjs`](supabase/scripts/generate_seed.cjs). New decks can be
  generated/enriched with [`generate_cards.cjs`](supabase/scripts/generate_cards.cjs)
  (Ollama `gpt-oss:20b`).
- ⚠️ **Rotate the OpenAI key.** The repo's root `.env` (gitignored, not committed)
  held a real `OPEN_AI_API_KEY` used by the now-removed generator. Revoke it in
  the OpenAI dashboard and delete the file — nothing uses it anymore.
