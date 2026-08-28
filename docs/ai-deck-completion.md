# AI deck completion — implementation plan

Fill in the empty fields of decks the learner already owns, and (optionally) judge
whether the values that are already there deserve to be replaced.

It is the second half of the in-app AI builder documented in
[`ai-deck-builder.md`](ai-deck-builder.md): same pipeline, same prompts, same
audits, same provider keys — pointed at `cards` rows that already exist instead
of at a blank deck.

---

## 1. What already exists

| Piece | Where | Reusable as-is? |
| --- | --- | --- |
| Deterministic field validators, grouped by the sub-prompt that repairs them | `frontend/src/ai/validate.js` | yes — this *is* the audit engine |
| `cardStatus(card, deck, opts)` — validator issues + stale/never-passed audit report, **zero LLM calls** | `frontend/src/ai/enrich.js:216` | yes — the free "current state" scan |
| `processCard()` — gap-fill only the failing groups, then LLM-as-judge audits, fingerprinted into `card._audits` | `frontend/src/ai/enrich.js:243` | needs two new options (§5) |
| Run machinery: concurrency, progress, log, stop/resume, persistence, header pill | `ai/generator.js`, `ai/runManager.js`, `ai/jobStore.js`, `components/AiRunIndicator.jsx` | yes, untouched |
| Provider / key panel and prefs | `components/AiProviderPanel.jsx`, `ai/keyStore.js` | yes, untouched |
| Field-level diffing and the "review these changes, then apply" UI pattern | `cardDiff.js`, `components/DeckSyncModal.jsx`, `components/ProposeChangesModal.jsx` | yes, for the review screen |
| The CLI sibling of this exact feature | `supabase/scripts/update_cards.cjs` (`FEATURES` registry, `--dry-run`), `generate_cards.cjs enrich --only-missing` | port its semantics |

The CLI already does this deck-file-side: `update_cards.cjs --dry-run` is the
"audit the current state" report, and `enrich --only-missing` is "fill blanks
only". This feature is the browser sibling, writing `cards` rows instead of
`seed_data/*.json`.

## 2. Two gaps that force backend work

1. **Reading** — `_preview_card_json` (0019) does not return `cloze_distractors_en`,
   so `fetchDeckPreview` cannot tell whether word-bank options are missing. That
   is the most commonly blank field on older decks.
2. **Writing** — `update_card` (0025) takes no `cloze_distractors_en`, and it is a
   *full* write: every unsupplied field is nulled. "Fill only what is blank"
   needs a **partial patch**. A direct `supabase.from('cards').update()` works
   under `cards_update_own` for personal decks but is blocked for market decks
   the user *maintains* (`user_id is null`), where only the SECURITY DEFINER path
   works.

Hence one new migration, `0026_ai_card_patch.sql`.

## 3. User flow

```
Home decks ─ "Create with AI" ─▶ /decks/new  [ Build a new deck | Complete a deck ]
                                                                        │
  1. Pick a deck            home decks; ineligible ones marked (§7)      │
  2. Scan                   FREE — no key, no LLM:                       ▼
                              80 cards · 12 missing examples · 61 missing word-bank
                              options · 9 never audited · 3 with invalid fields
  3. Choose what to do      (•) Fill in blanks only — never touch a value that exists
                            ( ) Audit and improve — judge existing values, rewrite failures
                            [x] lexical  [x] translations/collocations  [x] synonyms
                            [x] examples [x] word-bank options
  4. Deck context           title/description prefilled; "Infer from the deck" (1 call)
  5. Provider + parallelism the existing AiProviderPanel, unchanged
  ──▶ /decks/runs/:jobId    the same live run screen, then:
  6. Review                 per-card diff (before -> after), all checked by default
  7. Apply                  chunked patch writes; partial-failure reporting
```

The scan is free and instant, so the deck picker shows a per-deck gap badge
before the user commits to anything.

## 4. Backend — `supabase/migrations/0026_ai_card_patch.sql`

**`get_deck_cards_for_ai(p_deck_id bigint) -> jsonb`**
Full enrichable card shape in `ai/cards.js` naming (`spanish_text` / `english_text`,
not `prompt_es` / `answer_en`), including the two fields the explorer never
needed — `cloze_distractors_en` and `generation_metadata` — plus `card_id`,
`base_card_id`, `is_enabled`. Same visibility rule as `get_deck_preview` (own
deck or global), `generation_phase = 'refined'` only.

