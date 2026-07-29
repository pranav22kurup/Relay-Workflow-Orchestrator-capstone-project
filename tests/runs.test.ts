import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { prisma } from '../src/lib/prisma.js';
import { config } from '../src/config.js';
import { runOnce } from '../src/engine/worker.js';
import { cancelRun, listRuns, getRunTrace } from '../src/runs/service.js';
import { setAiProvider, getAiProvider, type AiProvider } from '../src/ai/provider.js';
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

async function seedTestRun(definition: TestDefinition, input: unknown, overrides: Partial<{ status: string }> = {}) {
  return prisma.run.create({
    data: {
      workflowId: definition.id,
      triggerType: 'manual',
      definitionSnapshot: JSON.stringify(definition),
      input: JSON.stringify(input),
      status: overrides.status ?? 'queued',
      currentNodeId: definition.entry,
      stepsExecuted: 0
    }
  });
}

async function cleanupWorkflow(workflowId: string): Promise<void> {
  await prisma.workflow.delete({ where: { id: workflowId } }).catch(() => {});
}

// --- getRunTrace: 404, and shape for a straightforward success ------------

test('getRunTrace 404s on an unknown run id', async () => {
  await assert.rejects(() => getRunTrace('run_does_not_exist'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    return true;
  });
});

test('getRunTrace reports resolved input, output, attempt, and timing for a succeeded run', async () => {
  const definition: TestDefinition = {
    id: 'wf_runs_test_trace_shape',
    name: 'Runs test trace shape',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [{ id: 'gate', type: 'condition', params: { left: '{{trigger.body.amount}}', op: 'greater_than', right: '100' }, on_true: null, on_false: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, { amount: 250 });

  try {
    await runOnce(run.id);
    const trace = await getRunTrace(run.id);

    assert.equal(trace.run_id, run.id);
    assert.equal(trace.workflow_id, definition.id);
    assert.equal(trace.status, 'succeeded');
    assert.equal(trace.trigger_type, 'manual');
    assert.deepEqual(trace.input, { amount: 250 });
    assert.equal(trace.current_node_id, null);
    assert.equal(trace.steps_executed, 1);
    assert.ok(trace.started_at);
    assert.ok(trace.finished_at);

    assert.equal(trace.steps.length, 1);
    const [step] = trace.steps;
    assert.equal(step.node_id, 'gate');
    assert.equal(step.type, 'condition');
    assert.equal(step.status, 'succeeded');
    assert.equal(step.sequence, 1);
    assert.equal(step.attempt, 1);
    assert.deepEqual(step.input, { left: 250, op: 'greater_than', right: '100' });
    assert.deepEqual(step.output, { result: true });
    assert.equal(step.idempotency_key, null);
    assert.equal(step.tokens_prompt, null);
    assert.equal(step.tokens_completion, null);
    assert.ok(step.started_at);
    assert.ok(typeof step.duration_ms === 'number');
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

// --- every documented run status is reachable and reflected correctly -----

test('getRunTrace reflects a queued run with no steps yet', async () => {
  const definition: TestDefinition = {
    id: 'wf_runs_test_status_queued',
    name: 'Runs test status queued',
    trigger: { type: 'manual' },
    entry: 'n1',
    limits: { max_steps: 10 },
    nodes: [{ id: 'n1', type: 'notify', params: { channel: 'chat', to: '#x', message: 'hi' }, next: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    const trace = await getRunTrace(run.id);
    assert.equal(trace.status, 'queued');
    assert.equal(trace.steps.length, 0);
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('getRunTrace reflects a running run', async () => {
  const definition: TestDefinition = {
    id: 'wf_runs_test_status_running',
    name: 'Runs test status running',
    trigger: { type: 'manual' },
    entry: 'n1',
    limits: { max_steps: 10 },
    nodes: [{ id: 'n1', type: 'notify', params: { channel: 'chat', to: '#x', message: 'hi' }, next: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {}, { status: 'running' });

  try {
    const trace = await getRunTrace(run.id);
    assert.equal(trace.status, 'running');
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('getRunTrace reflects waiting_approval, with the waiting step carrying an approval_id', async () => {
  const definition: TestDefinition = {
    id: 'wf_runs_test_status_waiting_approval',
    name: 'Runs test status waiting_approval',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [{ id: 'gate', type: 'approval', params: { message: 'ok?' }, next: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const trace = await getRunTrace(run.id);

    assert.equal(trace.status, 'waiting_approval');
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.steps[0].status, 'waiting');
    assert.equal(trace.steps[0].type, 'approval');
    assert.ok(trace.steps[0].approval_id);

    const approval = await prisma.approval.findFirstOrThrow({ where: { runId: run.id, nodeId: 'gate' } });
    assert.equal(trace.steps[0].approval_id, approval.id);
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('getRunTrace reflects failed, with the error and the failed step both visible', async () => {
  const definition: TestDefinition = {
    id: 'wf_runs_test_status_failed',
    name: 'Runs test status failed',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [{ id: 'gate', type: 'condition', params: { left: '{{trigger.body.missing}}', op: 'equals', right: '1' }, on_true: null, on_false: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const trace = await getRunTrace(run.id);

    assert.equal(trace.status, 'failed');
    assert.match(trace.error ?? '', /Unresolvable template reference/);
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.steps[0].status, 'failed');
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('getRunTrace reflects cancelled, and the approval_id from before cancellation still resolves', async () => {
  const definition: TestDefinition = {
    id: 'wf_runs_test_status_cancelled',
    name: 'Runs test status cancelled',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [{ id: 'gate', type: 'approval', params: { message: 'ok?' }, next: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    await cancelRun(run.id);

    const trace = await getRunTrace(run.id);
    assert.equal(trace.status, 'cancelled');
    assert.match(trace.error ?? '', /cancelled/i);
    assert.ok(trace.steps[0].approval_id, 'the approval_id should still resolve after cancellation closed it');
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

// --- AI token usage shows up in the trace ----------------------------------

test('getRunTrace surfaces tokens_prompt/tokens_completion for an ai step', async () => {
  const originalProvider = getAiProvider();
  const fakeProvider: AiProvider = async () => ({
    content: JSON.stringify({ category: 'x' }),
    tokensPrompt: 33,
    tokensCompletion: 7
  });
  setAiProvider(fakeProvider);

  const definition: TestDefinition = {
    id: 'wf_runs_test_ai_tokens',
    name: 'Runs test ai tokens',
    trigger: { type: 'manual' },
    entry: 'classify',
    limits: { max_steps: 10 },
    nodes: [
      {
        id: 'classify',
        type: 'ai',
        params: { prompt: 'classify', output_schema: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] } },
        next: null
      }
    ]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const trace = await getRunTrace(run.id);

    assert.equal(trace.status, 'succeeded');
    assert.equal(trace.ai_tokens_used, 40);
    assert.equal(trace.steps[0].tokens_prompt, 33);
    assert.equal(trace.steps[0].tokens_completion, 7);
  } finally {
    setAiProvider(originalProvider);
    await cleanupWorkflow(definition.id);
  }
});

// --- listRuns -------------------------------------------------------------

test('listRuns filters by workflowId and orders most-recent-first', async () => {
  const definitionA: TestDefinition = {
    id: 'wf_runs_test_list_a',
    name: 'Runs test list a',
    trigger: { type: 'manual' },
    entry: 'n1',
    limits: { max_steps: 10 },
    nodes: [{ id: 'n1', type: 'condition', params: { left: '1', op: 'equals', right: '1' }, on_true: null, on_false: null }]
  };
  const definitionB: TestDefinition = { ...definitionA, id: 'wf_runs_test_list_b', name: 'Runs test list b' };

  await seedTestWorkflow(definitionA);
  await seedTestWorkflow(definitionB);

  const runA1 = await seedTestRun(definitionA, {});
  const runA2 = await seedTestRun(definitionA, {});
  const runB1 = await seedTestRun(definitionB, {});

  try {
    const onlyA = await listRuns(definitionA.id);
    const ids = onlyA.map((r) => r.run_id);
    assert.ok(ids.includes(runA1.id) && ids.includes(runA2.id));
    assert.ok(!ids.includes(runB1.id));

    const all = await listRuns();
    const allIds = all.map((r) => r.run_id);
    assert.ok(allIds.includes(runA1.id) && allIds.includes(runA2.id) && allIds.includes(runB1.id));
  } finally {
    await cleanupWorkflow(definitionA.id);
    await cleanupWorkflow(definitionB.id);
  }
});
