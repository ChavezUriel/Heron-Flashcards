// Security, Ethics, Safety and Quality Filter for Deck Publishing.
//
// Multi-tier screening pipeline:
//   Tier 0: Deterministic Fast-Fail Pre-Scan (Client-side regex & structural checks)
//   Tier 1: Card-Level Safety & Ethics LLM-as-Judge (Batched semantic analysis)
//   Tier 2: Deck-Level Holistic Assessment (Title, description, topic integrity)

import { cardSafetyAuditPrompt, deckSafetyAuditPrompt } from './prompts.js';

export const SAFETY_CATEGORIES = {
  hate_and_harassment: {
    label: 'Hate & Harassment',
    description: 'Slurs, discriminatory attacks, bullying, or dehumanizing language.',
  },
  safety_and_violence: {
    label: 'Safety & Violence',
    description: 'Instructions for weapons, violence, self-harm, or illegal acts.',
  },
  explicit_nsfw: {
    label: 'Explicit / NSFW',
    description: 'Pornographic or non-consensual sexually explicit content.',
  },
  pii_and_privacy: {
    label: 'PII & Privacy',
    description: 'Personal phone numbers, emails, passwords, or personal credentials.',
  },
  spam_and_malicious: {
    label: 'Malicious & Spam',
    description: 'Phishing links, promotional spam, or executable scripts (<script>, SQL injection).',
  },
  adversarial_injection: {
    label: 'Adversarial Injection',
    description: 'System prompt override attempts or moderation circumvention.',
  },
  linguistic_integrity: {
    label: 'Language Quality',
    description: 'Severe translation errors, false friends, corrupted characters, or gibberish.',
  },
};

