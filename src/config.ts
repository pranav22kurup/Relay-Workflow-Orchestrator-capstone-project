import './env.js';

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./dev.db',
  mockWorldUrl: process.env.MOCK_WORLD_URL ?? 'http://localhost:9210',
  demoToken: process.env.DEMO_TOKEN ?? 'demo-token',
  // Every outbound call the engine makes (mock world, and later model
  // providers) is bounded so a hung dependency fails the step, not the engine.
  engineHttpTimeoutMs: Number(process.env.ENGINE_HTTP_TIMEOUT_MS ?? 5000),
  // Per-node retry policy for transient failures (timeouts, network errors,
  // 5xx from the mock world) - exponential backoff between attempts.
  nodeMaxAttempts: Number(process.env.NODE_MAX_ATTEMPTS ?? 3),
  nodeRetryBaseDelayMs: Number(process.env.NODE_RETRY_BASE_DELAY_MS ?? 200),
  nodeRetryMaxDelayMs: Number(process.env.NODE_RETRY_MAX_DELAY_MS ?? 5000),
  // AI provider adapter: any OpenAI-chat-completions-compatible endpoint
  // (Groq, Ollama's OpenAI-compat route, a Gemini compat proxy, or the
  // bundled scripts/mock_provider.py for local smoke testing). Engine tests
  // swap in an in-process fake instead of hitting this - see src/ai/provider.ts.
  aiProviderUrl: process.env.AI_PROVIDER_URL ?? '',
  aiProviderApiKey: process.env.AI_PROVIDER_API_KEY ?? '',
  aiProviderModel: process.env.AI_PROVIDER_MODEL ?? ''
} as const;
