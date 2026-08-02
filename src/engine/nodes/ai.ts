import { getAiProvider, type ChatMessage } from '../../ai/provider.js';
import { compileSchema, formatValidationErrors } from '../../ai/schema.js';
import type { NodeExecutionResult } from '../executors.js';

export class AiNodeParamsError extends Error {}

/**
 * Thrown when the model's output still doesn't conform after the one
 * permitted repair retry. Carries token usage so the worker can still
 * charge it to the run's trace even though the step failed - the tokens
 * were genuinely spent. Not classified as retryable by the outer per-node
 * retry wrapper: re-asking an unchanged prompt won't produce a different
 * answer, so this fails the step cleanly instead of burning attempts.
 */
export class AiSchemaValidationError extends Error {
  readonly tokensPrompt: number;
  readonly tokensCompletion: number;

  constructor(message: string, tokensPrompt: number, tokensCompletion: number) {
    super(message);
    this.tokensPrompt = tokensPrompt;
    this.tokensCompletion = tokensCompletion;
  }
}

function buildSystemPrompt(schema: unknown): string {
  return [
    'You are a workflow automation node. Respond with a single JSON object only.',
    'No prose, no markdown code fences, no explanation before or after the JSON.',
    'The JSON must conform exactly to this JSON Schema:',
    JSON.stringify(schema)
  ].join('\n');
}

function parseJson(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  // Models sometimes wrap JSON in a code fence despite instructions not to.
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function executeAiNode(params: Record<string, unknown>): Promise<NodeExecutionResult> {
  const { prompt, output_schema: outputSchema } = params;

  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new AiNodeParamsError("ai node is missing a string 'prompt' param");
  }
  if (typeof outputSchema !== 'object' || outputSchema === null) {
    throw new AiNodeParamsError("ai node is missing an object 'output_schema' param");
  }

  const provider = getAiProvider();
  const validate = compileSchema(outputSchema as object);

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(outputSchema) },
    { role: 'user', content: prompt }
  ];

  let tokensPrompt = 0;
  let tokensCompletion = 0;

  const first = await provider(messages);
  tokensPrompt += first.tokensPrompt;
  tokensCompletion += first.tokensCompletion;

  const firstParsed = parseJson(first.content);
  if (firstParsed.ok && validate(firstParsed.value)) {
    return { output: firstParsed.value as Record<string, unknown>, tokensPrompt, tokensCompletion };
  }

  const firstError = firstParsed.ok ? formatValidationErrors(validate) : `Response was not valid JSON: ${firstParsed.error}`;

  // One repair retry, with the validation error fed back to the model.
  messages.push({ role: 'assistant', content: first.content });
  messages.push({
    role: 'user',
    content: `Your previous response did not conform to the required schema. Validation errors: ${firstError}\n\nRespond again with ONLY a corrected JSON object matching the schema.`
  });

  const second = await provider(messages);
  tokensPrompt += second.tokensPrompt;
  tokensCompletion += second.tokensCompletion;

  const secondParsed = parseJson(second.content);
  if (secondParsed.ok && validate(secondParsed.value)) {
    return { output: secondParsed.value as Record<string, unknown>, tokensPrompt, tokensCompletion };
  }

  const secondError = secondParsed.ok ? formatValidationErrors(validate) : `Response was not valid JSON: ${secondParsed.error}`;

  throw new AiSchemaValidationError(
    `AI output did not conform to output_schema after a repair retry: ${secondError}`,
    tokensPrompt,
    tokensCompletion
  );
}