**`apply_card_ai_patch(p_card_id bigint, p_patch jsonb) -> jsonb`**
- Authorization copied verbatim from `update_card` (0025): deck owner, or market-deck maintainer.
- **Partial**: writes only keys *present* in `p_patch`; an absent key is untouched, and an explicit `null` is rejected rather than treated as a clear.
- Accepts `cloze_distractors_en` and `examples`; when `examples` is patched it re-mirrors `example_es` / `example_en` / `example_sentence` from `examples[0]` **server-side**, so the 0017 sync hash and pre-0019 consumers can never drift (the invariant `validate.js` asserts client-side).
- Merges `p_patch->'generation_metadata'` into the column (`||`) instead of replacing it — this is where `card._audits` is persisted so a second run does not re-pay for audits that already passed. Today `_audits` is dropped at save time (`ai/saveDeck.js:15`); this fixes that for both flows.
- Returns `_preview_card_json(p_card_id)`.

**`apply_card_ai_patches(p_patches jsonb) -> jsonb`**
Array of `{card_id, patch}`, all-or-nothing per call, mirroring
`update_cards_visibility` (0023). The client chunks at ~50.

Grants follow every other migration here: `revoke ... from public, anon;`
`grant execute ... to authenticated;` `notify pgrst, 'reload schema';`

`api.js` gains `fetchDeckCardsForAi(deckId)` and `applyCardAiPatches(patches)`.

## 5. AI layer

### `frontend/src/ai/deckAudit.js` (new, no LLM)
- `FEATURE_GROUPS` — port of `update_cards.cjs`'s `FEATURES` registry (`fields`, `examples`, `cloze-options`, `example-audit`, `cloze-audit`), each with `reasons(card, deckCtx)`.
- `fieldPresence(card)` -> per group `'empty' | 'partial' | 'present'`. **This is what `validateCard` cannot give us**: it conflates "no synonyms" with "four synonyms, one too many". Fill-blanks mode acts only on `'empty'`; audit mode acts on anything failing.
- `scanDeck(cards, deckCtx, quality)` -> `{ perFeature, perCard, totals }` — drives the step-2 report, the picker badges, and the estimate.
- `estimateFillRun(scan, mode, groups)` -> an *exact* call count (gap sub-prompts are countable), instead of the flat `CALLS_PER_CARD = 15` the create flow assumes.

### `frontend/src/ai/enrich.js` — two new `processCard` options
- `only: Set<group>` — the groups this run may write at all (the step-3 checkboxes).
- `protect: Set<group>` — groups whose **non-empty** stored value must never be overwritten.
  Fill-blanks = `protect: <all selected groups>`, audits off. Audit mode = `protect: <empty>`, audits on.
  Implementation is a filter over the `det` groups at the top of each round (~15 lines); the repair loop underneath is untouched.
- Subtlety: today a structurally-invalid example set triggers a **full** `examplesPrompt` rewrite (`enrich.js:302`). Under `protect`, a card with two hand-written good pairs must get pairs *added*, not replaced. `examplesPrompt` already receives the current pairs and is told to keep compliant ones; the change is to keep it out of the "clear `cloze_distractors_en` + void both audits" branch when the existing pairs survive.
- **Mirror both options into `supabase/scripts/lib/enrich.cjs`.** The docs are emphatic that these files are text-for-text ports; letting the browser copy fork silently is the one thing that makes this feature expensive to maintain later.

### `frontend/src/ai/prompts.js` — one new audit builder
`fieldAuditPrompt(card, deck)` judges what has **no** quality gate today: is
`part_of_speech` right for the answer; is `definition_en` accurate for *this*
sense and actually English; are `main_translations_es` correct equivalents
consistent with `spanish_text`; are `collocations` real collocations of the
answer; are `synonyms_en` true synonyms in this sense.

- Returns per-group `pass`/`fail` + `issues`, which map straight onto the `issues` argument `lexicalPrompt` / `equivalentsPrompt` / `synonymsPrompt` already accept for repair. **No new repair prompts needed.**
- One call per card, temperature 0, `PROMPT_VERSIONS.fieldAudit`, `AUDIT_VERSIONS.field_quality`, fingerprinted over those fields + deck context exactly like `exampleFingerprint`.
- It also returns a `pair_correct` verdict on `spanish_text` <-> `english_text`. **Report only, never auto-rewrite** — the card text is the card's identity for market sync (`base_card_id` matching) and for the learner's review history. Surfaced in the review screen as a flag linking to the card editor.
- Because imported and starter cards carry no `_audits`, the two *existing* audits (example quality, cloze solvability) fire on every card in audit mode with no extra work. That is most of "should this existing value be updated?" already built.

