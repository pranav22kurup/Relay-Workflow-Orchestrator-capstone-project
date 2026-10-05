export class ConditionEvaluationError extends Error {}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  const aNum = toNumberOrNull(a);
  const bNum = toNumberOrNull(b);
  if (aNum !== null && bNum !== null) {
    return aNum === bNum;
  }

  return String(a) === String(b);
}

export function evaluateCondition(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case 'equals':
      return isEqual(left, right);
    case 'not_equals':
      return !isEqual(left, right);
    case 'greater_than':
    case 'less_than': {
      const leftNum = toNumberOrNull(left);
      const rightNum = toNumberOrNull(right);
      if (leftNum === null || rightNum === null) {
        throw new ConditionEvaluationError(
          `Cannot compare non-numeric values with '${op}': left=${JSON.stringify(left)}, right=${JSON.stringify(right)}`
        );
      }
      return op === 'greater_than' ? leftNum > rightNum : leftNum < rightNum;
    }
    case 'contains': {
      if (Array.isArray(left)) {
        return left.some((item) => isEqual(item, right));
      }
      return String(left).includes(String(right));
    }
    default:
      throw new ConditionEvaluationError(`Unknown condition operator '${op}'`);
  }
}

export async function executeConditionNode(params: Record<string, unknown>): Promise<{ output: Record<string, unknown> }> {
  const { left, op, right } = params;

  if (typeof op !== 'string') {
    throw new ConditionEvaluationError("Condition node is missing a string 'op' param");
  }

  const result = evaluateCondition(left, op, right);
  return { output: { result } };
}
