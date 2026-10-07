// Vercel function: the stateless half of the server. It reads uploaded documents,
// maps text onto campaign fields with Claude, and runs the Flow Planner. Campaigns
// are NOT stored here: in the Vercel build the browser keeps them (VITE_STORAGE=local).
const express = require('express');
const cors = require('cors');
const { AnthropicFoundry } = require('@anthropic-ai/foundry-sdk');
const stateless = require('../server/stateless');
const studio = require('../server/studio-routes');

const app = express();
app.use(cors());
// Vercel rejects request bodies over ~4.5 MB before they reach this function.
app.use(express.json({ limit: '4mb' }));

const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY;
const resource = process.env.ANTHROPIC_FOUNDRY_RESOURCE;
const ai = apiKey && resource ? new AnthropicFoundry({ apiKey, resource }) : null;
const model = process.env.CLAUDE_DEPLOYMENT || 'claude-opus-4-8';

stateless.register(app, { ai, model });
studio.registerAi(app, { ai, model, extractFileText: stateless.extractFileText });

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'campaign-studio-vercel', ai: !!ai }));

module.exports = app;
