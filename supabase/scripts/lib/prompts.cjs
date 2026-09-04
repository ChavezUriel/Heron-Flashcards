// Prompt builders for the card generator pipeline.
// Deliberate text-for-text parity with frontend/src/ai/prompts.js.
// Extracted into shared source frontend/src/ai/promptRules.js (P3) to guarantee zero divergence.

const path = require('path');
const sharedRules = require(path.resolve(__dirname, '../../../frontend/src/ai/promptRules.js'));

module.exports = sharedRules;