### `frontend/src/ai/generator.js` — a second job kind
- `kind: 'create' | 'fill'` on the job; absent means `'create'`, so the six jobs already in a user's `localStorage` keep working.
- `createFillJob({ deck, cards, deckCtx, mode, groups, provider, concurrency })`.
- `runJob` branches: fill jobs skip stages 1-2 (blueprint / word sets) and enter stage `cards` directly. Stages become `scan -> cards -> review -> applied`.
- Each card carries `_before` (only the in-scope fields, not a whole copy) and `_patch` (only fields that actually changed). Payload size matters: `jobStore` caps at 6 jobs and prunes on quota, and a 200-card deck with full before/after copies would blow that. The UI warns above ~150 cards and offers a section filter to split the run.
- Concurrency, stop/resume, retry-failed and usage accounting are all inherited unchanged.

### `frontend/src/ai/applyFill.js` (new)
The sibling of `saveDeck.js`: takes the approved card ids, builds patches from
`_patch`, chunks through `applyCardAiPatches`, and reports partial failure the
way `saveJobAsDeck` does (`error.partial`).

### `frontend/src/ai/specPrompts.js`
`specFromDeckPrompt(deck, sampleCards)` infers `topic` / `difficulty` /
`learner_profile` / `generation_notes` from the deck row plus ~15 sampled cards,
because those fields steer every downstream prompt and the database does not
store them. One call; cached per deck in `localStorage` so repeat runs skip step 4.

## 6. UI

- `pages/HomePage.jsx:522` — **unchanged**, still `<Link to="/decks/new">Create with AI</Link>`.
- New shared `<AiModeTabs />` at the top of both AI pages: **Build a new deck** (`/decks/new`) and **Complete a deck** (`/decks/complete`). A segmented control rather than a dropdown on the Home link: deep-linkable, mobile-friendly, no popover code, and it leaves room for the deck explorer to link to `/decks/complete?deck=<id>` later.
- `pages/AiDeckCompletePage.jsx` (new) — steps 1-5, on the same `StepHeader` / `panel st-section ai-step` scaffolding as `AiDeckBuilderPage`.
- `pages/DeckRunPage.jsx` — kind-aware: for `kind: 'fill'` the stage strip reads `Scan / Cards / Review / Applied`, the "Save to your decks" panel becomes "Apply to <deck>", and `<GeneratedCardList>` is replaced by `<ProposedChangeList>` (new) whose rows use `diffCardContent()` from `cardDiff.js` for before -> after, checked by default, unchecked rows skipped. Per-**field** accept/reject is a v2 refinement; v1 is per-card.
- `components/DeckGapReport.jsx` (new) — the scan table, shared by the picker badge and step 2.

## 7. Interactions and risks

- **Market-sync drift (the big one).** Writing `definition_en` / translations /
  collocations / synonyms / the example mirror changes `_card_content_hash`
  (0017), so on a deck linked to a market deck every enriched card becomes
  `locally_modified` and lands in `outgoing_changes` — visible in
  `DeckSyncModal`, and a conflict on the next `apply_deck_sync`. Note the
  asymmetry: `examples` and `cloze_distractors_en` are **not** in
  `_card_sync_content`, so filling only those creates no drift — except that
  `examples[0]` mirrors into `example_es` / `example_en`, which is. The review
  screen warns with the exact count when the deck is linked, and offers the
  natural follow-up: "Propose these to the market deck" via the existing
  `createDeckChangeProposal(marketDeckId, message, userCardIds)`.
- **Which decks are eligible**: personal decks (`user_id = me`) and market decks
  the user maintains (`is_owner`). A market deck they do not maintain is
  read-only — the picker marks it and points at "add it to home, then complete
  your copy", which the explorer already teaches.
- **Scheduling is untouched.** Content patches never write `card_progress`; FSRS
  state and review history survive a fill run. Worth saying in the UI, because
  "AI rewrote my deck" sounds like it might reset progress.
