import { prisma } from '../lib/prisma.js';
import { buildRunContext } from './context.js';
import { resolveTemplates, type TemplateContext } from './template.js';
import { nodeExecutors, UnimplementedNodeTypeError } from './executors.js';
import { loadNodeCatalog } from '../bootstrap/catalog.js';
import { config } from '../config.js';
import { withRetries } from './retry.js';
import { HttpTimeoutError, HttpNetworkError } from './httpClient.js';
import { NotifyDeliveryError } from './nodes/notify.js';
import { OrderActionError } from './nodes/orderAction.js';
import { AiProviderError } from '../ai/provider.js';
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

/**
 * Only errors that are genuinely transient (timeouts, network failures, 5xx
 * from the mock world) consume a retry. A bad param, a broken template, or a
 * 4xx business-rule rejection (already refunded, amount too high) will fail
 * identically on the next attempt, so those fail on the first try.
 */
function isRetryableNodeError(error: unknown): boolean {
  if (error instanceof HttpTimeoutError || error instanceof HttpNetworkError) {
    return true;
  }
  if (error instanceof NotifyDeliveryError) {
    return error.status >= 500;
  }
  if (error instanceof OrderActionError) {
    // 404 (unknown order), 400 (bad amount), 409 (already refunded) are
    // permanent business-rule outcomes; 5xx is the mock world genuinely down.
    return error.status >= 500;
  }
  if (error instanceof AiProviderError) {
    // 5xx and 429 (rate limited) are worth a backoff-and-retry; a 4xx like a
    // bad model name or an auth failure will fail identically again.
    return error.status >= 500 || error.status === 429;
  }
  return false;
}

/** Duck-typed: any thrown error may optionally report token spend (only the
 * `ai` node's errors do), so this stays independent of which node type threw. */
function extractTokenUsage(error: unknown): { tokensPrompt: number; tokensCompletion: number } | null {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { tokensPrompt?: unknown }).tokensPrompt === 'number' &&
    typeof (error as { tokensCompletion?: unknown }).tokensCompletion === 'number'
  ) {
    const withUsage = error as { tokensPrompt: number; tokensCompletion: number };
    return { tokensPrompt: withUsage.tokensPrompt, tokensCompletion: withUsage.tokensCompletion };
  }
  return null;
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
  attempt: number,
  idempotencyKey?: string,
  tokenUsage?: { tokensPrompt: number; tokensCompletion: number }
): Promise<void> {
  await prisma.step.create({
    data: {
      runId,
      nodeId: node.id,
      nodeType: node.type,
      sequence,
      status: 'failed',
      attempt,
      resolvedInput: JSON.stringify(resolvedInput),
      output: JSON.stringify({ error: message }),
      idempotencyKey: idempotencyKey ?? null,
      tokensPrompt: tokenUsage?.tokensPrompt ?? null,
      tokensCompletion: tokenUsage?.tokensCompletion ?? null,
      startedAt,
      durationMs: Date.now() - startedAt.getTime()
    }
  });
}

async function failRun(runId: string, message: string, stepsExecuted: number, aiTokensUsed?: number): Promise<void> {
  await prisma.run.update({
    where: { id: runId },
    data: {
      status: 'failed',
      error: message,
      finishedAt: new Date(),
      stepsExecuted,
      ...(aiTokensUsed !== undefined ? { aiTokensUsed } : {})
    }
  });
}

type ApprovalNodeOutcome = { stepsExecuted: number; nextNodeId: string | null };

/**
 * The `approval` node doesn't return a result the way other executors do -
 * it pauses the run until a human decides. This handles both halves of that
 * lifecycle from the same call site, so a resume (approve/reject re-enqueue,
 * or a crash reclaim while still pending) always lands here again and
 * re-derives what to do from persisted Approval/Step state, never from
 * anything held in memory between calls.
 *
 * Returns undefined when there's nothing more for runOnce to do this call
 * (freshly paused, still pending, or the run just ended via rejection).
 * Returns the next node to advance to (or null, meaning the run just
 * succeeded) once a decision has been recorded.
 */
