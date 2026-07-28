import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createMockLanguageModel } from './ai/mock-nlu.js';

const config = loadConfig();

// AI_PROVIDER=mock is for E2E/local testing only (research.md §8) — a real deployment sets
// AI_PROVIDER=anthropic|openai and this branch never runs.
const languageModel = process.env.AI_PROVIDER === 'mock' ? createMockLanguageModel() : undefined;

buildApp({ config, languageModel })
  .then((app) => app.listen({ port: config.port, host: '0.0.0.0' }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