- **Cost.** Fill-blanks on a deck that only lacks word-bank options is ~2 calls
  per card, not 15. Audit mode on a complete deck is ~1 field audit + 3-4 example
  audits + 3-4 cloze solves ~= 8-10 calls per card before repairs. The scan gives
  an exact number, so step 3 shows a real per-mode estimate — which is also the
  honest way to present "audit everything" as the expensive option it is.

## 8. Decisions already made (overrule before Phase 1 if you disagree)

1. **Segmented tabs** on `/decks/new` + `/decks/complete`, not a dropdown on the Home link. Both satisfy "the same button"; tabs are cheaper and deep-linkable.
2. **Review-then-apply, never auto-write.** This edits data the learner already studies, so a diff gate is non-negotiable — at the cost of a long run ending in a screen to work through rather than a finished deck.
3. **The pipeline never rewrites `spanish_text` / `english_text`**, even when audit mode judges the pair wrong. It flags them instead.

---

# Execution — orchestrated phases

Four phases, each run by its own **antigravity (`agy`) agent** in its own Herdr
tab in the **`Heron`** workspace (`wC`). The orchestrator (Claude Code, workspace
`Heron`, tab `orchestrator`, agent name `orchestrator`, pane `wC:p4`) drives the
chain: it starts one phase agent, waits for that agent's completion report,
reviews the diff, fixes what needs fixing, and only then starts the next.

## Orchestrator runbook

Per phase, from the `orchestrator` tab:

```bash
# 1. a fresh tab in the Heron workspace, at the repo root, not stealing focus
herdr tab create --workspace wC --cwd "$PWD" --label "phase-1-scan" --no-focus
#    -> read .result.root_pane.pane_id

# 2. antigravity in that pane, named for the phase
herdr agent start phase1 --kind agy --pane <root_pane_id> -- --dangerously-skip-permissions

# 3. hand it the phase prompt (below), verbatim
herdr agent prompt phase1 "<PHASE PROMPT>" --wait --timeout 600000
```

The phase agent reports back by prompting the orchestrator directly — this wakes
the orchestrator's session, which is the trigger for the next link in the chain:

```bash
herdr agent prompt orchestrator "PHASE <n> COMPLETE. <summary>. Files: <paths>. Verification: <what was run and its result>. Open issues: <none | list>."
```

On receiving that report the orchestrator:

1. reads the actual diff (`git status`, `git diff`) rather than trusting the summary;
2. runs the phase's own verification (see [Tests, by phase](#tests-by-phase)) itself;
3. fixes anything small in place, or sends the phase agent a correction with `herdr agent prompt phase<n> "..."` and waits again;
4. when the phase is genuinely green, commits, then starts phase `n+1` with the runbook above;
5. after Phase 4, reports the whole chain to the user and stops.

Rules the orchestrator holds itself to: never `--focus` a phase tab (the user
keeps their focus), never close a tab it did not create, and never start phase
`n+1` while phase `n` has a failing check.

---

## Phase 1 — the free scan (no LLM, no writes)

Read-only end to end: the gap report, the deck picker, the mode tabs. Useful on
its own, and it makes every later phase's cost estimate honest.

**Deliverables**
- `supabase/migrations/0026_ai_card_patch.sql` — the **read** half only: `get_deck_cards_for_ai`.
- `frontend/src/api.js` — `fetchDeckCardsForAi`.
- `frontend/src/ai/deckAudit.js` — `FEATURE_GROUPS`, `fieldPresence`, `scanDeck`, `estimateFillRun`.
- `frontend/src/components/AiModeTabs.jsx`, `frontend/src/components/DeckGapReport.jsx`.
- `frontend/src/pages/AiDeckCompletePage.jsx` — steps 1-2 only (picker + report); steps 3-5 stubbed with a "coming next" note.
- `frontend/src/App.jsx` — the `/decks/complete` route.

### Prompt — Phase 1

