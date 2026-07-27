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
  nodeRetryMaxDelayMs: Number(process.env.NODE_RETRY_MAX_DELAY_MS ?? 5000)
} as const;
