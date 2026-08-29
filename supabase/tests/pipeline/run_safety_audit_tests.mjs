#!/usr/bin/env node
// Offline tests for the Safety, Security and Ethics Filter (frontend/src/ai/safetyAudit.js)
//
//   node supabase/tests/pipeline/run_safety_audit_tests.mjs

import assert from 'assert';
import { runDeterministicPreScan, auditDeckForPublishing, SAFETY_CATEGORIES } from '../../../frontend/src/ai/safetyAudit.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('Safety & Ethics Filter Tests');

  // Test 1: Clean deck pre-scan
  await test('T1: Clean deck passes deterministic pre-scan', async () => {
    const deck = { title: 'Pharmacy Basics', description: 'Beginner medical English' };
    const cards = [
      { id: 1, spanish_text: 'la medicina', english_text: 'medicine', definition_en: 'Substance used for medical treatment.' },
      { id: 2, spanish_text: 'la receta', english_text: 'prescription', definition_en: 'Doctor note authorizing medication.' },
    ];
    const preScan = runDeterministicPreScan(deck, cards);
    assert.strictEqual(preScan.passed, true);
    assert.strictEqual(preScan.issues.length, 0);
  });

  // Test 2: PII Detection (real email and phone)
  await test('T2: Detects PII email and phone numbers', async () => {
    const deck = { title: 'Contact info', description: 'Vocabulary' };
    const cards = [
      { id: 10, spanish_text: 'contacto', english_text: 'contact', example_es: 'Escribe a john.doe@realcompany.org para pedir ayuda.' },
      { id: 11, spanish_text: 'llamar', english_text: 'to call', example_en: 'Call me at 415-555-1234 tonight.' },
      { id: 12, spanish_text: 'correo', english_text: 'mail', example_en: 'Use example@example.com for testing.' }, // Allowed placeholder
    ];
    const preScan = runDeterministicPreScan(deck, cards);
    assert.strictEqual(preScan.passed, false);
    const piiIssues = preScan.issues.filter((i) => i.violated_categories?.includes('pii_and_privacy'));
    assert.strictEqual(piiIssues.length, 2, 'Should flag 2 PII issues (1 email, 1 phone; placeholder ignored)');
    assert.strictEqual(piiIssues[0].card_id, 10);
    assert.strictEqual(piiIssues[1].card_id, 11);
  });

  // Test 3: Malicious script tags and URLs
  await test('T3: Flags malicious scripts and external links', async () => {
    const deck = { title: 'Tech vocabulary', description: 'Terms' };
    const cards = [
      { id: 20, spanish_text: 'código', english_text: 'code', example_en: 'Look at <script>alert("hack")</script> in HTML.' },
      { id: 21, spanish_text: 'enlace', english_text: 'link', example_en: 'Visit https://spammy-affiliate.com/buy-now for deals.' },
    ];
    const preScan = runDeterministicPreScan(deck, cards);
    assert.strictEqual(preScan.passed, false);
    const malicious = preScan.issues.filter((i) => i.violated_categories?.includes('spam_and_malicious'));
    assert.strictEqual(malicious.length, 2);
  });

  // Test 4: LLM-as-judge audit simulation with Hate Speech and False Friends
  await test('T4: End-to-end audit flags hate speech and false friends with actionable remediation', async () => {
    const deck = { title: 'Vocabulary test', description: 'Mixed words' };
    const cards = [
      { id: 101, spanish_text: 'buenos días', english_text: 'good morning', definition_en: 'Morning greeting.' },
      { id: 102, spanish_text: 'insulto', english_text: 'slur', example_en: 'He yelled a hateful slur targeting minorities.' },
      { id: 103, spanish_text: 'embarazada', english_text: 'embarrassed', definition_en: 'Feeling shame or awkwardness.' }, // False friend
    ];

    const stubModel = async (promptObj) => {
      const task = JSON.parse(promptObj.user).task;
      if (task.startsWith('Audit this batch')) {
        return {
          evaluations: [
            { card_id: 101, status: 'pass', violated_categories: [], severity: 'none' },
            {
              card_id: 102,
              status: 'fail',
              violated_categories: ['hate_and_harassment'],
              severity: 'critical',
              flagged_field: 'example_en',
              flagged_excerpt: 'hateful slur',
              why_rejected: 'Example sentence promotes derogatory or abusive targeting.',
              remediation_advice: 'Replace with an educational example showing neutral context.',
            },
            {
              card_id: 103,
              status: 'fail',
              violated_categories: ['linguistic_integrity'],
              severity: 'high',
              flagged_field: 'answer_en',
              flagged_excerpt: 'embarrassed',
              why_rejected: 'False friend: "embarazada" means "pregnant", not "embarrassed".',
              remediation_advice: 'Update English answer to "pregnant" or Spanish prompt to "avergonzada".',
            },
          ],
        };
      }
      if (task.startsWith('Audit this deck title')) {
        return { is_eligible: true, verdict: 'approved', summary: 'Deck title is acceptable.' };
      }
      throw new Error('Unknown prompt: ' + task);
    };

    const report = await auditDeckForPublishing(deck, cards, { runPrompt: stubModel });
    assert.strictEqual(report.eligible, false);
    assert.strictEqual(report.verdict, 'rejected');
    assert.strictEqual(report.summary.conflicted_cards_count, 2);
    assert.strictEqual(report.summary.clean_cards, 1);
    assert.strictEqual(report.summary.policy_breakdown.hate_and_harassment, 1);
    assert.strictEqual(report.summary.policy_breakdown.linguistic_integrity, 1);

    // Verify conflicted card diagnostics
    assert.strictEqual(report.conflicted_cards[0].card_id, 102);
    assert.strictEqual(report.conflicted_cards[0].why_rejected.includes('derogatory'), true);
    assert.strictEqual(report.conflicted_cards[0].remediation_advice.includes('Replace with an educational example'), true);

    assert.strictEqual(report.conflicted_cards[1].card_id, 103);
    assert.strictEqual(report.conflicted_cards[1].why_rejected.includes('False friend'), true);
  });

  // Test 5: Fully clean deck gets approved verdict
  await test('T5: Clean deck gets approved verdict and is eligible for publishing', async () => {
    const deck = { title: 'Food & Cooking', description: 'Culinary terms in English' };
    const cards = [
      { id: 201, spanish_text: 'la manzana', english_text: 'apple', definition_en: 'A round fruit with red or green skin.' },
      { id: 202, spanish_text: 'el pan', english_text: 'bread', definition_en: 'Food made of flour, water, and yeast.' },
    ];

    const stubModel = async () => ({
      evaluations: [
        { card_id: 201, status: 'pass', violated_categories: [] },
        { card_id: 202, status: 'pass', violated_categories: [] },
      ],
      is_eligible: true,
      verdict: 'approved',
      summary: 'High quality culinary deck.',
    });

    const report = await auditDeckForPublishing(deck, cards, { runPrompt: stubModel });
    assert.strictEqual(report.eligible, true);
    assert.strictEqual(report.verdict, 'approved');
    assert.strictEqual(report.conflicted_cards.length, 0);
    assert.strictEqual(report.summary.clean_cards, 2);
  });

  console.log(`\nALL ${passed} SAFETY & ETHICS TESTS PASSED`);
})();
