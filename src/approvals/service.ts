import { prisma } from '../lib/prisma.js';
import { ApiError } from '../http/errors.js';

// Must Have: a single demo token covers builder/operator/approver, so the
// decider is a constant - the field still exists and is still populated,
// per API_CONTRACT.md ("the decider can be a constant").
const DEMO_DECIDER = 'demo-approver';

export async function listPendingApprovals() {
  const approvals = await prisma.approval.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' }
  });

  return approvals.map((approval) => ({
    id: approval.id,
    run_id: approval.runId,
    node_id: approval.nodeId,
    message: approval.message,
    status: approval.status,
    created_at: approval.createdAt
  }));
}

async function enqueueResume(runId: string): Promise<void> {
  await prisma.queueJob.create({
    data: {
      type: 'run_step',
      status: 'queued',
      payload: JSON.stringify({ runId }),
      availableAt: new Date()
    }
  });
}

/**
 * Only flips the Approval's decision and wakes the worker back up - the
 * actual Run/Step state transition happens in the engine (handleApprovalNode
 * in src/engine/worker.ts) the next time it revisits this node, the same way
 * a crash-resume re-derives everything from persisted state rather than
 * trusting anything decided outside the engine loop.
 */
async function decideApproval(approvalId: string, decision: 'approved' | 'rejected') {
  const approval = await prisma.approval.findUnique({ where: { id: approvalId } });
  if (!approval) {
    throw new ApiError(404, 'approval_not_found', 'Approval not found');
  }
  if (approval.status !== 'pending') {
    throw new ApiError(409, 'approval_already_decided', `Approval '${approvalId}' has already been ${approval.status}`);
  }

  const decidedAt = new Date();
  await prisma.approval.update({
    where: { id: approvalId },
    data: { status: decision, decidedBy: DEMO_DECIDER, decidedAt }
  });

  await enqueueResume(approval.runId);

  return { id: approval.id, run_id: approval.runId, status: decision, decided_by: DEMO_DECIDER, decided_at: decidedAt };
}

export function approveApproval(approvalId: string) {
  return decideApproval(approvalId, 'approved');
}

export function rejectApproval(approvalId: string) {
  return decideApproval(approvalId, 'rejected');
}
