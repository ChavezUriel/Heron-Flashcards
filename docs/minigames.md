# Minigames — Design & Implementation Plan

Status: **proposal / not yet implemented**
Scope: add optional, fun answer modalities ("minigames") to Smart Practice **without corrupting the FSRS schedule**, and let each end‑user choose which games to enable.

---

## 1. Goals & non‑negotiables

**Goal.** Make studying more engaging by varying *how* a card is answered — typing, multiple choice, matching, speed rounds, etc. — instead of only the classic flip‑and‑swipe.

**Non‑negotiables (in priority order):**

1. **FSRS signal integrity.** A minigame must never produce a *false positive* memory signal. Games that reveal or scaffold the answer must not inflate `stability` / push `due_at` out.
2. **In‑session graduation integrity.** The 2‑in‑a‑row `known` streak that sets `initial_mastered_at` (and promotes a new card into the review pool) must only be advanced by genuine free recall.
3. **Always‑safe default.** The classic flashcard is the fallback for every card and every phase. With all games disabled the app behaves exactly as it does today.
4. **User control.** Each game can be toggled on/off per user; the UI makes clear which games affect scheduling and which are practice‑only.

---

## 2. Current system (what we build on)

References are `file:line` into the current codebase.

### 2.1 Card material available per card
`_review_card_json` ([supabase/migrations/0008_card_synonyms_en.sql](../supabase/migrations/0008_card_synonyms_en.sql)) exposes, and the session snapshot forwards, these fields on `current_card`:

| Field | Use for games |
|---|---|
| `prompt_es`, `answer_en` | core prompt/answer |
| `part_of_speech`, `section_name` | grouping plausible distractors |
| `definition_en` | recall‑from‑definition |
| `main_translations_es[]` | Spanish‑side distractors/synonyms |
| `synonyms_en[]` | accept near‑answers when typing |
| `collocations[]` | depth/collocation games |
| `example_es`, `example_en` | cloze / fill‑the‑gap |
| `mnemonic_en` | unused — memory-hook feature removed (column kept; still part of the 0017 sync content hash) |

### 2.2 The grade path (how a "guess" is counted)
Every review funnels through a **binary** result. `handleReview('known'|'unknown')` ([frontend/src/pages/PracticePage.jsx:202](../frontend/src/pages/PracticePage.jsx)) → `submit_smart_practice_review` → `_apply_card_progress` ([supabase/migrations/0006_fsrs_scheduling.sql:157](../supabase/migrations/0006_fsrs_scheduling.sql)), which **hardcodes the FSRS rating** `known → Good(3)`, `unknown → Again(1)` (line 210). That single grade drives `stability`, `difficulty`, `due_at`, `lapses`, and the **2‑streak that trips `initial_mastered_at`** (lines 198–200). There is no Hard/Easy middle grade.

### 2.3 The session skeleton (there are no fixed "rounds")
A session is **one continuous FIFO queue**, built by `start_smart_practice_session` ([supabase/migrations/0021_smart_session_shape.sql](../supabase/migrations/0021_smart_session_shape.sql)) and recycled by `submit_smart_practice_review` ([supabase/migrations/0012_review_undo.sql:255](../supabase/migrations/0012_review_undo.sql)):

- **New cards** (`card_kind='new'`) **cycle to the back of the queue until a 2‑in‑a‑row `known` streak**, then graduate out of the session.
- **Review cards** (`card_kind='review'`) are due cards: **one clean `known` and they leave**; a miss re‑queues them (effectively relearning).
- Mode is `new_material` / `review` / `mixed`; for a `mixed` session the builder auto-derives a `session_shape` (`front_loaded` / `spread` / `interleaved`) from the learner's card status — how new cards are spread through reviews is a rule, not a user knob (see [supabase/migrations/0021_smart_session_shape.sql](../supabase/migrations/0021_smart_session_shape.sql)).

### 2.4 What the frontend already receives
`_practice_session_snapshot` ([supabase/migrations/0012_review_undo.sql:188](../supabase/migrations/0012_review_undo.sql)) returns:

