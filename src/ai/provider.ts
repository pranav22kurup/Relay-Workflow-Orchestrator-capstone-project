import { requestWithTimeout } from '../engine/httpClient.js';
import { config } from '../config.js';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type CompletionResult = {
  content: string;
  tokensPrompt: number;
  tokensCompletion: number;
};

export type AiProvider = (messages: ChatMessage[]) => Promise<CompletionResult>;

export class AiProviderError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (err && typeof err === 'object' && 'message' in err) {
      const message = (err as { message?: unknown }).message;
      return typeof message === 'string' ? message : null;
    }
  }
  return null;
}

/**
 * Speaks the OpenAI chat-completions shape, which covers Groq, Ollama's
 * OpenAI-compat route, a Gemini compat proxy, and scripts/mock_provider.py -
 * so the demo can point at any free-tier or local model without a second
 * adapter. Reuses the same timeout-bounded client as the mock-world calls.
 */
export function createHttpAiProvider(options: { baseUrl: string; apiKey?: string; model: string; timeoutMs: number }): AiProvider {
  return async (messages: ChatMessage[]): Promise<CompletionResult> => {
    const result = await requestWithTimeout(
      `${options.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {})
        },
        body: JSON.stringify({ model: options.model, messages })
      },
      options.timeoutMs
    );

    if (result.status < 200 || result.status >= 300) {
      const message = extractErrorMessage(result.body) ?? `AI provider request failed with status ${result.status}`;
      throw new AiProviderError(message, result.status);
    }

    const body = result.body as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new AiProviderError('AI provider response did not include message content', result.status);
    }

    return {
      content,
      tokensPrompt: body.usage?.prompt_tokens ?? 0,
      tokensCompletion: body.usage?.completion_tokens ?? 0
    };
  };
}

let activeProvider: AiProvider = createHttpAiProvider({
  baseUrl: config.aiProviderUrl,
  apiKey: config.aiProviderApiKey || undefined,
  model: config.aiProviderModel,
  timeoutMs: config.engineHttpTimeoutMs
});

/** Engine tests swap this for a canned/fake provider - see docs/IMPLEMENTATION_GUIDE.md FAQ. */
export function setAiProvider(provider: AiProvider): void {
  activeProvider = provider;
}

export function getAiProvider(): AiProvider {
  return activeProvider;
}
