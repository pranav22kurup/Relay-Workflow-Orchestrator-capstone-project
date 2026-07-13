import './env.js';

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./dev.db',
  mockWorldUrl: process.env.MOCK_WORLD_URL ?? 'http://localhost:9210',
  demoToken: process.env.DEMO_TOKEN ?? 'demo-token'
} as const;
