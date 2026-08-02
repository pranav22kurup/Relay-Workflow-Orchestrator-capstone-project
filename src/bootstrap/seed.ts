import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { loadNodeCatalog } from './catalog.js';

type SeedWorkflow = {
  id: string;
  name: string;
  description?: string;
  trigger: unknown;
  entry: string;
  limits: unknown;
  nodes: unknown[];
};

type SeedFile = {
  workflows: SeedWorkflow[];
};

function seedPath(fileName: string): string {
  return path.resolve(process.cwd(), 'data', fileName);
}

export async function loadSeedWorkflows(): Promise<void> {
  await loadNodeCatalog();

  const raw = await readFile(seedPath('seed_workflows.json'), 'utf8');
  const parsed = JSON.parse(raw) as SeedFile;

  for (const workflow of parsed.workflows) {
    const existing = await prisma.workflow.findUnique({ where: { id: workflow.id } });
    const definition = JSON.stringify(workflow);

    await prisma.workflow.upsert({
      where: { id: workflow.id },
      create: {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        status: 'published',
        definition
      },
      update: {
        name: workflow.name,
        description: workflow.description,
        status: 'published',
        definition
      }
    });

    if (existing && existing.definition !== definition) {
      await prisma.workflow.update({
        where: { id: workflow.id },
        data: {
          name: workflow.name,
          description: workflow.description,
          status: 'published',
          definition
        }
      });
    }
  }
}
