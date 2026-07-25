import { config } from '../../config.js';
import { requestWithTimeout } from '../httpClient.js';
import type { NodeExecutionContext, NodeExecutionResult } from '../executors.js';

export class NotifyParamsError extends Error {}
export class NotifyDeliveryError extends Error {}

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
 * Sends a message through the mock world. Unlike http_request, this node's
 * catalog output is strictly {delivered, notification_id} - a non-2xx
 * response is a genuine step failure, not a value to branch on.
 */
export async function executeNotifyNode(
  params: Record<string, unknown>,
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> {
  const { channel, to, subject, message } = params;

  if (channel !== 'email' && channel !== 'chat') {
    throw new NotifyParamsError("notify node requires 'channel' to be 'email' or 'chat'");
  }
  if (typeof to !== 'string' || to.trim() === '') {
    throw new NotifyParamsError("notify node is missing a string 'to' param");
  }
  if (typeof message !== 'string' || message.trim() === '') {
    throw new NotifyParamsError("notify node is missing a string 'message' param");
  }

  const url = channel === 'email' ? `${config.mockWorldUrl}/email/send` : `${config.mockWorldUrl}/chat/message`;
  const body = channel === 'email' ? { to, subject, message } : { channel: to, message };

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
    throw new NotifyDeliveryError(`notify to ${channel} '${to}' failed with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }

  const responseBody = (result.body ?? {}) as Record<string, unknown>;
  return {
    output: {
      delivered: Boolean(responseBody.delivered),
      notification_id: responseBody.notification_id
    },
    idempotencyKey: ctx.idempotencyKey
  };
}
