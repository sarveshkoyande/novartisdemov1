// Vercel function: the stateless half of the server. It reads uploaded documents,
// maps text onto campaign fields with Claude, and runs the Flow Planner. Campaigns
// are NOT stored here: in the Vercel build the browser keeps them (VITE_STORAGE=local).
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
// Vercel rejects request bodies over ~4.5 MB before they reach this function.
app.use(express.json({ limit: '4mb' }));

const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY;
const resource = process.env.ANTHROPIC_FOUNDRY_RESOURCE;
const model = process.env.CLAUDE_DEPLOYMENT || 'claude-opus-4-8';

try {
  const { AnthropicFoundry } = require('@anthropic-ai/foundry-sdk');
  const stateless = require('../server/stateless');
  const studio = require('../server/studio-routes');
  const ai = apiKey && resource ? new AnthropicFoundry({ apiKey, resource }) : null;

  stateless.register(app, { ai, model });
  studio.registerAi(app, { ai, model, extractFileText: stateless.extractFileText });
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'campaign-studio-vercel', ai: !!ai, node: process.version }));
} catch (err) {
  // Startup failure: say what it was instead of a bare 500, so it can be fixed from the deploy.
  console.error('[api] failed to start:', err);
  const detail = String((err && err.stack) || err).split('\n').slice(0, 6).join('\n');
  app.use((req, res) => res.status(500).json({ error: 'The API failed to start.', detail }));
}

// Anything that throws inside a route comes back as readable JSON.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api] request failed:', err);
  res.status(500).json({ error: 'The API hit an error.', detail: String((err && err.message) || err) });
});

module.exports = app;