- `summary`: `mode`, `remaining_new`, `remaining_review`, `remaining_cards`, `completed_cards`, `total_cards`, `session_shape`, `can_undo`.
- `current_card`: the full card JSON **plus `card_kind`** (merged at line 230).
- `submit_smart_practice_review` additionally returns `review_feedback`: `result`, `state`, `interval_days`, `due_at`, `repeats_in_session`.

**Gap:** `current_card` does **not** include `times_presented` or `last_result`, so the client can tell *new vs review* but not *first exposure vs later exposure vs just‑lapsed*. Closing this gap is a one‑line snapshot change (both columns already live on `practice_session_cards`).

### 2.5 Settings pattern
Practice settings are **client‑side** in `localStorage` under `duocards.smartPracticeSettings` via [frontend/src/practiceSettings.js](../frontend/src/practiceSettings.js) (`DEFAULT_PRACTICE_SETTINGS` merged with stored overrides). Minigame preferences follow the same pattern.

---

## 3. Core principles

### 3.1 Grade by retrieval strength
The classic swipe is **self‑graded free recall**. For a game to legitimately earn a `Good(3)` it must demand retrieval *at least as strong*. This yields three tiers, and the tier decides the counting rule:

```
New word ───────────────────────────────────────────────► Mastered / due
 encode  →  recognize   →  cued recall  →  free recall  →  retention test
(exposure) (MC / match)   (cloze / type)   (type / def)    (classic swipe)
 never       fail‑only      fail‑only        count           count
 count                                       fully            fully
```

- **Tier A — Production / free recall → count fully.** No options on screen; the user produces the answer. As strong as the swipe, and *verifiable* (higher‑quality data than self‑report).
- **Tier B — Recognition / cued → count only clean failures.** Options are visible; a win can come from elimination, so it earns **no** `known`. A *clean* wrong pick is solid proof of not‑knowing → record `unknown`.
- **Tier C — Exposure / scaffolded / different‑skill → never count.** No meaningful es→en retrieval (memory‑grid spatial matching, hangman, listening/spelling). Pure fun / encoding aid.

### 3.2 The asymmetry
A right answer and a wrong answer are **not** symmetric. Even where a *win* is weak evidence, a *clean loss* is strong evidence. So Tier B's rule is "**count failures, ignore wins**," which never inflates stability yet still captures the negative signal.

> A "clean" failure is a semantically wrong choice — **not** a timeout or a mis‑tap. Inside a `review`‑state card an `unknown` triggers a full lapse (relearning, interval collapse); don't spend that on a game artifact.

### 3.3 Two guardrails
1. **Protect due‑card measurement.** The review phase *is* the retention measurement; the first pass on a due card stays free recall (classic swipe or a Tier‑A production game). No answer‑revealing games on a due card's first pass.
2. **Only free recall advances graduation.** Recognition games never advance the 2‑streak `initial_mastered_at`; they are scaffolding.

### 3.4 Timing = scaffolding = counting (one axis)
Support‑heavy formats early in a word's life; production formats late and on reviews. This is the *same* axis as the counting rule, so timing and FSRS‑safety fall out together.

---

## 4. Minigame catalog

| # | Game | Tier | Card fields | Counting | Primary placement |
|---|---|---|---|---|---|
| 1 | **Type the translation** | A | `prompt_es`, `answer_en`, `synonyms_en` | Count fully (near miss: neutral) | Review 1st pass; new consolidation |
| 2 | **Recall from definition** | A | `definition_en`, `part_of_speech`, `answer_en` | Count fully (near miss: neutral) | Review 1st pass |
| 3 | **Cloze (free‑type)** | A | `example_en`, `answer_en` | Count fully (near miss: neutral) | New consolidation; review |
| 4 | **Multiple choice (es→en)** | B | `prompt_es`, siblings' `answer_en` | Failures only | New consolidation; lapsed review |
| 5 | **Reverse MC (en→es)** | B | `answer_en`, siblings' `prompt_es` | Failures only | New consolidation |
| 6 | **Word‑bank cloze** | B | `example_en` + option tiles | Failures only | New consolidation |
| 7 | **Speed round** (timed MC) | B | MC fields | Failures only (not timeouts) | Boundary / cool‑down |
| 8 | **Memory / matching grid** | C | `prompt_es`, `answer_en` | Never | Warm‑up / cool‑down |
| 9 | **Word scramble** | C | `answer_en` letters | Never | Cool‑down |
| 10 | **Hangman** | C | `answer_en` letters | Never | Cool‑down |
| 11 | **Listening / dictation** | C | TTS `answer_en` (speech synth already in [Flashcard.jsx:263](../frontend/src/components/Flashcard.jsx)) | Never (different skill) | New 1st exposure |
| 12 | **Mnemonic reveal** *(removed — shipped in Phase 4, cut with the memory-hook feature)* | C | `mnemonic_en` | Never | New 1st exposure |

