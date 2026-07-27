import { prisma } from '../lib/prisma.js';
import { ApiError } from '../http/errors.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

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
