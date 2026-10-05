import { prisma } from '../lib/prisma.js';
import { ApiError } from '../http/errors.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function safeParse(value: string | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function listRuns(workflowId?: string) {
  const runs = await prisma.run.findMany({
    where: workflowId ? { workflowId } : undefined,
    orderBy: { startedAt: 'desc' }
  });

  return runs.map((run) => ({
    run_id: run.id,
    workflow_id: run.workflowId,
    status: run.status,
    trigger_type: run.triggerType,
    steps_executed: run.stepsExecuted,
    ai_tokens_used: run.aiTokensUsed,
    error: run.error,
    started_at: run.startedAt,
    finished_at: run.finishedAt
  }));
}

/**
 * The trace: every step with resolved input, output, attempts, timing, and
 * (for ai steps) token usage - complete enough to debug a wrong branch
 * decision after the fact. approval_id is attached by joining Approval
 * rows on (runId, nodeId) rather than trusting it to still be sitting in a
 * step's `output` (which gets overwritten once the approval is decided).
 */
export async function getRunTrace(runId: string) {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) {
    throw new ApiError(404, 'run_not_found', 'Run not found');
  }

  const [steps, approvals] = await Promise.all([
    prisma.step.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }),
    prisma.approval.findMany({ where: { runId } })
  ]);

  const approvalIdByNodeId = new Map(approvals.map((approval) => [approval.nodeId, approval.id]));

  return {
    run_id: run.id,
    workflow_id: run.workflowId,
    status: run.status,
    trigger_type: run.triggerType,
    input: safeParse(run.input),
    current_node_id: run.currentNodeId,
    steps_executed: run.stepsExecuted,
    ai_tokens_used: run.aiTokensUsed,
    error: run.error,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    steps: steps.map((step) => ({
      node_id: step.nodeId,
      type: step.nodeType,
      status: step.status,
      sequence: step.sequence,
      attempt: step.attempt,
      input: safeParse(step.resolvedInput),
      output: safeParse(step.output),
      idempotency_key: step.idempotencyKey,
      tokens_prompt: step.tokensPrompt,
      tokens_completion: step.tokensCompletion,
      started_at: step.startedAt,
      duration_ms: step.durationMs,
      ...(approvalIdByNodeId.has(step.nodeId) ? { approval_id: approvalIdByNodeId.get(step.nodeId) } : {})
    }))
  };
}

/**
 * Cancel semantics (API_CONTRACT.md #5):
 * - queued: ends cancelled without executing anything - runOnce's terminal
 *   check already no-ops on a cancelled run, so setting the status is enough.
 * - running: stops cooperatively - the engine checks between steps (see
 *   src/engine/worker.ts), so the in-flight step is left to finish.
 * - waiting_approval: ends cancelled and closes the pending approval so it's
 *   no longer actionable or listed as pending.
 * - already terminal: 409.
 */
export async function cancelRun(runId: string) {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) {
    throw new ApiError(404, 'run_not_found', 'Run not found');
  }

  if (TERMINAL_STATUSES.has(run.status)) {
    throw new ApiError(409, 'run_already_terminal', `Run '${runId}' is already ${run.status}`);
  }

  const finishedAt = new Date();

  await prisma.$transaction([
    prisma.run.update({
      where: { id: runId },
      data: { status: 'cancelled', error: 'Run was cancelled', finishedAt }
    }),
    prisma.approval.updateMany({
      where: { runId, status: 'pending' },
      data: { status: 'cancelled', decidedAt: finishedAt }
    })
  ]);

  return { run_id: runId, status: 'cancelled' as const };
}