Enrichment aside: synonym/collocation matching (`synonyms_en`, `collocations`) is fun but tests a *different fact*; if tracked, it should feed a separate "depth" stat, never `due_at`.

Hints aside (#2 recall‑from‑definition and #3 free‑type cloze, `MinigameHints.jsx`): a two‑step ladder the learner can spend before submitting — step 1 reveals the answer's **shape** (one underscore per character, word gaps shown; in the cloze it replaces the anonymous underline blank in the sentence), step 2 additionally shows `prompt_es`. The hint button sits one Tab after the answer input and returns focus to it on press. Hints don't change grading: a hinted correct answer still counts `known` (Tier A contract untouched).

Near‑miss aside (#1–#3, `classifyGuess` in `minigameText.js`): a guess that is *close but not exact* grades as **neutral**, not as a lapse. Close means: within a typo budget of the answer or any synonym (Damerau‑Levenshtein on the normalized strings — 1 edit for 4–7 chars, 2 for 8+, 0 for ≤3 where one edit is usually a different word), or the same content words with exactly one function word (article / infinitive `to` / preposition / particle) dropped or added ("listen" for "listen to"). The UI shows an amber `≈` verdict, echoes the guess, and prints the exact answer; the card advances via `skip_smart_practice_card` (§5.3) — FSRS and the 2‑streak untouched, card recycled to the back of the queue for a clean free‑recall rep. Telemetry logs it as outcome `almost`, `counted=false`. Rationale: punishing "recieve" with a lapse mis‑measures memory (the word *was* recalled), but rewarding it with `known` teaches the typo — deferring the rep measures nothing falsely.

---

## 5. Integration with the queue & FSRS

Every card gets **exactly one graded interaction.** Games fall into two structural categories:

### 5.1 Graded games (replace the swipe) — Tier A
The game *is* the graded rep. Correct → `submit_smart_practice_review(..., 'known')`, wrong → `'unknown'`. Drop‑in replacement for the swipe on eligible cards. **Zero backend change** (uses the existing RPC). One carve‑out: a *near miss* (typo‑level, §4 near‑miss aside) grades neither way — it rides the §5.3 skip so the rep is deferred, not counted.

### 5.2 Practice games (never award a positive) — Tier B & C
These never call `submit(..., 'known')`. Placement determines how they touch the queue:

- **Boundary / cool‑down (Tier C):** run entirely **outside** the queue (warm‑up before the first card, interstitial at a block boundary, cool‑down on the session‑complete screen). No submit. **Zero backend change.**
- **In‑queue Tier B (count‑failures‑only):**
  - **Clean wrong →** `submit(..., 'unknown')` (records the lapse, re‑queues) — existing RPC.
  - **Correct →** the card must advance **without** a grade (don't inflate FSRS, don't advance the 2‑streak). The current API has no way to advance without grading. **This is the one place a small backend affordance is needed** — see §5.3.

### 5.3 The `skip`/advance‑without‑grade affordance
Add one RPC:

```sql
-- Advance the current pending card of a session WITHOUT touching card_progress:
--   * new card  → increment times_presented, move to back of queue (another rep later)
--   * review    → same (stays for a later free-recall rep) OR complete, per policy
-- Never calls _apply_card_progress; never changes stability/difficulty/due_at/streak.
public.skip_smart_practice_card(p_session_id bigint, p_card_id bigint) returns jsonb  -- new snapshot
```

This keeps FSRS pristine while letting a *recognized* card move on. It serves Tier‑B‑in‑session wins and the Tier‑A **near‑miss neutral** outcome (§4 near‑miss aside); Tier A exact/wrong grading and all boundary games work without it.

### 5.4 Optional future: a real Hard(2) grade
If we later want recognition wins to count as a **downgraded positive** (instead of not at all), extend `_apply_card_progress` to accept a third result mapped to FSRS rating `2`, and relax the `CHECK (... in ('known','unknown'))` constraints on `card_progress.last_result` and `practice_session_cards.last_result`. **Deferred** — the count‑failures‑only model above is FSRS‑safe without it. (Still deferred as of Phase 6, §9: if ever adopted, the 2‑streak graduation must keep requiring a genuine free‑recall `known`, never a Hard.)

---

## 6. Timing / orchestration

### 6.1 Phase → game → counting

| Moment (detected via) | Learner is… | Game type | Counts? |
|---|---|---|---|
| **Warm‑up** (before queue) | re‑activating prior words | matching grid, fast recognition | No |
| **New card, 1st exposure** (`card_kind='new'`, `times_presented=0`) | *encoding* a new word | listening | No |
| **New card, consolidating** (cycling to 2‑streak) | building the trace | MC, word‑bank cloze | Wins no / clean fails yes; never advance graduation |
| **Between blocks** (`remaining_new`/`remaining_review` boundary) | resetting attention | speed round, grid interstitial | No |
| **Review, 1st pass** (`card_kind='review'`, `times_presented=0`) | *measuring* retention | classic swipe **or** Tier‑A production | Yes, fully |
| **Review, 2nd pass** (lapsed, re‑queued) | rebuilding a just‑failed word | typing w/ hints, MC scaffold | No re‑count of wins |
| **Cool‑down** (`current_card` null / complete) | reward + light exposure | any arcade game | No |

### 6.2 Detection signals (all already available, or one‑line to add)
- `card_kind` — new vs review (**already on `current_card`**).
- `times_presented`, `last_result` — first vs later vs lapsed (**add to snapshot**, §2.4).
- `summary.mode`, `remaining_new`, `remaining_review` — phase boundaries.
- `current_card === null` / session‑complete panel — cool‑down.

### 6.3 Dosing rules
- **Insert at boundaries, not per card** — format‑switching has a cognitive cost; ~1 interstitial per phase transition, or a games‑ratio like 1‑in‑5.
- **Respect the session's auto-chosen `session_shape`** — don't add a second randomizer on top; tie game choice deterministically to `card_kind` + `times_presented`.
- **Personalize by struggle** — high in‑session `times_presented` / FSRS `lapses` → more scaffolds; well‑known cards → fast swipe.
- **Front‑load support, fade it** — more games early in a word's life and early in a session.

---

## 7. User configuration (per‑user opt‑in)

### 7.1 Where prefs live
Extend `practiceSettings.js` (client‑side `localStorage`, same pattern as today). New sub‑object:

```js
// added to DEFAULT_PRACTICE_SETTINGS
minigames: {
  enabled: true,             // master switch; false => classic flashcard only (today's behavior)
  frequency: 'balanced',     // 'off' | 'light' | 'balanced' | 'heavy' — how often games replace/wrap the swipe
  games: {
    type_translation:      true,   // Tier A — counts
    recall_from_definition:true,    // Tier A — counts
    cloze_free:            true,    // Tier A — counts
    multiple_choice:       true,    // Tier B — practice
    reverse_mc:            false,   // Tier B — practice
    word_bank_cloze:       true,    // Tier B — practice
    speed_round:           true,    // Tier B — practice
    memory_grid:           true,    // Tier C — practice
    scramble:              false,   // Tier C — practice
    hangman:               false,   // Tier C — practice
    listening:             true,    // Tier C — practice
  },
}
```

`loadPracticeSettings()` already deep‑merges over defaults, so older stored blobs pick up new games as enabled‑by‑default (or we can gate new games off — a product choice).

### 7.2 Settings UI ([frontend/src/pages/SettingsPage.jsx](../frontend/src/pages/SettingsPage.jsx))
A new "Minigames" section with:
- **Master toggle** (`enabled`).
- **Frequency selector** (off / light / balanced / heavy).
- **Per‑game toggles**, grouped by counting semantics so the impact is legible, each with a badge:
  - **"Counts toward scheduling"** (Tier A) vs **"Practice only"** (Tier B/C).
- Short copy explaining that practice‑only games never change when a card is next due.

### 7.3 Fallback contract
- `enabled: false` → **always** classic swipe (identical to today).
- A phase whose eligible games are all disabled → falls back to classic swipe for that card.
- A disabled game is simply removed from the orchestrator's eligible set; nothing else changes.

---

## 8. Architecture

### 8.1 Frontend‑first
Most games are pure client‑side over fields already on `current_card`. The main server needs are: (a) the snapshot fields in §2.4, (b) distractors (§8.3), (c) the skip RPC (§5.3, Tier‑B‑in‑session only).

### 8.2 `MinigameHost` orchestrator
Introduce a component that sits **where `<Flashcard>` renders today** in PracticePage and owns modality selection:

```
MinigameHost({ card, summary, settings, onResolve })
  selectModality(card.card_kind, card.times_presented, card.last_result, settings)
    -> 'classic' | 'type_translation' | 'multiple_choice' | ...
  render the chosen component
  each modality reports back via a single contract:
     onResolve({ result: 'known'|'unknown'|null, counts: boolean, skip?: boolean })
```

`PracticePage.handleReview` is refactored to a single `resolveCard({result, counts, skip})`:
- `counts && result` → `submit_smart_practice_review(result)` (existing).
- `skip` (Tier‑B win) → `skip_smart_practice_card(...)` (new RPC).
- boundary/cool‑down games → resolve locally, never call the session RPCs.

Each minigame is a **self‑contained component** with a uniform props contract (`card`, `distractors?`, `onResolve`, `onSkip`), so games can be added/removed without touching the host.

### 8.3 Distractor generation (Tier B)
MC/word‑bank need plausible wrong options. Preferred: a small RPC

```sql
public.get_minigame_distractors(p_card_id bigint, p_n int default 3, p_side text default 'en') returns jsonb
-- 'en'    (MC):            N sibling answers from the same deck/section (and, when possible, same part_of_speech)
-- 'es'    (reverse MC):    sibling spanish_text prompts (0014)
-- 'cloze' (word‑bank):     the card's CURATED cloze_distractors_en (0018) — options
--                          generated against the card's specific example sentences and
--                          verified by a blind LLM solve‑check so ONLY the real answer
--                          fits any blank; read through base_card_id for user copies
--                          (while english_text matches), sibling-'en' fallback when
--                          fewer than 2 curated options survive filtering.
```

Sibling answers share the deck's theme, so for the word‑bank cloze they can accidentally ALSO fit the blank ("I ate an ____" + siblings apple/orange/banana) — that is what the curated 0018 set fixes. The generation pipeline (`supabase/scripts/lib/enrich.cjs`, swept by `update_cards.cjs`) writes and audits the options; the RPC only serves them.

Since 0019 every card also carries `examples` — 3+ blankable sentence pairs (each `en` contains the answer verbatim). The cloze games pick which sentence to blank deterministically per presentation (`sentenceIndex`, decorrelated from the game pick), so repeat passes vary the sentence; one curated distractor set serves all of a card's sentences (the solve‑check verifies each one).

Alternative: enrich `current_card` with precomputed distractors (heavier snapshot). Recommend the on‑demand RPC, prefetched for the next card to hide latency.

### 8.4 Accessibility parity
Games must match the current keyboard story (arrows reveal/answer in [PracticePage.jsx:126](../frontend/src/pages/PracticePage.jsx)): typing games need Enter‑to‑submit, MC needs number/arrow selection, all interactive elements labeled. No game may be pointer‑only.

---

## 9. Phased rollout

Each phase ships independently and leaves the app fully working.

### Phase 0 — Foundation (no game yet)
- Add `minigames` to `DEFAULT_PRACTICE_SETTINGS`; add the Settings "Minigames" section (master toggle + empty game list).
- Add `MinigameHost` that currently renders only `classic` (behavior‑identical to today).
- Refactor `PracticePage.handleReview` → `resolveCard`.
- **Acceptance:** app behaves exactly as today; settings persist; host indirection has no visible effect.

### Phase 1 — First Tier‑A game: **Type the translation** (counts fully, zero backend)
- Build the typing modality; accept `answer_en` + `synonyms_en`, case/accent‑normalized.
- Eligible on **review 1st pass** (key off `card_kind='review'`, already exposed) when enabled.
- Correct → `known`, wrong → `unknown` via the existing RPC.
- **Acceptance:** with only this game on, review cards can be answered by typing; grades reach FSRS identically to a swipe; disabling → classic returns.

### Phase 2 — Snapshot fields + first Tier‑B game: **Multiple choice** (failures‑only)
- Add `times_presented`, `last_result` to `current_card` (snapshot one‑liner).
- Add `get_minigame_distractors` RPC + `skip_smart_practice_card` RPC.
- MC eligible on **new consolidation** and **lapsed review**; clean wrong → `unknown`, win → `skip`.
- **Acceptance:** MC never advances the 2‑streak; a wrong pick records a lapse; graduation still requires free recall; distractors are same‑section/pos.

### Phase 3 — Boundary & cool‑down (Tier C, never count)
- Warm‑up interstitial, block‑boundary interstitial, cool‑down arcade (memory grid, speed round).
- Run outside the queue; frequency‑gated.
- **Acceptance:** these never call session RPCs; toggling frequency changes how often they appear.

### Phase 4 — Encoding aids for new 1st exposure (Tier C)
- Mnemonic reveal + listening/dictation shown on a new card's very first exposure (`times_presented=0`), before any graded rep. *(The mnemonic reveal was later removed along with the whole memory-hook feature; listening remains.)*
- **Acceptance:** first exposure never produces a grade; the graded rep still happens on a later cycle.

### Phase 5 — Remaining Tier‑A/B games + polish
- Recall‑from‑definition, free‑type cloze, word‑bank cloze, reverse MC, scramble, hangman.
- Per‑game badges, copy, and (optional) minigame telemetry (§10).

### Phase 6 — Telemetry, reverse‑MC go‑live & a depth stat
Net‑new scope beyond the original plan, drawn from the deferred items (§10, §11) and the §4
enrichment aside. **Additive only: zero change to FSRS, the 2‑streak, or any modality's
`onResolve` contract** — with everything here off/empty the app is byte‑for‑byte the Phase 5 flow.

- **Minigame telemetry (§10).** New `minigame_plays` table (`user_id`, `card_id`, `game`,
  `outcome`, `counted`, `created_at`) written through a SECURITY DEFINER RPC
  `log_minigame_play` (migration 0015), mirroring the 0013/0014 grant pattern. The frontend
  logs every **per‑card** minigame resolution from `resolveCard` — each Tier‑A/B modality with
  its `outcome` (`known` / `unknown` / `skip`) and whether it `counted` toward FSRS — plus each
  depth‑game play. The classic swipe is **not** a minigame and is not logged (so a
  minigames‑disabled session writes zero rows). The queue‑external arcade games (memory grid /
  speed round / scramble / hangman) are pure fun with no card‑learning outcome and are not
  logged either. Purely additive analytics — **never read by the scheduler**.
- **Reverse‑MC go‑live (§4 #5).** Migration 0014's `p_side='es'` distractor path is live on the
  remote, so Reverse MC now has real Spanish sibling distractors end‑to‑end. Flipped **on by
  default** (joining Multiple choice); it still degrades cleanly to a production/classic modality
  whenever a card can't supply enough distractors (`resolveModality`), so nothing breaks on a
  remote that predates 0014.
- **Depth stat (§11, §4 enrichment aside).** A new **Synonym match** game (`synonym_match`) over
  `synonyms_en`: show an answer word and pick which sibling words share its meaning (distractors
  drawn from the seen‑cards pool — no fetch). It runs as a queue‑external **cool‑down**
  interstitial (like scramble/hangman), so it **never touches `due_at` or the graduation
  streak** and never calls a session RPC. Results feed a separate **client‑side depth stat**
  (localStorage, `duocards.depthStat`) — a running count of related words matched, orthogonal to
  the FSRS schedule — surfaced in Settings → Minigames and on the session‑complete screen.
- **Deferred (unchanged):** the Hard(2) grade (§5.4) and active "type what you hear" dictation
  stay deferred — the count‑failures‑only model is FSRS‑safe without them, and graduation must
  keep requiring genuine free‑recall Good.

**Acceptance:** telemetry is write‑only and never influences a grade or the streak; disabling
minigames still yields pure classic and writes no plays; Reverse MC works end‑to‑end after 0014
and degrades cleanly before it; the depth game and its stat never reach
`submit_smart_practice_review` / `skip_smart_practice_card`.

---

## 10. Minigame telemetry (implemented in Phase 6)
To analyze engagement without touching FSRS, a `minigame_plays` table (`user_id`, `card_id`, `game`, `outcome`, `counted boolean`, `created_at`) records every per‑card minigame play and every depth‑game play. Writes go through the SECURITY DEFINER RPC `log_minigame_play` (migration 0015); the frontend fires them best‑effort (a failed log never disrupts practice). Purely additive; **never read by the scheduler**. The classic swipe and the pure arcade boundary/cool‑down games are not logged. See §9 Phase 6.

---

## 11. Open decisions (resolve before Phase 2)
1. **Graduation rule.** Recommended: **only free recall advances `initial_mastered_at`** (guardrail §3.3). Alternative (allow recognition to graduate) reintroduces the inflation problem — not recommended.
2. **Skip vs wrap for Tier‑B‑in‑session wins.** Recommended: the `skip_smart_practice_card` RPC (§5.3). Alternative: always follow a Tier‑B game with the classic swipe (no new RPC, but two interactions per card and a contaminated post‑reveal swipe).
3. **Distractor source.** Recommended: `get_minigame_distractors` RPC with prefetch. Alternative: precompute into the snapshot.
4. **New‑game default state.** Enabled‑by‑default (discoverable) vs off‑by‑default (conservative) when a user has older stored settings.
5. **Hard(2) grade** (§5.4): adopt now or defer. Recommended: defer.

---

## 12. Risks & mitigations
| Risk | Mitigation |
|---|---|
| False‑positive memory signal inflates schedule | Tier B never awards `known`; wins use `skip`; guardrails §3.3 |
| Cognitive overload from too much variety | Boundary‑only insertion + frequency dosing (§6.3) |
| Distractor fetch latency | Prefetch next card's distractors; cache per session |
| Lapse spent on a game artifact (timeout/mis‑tap) | Only *clean* semantic failures count (§3.2) |
| Accessibility regression | Keyboard parity contract (§8.4) |
| Settings drift across app versions | `loadPracticeSettings` deep‑merge over defaults (existing behavior) |

---

## 13. Summary of backend changes required
| Change | Needed for | Size |
|---|---|---|
| Add `times_presented`, `last_result` to `current_card` in `_practice_session_snapshot` | Phase 2+ | 1 line |
| `get_minigame_distractors(card_id, n, side)` RPC (`'cloze'` curated side: 0018) | Tier B games | small |
| `cards.cloze_distractors_en` + `cards.examples` (+ card‑JSON read‑through) | word‑bank cloze quality, sentence variety (0018/0019) | small |
| `skip_smart_practice_card(session_id, card_id)` RPC | Tier‑B‑in‑session wins | small |
| (optional) Hard(2) grade in `_apply_card_progress` + relax CHECKs | future richer scheme | medium |

Everything else — Tier‑A graded games and all boundary/cool‑down games — ships with **no backend change**, reusing the existing `submit_smart_practice_review`.
