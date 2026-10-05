import { config } from '../../config.js';
import { requestWithTimeout } from '../httpClient.js';
import type { NodeExecutionContext, NodeExecutionResult } from '../executors.js';

export class OrderActionParamsError extends Error {}

export class OrderActionError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function errorMessageFromBody(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const errorField = (body as { error?: unknown }).error;
    if (errorField && typeof errorField === 'object' && 'message' in errorField) {
      const message = (errorField as { message?: unknown }).message;
      return typeof message === 'string' ? message : null;
    }
  }
  return null;
}

/**
 * Executes the sensitive commerce action itself. Getting here at all already
 * proves the engine-level requires_approval gate passed (see worker.ts) -
 * this executor doesn't re-check anything about approval, it just performs
 * the call. Always a side effect, so it always carries the idempotency key.
 *
 * The refund amount is deliberately never AI-controlled: `amount_usd` is a
 * workflow-definition param, not something an ai node's output can set
 * (wf_support_triage's issue_refund omits it entirely, so the mock world
 * refunds the real order total regardless of what a model claimed).
 */
export async function executeOrderActionNode(
  params: Record<string, unknown>,
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> {
  const { action, order_id: orderId, amount_usd: amountUsd } = params;

  if (action !== 'refund' && action !== 'replacement') {
    throw new OrderActionParamsError("order_action node requires 'action' to be 'refund' or 'replacement'");
  }
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    throw new OrderActionParamsError("order_action node is missing a string 'order_id' param");
  }
  if (amountUsd !== undefined && (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd))) {
    throw new OrderActionParamsError("order_action node's 'amount_usd' param must be a number when present");
  }

  const url = `${config.mockWorldUrl}/orders/${encodeURIComponent(orderId)}/${action === 'refund' ? 'refund' : 'replacement'}`;
  const body = action === 'refund' && amountUsd !== undefined ? { amount_usd: amountUsd } : {};

  const result = await requestWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': ctx.idempotencyKey },
      body: JSON.stringify(body)
    },
    config.engineHttpTimeoutMs
  );

  if (result.status < 200 || result.status >= 300) {
    const detail = errorMessageFromBody(result.body);
    throw new OrderActionError(
      `order_action '${action}' on order '${orderId}' failed with status ${result.status}${detail ? `: ${detail}` : ''}`,
      result.status
    );
  }

  const responseBody = (result.body ?? {}) as Record<string, unknown>;
  return {
    output: {
      status: responseBody.status,
      reference_id: responseBody.reference_id
    },
    idempotencyKey: ctx.idempotencyKey
  };
}
