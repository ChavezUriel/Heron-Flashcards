// Prompt builders for the card generator pipeline.
// Re-exports the shared prompt rules from frontend/src/ai/promptRules.js (P3)
// to guarantee zero divergence between the CLI and web app.

const path = require('path');
const sharedRules = require(path.resolve(__dirname, '../../../frontend/src/ai/promptRules.js'));

module.exports = sharedRules;
