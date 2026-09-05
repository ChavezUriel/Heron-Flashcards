// Deterministic flashcard validators.
// Re-exports the shared validator from frontend/src/ai/validate.js (P4)
// to guarantee zero divergence between the CLI and web app.

const path = require('path');
const sharedValidate = require(path.resolve(__dirname, '../../../frontend/src/ai/validate.js'));

module.exports = sharedValidate;