```
You are implementing Phase 1 of the plan in docs/ai-deck-completion.md in the repo
at C:\Users\tu_rk\Desktop\Projects\Web Projects\4. Heron Flashcards (branch main).
Read that document first, in full, then read the files it points at before writing
any code. Implement ONLY Phase 1 - the free, read-only scan. Do not write any card
data, do not add any LLM call, do not touch the enrichment pipeline.

Scope:
1. supabase/migrations/0026_ai_card_patch.sql - create it with ONLY the read
   function get_deck_cards_for_ai(p_deck_id bigint) returns jsonb, per section 4 of
   the plan. Match the style of 0025_update_card_examples.sql exactly: security
   definer, set search_path = '', the same auth/visibility checks get_deck_preview
   uses, then revoke from public/anon, grant to authenticated, and
   notify pgrst, 'reload schema'. It must return cloze_distractors_en and
   generation_metadata, which _preview_card_json does not, and use ai/cards.js
   naming (spanish_text / english_text), not prompt_es / answer_en.
2. frontend/src/api.js - add fetchDeckCardsForAi(deckId), following the existing
   rpc() wrappers in that file.
3. frontend/src/ai/deckAudit.js - new, and NO LLM calls anywhere in it. Port the
   FEATURES registry from supabase/scripts/update_cards.cjs into FEATURE_GROUPS,
   reusing validateCard from ai/validate.js and cardStatus from ai/enrich.js.
   Add fieldPresence(card) returning 'empty' | 'partial' | 'present' per group -
   this distinction does not exist in validateCard and later phases depend on it.
   Add scanDeck(cards, deckCtx, quality) and estimateFillRun(scan, mode, groups).
4. frontend/src/components/AiModeTabs.jsx - a segmented control linking
   /decks/new ("Build a new deck") and /decks/complete ("Complete a deck").
   Render it at the top of both AiDeckBuilderPage and AiDeckCompletePage. Reuse
   existing class conventions from frontend/src/aiBuilder.css; add new classes
   there if you need them.
5. frontend/src/components/DeckGapReport.jsx - renders a scanDeck result.
6. frontend/src/pages/AiDeckCompletePage.jsx - steps 1 and 2 only: pick a deck
   from fetchHomeDecks(), then show its DeckGapReport. Mark decks that cannot be
   written to (a market deck the user does not maintain) as ineligible, with the
   "add it to home first" hint. Stub steps 3-5 with a short "coming next" note.
7. frontend/src/App.jsx - add the /decks/complete route, mirroring how
   /decks/new is wired.

Do NOT change HomePage.jsx - the existing "Create with AI" link stays as it is.

Match the surrounding code: comment density and voice, existing CSS class naming,
the rpc() pattern in api.js, and the migration header-comment style. This codebase
explains WHY in comments; follow that.

Verify before reporting: `cd frontend && npm run build` must pass. Sanity-check
deckAudit.js against a real deck by writing a scratch node script under
C:\Users\tu_rk\AppData\Local\Temp\claude\ (not in the repo) that feeds it cards
from supabase/seed_data/*.json and prints the report; confirm the counts are
plausible and that it makes zero network calls. Delete the scratch script after.

When you are done, report to the orchestrator with exactly this command:
herdr agent prompt orchestrator "PHASE 1 COMPLETE. <one-line summary>. Files: <paths changed>. Verification: <what you ran and its result>. Open issues: <none or a list>."
If you get blocked or decide to deviate from the plan, report that the same way
instead of pressing on.
```

---

## Phase 2 — fill in the blanks, end to end

The whole feature for most decks: the patch RPCs, the `protect`/`only` options,
the fill job kind, and the review-and-apply screen.

**Deliverables**
- `0026_ai_card_patch.sql` — add `apply_card_ai_patch` and `apply_card_ai_patches`.
- `frontend/src/api.js` — `applyCardAiPatches`.
- `frontend/src/ai/enrich.js` **and** `supabase/scripts/lib/enrich.cjs` — `only` + `protect`.
- `frontend/src/ai/generator.js` — `kind`, `createFillJob`, the fill branch of `runJob`.
- `frontend/src/ai/applyFill.js`, `frontend/src/ai/specPrompts.js` (`specFromDeckPrompt`).
- `frontend/src/pages/AiDeckCompletePage.jsx` — steps 3-5 for real.
- `frontend/src/pages/DeckRunPage.jsx` + `frontend/src/components/ProposedChangeList.jsx`.

### Prompt — Phase 2

