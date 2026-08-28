// The deck specification: the single document that drives a generation run.
//
// The form and the YAML editor are two views of THIS object — the form edits it
// directly, the YAML tab serializes it, and both go through normalizeSpec()
// before a run so a hand-written file and a form-built spec behave identically.
// It is deliberately the same shape the CLI's --spec files use
// (supabase/scripts/specs/example.json), so specs move between the two.

import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
// Explicit .js extension is required by run_browser_pipeline_tests.mjs (Node ESM resolver)
import { optText, normList } from './cards.js';

export const DIFFICULTIES = ['beginner', 'elementary', 'intermediate', 'advanced'];

export const CARD_COUNT_RANGE = { min: 4, max: 120 };

export const DEFAULT_SPEC = {
  title: '',
  description: '',
  topic: '',
  difficulty: 'beginner',
  learner_profile: 'Spanish-speaking learners of English',
  generation_notes: '',
  target_card_count: 20,
  language_from: 'es',
  language_to: 'en',
  // Empty = let the AI plan the sections (stage 1 of the pipeline).
  sections: [],
  quality: {
    // Both audits are what separates this from "ask a model for 20 words".
    example_audit: true,
    cloze_audit: true,
    // Curated word-bank cloze options (migration 0018).
    cloze_options: true,
    max_repairs: 2,
  },
};

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeSection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = optText(raw.name ?? raw.section_name);
  if (!name) return null;
  return {
    name,
    communicative_goal: optText(raw.communicative_goal ?? raw.goal) ?? '',
    lexical_focus: normList(raw.lexical_focus ?? raw.keywords).slice(0, 12),
    target_card_count: clamp(raw.target_card_count ?? raw.card_count, 1, CARD_COUNT_RANGE.max, 5),
  };
}

// Accepts anything (form state, parsed YAML, a CLI spec file) and returns a
// complete, in-range spec. Never throws — validateSpec() reports what a human
// still has to fix.
export function normalizeSpec(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const quality = source.quality && typeof source.quality === 'object' ? source.quality : {};
  const title = optText(source.title) ?? '';
  return {
    title,
    description: optText(source.description) ?? '',
    topic: optText(source.topic) ?? '',
    difficulty: DIFFICULTIES.includes(source.difficulty) ? source.difficulty : DEFAULT_SPEC.difficulty,
    learner_profile: optText(source.learner_profile) ?? DEFAULT_SPEC.learner_profile,
    generation_notes: optText(source.generation_notes ?? source.notes) ?? '',
    target_card_count: clamp(
      source.target_card_count, CARD_COUNT_RANGE.min, CARD_COUNT_RANGE.max, DEFAULT_SPEC.target_card_count,
    ),
    language_from: optText(source.language_from) ?? 'es',
    language_to: optText(source.language_to) ?? 'en',
    sections: (Array.isArray(source.sections) ? source.sections : [])
      .map(normalizeSection)
      .filter(Boolean)
      .slice(0, 8),
    quality: {
      example_audit: quality.example_audit !== false,
      cloze_audit: quality.cloze_audit !== false,
      cloze_options: quality.cloze_options !== false,
      max_repairs: clamp(quality.max_repairs, 0, 4, DEFAULT_SPEC.quality.max_repairs),
    },
  };
}

// Blocking problems only — anything that would make the run produce a useless
// deck. Style advice belongs in the form's helper text, not here.
export function validateSpec(spec) {
  const problems = [];
  if (!optText(spec.title)) problems.push('Give the deck a title.');
  if (!optText(spec.description)) problems.push('Add a one-line description — it is shown on the deck card and steers every prompt.');
  if (!optText(spec.topic)) problems.push('Describe the topic the cards should cover.');
  if (spec.target_card_count < CARD_COUNT_RANGE.min || spec.target_card_count > CARD_COUNT_RANGE.max) {
    problems.push(`Card count must be between ${CARD_COUNT_RANGE.min} and ${CARD_COUNT_RANGE.max}.`);
  }
  if (spec.language_from === spec.language_to) {
    problems.push('The prompt and answer languages must differ.');
  }
  const sectionTotal = spec.sections.reduce((total, section) => total + section.target_card_count, 0);
  if (spec.sections.length > 0 && sectionTotal > spec.target_card_count * 2) {
    problems.push('The section card counts add up to far more than the deck total — lower them or raise the deck total.');
  }
  return problems;
}

// How many cards the run will actually attempt: the sections' own totals when
// the spec names them, otherwise the deck target.
export function plannedCardCount(spec) {
  if (spec.sections.length === 0) return spec.target_card_count;
  return spec.sections.reduce((total, section) => total + section.target_card_count, 0);
}

// ---------------------------------------------------------------------------
// YAML view
// ---------------------------------------------------------------------------
export function specToYaml(spec) {
  const normalized = normalizeSpec(spec);
  return dumpYaml(normalized, { lineWidth: 100, noRefs: true, sortKeys: false });
}

// -> { spec, error }. A parse failure keeps `spec` null so the editor can show
// the YAML error inline instead of silently discarding the user's text.
export function specFromYaml(text) {
  try {
    const parsed = loadYaml(String(text ?? ''));
    if (parsed === null || parsed === undefined || parsed === '') {
      return { spec: null, error: 'The document is empty.' };
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { spec: null, error: 'Expected a YAML mapping of deck fields (title, description, …).' };
    }
    return { spec: normalizeSpec(parsed), error: null };
  } catch (parseError) {
    const mark = parseError?.mark;
    const where = mark ? ` (line ${mark.line + 1}, column ${mark.column + 1})` : '';
    return { spec: null, error: `${parseError?.reason ?? parseError?.message ?? 'Invalid YAML'}${where}` };
  }
}

export const SPEC_TEMPLATE_YAML = `# Deck specification — every field steers the generator.
title: Pharmacy Basics
description: Practical English for buying medicine and describing simple symptoms.
topic: beginner English for pharmacy visits
difficulty: beginner            # beginner | elementary | intermediate | advanced
learner_profile: Spanish-speaking beginners who need practical English in a pharmacy
generation_notes: Keep vocabulary concrete, high-frequency, and immediately useful.
target_card_count: 20
language_from: es
language_to: en

# Leave empty to let the AI plan the sections, or list them yourself:
sections: []
# sections:
#   - name: Describing symptoms
#     communicative_goal: Tell the pharmacist what hurts
#     lexical_focus: [headache, cough, fever, sore throat]
#     target_card_count: 6

quality:
  example_audit: true    # judge every example: on-theme + the blank is inferable
  cloze_audit: true      # a blind examiner checks only the answer fits the blank
  cloze_options: true    # curated wrong options for the word-bank game
  max_repairs: 2         # rewrite attempts per failed audit
`;
