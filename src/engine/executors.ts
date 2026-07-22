import { executeConditionNode } from './nodes/condition.js';
import { executeHttpRequestNode } from './nodes/httpRequest.js';
import { executeDelayNode } from './nodes/delay.js';
import { executeNotifyNode } from './nodes/notify.js';

export type NodeExecutionResult = { output: Record<string, unknown> };
export type NodeExecutor = (resolvedParams: Record<string, unknown>) => Promise<NodeExecutionResult>;

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
