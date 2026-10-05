export type HttpResult = {
  status: number;
  body: unknown;
};

export class HttpTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to '${url}' timed out after ${timeoutMs}ms`);
  }
}

// Connection refused, DNS failure, etc. - distinct from HttpTimeoutError only
// so callers can classify both as transient without string-matching messages.
export class HttpNetworkError extends Error {}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * fetch with a hard timeout. Never hangs the caller: a slow or unresponsive
 * dependency rejects instead of blocking the worker loop indefinitely.
 * Returns whatever HTTP response comes back (including non-2xx) - only
 * transport-level failures (network error, timeout) reject.
 */
export async function requestWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await parseResponseBody(response);
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpTimeoutError(url, timeoutMs);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpNetworkError(`Request to '${url}' failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}