```
You are implementing Phase 2 of docs/ai-deck-completion.md in the repo at
C:\Users\tu_rk\Desktop\Projects\Web Projects\4. Heron Flashcards (branch main).
Phase 1 is merged - read the doc in full, then read frontend/src/ai/deckAudit.js
and the 0026 migration as they now stand before writing code. Implement Phase 2:
"fill in blanks only", end to end. Do NOT implement audit mode or the new
fieldAuditPrompt - that is Phase 3.

Scope:
1. supabase/migrations/0026_ai_card_patch.sql - add apply_card_ai_patch(p_card_id
   bigint, p_patch jsonb) and apply_card_ai_patches(p_patches jsonb) per section 4
   of the plan. Copy the authorization block from update_card in
   0025_update_card_examples.sql verbatim (deck owner OR market-deck maintainer).
   The patch must be PARTIAL: only keys present in p_patch are written, an absent
   key is left untouched, an explicit null is rejected rather than treated as a
   clear. It must accept cloze_distractors_en and examples, and whenever examples
   is patched it re-mirrors example_es / example_en / example_sentence from
   examples[0] server-side. It must MERGE p_patch->'generation_metadata' into the
   existing column with ||, never replace it. Same grants and notify pgrst as the
   read function.
2. frontend/src/api.js - applyCardAiPatches(patches).
3. frontend/src/ai/enrich.js - add two processCard options: `only` (Set of groups
   this run may write at all) and `protect` (Set of groups whose NON-EMPTY stored
   value must never be overwritten). Implement as a filter over the `det` issue
   groups at the top of each round; leave the repair loop below untouched. Read
   the note in section 5 of the plan about the full-set examples rewrite at
   enrich.js:302 - under `protect`, a card with two good hand-written pairs must
   have pairs ADDED, not replaced, and must not fall into the branch that clears
   cloze_distractors_en and voids both audits when the existing pairs survive.
4. supabase/scripts/lib/enrich.cjs - mirror the exact same two options. These two
   files are deliberate text-for-text ports of each other; they must not fork.
5. frontend/src/ai/generator.js - add `kind: 'create' | 'fill'` (absent means
   'create', so jobs already in users' localStorage keep working), add
   createFillJob({deck, cards, deckCtx, mode, groups, provider, concurrency}), and
   branch runJob so a fill job skips the blueprint and word-set stages and enters
   the cards stage directly. Stages for a fill job: scan -> cards -> review ->
   applied. Store only _before (the in-scope fields) and _patch (only fields that
   actually changed) per card, NOT whole card copies - jobStore caps at 6 jobs and
   prunes on quota. Concurrency, stop/resume, retry-failed and usage accounting
   must all keep working unchanged.
6. frontend/src/ai/applyFill.js - the sibling of ai/saveDeck.js: approved card ids
   -> patches -> chunks of ~50 through applyCardAiPatches, with the same partial-
   failure reporting saveJobAsDeck uses (error.partial).
7. frontend/src/ai/specPrompts.js - add specFromDeckPrompt(deck, sampleCards)
   inferring topic / difficulty / learner_profile / generation_notes from the deck
   row plus ~15 sampled cards. One call. Cache the result per deck in localStorage.
8. frontend/src/pages/AiDeckCompletePage.jsx - implement steps 3, 4 and 5: the
   mode radio (only "Fill in blanks only" is selectable this phase; show "Audit and
   improve" disabled with a "coming soon" note), the per-group checkboxes, the deck
   context step with the "Infer from the deck" button, and the existing
   AiProviderPanel + concurrency slider copied from AiDeckBuilderPage. Launch via
   createFillJob + startRun + navigate to /decks/runs/:jobId.
9. frontend/src/pages/DeckRunPage.jsx - make it kind-aware. For kind 'fill': the
   stage strip reads Scan / Cards / Review / Applied, the "Save to your decks"
   panel becomes "Apply to <deck title>", and GeneratedCardList is replaced by a
   new components/ProposedChangeList.jsx whose rows use diffCardContent() from
   frontend/src/cardDiff.js to show before -> after. Every card checked by
   default; unchecked cards are skipped on apply. Per-card granularity only -
   per-field accept/reject is deliberately out of scope.
   When the target deck is linked to a market deck, the review panel must warn
   with the exact count of cards that will become locally_modified, per section 7
   of the plan.

Verify before reporting: `cd frontend && npm run build` passes;
`node supabase/tests/pipeline/run_stub_tests.cjs` still passes after the
enrich.cjs change. Then prove the partial-patch semantics: write a scratch SQL
script under C:\Users\tu_rk\AppData\Local\Temp\claude\ modelled on
supabase/tests/market_sync/run.sh (throwaway cluster, migrations 0001..0026) that
asserts an absent key leaves its column untouched, that the examples mirror is
rebuilt, that generation_metadata merges rather than replaces, and that a
non-owner is rejected. Report whether it passed. If you cannot start a local
Postgres, say so explicitly rather than claiming it passed.

When done, report with exactly:
herdr agent prompt orchestrator "PHASE 2 COMPLETE. <one-line summary>. Files: <paths changed>. Verification: <what you ran and its result>. Open issues: <none or a list>."
If blocked or deviating from the plan, report that the same way instead.
```

