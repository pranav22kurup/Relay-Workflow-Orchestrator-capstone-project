import { prisma } from '../lib/prisma.js';
import { buildRunContext } from './context.js';
import { resolveTemplates, type TemplateContext } from './template.js';
import { nodeExecutors, UnimplementedNodeTypeError } from './executors.js';
import { loadNodeCatalog } from '../bootstrap/catalog.js';
import type { WorkflowDefinition } from '../workflows/validation.js';

type DefinitionNode = WorkflowDefinition['nodes'][number];

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const DEFAULT_MAX_STEPS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMaxSteps(definition: WorkflowDefinition): number {
  const limits = definition.limits as Record<string, unknown> | undefined;
  const maxSteps = limits?.max_steps;
  return typeof maxSteps === 'number' && Number.isFinite(maxSteps) ? maxSteps : DEFAULT_MAX_STEPS;
}

function nextNodeId(node: DefinitionNode, output: Record<string, unknown>): string | null {
  if (node.type === 'condition') {
    const target = output.result ? node.on_true : node.on_false;
    return typeof target === 'string' ? target : null;
  }
  return typeof node.next === 'string' ? node.next : null;
}

function buildIdempotencyKey(runId: string, nodeId: string, sequence: number): string {
  // {run_id}:{node_id}:{sequence}. Stable across retries and resumes of one
  // node attempt (sequence is only assigned once, before the first try, and
  // doesn't advance until the step succeeds) - but distinct per loop
  // iteration (each iteration gets its own sequence), so a backward jump
  // that revisits the same node id is treated as a new side effect.
  return `${runId}:${nodeId}:${sequence}`;
}

async function recordFailedStep(
  runId: string,
  node: DefinitionNode,
  sequence: number,
  resolvedInput: unknown,
  message: string,
  startedAt: Date,
  idempotencyKey?: string
): Promise<void> {
  await prisma.step.create({
    data: {
      runId,
      nodeId: node.id,
      nodeType: node.type,
      sequence,
      status: 'failed',
      attempt: 1,
      resolvedInput: JSON.stringify(resolvedInput),
      output: JSON.stringify({ error: message }),
      idempotencyKey: idempotencyKey ?? null,
      startedAt,
      durationMs: Date.now() - startedAt.getTime()
    }
  });
}

async function failRun(runId: string, message: string, stepsExecuted: number): Promise<void> {
  await prisma.run.update({
    where: { id: runId },
    data: { status: 'failed', error: message, finishedAt: new Date(), stepsExecuted }
  });
}

/**
 * Executes one run to completion, a pause point, or a failure - whichever
 * comes first. Each step is persisted (persist-then-advance) before the run
 * pointer moves, which is what Day 7 crash recovery will resume from.
 */