async function handleApprovalNode(
  runId: string,
  node: DefinitionNode,
  context: TemplateContext,
  stepsExecuted: number
): Promise<ApprovalNodeOutcome | undefined> {
  const existingApproval = await prisma.approval.findFirst({
    where: { runId, nodeId: node.id },
    orderBy: { createdAt: 'desc' }
  });

  if (!existingApproval) {
    const startedAt = new Date();
    const sequence = stepsExecuted + 1;

    let resolvedInput: Record<string, unknown>;
    try {
      resolvedInput = resolveTemplates(node.params ?? {}, context) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordFailedStep(runId, node, sequence, node.params ?? {}, message, startedAt, 1);
      await failRun(runId, message, sequence);
      return undefined;
    }

    const messageText = typeof resolvedInput.message === 'string' ? resolvedInput.message : '';

    await prisma.$transaction(async (tx) => {
      const created = await tx.approval.create({
        data: { runId, nodeId: node.id, message: messageText, status: 'pending' }
      });
      await tx.step.create({
        data: {
          runId,
          nodeId: node.id,
          nodeType: node.type,
          sequence,
          status: 'waiting',
          attempt: 1,
          resolvedInput: JSON.stringify(resolvedInput),
          output: JSON.stringify({ approval_id: created.id }),
          startedAt
        }
      });
    });

    await prisma.run.update({
      where: { id: runId },
      data: { status: 'waiting_approval', currentNodeId: node.id, stepsExecuted }
    });

    return undefined;
  }

  if (existingApproval.status === 'pending') {
    await prisma.run.update({ where: { id: runId }, data: { status: 'waiting_approval' } });
    return undefined;
  }

  // Decided (approved or rejected) - finalize the waiting step.
  const waitingStep = await prisma.step.findFirst({
    where: { runId, nodeId: node.id, status: 'waiting' },
    orderBy: { sequence: 'desc' }
  });

  const decisionOutput = { decision: existingApproval.status, decided_by: existingApproval.decidedBy };
  const finalizedAt = new Date();
  let finalStepsExecuted = stepsExecuted;

  if (waitingStep) {
    await prisma.step.update({
      where: { id: waitingStep.id },
      data: {
        status: 'succeeded',
        output: JSON.stringify(decisionOutput),
        durationMs: finalizedAt.getTime() - waitingStep.startedAt.getTime()
      }
    });
    finalStepsExecuted = waitingStep.sequence;
  }

  context.nodes[node.id] = { output: decisionOutput };

  if (existingApproval.status === 'rejected') {
    await prisma.run.update({
      where: { id: runId },
      data: { status: 'cancelled', error: `Approval '${node.id}' was rejected`, finishedAt: finalizedAt, stepsExecuted: finalStepsExecuted }
    });
    return undefined;
  }

  const nextId = typeof node.next === 'string' ? node.next : null;

  if (!nextId) {
    await prisma.run.update({
      where: { id: runId },
      data: { status: 'succeeded', currentNodeId: null, stepsExecuted: finalStepsExecuted, finishedAt: finalizedAt }
    });
    return { stepsExecuted: finalStepsExecuted, nextNodeId: null };
  }

  await prisma.run.update({ where: { id: runId }, data: { currentNodeId: nextId, stepsExecuted: finalStepsExecuted } });
  return { stepsExecuted: finalStepsExecuted, nextNodeId: nextId };
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
  const approvalRequiredNodeTypes = new Set(catalog.nodes.filter((n) => n.requires_approval).map((n) => n.type));

  // A resumed run (after an approve/reject re-enqueue, or after a crash
  // reclaim) is actively being processed again, so it's 'running' - even if
  // it was 'waiting_approval' a moment ago.
  if (run.status === 'queued' || run.status === 'waiting_approval') {
    await prisma.run.update({ where: { id: run.id }, data: { status: 'running' } });
  }

  const context: TemplateContext = await buildRunContext(run);
  let currentNodeId: string | null = run.currentNodeId ?? definition.entry;
  let stepsExecuted = run.stepsExecuted;
  let aiTokensUsed = run.aiTokensUsed;

  while (currentNodeId) {
    // Cooperative cancellation: checked between steps, not mid-step. A run
    // cancelled by the API while this loop was mid-step is picked up here,
    // before the *next* node starts - the in-flight step is left to finish.
    const liveRun = await prisma.run.findUnique({ where: { id: run.id }, select: { status: true } });
    if (!liveRun || liveRun.status === 'cancelled') {
      return;
    }

    if (stepsExecuted >= maxSteps) {
      await failRun(run.id, `Step cap exceeded: run executed ${stepsExecuted} steps, limit is ${maxSteps} (limits.max_steps)`, stepsExecuted);
      return;
    }

    const node = nodeMap.get(currentNodeId);
    if (!node) {
      await failRun(run.id, `Node '${currentNodeId}' is referenced but not found in the workflow definition`, stepsExecuted);
      return;
    }

    if (node.type === 'approval') {
      const advanceTo = await handleApprovalNode(run.id, node, context, stepsExecuted);
      if (advanceTo === undefined) {
        // Paused (still pending) or ended (rejected/terminal) - nothing more to do here.
        return;
      }
      stepsExecuted = advanceTo.stepsExecuted;
      if (!advanceTo.nextNodeId) {
        return;
      }
      currentNodeId = advanceTo.nextNodeId;
      continue;
    }

    if (approvalRequiredNodeTypes.has(node.type)) {
      const hasApproval = (await prisma.approval.count({ where: { runId: run.id, status: 'approved' } })) > 0;
      if (!hasApproval) {
        // Engine-enforced, independent of node params or any upstream AI
        // output: nothing written to the Approval table means this cannot run.
        const message = `Node '${node.id}' of type '${node.type}' requires an approved approval earlier in this run`;
        const sequence = stepsExecuted + 1;
        await recordFailedStep(run.id, node, sequence, node.params ?? {}, message, new Date(), 1);
        await failRun(run.id, message, sequence);
        return;
      }
    }

    const startedAt = new Date();
    const sequence = stepsExecuted + 1;

    let resolvedInput: Record<string, unknown>;
    try {
      resolvedInput = resolveTemplates(node.params ?? {}, context) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordFailedStep(run.id, node, sequence, node.params ?? {}, message, startedAt, 1);
      await failRun(run.id, message, sequence);
      return;
    }

    const executor = nodeExecutors[node.type];
    if (!executor) {
      const message = new UnimplementedNodeTypeError(node.type).message;
      await recordFailedStep(run.id, node, sequence, resolvedInput, message, startedAt, 1);
      await failRun(run.id, message, sequence);
      return;
    }

    // Computed before the call, from persisted state alone, so a resume
    // after a crash - or a retry of this same attempt - recomputes the
    // exact same key.
    const idempotencyKey = buildIdempotencyKey(run.id, node.id, sequence);

    const retryResult = await withRetries((_attempt) => executor(resolvedInput, { idempotencyKey }), {
      maxAttempts: config.nodeMaxAttempts,
      baseDelayMs: config.nodeRetryBaseDelayMs,
      maxDelayMs: config.nodeRetryMaxDelayMs,
      isRetryable: isRetryableNodeError
    });

    if (retryResult.outcome === 'failed') {
      const error = retryResult.error;
      const message = error instanceof Error ? error.message : String(error);
      // Only recorded for node types the catalog marks as side-effecting -
      // the key was never actually sent anywhere for e.g. a failed condition.
      const failedKey = sideEffectNodeTypes.has(node.type) ? idempotencyKey : undefined;
      // Tokens may have genuinely been spent even though the step failed
      // (e.g. two AI calls that both came back malformed) - still charge them.
      const tokenUsage = extractTokenUsage(error);
      if (tokenUsage) {
        aiTokensUsed += tokenUsage.tokensPrompt + tokenUsage.tokensCompletion;
      }
      await recordFailedStep(run.id, node, sequence, resolvedInput, message, startedAt, retryResult.attempts, failedKey, tokenUsage ?? undefined);
      await failRun(run.id, message, sequence, aiTokensUsed);
      return;
    }

    const result = retryResult.value;
    stepsExecuted = sequence;
    if (result.tokensPrompt !== undefined || result.tokensCompletion !== undefined) {
      aiTokensUsed += (result.tokensPrompt ?? 0) + (result.tokensCompletion ?? 0);
    }

    await prisma.step.create({
      data: {
        runId: run.id,
        nodeId: node.id,
        nodeType: node.type,
        sequence,
        status: 'succeeded',
        attempt: retryResult.attempts,
        resolvedInput: JSON.stringify(resolvedInput),
        output: JSON.stringify(result.output),
        idempotencyKey: result.idempotencyKey ?? null,
        tokensPrompt: result.tokensPrompt ?? null,
        tokensCompletion: result.tokensCompletion ?? null,
        startedAt,
        durationMs: Date.now() - startedAt.getTime()
      }
    });

    context.nodes[node.id] = { output: result.output };

    const nextId = nextNodeId(node, result.output);

    if (!nextId) {
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'succeeded', currentNodeId: null, stepsExecuted, aiTokensUsed, finishedAt: new Date() }
      });
      return;
    }

    await prisma.run.update({ where: { id: run.id }, data: { currentNodeId: nextId, stepsExecuted, aiTokensUsed } });
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