---

## Phase 3 — audit and improve

Judging values that are already there, and routing the verdicts into the repair
prompts that already exist.

**Deliverables**
- `frontend/src/ai/prompts.js` + `supabase/scripts/lib/prompts.cjs` — `fieldAuditPrompt`, `PROMPT_VERSIONS.fieldAudit`.
- `frontend/src/ai/enrich.js` + `.cjs` — `AUDIT_VERSIONS.field_quality`, its fingerprint, its place in the loop.
- Audit mode enabled in `AiDeckCompletePage`; `pair_correct` surfaced (never auto-applied).
- Per-field accept/reject in `ProposedChangeList`.

### Prompt — Phase 3

```
You are implementing Phase 3 of docs/ai-deck-completion.md in the repo at
C:\Users\tu_rk\Desktop\Projects\Web Projects\4. Heron Flashcards (branch main).
Phases 1 and 2 are merged. Read the doc in full, then read frontend/src/ai/enrich.js
and frontend/src/ai/prompts.js as they now stand - especially how exampleFingerprint,
auditFresh, setAudit and the audit blocks in processCard work - before writing code.
Implement Phase 3: audit mode.

Scope:
1. frontend/src/ai/prompts.js - add fieldAuditPrompt(card, deck) and
   PROMPT_VERSIONS.fieldAudit. It judges what has no quality gate today:
   part_of_speech correct for the English answer; definition_en accurate for THIS
   sense and actually English; main_translations_es correct equivalents consistent
   with spanish_text; collocations real collocations of the answer; synonyms_en
   true synonyms in this sense. Return per-group pass/fail plus issues, shaped so
   the issues drop straight into the `issues` argument lexicalPrompt /
   equivalentsPrompt / synonymsPrompt already accept. Do NOT add new repair
   prompts - the existing ones are the repair path. temperature 0, JSON only,
   same style and voice as exampleAuditPrompt.
   It also returns a pair_correct verdict on spanish_text <-> english_text.
2. frontend/src/ai/enrich.js - add AUDIT_VERSIONS.field_quality, a
   fieldFingerprint(deck, card) over those fields plus deck context (model it on
   exampleFingerprint), and run the field audit inside processCard's audit section
   under the same rules the other two audits follow: skipped when auditFresh,
   recorded with setAudit on a pass, failures turned into repair hints for the
   matching enrichment sub-prompt, and bounded by the same maxRepairs budget.
   pair_correct is REPORT ONLY: surface it as an issue on the card, and NEVER
   rewrite spanish_text or english_text. The card text is the card's identity for
   market sync (base_card_id matching) and for the learner's review history.
3. supabase/scripts/lib/prompts.cjs and supabase/scripts/lib/enrich.cjs - mirror
   both changes exactly. These are text-for-text ports and must not fork.
   Add a matching entry to the FEATURES registry in
   supabase/scripts/update_cards.cjs so the CLI reports and selects on it too.
4. frontend/src/pages/AiDeckCompletePage.jsx - enable the "Audit and improve"
   mode: protect is empty, audits on. Its estimate must reflect the real cost
   (~1 field audit + 3-4 example audits + 3-4 cloze solves per card before
   repairs) via estimateFillRun, not the create flow's flat 15 calls per card.
5. frontend/src/components/ProposedChangeList.jsx - add per-field accept/reject
   on top of the per-card checkbox from Phase 2, and show each proposed change's
   reason (the audit issue that triggered it) next to the diff. Show pair_correct
   flags as a non-applicable warning row linking to the card in the deck explorer.

Verify before reporting: `cd frontend && npm run build` passes. Extend
supabase/tests/pipeline/run_stub_tests.cjs with stub cases for the new prompt:
a non-empty definition_en produces NO lexical call under protect; a fieldAudit
failure routes to the right repair prompt; a passing fieldAudit is recorded and
skipped on a second processCard call. Run it and report the result. Also add
supabase/tests/pipeline/run_browser_pipeline_tests.mjs asserting the same
behaviour directly against frontend/src/ai/enrich.js (it is pure JS with no
browser-only dependencies), so the browser copy cannot drift from the .cjs
unnoticed. Run that too and report its result.

When done, report with exactly:
herdr agent prompt orchestrator "PHASE 3 COMPLETE. <one-line summary>. Files: <paths changed>. Verification: <what you ran and its result>. Open issues: <none or a list>."
If blocked or deviating from the plan, report that the same way instead.
```

