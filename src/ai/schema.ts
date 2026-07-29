import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';

// ajv is CJS-only with no "exports" map; under NodeNext + esModuleInterop,
// a static `import Ajv from 'ajv'` resolves to the type-only namespace
// instead of the constructable default export. Loading it via require
// sidesteps that resolution quirk while keeping the real (type-only) types.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Ajv = require('ajv') as new (options?: Record<string, unknown>) => { compile: (schema: object) => ValidateFunction };

// strict:false - workflow-authored schemas (including ones an NL compiler
// might generate later) shouldn't be rejected for minor JSON Schema style
// issues Ajv's strict mode flags; we still validate the AI output itself strictly.
const ajv = new Ajv({ allErrors: true, strict: false });

const compiledCache = new Map<string, ValidateFunction>();

export function compileSchema(schema: object): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = compiledCache.get(key);
  if (cached) {
    return cached;
  }
  const validate = ajv.compile(schema);
  compiledCache.set(key, validate);
  return validate;
}

export function formatValidationErrors(validate: ValidateFunction): string {
  return (validate.errors ?? []).map((err) => `${err.instancePath || '(root)'} ${err.message ?? 'is invalid'}`).join('; ');
}
