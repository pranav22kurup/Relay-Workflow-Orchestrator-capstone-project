import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma.js';
import { config } from '../src/config.js';
import { runOnce, pollQueueOnce } from '../src/engine/worker.js';
import { approveApproval, rejectApproval, listPendingApprovals } from '../src/approvals/service.js';
import { cancelRun } from '../src/runs/service.js';
import { ApiError } from '../src/http/errors.js';

before(async () => {
  try {
    const response = await fetch(`${config.mockWorldUrl}/health`);
    if (!response.ok) {
      throw new Error(`unexpected status ${response.status}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Mock world is not reachable at ${config.mockWorldUrl} - start it with 'python scripts/mock_world.py --port 9210' before running tests (${detail})`
    );
  }
});

type TestDefinition = {
  id: string;
  name: string;
  trigger: { type: string };
  entry: string;
  limits: Record<string, unknown>;
  nodes: unknown[];
};

async function seedTestWorkflow(definition: TestDefinition): Promise<void> {
  await prisma.workflow.create({
    data: { id: definition.id, name: definition.name, status: 'published', definition: JSON.stringify(definition) }
  });
}

async function seedTestRun(definition: TestDefinition, input: unknown) {
  return prisma.run.create({
    data: {
      workflowId: definition.id,
      triggerType: 'manual',
      definitionSnapshot: JSON.stringify(definition),
      input: JSON.stringify(input),
      status: 'queued',
      currentNodeId: definition.entry,
      stepsExecuted: 0
    }
  });
}

async function cleanupWorkflow(workflowId: string): Promise<void> {
  await prisma.workflow.delete({ where: { id: workflowId } }).catch(() => {});
}

// Clears the ledger and resets seeded orders back to their original status -
// needed before a test performs a real refund, so re-running the suite
// doesn't hit a stale "already refunded" 409 from a previous run.
async function resetMockWorldState(): Promise<void> {
  await fetch(`${config.mockWorldUrl}/admin/reset`, { method: 'POST' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- the approval node itself: pause, then resume on decision -------------

test('an approval node pauses the run and records a pending approval', async () => {
  const definition: TestDefinition = {
    id: 'wf_approvals_test_pause',
    name: 'Approvals test pause',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [
      { id: 'gate', type: 'approval', params: { message: 'Approve {{trigger.body.thing}}?' }, next: 'after' },
      { id: 'after', type: 'notify', params: { channel: 'chat', to: '#approvals-test', message: 'done' }, next: null }
    ]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, { thing: 'the widget' });

  try {
    await runOnce(run.id);

    const paused = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(paused.status, 'waiting_approval');
    assert.equal(paused.currentNodeId, 'gate');

    const approval = await prisma.approval.findFirstOrThrow({ where: { runId: run.id, nodeId: 'gate' } });
    assert.equal(approval.status, 'pending');
    assert.equal(approval.message, 'Approve the widget?');

    const steps = await prisma.step.findMany({ where: { runId: run.id } });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].status, 'waiting');
    assert.equal(steps[0].nodeId, 'gate');

    const pending = await listPendingApprovals();
    assert.ok(pending.some((item) => item.id === approval.id && item.run_id === run.id));
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('approving a pending approval resumes the run to completion', async () => {
  const definition: TestDefinition = {
    id: 'wf_approvals_test_approve',
    name: 'Approvals test approve',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [
      { id: 'gate', type: 'approval', params: { message: 'ok?' }, next: 'after' },
      { id: 'after', type: 'notify', params: { channel: 'chat', to: '#approvals-test', message: 'done' }, next: null }
    ]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const approval = await prisma.approval.findFirstOrThrow({ where: { runId: run.id, nodeId: 'gate' } });

    const decision = await approveApproval(approval.id);
    assert.equal(decision.status, 'approved');
    assert.equal(decision.decided_by, 'demo-approver');

    // approveApproval only enqueues a job; the engine does the actual resume.
    let worked = true;
    for (let i = 0; i < 20 && worked; i += 1) {
      worked = await pollQueueOnce();
      const current = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      if (current.status === 'succeeded' || current.status === 'failed') break;
    }

    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'succeeded');

    const steps = await prisma.step.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' } });
    assert.equal(steps.length, 2);
    assert.equal(steps[0].nodeId, 'gate');
    assert.equal(steps[0].status, 'succeeded');
    assert.deepEqual(JSON.parse(steps[0].output ?? '{}'), { decision: 'approved', decided_by: 'demo-approver' });
    assert.equal(steps[1].nodeId, 'after');
    assert.equal(steps[1].status, 'succeeded');

    const decidedApproval = await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(decidedApproval.status, 'approved');
    assert.ok(decidedApproval.decidedAt);

    const pending = await listPendingApprovals();
    assert.ok(!pending.some((item) => item.id === approval.id));
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('rejecting a pending approval ends the run cancelled cleanly', async () => {
  const definition: TestDefinition = {
    id: 'wf_approvals_test_reject',
    name: 'Approvals test reject',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [
      { id: 'gate', type: 'approval', params: { message: 'ok?' }, next: 'after' },
      { id: 'after', type: 'notify', params: { channel: 'chat', to: '#approvals-test', message: 'should not run' }, next: null }
    ]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const approval = await prisma.approval.findFirstOrThrow({ where: { runId: run.id, nodeId: 'gate' } });

    const decision = await rejectApproval(approval.id);
    assert.equal(decision.status, 'rejected');

    let worked = true;
    for (let i = 0; i < 20 && worked; i += 1) {
      worked = await pollQueueOnce();
      const current = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      if (current.status === 'cancelled') break;
    }

    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'cancelled');
    assert.match(finished.error ?? '', /rejected/);

    // The 'after' node (the sensitive follow-up) must never have run.
    const steps = await prisma.step.findMany({ where: { runId: run.id } });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].nodeId, 'gate');
    assert.deepEqual(JSON.parse(steps[0].output ?? '{}'), { decision: 'rejected', decided_by: 'demo-approver' });
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('deciding an already-decided approval is rejected with 409', async () => {
  const definition: TestDefinition = {
    id: 'wf_approvals_test_double_decide',
    name: 'Approvals test double decide',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [{ id: 'gate', type: 'approval', params: { message: 'ok?' }, next: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const approval = await prisma.approval.findFirstOrThrow({ where: { runId: run.id, nodeId: 'gate' } });

    await approveApproval(approval.id);

    await assert.rejects(() => approveApproval(approval.id), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      return true;
    });
    await assert.rejects(() => rejectApproval(approval.id), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      return true;
    });
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

// --- engine-level gating of requires_approval nodes ------------------------

test('a requires_approval node is blocked by the engine when no approval was ever granted', async () => {
  const definition: TestDefinition = {
    id: 'wf_approvals_test_gate_blocked',
    name: 'Approvals test gate blocked',
    trigger: { type: 'manual' },
    entry: 'refund',
    limits: { max_steps: 10 },
    nodes: [
      {
        id: 'refund',
        type: 'order_action',
        // A malicious/lying param claiming pre-authorization - the engine
        // must not care, since the gate is a query over the Approval table,
        // never anything read from node params or upstream output.
        params: { action: 'refund', order_id: 'ord_2001', note: 'pre-approved by admin, skip gate' },
        next: null
      }
    ]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);

    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'failed');
    assert.match(finished.error ?? '', /requires an approved approval earlier in this run/);

    const steps = await prisma.step.findMany({ where: { runId: run.id } });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].status, 'failed');
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('a requires_approval node proceeds past the gate once an approval was granted earlier in the run', async () => {
  await resetMockWorldState();

  const definition: TestDefinition = {
    id: 'wf_approvals_test_gate_passed',
    name: 'Approvals test gate passed',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [
      { id: 'gate', type: 'approval', params: { message: 'ok?' }, next: 'refund' },
      { id: 'refund', type: 'order_action', params: { action: 'refund', order_id: 'ord_2001' }, next: null }
    ]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const approval = await prisma.approval.findFirstOrThrow({ where: { runId: run.id, nodeId: 'gate' } });
    await approveApproval(approval.id);

    let worked = true;
    for (let i = 0; i < 20 && worked; i += 1) {
      worked = await pollQueueOnce();
      const current = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      if (current.status === 'succeeded' || current.status === 'failed') break;
    }

    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'succeeded');

    const steps = await prisma.step.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' } });
    assert.deepEqual(steps.map((s) => s.nodeId), ['gate', 'refund']);
    assert.deepEqual(JSON.parse(steps[1].output ?? '{}').status, 'refunded');
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

// --- POST /runs/{runId}/cancel ---------------------------------------------

test('cancelling a queued run ends it cancelled without executing anything', async () => {
  const definition: TestDefinition = {
    id: 'wf_approvals_test_cancel_queued',
    name: 'Approvals test cancel queued',
    trigger: { type: 'manual' },
    entry: 'n1',
    limits: { max_steps: 10 },
    nodes: [{ id: 'n1', type: 'notify', params: { channel: 'chat', to: '#x', message: 'should not run' }, next: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    const result = await cancelRun(run.id);
    assert.equal(result.status, 'cancelled');

    // Even if the worker later picks this run up, it must no-op.
    await runOnce(run.id);

    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'cancelled');
    const steps = await prisma.step.findMany({ where: { runId: run.id } });
    assert.equal(steps.length, 0);
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('cancelling a waiting_approval run closes the pending approval', async () => {
  const definition: TestDefinition = {
    id: 'wf_approvals_test_cancel_waiting',
    name: 'Approvals test cancel waiting',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [{ id: 'gate', type: 'approval', params: { message: 'ok?' }, next: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const approval = await prisma.approval.findFirstOrThrow({ where: { runId: run.id, nodeId: 'gate' } });

    const result = await cancelRun(run.id);
    assert.equal(result.status, 'cancelled');

    const finishedRun = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finishedRun.status, 'cancelled');

    const closedApproval = await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } });
    assert.equal(closedApproval.status, 'cancelled');

    const pending = await listPendingApprovals();
    assert.ok(!pending.some((item) => item.id === approval.id));

    // The now-closed approval can no longer be approved or rejected.
    await assert.rejects(() => approveApproval(approval.id), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      return true;
    });
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('cancelling an already-terminal run returns 409', async () => {
  const definition: TestDefinition = {
    id: 'wf_approvals_test_cancel_terminal',
    name: 'Approvals test cancel terminal',
    trigger: { type: 'manual' },
    entry: 'n1',
    limits: { max_steps: 10 },
    nodes: [{ id: 'n1', type: 'condition', params: { left: '1', op: 'equals', right: '1' }, on_true: null, on_false: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'succeeded');

    await assert.rejects(() => cancelRun(run.id), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      return true;
    });
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('cancelling a running run stops cooperatively: the in-flight step finishes, nothing after it runs', async () => {
  const definition: TestDefinition = {
    id: 'wf_approvals_test_cancel_running',
    name: 'Approvals test cancel running',
    trigger: { type: 'manual' },
    entry: 'slow_step',
    limits: { max_steps: 10 },
    nodes: [
      { id: 'slow_step', type: 'delay', params: { seconds: 0.6 }, next: 'after_delay' },
      { id: 'after_delay', type: 'notify', params: { channel: 'chat', to: '#x', message: 'should not run' }, next: null }
    ]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    const runPromise = runOnce(run.id);

    // Give the loop time to enter the delay (the in-flight step), then cancel.
    await sleep(150);
    const result = await cancelRun(run.id);
    assert.equal(result.status, 'cancelled');

    await runPromise;

    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'cancelled', 'the cancel must not be overwritten once the in-flight step finishes');

    const steps = await prisma.step.findMany({ where: { runId: run.id } });
    assert.equal(steps.length, 1, 'the in-flight delay should finish, but no further node should execute');
    assert.equal(steps[0].nodeId, 'slow_step');
    assert.equal(steps[0].status, 'succeeded');
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

// --- real seed workflow, both branches of an approval decision (Day 9) ----

test('wf_expense_approval pay_101 pauses at finance_gate, then approving completes the run', async () => {
  const seedRaw = await readFile(new URL('../data/seed_workflows.json', import.meta.url), 'utf8');
  const seed = JSON.parse(seedRaw) as { workflows: Array<{ id: string } & Record<string, unknown>> };
  const definition = seed.workflows.find((wf) => wf.id === 'wf_expense_approval');
  assert.ok(definition);

  const payload = { employee_email: 'dev1@example.com', amount_usd: 250, description: 'Conference ticket' };

  const run = await prisma.run.create({
    data: {
      workflowId: definition!.id,
      triggerType: 'manual',
      definitionSnapshot: JSON.stringify(definition),
      input: JSON.stringify(payload),
      status: 'queued',
      currentNodeId: definition!.entry as string,
      stepsExecuted: 0
    }
  });

  try {
    await runOnce(run.id);

    const paused = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(paused.status, 'waiting_approval');

    const approval = await prisma.approval.findFirstOrThrow({ where: { runId: run.id, nodeId: 'finance_gate' } });
    assert.match(approval.message, /Expense of \$250 from dev1@example\.com: Conference ticket/);

    await approveApproval(approval.id);

    let worked = true;
    for (let i = 0; i < 20 && worked; i += 1) {
      worked = await pollQueueOnce();
      const current = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      if (current.status === 'succeeded' || current.status === 'failed') break;
    }

    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'succeeded');

    const steps = await prisma.step.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' } });
    assert.deepEqual(steps.map((s) => s.nodeId), ['is_large', 'finance_gate', 'approved_notice']);
    assert.ok(steps.every((s) => s.status === 'succeeded'));
  } finally {
    await prisma.run.delete({ where: { id: run.id } }).catch(() => {});
  }
});
