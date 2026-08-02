export class DelayParamsError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Blocking sleep for Must Have (single in-process worker). A crash mid-delay
 * has no side effect to duplicate - on resume (Day 7) the step simply reruns
 * and waits out its duration again.
 */
export async function executeDelayNode(params: Record<string, unknown>): Promise<{ output: Record<string, unknown> }> {
  const { seconds } = params;

  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new DelayParamsError("delay node requires a non-negative number 'seconds' param");
  }

  await sleep(seconds * 1000);
  return { output: {} };
}
