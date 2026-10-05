export type TemplateContext = {
  trigger: { body: unknown };
  nodes: Record<string, { output: unknown }>;
};

const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const FULL_MATCH_PATTERN = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;

export class TemplateResolutionError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Unresolvable template reference '{{${path}}}'`);
    this.path = path;
  }
}

function getPath(root: unknown, path: string): { found: true; value: unknown } | { found: false } {
  const segments = path.split('.');
  let current: unknown = root;

  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return { found: false };
    }

    if (!(segment in (current as Record<string, unknown>))) {
      return { found: false };
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return { found: true, value: current };
}

function resolvePath(path: string, context: TemplateContext): unknown {
  const result = getPath(context, path);
  if (!result.found) {
    throw new TemplateResolutionError(path);
  }
  return result.value;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function resolveString(input: string, context: TemplateContext): unknown {
  const fullMatch = input.match(FULL_MATCH_PATTERN);
  if (fullMatch) {
    // The whole string is a single expression: preserve the underlying type
    // (number/boolean/object) instead of coercing it to a string.
    return resolvePath(fullMatch[1], context);
  }

  if (!input.includes('{{')) {
    return input;
  }

  return input.replace(TEMPLATE_PATTERN, (_match, path: string) => stringifyValue(resolvePath(path, context)));
}

export function resolveTemplates(value: unknown, context: TemplateContext): unknown {
  if (typeof value === 'string') {
    return resolveString(value, context);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, context));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolveTemplates(item, context);
    }
    return result;
  }

  return value;
}