export async function runOnce(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
    return;
  }

  const definition = JSON.parse(run.definitionSnapshot) as WorkflowDefinition;
  const nodeMap = new Map(definition.nodes.map((node) => [node.id, node]));
  const maxSteps = getMaxSteps(definition);

  const catalog = await loadNodeCatalog();
  const sideEffectNodeTypes = new Set(catalog.nodes.filter((n) => n.side_effect).map((n) => n.type));

  if (run.status === 'queued') {
    await prisma.run.update({ where: { id: run.id }, data: { status: 'running' } });
  }

  const context: TemplateContext = await buildRunContext(run);
  let currentNodeId: string | null = run.currentNodeId ?? definition.entry;
  let stepsExecuted = run.stepsExecuted;

  while (currentNodeId) {
    if (stepsExecuted >= maxSteps) {
      await failRun(run.id, `Step cap exceeded: run executed ${stepsExecuted} steps, limit is ${maxSteps} (limits.max_steps)`, stepsExecuted);
      return;
    }

    const node = nodeMap.get(currentNodeId);
    if (!node) {
      await failRun(run.id, `Node '${currentNodeId}' is referenced but not found in the workflow definition`, stepsExecuted);
      return;
    }

    const startedAt = new Date();
    const sequence = stepsExecuted + 1;

    let resolvedInput: Record<string, unknown>;
    try {
      resolvedInput = resolveTemplates(node.params ?? {}, context) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordFailedStep(run.id, node, sequence, node.params ?? {}, message, startedAt);
      await failRun(run.id, message, sequence);
      return;
    }

    const executor = nodeExecutors[node.type];
    if (!executor) {
      const message = new UnimplementedNodeTypeError(node.type).message;
      await recordFailedStep(run.id, node, sequence, resolvedInput, message, startedAt);
      await failRun(run.id, message, sequence);
      return;
    }

    // Computed before the call, from persisted state alone, so a resume
    // after a crash recomputes the exact same key for the same attempt.
    const idempotencyKey = buildIdempotencyKey(run.id, node.id, sequence);

    let result;
    try {
      result = await executor(resolvedInput, { idempotencyKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only recorded for node types the catalog marks as side-effecting -
      // the key was never actually sent anywhere for e.g. a failed condition.
      const failedKey = sideEffectNodeTypes.has(node.type) ? idempotencyKey : undefined;
      await recordFailedStep(run.id, node, sequence, resolvedInput, message, startedAt, failedKey);
      await failRun(run.id, message, sequence);
      return;
    }

    stepsExecuted = sequence;

    await prisma.step.create({
      data: {
        runId: run.id,
        nodeId: node.id,
        nodeType: node.type,
        sequence,
        status: 'succeeded',
        attempt: 1,
        resolvedInput: JSON.stringify(resolvedInput),
        output: JSON.stringify(result.output),
        idempotencyKey: result.idempotencyKey ?? null,
        startedAt,
        durationMs: Date.now() - startedAt.getTime()
      }
    });

    context.nodes[node.id] = { output: result.output };

    const nextId = nextNodeId(node, result.output);

    if (!nextId) {
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'succeeded', currentNodeId: null, stepsExecuted, finishedAt: new Date() }
      });
      return;
    }

    await prisma.run.update({ where: { id: run.id }, data: { currentNodeId: nextId, stepsExecuted } });
    currentNodeId = nextId;
  }
}

/**
 * Claims the oldest available queued job with a conditional update, so a
 * job already claimed (or not yet due) is left alone. Single-worker for
 * Must Have, but the claim is written to survive multiple pollers later.
 */
export async function pollQueueOnce(): Promise<boolean> {
  const now = new Date();
  const job = await prisma.queueJob.findFirst({
    where: { type: 'run_step', status: 'queued', availableAt: { lte: now } },
    orderBy: { availableAt: 'asc' }
  });

  if (!job) {
    return false;
  }

  const claimed = await prisma.queueJob.updateMany({
    where: { id: job.id, status: 'queued' },
    data: { status: 'running', lockedAt: now, attempts: { increment: 1 } }
  });

  if (claimed.count === 0) {
    return false;
  }

  const payload = JSON.parse(job.payload) as { runId: string };

  try {
    await runOnce(payload.runId);
    await prisma.queueJob.update({ where: { id: job.id }, data: { status: 'done' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Worker job ${job.id} failed`, error);
    await prisma.queueJob.update({ where: { id: job.id }, data: { status: 'failed', error: message } });
  }

  return true;
}

/**
 * A job stuck in `running` past a worker's lifetime is the crash signature:
 * something claimed it and never finished. Reset it to `queued` so it's
 * picked up again - the run itself resumes correctly from its persisted
 * currentNodeId/stepsExecuted regardless of why runOnce is being re-invoked.
 */
export async function reclaimInFlightJobs(): Promise<number> {
  const result = await prisma.queueJob.updateMany({
    where: { type: 'run_step', status: 'running' },
    data: { status: 'queued', lockedAt: null, availableAt: new Date() }
  });
  return result.count;
}

export function startWorker(intervalMs = 500): () => void {
  let stopped = false;

  void (async function loop() {
    const reclaimed = await reclaimInFlightJobs();
    if (reclaimed > 0) {
      console.log(`Worker reclaimed ${reclaimed} in-flight job(s) left over from a previous run`);
    }

    while (!stopped) {
      let worked = false;
      try {
        worked = await pollQueueOnce();
      } catch (error) {
        console.error('Worker poll error', error);
      }
      if (!worked) {
        await sleep(intervalMs);
      }
    }
  })();

  return () => {
    stopped = true;
  };
}
