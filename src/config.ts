import './env.js';

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./dev.db',
  mockWorldUrl: process.env.MOCK_WORLD_URL ?? 'http://localhost:9210',
  demoToken: process.env.DEMO_TOKEN ?? 'demo-token',
  // Every outbound call the engine makes (mock world, and later model
  // providers) is bounded so a hung dependency fails the step, not the engine.
  engineHttpTimeoutMs: Number(process.env.ENGINE_HTTP_TIMEOUT_MS ?? 5000)
} as const;
