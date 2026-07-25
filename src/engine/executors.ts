import { executeConditionNode } from './nodes/condition.js';
import { executeHttpRequestNode } from './nodes/httpRequest.js';
import { executeDelayNode } from './nodes/delay.js';
import { executeNotifyNode } from './nodes/notify.js';

export type NodeExecutionResult = {
  output: Record<string, unknown>;
  // Set by an executor only when it actually sent this key to an external
  // system, so the trace reflects real usage rather than every node type.
  idempotencyKey?: string;
};

export type NodeExecutionContext = {
  // Stable across retries of, and resumes of, this exact node execution;
  // distinct across loop iterations (see src/engine/worker.ts for how it's
  // derived from the run's step sequence).
  idempotencyKey: string;
};

export type NodeExecutor = (
  resolvedParams: Record<string, unknown>,
  ctx: NodeExecutionContext
) => Promise<NodeExecutionResult>;

export class UnimplementedNodeTypeError extends Error {
  constructor(nodeType: string) {
    super(`No executor implemented yet for node type '${nodeType}'`);
  }
}

// Deterministic node types (Must Have 4). `ai`, `approval`, and
// `order_action` are added on their own days (8-9).
export const nodeExecutors: Record<string, NodeExecutor> = {
  condition: executeConditionNode,
  http_request: executeHttpRequestNode,
  delay: executeDelayNode,
  notify: executeNotifyNode
};
