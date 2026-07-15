import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkflowDefinition } from '../src/workflows/validation.js';

const validWorkflow = {
  id: 'wf_test',
  name: 'Test workflow',
  description: 'Used for validator coverage',
  trigger: { type: 'manual' },
  entry: 'n1',
  limits: { max_steps: 10 },
  nodes: [
    {
      id: 'n1',
      type: 'notify',
      params: {
        channel: 'chat',
        to: '#support',
        message: 'hello'
      },
      next: null
    }
  ]
};

test('accepts a valid workflow definition', async () => {
  const result = await validateWorkflowDefinition(validWorkflow);
  assert.equal(result.id, 'wf_test');
});

test('rejects an unknown node type', async () => {
  await assert.rejects(
    () => validateWorkflowDefinition({
      ...validWorkflow,
      nodes: [{ ...validWorkflow.nodes[0], type: 'teleport' }]
    }),
    (error: unknown) => {
      const err = error as { code?: string; message?: string };
      assert.equal(err.code, 'invalid_node_type');
      assert.match(err.message ?? '', /unknown type/);
      return true;
    }
  );
});

test('rejects missing required params', async () => {
  await assert.rejects(
    () => validateWorkflowDefinition({
      ...validWorkflow,
      nodes: [{ id: 'n1', type: 'notify', params: { channel: 'chat', to: '#support' }, next: null }]
    }),
    (error: unknown) => {
      const err = error as { code?: string; message?: string };
      assert.equal(err.code, 'missing_required_param');
      assert.match(err.message ?? '', /missing required param 'message'/);
      return true;
    }
  );
});

test('rejects invalid branch targets', async () => {
  await assert.rejects(
    () => validateWorkflowDefinition({
      ...validWorkflow,
      entry: 'route',
      nodes: [
        {
          id: 'route',
          type: 'condition',
          params: { left: 'a', op: 'equals', right: 'b' },
          on_true: 'missing',
          on_false: 'n1'
        },
        validWorkflow.nodes[0]
      ]
    }),
    (error: unknown) => {
      const err = error as { code?: string; message?: string };
      assert.equal(err.code, 'invalid_node_edge');
      assert.match(err.message ?? '', /missing node/);
      return true;
    }
  );
});
