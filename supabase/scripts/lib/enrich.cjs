// Card enrichment + LLM-audit engine for the generator pipeline.
// Re-exports the shared enrichment module from frontend/src/ai/enrich.js (P5)
// to guarantee zero divergence between the CLI and web app.

const path = require('path');
const sharedEnrich = require(path.resolve(__dirname, '../../../frontend/src/ai/enrich.js'));

module.exports = sharedEnrich;
