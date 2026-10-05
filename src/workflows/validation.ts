import { z } from 'zod';
import { loadNodeCatalog, type NodeCatalog } from '../bootstrap/catalog.js';
import { ApiError } from '../http/errors.js';

const nodeSchema = z.object({
  id: z.string().trim().min(1),
  type: z.string().trim().min(1),
  params: z.record(z.unknown()).optional(),
  next: z.union([z.string().trim().min(1), z.null()]).optional(),
  on_true: z.union([z.string().trim().min(1), z.null()]).optional(),
  on_false: z.union([z.string().trim().min(1), z.null()]).optional()
}).passthrough();

const workflowSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]+$/, 'Workflow id may only contain letters, numbers, underscores, and hyphens'),
  name: z.string().trim().min(1),
  description: z.string().optional(),
  trigger: z.object({ type: z.string().trim().min(1) }).passthrough(),
  entry: z.string().trim().min(1),
  limits: z.record(z.unknown()),
  nodes: z.array(nodeSchema).min(1)
}).passthrough();

export type WorkflowDefinition = z.infer<typeof workflowSchema>;

type ValidateOptions = {
  expectedId?: string;
};

function getNodeTypeMap(catalog: NodeCatalog): Map<string, (typeof catalog.nodes)[number]> {
  return new Map(catalog.nodes.map((node) => [node.type, node]));
}

function getTriggerTypeMap(catalog: NodeCatalog): Map<string, (typeof catalog.triggers)[number]> {
  return new Map(catalog.triggers.map((trigger) => [trigger.type, trigger]));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePrimitiveType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return isObject(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

function validateTrigger(catalog: NodeCatalog, trigger: Record<string, unknown>): void {
  const triggerTypes = getTriggerTypeMap(catalog);
  const triggerType = String(trigger.type);
  const triggerDefinition = triggerTypes.get(triggerType);

  if (!triggerDefinition) {
    throw new ApiError(422, 'invalid_trigger_type', `Unknown trigger type '${triggerType}'`);
  }

  const config = triggerDefinition.config ?? {};
  for (const [configKey, configDefinition] of Object.entries(config)) {
    if (!isObject(configDefinition) || !configDefinition.required) {
      continue;
    }

    const value = trigger[configKey];
    if (value === undefined || value === null || value === '') {
      throw new ApiError(422, 'missing_trigger_config', `Trigger '${triggerType}' is missing required config '${configKey}'`);
    }
  }
}

function validateNodeParams(catalogNode: NodeCatalog['nodes'][number], node: z.infer<typeof nodeSchema>): void {
  const paramsSchema = catalogNode.params ?? {};
  const nodeParams = node.params ?? {};

  if (!isObject(nodeParams)) {
    throw new ApiError(422, 'invalid_node_params', `Node '${node.id}' must provide an object for params`);
  }

  for (const [paramName, definition] of Object.entries(paramsSchema)) {
    if (!isObject(definition) || !definition.required) {
      continue;
    }

    const value = nodeParams[paramName];
    if (value === undefined || value === null || value === '') {
      throw new ApiError(422, 'missing_required_param', `Node '${node.id}' of type '${node.type}' is missing required param '${paramName}'`);
    }
  }

  for (const [paramName, value] of Object.entries(nodeParams)) {
    const definition = paramsSchema[paramName];
    if (!definition) {
      throw new ApiError(422, 'unknown_node_param', `Node '${node.id}' of type '${node.type}' has unknown param '${paramName}'`);
    }

    if (isObject(definition) && 'enum' in definition && Array.isArray(definition.enum)) {
      if (!definition.enum.includes(value as never)) {
        throw new ApiError(422, 'invalid_node_param_value', `Node '${node.id}' of type '${node.type}' has invalid value for '${paramName}'`);
      }
    }

    if (isObject(definition) && typeof definition.type === 'string' && !validatePrimitiveType(value, definition.type)) {
      throw new ApiError(422, 'invalid_node_param_type', `Node '${node.id}' of type '${node.type}' expects '${paramName}' to be a ${definition.type}`);
    }
  }
}

function validateNodeEdges(catalogNode: NodeCatalog['nodes'][number], node: z.infer<typeof nodeSchema>, nodeIds: Set<string>): void {
  const branchKeys = catalogNode.branches ?? ['next'];

  for (const branchKey of branchKeys) {
    if (!Object.prototype.hasOwnProperty.call(node, branchKey)) {
      throw new ApiError(422, 'missing_node_edge', `Node '${node.id}' of type '${node.type}' must define '${branchKey}'`);
    }

    const target = node[branchKey as keyof typeof node];
    if (typeof target === 'string' && !nodeIds.has(target)) {
      throw new ApiError(422, 'invalid_node_edge', `Node '${node.id}' points '${branchKey}' to missing node '${target}'`);
    }

    if (branchKeys.length > 1 && (target === null || target === undefined || target === '')) {
      throw new ApiError(422, 'missing_node_edge_target', `Node '${node.id}' must set '${branchKey}' to a target node`);
    }
  }

  if (!catalogNode.branches && Object.prototype.hasOwnProperty.call(node, 'next')) {
    const target = node.next;
    if (typeof target === 'string' && !nodeIds.has(target)) {
      throw new ApiError(422, 'invalid_node_edge', `Node '${node.id}' points 'next' to missing node '${target}'`);
    }
  }
}

export async function validateWorkflowDefinition(input: unknown, options: ValidateOptions = {}): Promise<WorkflowDefinition> {
  const definition = workflowSchema.parse(input);
  const catalog = await loadNodeCatalog();
  const nodeTypes = getNodeTypeMap(catalog);
  const triggerTypes = getTriggerTypeMap(catalog);

  if (options.expectedId && definition.id !== options.expectedId) {
    throw new ApiError(400, 'workflow_id_mismatch', `Workflow id '${definition.id}' does not match '${options.expectedId}'`);
  }

  if (!triggerTypes.has(definition.trigger.type)) {
    throw new ApiError(422, 'invalid_trigger_type', `Unknown trigger type '${definition.trigger.type}'`);
  }

  validateTrigger(catalog, definition.trigger as Record<string, unknown>);

  const nodeIds = new Set<string>();
  for (const node of definition.nodes) {
    if (nodeIds.has(node.id)) {
      throw new ApiError(422, 'duplicate_node_id', `Workflow contains duplicate node id '${node.id}'`);
    }
    nodeIds.add(node.id);
  }

  if (!nodeIds.has(definition.entry)) {
    throw new ApiError(422, 'invalid_entry_node', `Workflow entry '${definition.entry}' does not point to a node in the definition`);
  }

  for (const node of definition.nodes) {
    const catalogNode = nodeTypes.get(node.type);
    if (!catalogNode) {
      throw new ApiError(422, 'invalid_node_type', `Node '${node.id}' has unknown type '${node.type}'`);
    }

    validateNodeParams(catalogNode, node);
    validateNodeEdges(catalogNode, node, nodeIds);
  }

  return definition;
}
