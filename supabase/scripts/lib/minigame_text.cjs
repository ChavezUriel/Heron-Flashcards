// Card and minigame text helpers for the generator pipeline.
// Re-exports the shared text module from frontend/src/ai/cardText.js (P5)
// to guarantee zero divergence between the CLI and web app.

const path = require('path');
const sharedCardText = require(path.resolve(__dirname, '../../../frontend/src/ai/cardText.js'));

module.exports = sharedCardText;

