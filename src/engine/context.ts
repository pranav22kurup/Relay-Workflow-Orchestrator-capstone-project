import { prisma } from '../lib/prisma.js';
import type { TemplateContext } from './template.js';

type RunLike = { id: string; input: string };

/**
 * Rebuilds the template context from persisted state rather than in-memory
 * accumulation, so the same function works for a fresh run and a resumed one
 * (Day 7 durability) without a separate code path.
 */
export async function buildRunContext(run: RunLike): Promise<TemplateContext> {
  const steps = await prisma.step.findMany({
    where: { runId: run.id, status: 'succeeded' },
    orderBy: { sequence: 'asc' }
  });

  const nodes: Record<string, { output: unknown }> = {};
  for (const step of steps) {
    nodes[step.nodeId] = { output: step.output ? JSON.parse(step.output) : null };
  }

  return {
    trigger: { body: JSON.parse(run.input) },
    nodes
  };
}