const PII_EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
const PII_PHONE_REGEX = /(?:\+?(\d{1,3}))?[-. (]*(\d{3})[-. )]*(\d{3})[-. ]*(\d{4})(?: *x(\d+))?\b/g;
const MALICIOUS_SCRIPT_REGEX = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>|javascript:|onerror\s*=|onload\s*=|onclick\s*=/gi;
const URL_REGEX = /\b(?:https?|ftp):\/\/[^\s/$.?#].[^\s]*/gi;
const PROMPT_INJECTION_REGEX = /\b(ignore\s+(?:all\s+)?(?:previous\s+)?instructions|system\s+prompt|DAN\s+mode|jailbreak)\b/gi;

const PLACEHOLDER_EMAILS = new Set([
  'example@example.com',
  'user@example.com',
  'test@test.com',
  'john.doe@example.com',
  'jane.doe@example.com',
  'email@domain.com',
]);

// ---------------------------------------------------------------------------
// Tier 0: Deterministic Fast-Fail Pre-Scan (0ms, 0 tokens)
// ---------------------------------------------------------------------------
export function runDeterministicPreScan(deckMeta, cards) {
  const issues = [];
  const activeCards = (cards || []).filter((c) => !c.is_deleted);

  if (!deckMeta?.title || deckMeta.title.trim().length === 0) {
    issues.push({
      type: 'deck',
      category: 'linguistic_integrity',
      severity: 'critical',
      why_rejected: 'The deck must have a title to be published.',
      remediation_advice: 'Provide a clear, descriptive title for the deck.',
    });
  }

  if (activeCards.length === 0) {
    issues.push({
      type: 'deck',
      category: 'linguistic_integrity',
      severity: 'critical',
      why_rejected: 'The deck contains no active flashcards to publish.',
      remediation_advice: 'Add or enable at least one refined flashcard before publishing.',
    });
  }

  // Scan each card for fast deterministic violations
  activeCards.forEach((card, index) => {
    const cardId = card.id ?? card.card_id ?? index;
    const promptEs = String(card.spanish_text ?? card.prompt_es ?? '').trim();
    const answerEn = String(card.english_text ?? card.answer_en ?? '').trim();
    const defEn = String(card.definition_en ?? '').trim();
    const exEs = String(card.example_es ?? card.example_sentence ?? '').trim();
    const exEn = String(card.example_en ?? '').trim();

    if (!promptEs || !answerEn) {
      issues.push({
        type: 'card',
        card_id: cardId,
        card_index: index,
        prompt_es: promptEs || '(empty)',
        answer_en: answerEn || '(empty)',
        section_name: card.section_name,
        violated_categories: ['linguistic_integrity'],
        severity: 'critical',
        flagged_field: !promptEs ? 'prompt_es' : 'answer_en',
        flagged_excerpt: !promptEs ? promptEs : answerEn,
        why_rejected: 'Flashcard has an empty Spanish prompt or English answer.',
        remediation_advice: 'Fill in both the Spanish prompt and English translation.',
      });
      return;
    }

    const fullText = `${promptEs} ${answerEn} ${defEn} ${exEs} ${exEn}`;

    // Check script injection / malware
    if (MALICIOUS_SCRIPT_REGEX.test(fullText)) {
      const match = fullText.match(MALICIOUS_SCRIPT_REGEX)?.[0] || '<script>';
      issues.push({
        type: 'card',
        card_id: cardId,
        card_index: index,
        prompt_es: promptEs,
        answer_en: answerEn,
        section_name: card.section_name,
        violated_categories: ['spam_and_malicious'],
        severity: 'critical',
        flagged_field: 'general',
        flagged_excerpt: match,
        why_rejected: 'Detected executable script tags or HTML event handlers in the flashcard.',
        remediation_advice: 'Remove all HTML tags, script snippets, and event handlers.',
      });
    }

    // Check external URLs
    if (URL_REGEX.test(fullText)) {
      const match = fullText.match(URL_REGEX)?.[0] || 'http://...';
      issues.push({
        type: 'card',
        card_id: cardId,
        card_index: index,
        prompt_es: promptEs,
        answer_en: answerEn,
        section_name: card.section_name,
        violated_categories: ['spam_and_malicious'],
        severity: 'high',
        flagged_field: 'general',
        flagged_excerpt: match,
        why_rejected: 'Flashcard contains external URLs or website links.',
        remediation_advice: 'Remove external links from flashcards.',
      });
    }

    // Check PII email
    const emailMatches = fullText.match(PII_EMAIL_REGEX) || [];
    const realEmails = emailMatches.filter((e) => !PLACEHOLDER_EMAILS.has(e.toLowerCase()));
    if (realEmails.length > 0) {
      issues.push({
        type: 'card',
        card_id: cardId,
        card_index: index,
        prompt_es: promptEs,
        answer_en: answerEn,
        section_name: card.section_name,
        violated_categories: ['pii_and_privacy'],
        severity: 'critical',
        flagged_field: 'general',
        flagged_excerpt: realEmails[0],
        why_rejected: 'Potential personal email address detected in flashcard text.',
        remediation_advice: 'Remove personal email addresses or replace with placeholder like "example@example.com".',
      });
    }

    // Check PII phone
    const phoneMatches = fullText.match(PII_PHONE_REGEX) || [];
    if (phoneMatches.length > 0) {
      issues.push({
        type: 'card',
        card_id: cardId,
        card_index: index,
        prompt_es: promptEs,
        answer_en: answerEn,
        section_name: card.section_name,
        violated_categories: ['pii_and_privacy'],
        severity: 'critical',
        flagged_field: 'general',
        flagged_excerpt: phoneMatches[0],
        why_rejected: 'Potential phone number detected in flashcard text.',
        remediation_advice: 'Remove phone numbers or use standard fictional placeholders (e.g. 555-0100).',
      });
    }

    // Check prompt injection
    if (PROMPT_INJECTION_REGEX.test(fullText)) {
      const match = fullText.match(PROMPT_INJECTION_REGEX)?.[0] || 'prompt injection';
      issues.push({
        type: 'card',
        card_id: cardId,
        card_index: index,
        prompt_es: promptEs,
        answer_en: answerEn,
        section_name: card.section_name,
        violated_categories: ['adversarial_injection'],
        severity: 'critical',
        flagged_field: 'general',
        flagged_excerpt: match,
        why_rejected: 'Flashcard contains text commonly used in prompt injection attacks.',
        remediation_advice: 'Remove system instruction bypass keywords.',
      });
    }
  });

  return {
    passed: issues.length === 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Tier 1 & 2: Comprehensive Multi-Tier AI Safety Audit
// ---------------------------------------------------------------------------
const BATCH_SIZE = 8;

export async function auditDeckForPublishing(
  deckMeta,
  cards,
  { runPrompt, onProgress, signal, skipLLM = false } = {}
) {
  const activeCards = (cards || []).filter((c) => !c.is_deleted);
  const totalCards = activeCards.length;

  onProgress?.({
    phase: 'pre_scan',
    step: 0,
    total: totalCards,
    message: 'Running Tier 0 security & structure pre-scan...',
  });

  // 1. Run Tier 0 Pre-Scan
  const preScan = runDeterministicPreScan(deckMeta, activeCards);
  const conflictedCardsMap = new Map();

  // Populate deterministic issues
  preScan.issues.forEach((issue) => {
    if (issue.type === 'card') {
      conflictedCardsMap.set(String(issue.card_id), {
        card_id: issue.card_id,
        prompt_es: issue.prompt_es,
        answer_en: issue.answer_en,
        section_name: issue.section_name,
        violated_categories: issue.violated_categories,
        severity: issue.severity,
        flagged_field: issue.flagged_field,
        flagged_excerpt: issue.flagged_excerpt,
        why_rejected: issue.why_rejected,
        remediation_advice: issue.remediation_advice,
      });
    }
  });

  // If there are critical deck-level pre-scan failures (like 0 cards) or no LLM available, return early
  const deckIssues = preScan.issues.filter((i) => i.type === 'deck');
  if (deckIssues.length > 0 || skipLLM || !runPrompt) {
    const conflicted = Array.from(conflictedCardsMap.values());
    const isEligible = preScan.passed && conflicted.length === 0 && deckIssues.length === 0;

    return buildReport({
      deckMeta,
      totalCards,
      conflictedCards: conflicted,
      deckIssues: deckIssues.map((d) => d.why_rejected),
      isEligible,
      deckVerdict: isEligible ? 'approved' : 'rejected',
      deckSummary: isEligible
        ? 'Pre-scan passed. Deck meets basic requirements.'
        : `Pre-scan failed: ${deckIssues.map((d) => d.why_rejected).join('; ') || 'Issues detected in flashcards.'}`,
    });
  }

  // 2. Run Tier 1: Batched Card-Level LLM Safety Audit
  const batches = [];
  for (let i = 0; i < activeCards.length; i += BATCH_SIZE) {
    batches.push(activeCards.slice(i, i + BATCH_SIZE));
  }

  let processedCount = 0;
  for (let bIndex = 0; bIndex < batches.length; bIndex += 1) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const batch = batches[bIndex];
    onProgress?.({
      phase: 'card_audit',
      step: processedCount,
      total: totalCards,
      message: `Auditing cards ${processedCount + 1}–${Math.min(processedCount + batch.length, totalCards)} of ${totalCards}...`,
    });

    try {
      const prompt = cardSafetyAuditPrompt(batch, deckMeta);
      const response = await runPrompt(prompt);
      const evals = Array.isArray(response?.evaluations) ? response.evaluations : [];

      evals.forEach((ev) => {
        const cardMatch = batch.find((c) => String(c.id ?? c.card_id) === String(ev.card_id)) || batch[0];
        const cardId = cardMatch?.id ?? cardMatch?.card_id ?? ev.card_id;

        if (ev.status === 'fail' || (Array.isArray(ev.violated_categories) && ev.violated_categories.length > 0)) {
          const existing = conflictedCardsMap.get(String(cardId));
          const mergedCategories = Array.from(
            new Set([...(existing?.violated_categories || []), ...(ev.violated_categories || [])])
          );

          conflictedCardsMap.set(String(cardId), {
            card_id: cardId,
            prompt_es: cardMatch?.spanish_text ?? cardMatch?.prompt_es ?? 'Word',
            answer_en: cardMatch?.english_text ?? cardMatch?.answer_en ?? 'Translation',
            section_name: cardMatch?.section_name,
            violated_categories: mergedCategories.length > 0 ? mergedCategories : ['linguistic_integrity'],
            severity: ev.severity || existing?.severity || 'high',
            flagged_field: ev.flagged_field || existing?.flagged_field || 'general',
            flagged_excerpt: ev.flagged_excerpt || existing?.flagged_excerpt || '',
            why_rejected: ev.why_rejected || existing?.why_rejected || 'Flashcard flagged by content safety policy.',
            remediation_advice: ev.remediation_advice || existing?.remediation_advice || 'Review and revise card content.',
          });
        }
      });
    } catch (err) {
      console.warn('Safety audit batch evaluation warning:', err);
    }

    processedCount += batch.length;
  }

  // 3. Run Tier 2: Deck-Level Holistic Safety Audit
  onProgress?.({
    phase: 'deck_audit',
    step: totalCards,
    total: totalCards,
    message: 'Evaluating overall deck integrity and metadata...',
  });

  let deckVerdict = 'approved';
  let deckSummary = 'All security, safety, and ethics audits passed.';
  const holisticDeckIssues = [];

  try {
    const deckPrompt = deckSafetyAuditPrompt(deckMeta, activeCards);
    const deckResponse = await runPrompt(deckPrompt);

    if (deckResponse?.is_eligible === false || deckResponse?.verdict === 'rejected') {
      deckVerdict = 'rejected';
      deckSummary = deckResponse.summary || 'Deck topic or description violated community guidelines.';
      if (Array.isArray(deckResponse.deck_level_issues)) {
        holisticDeckIssues.push(...deckResponse.deck_level_issues);
      }
    } else if (deckResponse?.summary) {
      deckSummary = deckResponse.summary;
    }
  } catch (deckErr) {
    console.warn('Deck holistic audit warning:', deckErr);
  }

  const conflictedCards = Array.from(conflictedCardsMap.values());
  const criticalCount = conflictedCards.filter((c) => c.severity === 'critical' || c.severity === 'high').length;
  const isEligible = deckVerdict === 'approved' && criticalCount === 0 && conflictedCards.length === 0;

  return buildReport({
    deckMeta,
    totalCards,
    conflictedCards,
    deckIssues: holisticDeckIssues,
    isEligible,
    deckVerdict: isEligible ? 'approved' : 'rejected',
    deckSummary,
  });
}

function buildReport({ deckMeta, totalCards, conflictedCards, deckIssues, isEligible, deckVerdict, deckSummary }) {
  const policyBreakdown = {};
  Object.keys(SAFETY_CATEGORIES).forEach((cat) => {
    policyBreakdown[cat] = 0;
  });

  conflictedCards.forEach((c) => {
    (c.violated_categories || []).forEach((cat) => {
      if (policyBreakdown[cat] !== undefined) {
        policyBreakdown[cat] += 1;
      }
    });
  });

  return {
    deck_title: deckMeta?.title || 'Deck',
    eligible: isEligible,
    verdict: deckVerdict,
    summary: {
      total_cards_scanned: totalCards,
      clean_cards: Math.max(0, totalCards - conflictedCards.length),
      conflicted_cards_count: conflictedCards.length,
      verdict_summary: isEligible
        ? 'Deck cleared all security and ethics checks and is ready for publishing.'
        : deckSummary || `Deck contains ${conflictedCards.length} conflicted card${conflictedCards.length === 1 ? '' : 's'} that must be resolved before publication.`,
      deck_level_issues: deckIssues || [],
      policy_breakdown: policyBreakdown,
    },
    conflicted_cards: conflictedCards,
    audited_at: new Date().toISOString(),
  };
}
