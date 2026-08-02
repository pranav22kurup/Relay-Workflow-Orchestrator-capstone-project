import { config } from '../../config.js';
import { requestWithTimeout } from '../httpClient.js';
import type { NodeExecutionContext, NodeExecutionResult } from '../executors.js';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'DELETE']);
// Only mutating calls are side effects per the catalog; GET stays replay-free.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE']);

export class HttpRequestParamsError extends Error {}

/**
 * Generic HTTP call. Any response the server sends back - including 4xx/5xx -
 * is a completed step (status + body are in the output for downstream nodes
 * to branch on); only a network failure or a timeout fails the step.
 */
export async function executeHttpRequestNode(
  params: Record<string, unknown>,
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> {
  const { method, url, headers, body } = params;

  if (typeof method !== 'string') {
    throw new HttpRequestParamsError("http_request node is missing a string 'method' param");
  }
  if (typeof url !== 'string' || url.trim() === '') {
    throw new HttpRequestParamsError("http_request node is missing a string 'url' param");
  }

  const upperMethod = method.toUpperCase();
  const isMutating = MUTATING_METHODS.has(upperMethod);
  const requestHeaders: Record<string, string> = { ...(isPlainObject(headers) ? stringifyHeaderValues(headers) : {}) };

  if (isMutating) {
    requestHeaders['Idempotency-Key'] = ctx.idempotencyKey;
  }

  let requestBody: string | undefined;
  if (body !== undefined && body !== null && METHODS_WITH_BODY.has(upperMethod)) {
    requestBody = JSON.stringify(body);
    if (!hasHeader(requestHeaders, 'content-type')) {
      requestHeaders['Content-Type'] = 'application/json';
    }
  }

  const result = await requestWithTimeout(
    url,
    { method: upperMethod, headers: requestHeaders, body: requestBody },
    config.engineHttpTimeoutMs
  );

  return {
    output: { status: result.status, body: result.body },
    idempotencyKey: isMutating ? ctx.idempotencyKey : undefined
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyHeaderValues(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = String(value);
  }
  return result;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}