---

## Phase 4 — hardening, docs, market handoff

**Deliverables**
- `supabase/tests/card_patch/run.sh` — the throwaway-cluster suite for 0026.
- `docs/ai-deck-builder.md` — a "Completing an existing deck" section and the CLI-vs-app table refreshed.
- The "Propose these to the market deck" handoff on the review screen.
- Deck explorer entry point: `/decks/complete?deck=<id>` from the deck menu.

### Prompt — Phase 4

```
You are implementing Phase 4 of docs/ai-deck-completion.md in the repo at
C:\Users\tu_rk\Desktop\Projects\Web Projects\4. Heron Flashcards (branch main).
Phases 1-3 are merged. Read the doc in full, then read the code those phases
produced before writing anything. Phase 4 is hardening, documentation, and the
market-deck handoff. No new pipeline behaviour.

Scope:
1. supabase/tests/card_patch/run.sh - a permanent test suite for migration 0026,
   following supabase/tests/market_sync/run.sh exactly in structure (throwaway
   local cluster, the Supabase auth shim, migrations 0001..0026, then a tests.sql
   of assertion blocks). Assert: authorization (deck owner passes, market-deck
   maintainer passes, an unrelated user is rejected); partial-patch semantics (an
   absent key leaves its column untouched, an explicit null is rejected); the
   examples -> example_es/example_en/example_sentence mirror is rebuilt
   server-side; generation_metadata merges rather than replaces; and
   content_updated_at fires only when synced content actually changes (see the
   trigger in 0017).
2. frontend/src/pages/DeckRunPage.jsx - after a successful apply on a deck linked
   to a market deck, offer "Propose these to the market deck" using the existing
   createDeckChangeProposal(marketDeckId, message, userCardIds) in
   frontend/src/api.js and the existing ProposeChangesModal component. Reuse, do
   not reimplement.
3. frontend/src/pages/DeckWordsPage.jsx - add a "Complete with AI" item to the
   deck's OverflowMenu, linking to /decks/complete?deck=<id>, shown only for decks
   the user can actually write to (the same eligibility rule the picker uses).
   AiDeckCompletePage must honour that ?deck= query param by preselecting the deck
   and running the scan immediately.
4. docs/ai-deck-builder.md - add a "Completing an existing deck" section covering
   the two modes, the free scan, the review-and-apply gate, the market-sync drift
   caveat from section 7 of the plan, and the real per-mode cost. Update the
   CLI-vs-app table so update_cards.cjs and this feature are shown as the two
   halves of the same pipeline. Match the document's existing voice and table
   style; do not restructure what is already there.
5. Sweep the four phases for leftovers: dead stubs, "coming soon" notes that are
   now live, TODOs, and any drift between frontend/src/ai/*.js and
   supabase/scripts/lib/*.cjs. Report anything you find but cannot safely fix.

Verify before reporting: `cd frontend && npm run build` passes;
`node supabase/tests/pipeline/run_stub_tests.cjs` passes;
`node supabase/tests/pipeline/run_browser_pipeline_tests.mjs` passes;
`bash supabase/tests/card_patch/run.sh` passes (if no local Postgres is
available, say so explicitly rather than claiming it passed).

When done, report with exactly:
herdr agent prompt orchestrator "PHASE 4 COMPLETE. <one-line summary>. Files: <paths changed>. Verification: <what you ran and its result>. Open issues: <none or a list>."
If blocked or deviating from the plan, report that the same way instead.
```

---

## Tests, by phase

| Phase | Gate |
| --- | --- |
| 1 | `npm run build`; scratch scan over `seed_data/*.json` produces plausible counts and makes zero network calls |
| 2 | `npm run build`; `run_stub_tests.cjs` still green after the `enrich.cjs` change; scratch SQL proving partial-patch, mirror rebuild, metadata merge, non-owner rejection |
| 3 | `npm run build`; `run_stub_tests.cjs` extended (protect, fieldAudit routing, audit freshness); new `run_browser_pipeline_tests.mjs` asserting the browser port matches |
| 4 | all of the above plus the permanent `supabase/tests/card_patch/run.sh` |
