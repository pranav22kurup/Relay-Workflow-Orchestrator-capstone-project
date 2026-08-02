import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { createApp } from './app.js';
import { loadSeedWorkflows } from './bootstrap/seed.js';
import { startWorker } from './engine/worker.js';

async function main(): Promise<void> {
  await loadSeedWorkflows();

  const app = await createApp();

  startWorker();

  app.listen(config.port, () => {
    console.log(`Relay API listening on http://localhost:${config.port}`);
  });
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
