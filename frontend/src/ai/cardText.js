// Text helpers the generation pipeline shares with the minigames.
//
// The blank-locating rule MUST be the one the games use at review time — a card
// whose answer the app cannot blank out is a card the cloze games silently skip
// — so normalizeAnswer/locateAnswerInExample are re-exported from
// src/minigameText.js rather than reimplemented here. Only blankedExample is
// new (it lives in supabase/scripts/lib/minigame_text.cjs on the CLI side).

// Explicit .js extension is required by run_browser_pipeline_tests.mjs (Node ESM resolver)
import { locateAnswerInExample, normalizeAnswer } from '../minigameText.js';

export { locateAnswerInExample, normalizeAnswer };

// The blanked English example ("I need to renew my ____ before traveling.") —
// what the word-bank cloze shows, and what the audit/distractor prompts reason
// about. Null when the answer isn't locatable in the sentence.
export function blankedExample(example, answer) {
  const span = locateAnswerInExample(example, answer);
  if (!span) return null;
  return example.slice(0, span.start) + '____' + example.slice(span.end);
}

// Small, stable, non-cryptographic content hash (FNV-1a). The pipeline only
// needs "did this content change since the audit passed?", and the browser's
// crypto.subtle digest is async, which would infect every call site.
export function contentHash(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
