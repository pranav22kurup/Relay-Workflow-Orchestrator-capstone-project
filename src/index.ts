import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  const app = await createApp();

  app.listen(config.port, () => {
    console.log(`Relay API listening on http://localhost:${config.port}`);
  });
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
