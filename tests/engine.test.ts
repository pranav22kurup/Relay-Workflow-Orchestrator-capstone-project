import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma.js';
import { config } from '../src/config.js';
import { resolveTemplates, TemplateResolutionError, type TemplateContext } from '../src/engine/template.js';
import { evaluateCondition, ConditionEvaluationError } from '../src/engine/nodes/condition.js';
import { requestWithTimeout, HttpTimeoutError } from '../src/engine/httpClient.js';
import { executeHttpRequestNode } from '../src/engine/nodes/httpRequest.js';
import { executeDelayNode, DelayParamsError } from '../src/engine/nodes/delay.js';
import { executeNotifyNode, NotifyParamsError, NotifyDeliveryError } from '../src/engine/nodes/notify.js';
import { runOnce, pollQueueOnce } from '../src/engine/worker.js';

async function setMockWorldConfig(overrides: Partial<{ mode: string; fail_rate: number; latency_ms: number }>): Promise<void> {
  await fetch(`${config.mockWorldUrl}/admin/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overrides)
  });
}

const resetMockWorldConfig = () => setMockWorldConfig({ mode: 'ok', fail_rate: 0, latency_ms: 0 });

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
  await resetMockWorldConfig();
});

// --- template resolution -----------------------------------------------

test('resolveTemplates preserves the underlying type on a full-string match', () => {
  const context: TemplateContext = { trigger: { body: { amount_usd: 250 } }, nodes: {} };
  assert.equal(resolveTemplates('{{trigger.body.amount_usd}}', context), 250);
});

test('resolveTemplates interpolates a path inside a larger string as text', () => {
  const context: TemplateContext = { trigger: { body: { order_id: 'ord_1' } }, nodes: {} };
  assert.equal(resolveTemplates('Order {{trigger.body.order_id}} received', context), 'Order ord_1 received');
});

test('resolveTemplates resolves nested paths under nodes.<id>.output', () => {
  const context: TemplateContext = { trigger: { body: {} }, nodes: { classify: { output: { category: 'refund_request' } } } };
  assert.equal(resolveTemplates('{{nodes.classify.output.category}}', context), 'refund_request');
});

test('resolveTemplates walks nested objects and arrays', () => {
  const context: TemplateContext = { trigger: { body: { email: 'a@example.com' } }, nodes: {} };
  const result = resolveTemplates(
    { headers: { to: '{{trigger.body.email}}' }, tags: ['{{trigger.body.email}}'] },
    context
  );
  assert.deepEqual(result, { headers: { to: 'a@example.com' }, tags: ['a@example.com'] });
});

test('resolveTemplates throws a clear error on an unresolvable path', () => {
  const context: TemplateContext = { trigger: { body: {} }, nodes: {} };
  assert.throws(() => resolveTemplates('{{trigger.body.missing}}', context), TemplateResolutionError);
});

// --- condition evaluation ------------------------------------------------

test('evaluateCondition compares numerically for greater_than/less_than', () => {
  assert.equal(evaluateCondition(250, 'greater_than', '100'), true);
  assert.equal(evaluateCondition('50', 'less_than', 100), true);
});

test('evaluateCondition fails cleanly when comparing non-numeric values numerically', () => {
  assert.throws(() => evaluateCondition('abc', 'greater_than', '100'), ConditionEvaluationError);
});

test('evaluateCondition handles equals/not_equals/contains', () => {
  assert.equal(evaluateCondition('refund_request', 'equals', 'refund_request'), true);
  assert.equal(evaluateCondition('a', 'not_equals', 'b'), true);
  assert.equal(evaluateCondition(['x', 'y'], 'contains', 'y'), true);
  assert.equal(evaluateCondition('hello world', 'contains', 'world'), true);
});

// --- deterministic node executors (integration, against the real mock world) ---

test('executeDelayNode waits out the requested duration', async () => {
  const startedAt = Date.now();
  const result = await executeDelayNode({ seconds: 0.05 });
  assert.deepEqual(result.output, {});
  assert.ok(Date.now() - startedAt >= 40, 'delay should block for roughly the requested duration');
});

test('executeDelayNode rejects a missing/invalid seconds param', async () => {
  await assert.rejects(() => executeDelayNode({}), DelayParamsError);
  await assert.rejects(() => executeDelayNode({ seconds: -1 }), DelayParamsError);
});

test('executeHttpRequestNode calls the mock world and returns status + body untouched', async () => {
  const result = await executeHttpRequestNode({ method: 'GET', url: `${config.mockWorldUrl}/health` });
  assert.equal(result.output.status, 200);
  assert.deepEqual(result.output.body, { status: 'ok', service: 'mock-world' });
});

test('executeHttpRequestNode passes through a non-2xx response instead of throwing', async () => {
  const result = await executeHttpRequestNode({ method: 'GET', url: `${config.mockWorldUrl}/orders/does_not_exist` });
  assert.equal(result.output.status, 404);
});

test('executeHttpRequestNode sends a JSON body on mutating methods', async () => {
  const result = await executeHttpRequestNode({
    method: 'POST',
    url: `${config.mockWorldUrl}/shipments`,
    body: { order_id: 'ord_2002' }
  });
  assert.equal(result.output.status, 201);
  assert.equal((result.output.body as Record<string, unknown>).order_id, 'ord_2002');
});

test('requestWithTimeout fails the call (not the process) when the dependency hangs', async () => {
  // /health intentionally bypasses failure injection in the mock world, so
  // use a route that goes through it (GET /orders/{id}) to induce latency.
  await setMockWorldConfig({ latency_ms: 2000 });
  try {
    await assert.rejects(
      () => requestWithTimeout(`${config.mockWorldUrl}/orders/ord_2001`, { method: 'GET' }, 150),
      HttpTimeoutError
    );
  } finally {
    await resetMockWorldConfig();
  }
});

test('executeNotifyNode delivers an email through the mock world', async () => {
  const result = await executeNotifyNode({
    channel: 'email',
    to: 'someone@example.com',
    subject: 'Hello',
    message: 'World'
  });
  assert.equal(result.output.delivered, true);
  assert.match(String(result.output.notification_id), /^eml_/);
});

test('executeNotifyNode delivers a chat message through the mock world', async () => {
  const result = await executeNotifyNode({ channel: 'chat', to: '#ops', message: 'hello' });
  assert.equal(result.output.delivered, true);
  assert.match(String(result.output.notification_id), /^msg_/);
});

test('executeNotifyNode rejects malformed params before making a network call', async () => {
  await assert.rejects(() => executeNotifyNode({ channel: 'sms', to: 'x', message: 'y' }), NotifyParamsError);
  await assert.rejects(() => executeNotifyNode({ channel: 'email', message: 'y' }), NotifyParamsError);
});

test('executeNotifyNode fails cleanly when the mock world rejects the call', async () => {
  await setMockWorldConfig({ fail_rate: 1 });
  try {
    await assert.rejects(
      () => executeNotifyNode({ channel: 'chat', to: '#ops', message: 'hello' }),
      NotifyDeliveryError
    );
  } finally {
    await resetMockWorldConfig();
  }
});

// --- worker loop (integration, against the real dev database) -----------

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
    data: {
      id: definition.id,
      name: definition.name,
      status: 'published',
      definition: JSON.stringify(definition)
    }
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

test('runOnce executes chained condition nodes and persists each step', async () => {
  const definition: TestDefinition = {
    id: 'wf_engine_test_chain',
    name: 'Engine test chain',
    trigger: { type: 'manual' },
    entry: 'check_a',
    limits: { max_steps: 10 },
    nodes: [
      {
        id: 'check_a',
        type: 'condition',
        params: { left: '{{trigger.body.amount}}', op: 'greater_than', right: '100' },
        on_true: 'check_b',
        on_false: 'check_b'
      },
      {
        id: 'check_b',
        type: 'condition',
        params: { left: '{{nodes.check_a.output.result}}', op: 'equals', right: 'true' },
        on_true: 'unsupported',
        on_false: 'unsupported'
      },
      {
        // 'approval' isn't implemented until Day 9 - used here purely to
        // prove the loop fails cleanly at a not-yet-implemented node type.
        id: 'unsupported',
        type: 'approval',
        params: { message: 'done' },
        next: null
      }
    ]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, { amount: 250 });

  try {
    await runOnce(run.id);

    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'failed');
    assert.match(finished.error ?? '', /No executor implemented yet for node type 'approval'/);
    assert.equal(finished.stepsExecuted, 3);

    const steps = await prisma.step.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' } });
    assert.equal(steps.length, 3);

    assert.equal(steps[0].nodeId, 'check_a');
    assert.equal(steps[0].status, 'succeeded');
    assert.deepEqual(JSON.parse(steps[0].output ?? '{}'), { result: true });

    assert.equal(steps[1].nodeId, 'check_b');
    assert.equal(steps[1].status, 'succeeded');
    // left resolved from {{nodes.check_a.output.result}} should keep its boolean type
    assert.deepEqual(JSON.parse(steps[1].resolvedInput ?? '{}'), { left: true, op: 'equals', right: 'true' });

    assert.equal(steps[2].nodeId, 'unsupported');
    assert.equal(steps[2].status, 'failed');
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('runOnce marks the run succeeded when a branch target is null', async () => {
  const definition: TestDefinition = {
    id: 'wf_engine_test_terminal',
    name: 'Engine test terminal',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [{ id: 'gate', type: 'condition', params: { left: '1', op: 'equals', right: '2' }, on_true: null, on_false: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.stepsExecuted, 1);
    assert.ok(finished.finishedAt);
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('runOnce stops at limits.max_steps and fails naming the cap', async () => {
  const definition: TestDefinition = {
    id: 'wf_engine_test_runaway',
    name: 'Engine test runaway',
    trigger: { type: 'manual' },
    entry: 'loop',
    limits: { max_steps: 3 },
    nodes: [{ id: 'loop', type: 'condition', params: { left: '1', op: 'equals', right: '1' }, on_true: 'loop', on_false: 'loop' }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'failed');
    assert.match(finished.error ?? '', /Step cap exceeded/);
    assert.equal(finished.stepsExecuted, 3);

    const steps = await prisma.step.findMany({ where: { runId: run.id } });
    assert.equal(steps.length, 3);
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('runOnce fails the step cleanly on an unresolvable template path', async () => {
  const definition: TestDefinition = {
    id: 'wf_engine_test_bad_template',
    name: 'Engine test bad template',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [
      {
        id: 'gate',
        type: 'condition',
        params: { left: '{{trigger.body.missing}}', op: 'equals', right: '1' },
        on_true: null,
        on_false: null
      }
    ]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});

  try {
    await runOnce(run.id);
    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'failed');
    assert.match(finished.error ?? '', /Unresolvable template reference/);

    const steps = await prisma.step.findMany({ where: { runId: run.id } });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].status, 'failed');
  } finally {
    await cleanupWorkflow(definition.id);
  }
});

test('wf_expense_approval auto-approves pay_102 end to end against the mock world', async () => {
  const seedRaw = await readFile(new URL('../data/seed_workflows.json', import.meta.url), 'utf8');
  const seed = JSON.parse(seedRaw) as { workflows: Array<{ id: string } & Record<string, unknown>> };
  const definition = seed.workflows.find((wf) => wf.id === 'wf_expense_approval');
  assert.ok(definition, 'wf_expense_approval must exist in the seed data');

  const payload = { employee_email: 'dev2@example.com', amount_usd: 40, description: 'Team lunch' };

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

    const finished = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.stepsExecuted, 2);
    assert.ok(finished.finishedAt);

    const steps = await prisma.step.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' } });
    assert.equal(steps.length, 2);

    assert.equal(steps[0].nodeId, 'is_large');
    assert.equal(steps[0].status, 'succeeded');
    assert.deepEqual(JSON.parse(steps[0].output ?? '{}'), { result: false });

    assert.equal(steps[1].nodeId, 'auto_ok');
    assert.equal(steps[1].status, 'succeeded');
    const notifyOutput = JSON.parse(steps[1].output ?? '{}') as { delivered: boolean; notification_id: string };
    assert.equal(notifyOutput.delivered, true);
    assert.match(notifyOutput.notification_id, /^eml_/);

    const resolvedInput = JSON.parse(steps[1].resolvedInput ?? '{}');
    assert.equal(resolvedInput.to, 'dev2@example.com');
    assert.match(resolvedInput.message, /Team lunch/);
  } finally {
    await prisma.run.delete({ where: { id: run.id } }).catch(() => {});
  }
});

test('pollQueueOnce claims a queued job off the real queue and drives the run to completion', async () => {
  const definition: TestDefinition = {
    id: 'wf_engine_test_queue',
    name: 'Engine test queue',
    trigger: { type: 'manual' },
    entry: 'gate',
    limits: { max_steps: 10 },
    nodes: [{ id: 'gate', type: 'condition', params: { left: '1', op: 'equals', right: '1' }, on_true: null, on_false: null }]
  };

  await seedTestWorkflow(definition);
  const run = await seedTestRun(definition, {});
  const job = await prisma.queueJob.create({
    data: {
      type: 'run_step',
      status: 'queued',
      payload: JSON.stringify({ runId: run.id, workflowId: definition.id, triggerType: 'manual' }),
      availableAt: new Date()
    }
  });

  try {
    // The queue may hold older jobs ahead of ours (e.g. pre-existing ones);
    // drain until ours is claimed rather than assuming it's picked up first.
    let current = job;
    for (let i = 0; i < 20 && current.status === 'queued'; i += 1) {
      const worked = await pollQueueOnce();
      current = await prisma.queueJob.findUniqueOrThrow({ where: { id: job.id } });
      if (!worked) break;
    }

    assert.equal(current.status, 'done');

    const finishedRun = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(finishedRun.status, 'succeeded');
  } finally {
    await prisma.queueJob.delete({ where: { id: job.id } }).catch(() => {});
    await cleanupWorkflow(definition.id);
  }
});
