import { prisma } from '../lib/prisma.js';
import { ApiError } from '../http/errors.js';
import { validateWorkflowDefinition, type WorkflowDefinition } from './validation.js';

type WorkflowSummary = {
  id: string;
  name: string;
  status: string;
  updatedAt: Date;
};

type WorkflowRecord = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  definition: string;
  createdAt: Date;
  updatedAt: Date;
};

function parseDefinition(definition: string): WorkflowDefinition {
  return JSON.parse(definition) as WorkflowDefinition;
}

function toResponse(record: WorkflowRecord) {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    status: record.status,
    definition: parseDefinition(record.definition),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  return prisma.workflow.findMany({
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      status: true,
      updatedAt: true
    }
  });
}

export async function getWorkflow(workflowId: string) {
  const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!workflow) {
    throw new ApiError(404, 'workflow_not_found', 'Workflow not found');
  }

  return toResponse(workflow as WorkflowRecord);
}

export async function createWorkflow(input: unknown) {
  const definition = await validateWorkflowDefinition(input);

  const existing = await prisma.workflow.findUnique({ where: { id: definition.id } });
  if (existing) {
    throw new ApiError(409, 'workflow_exists', `Workflow '${definition.id}' already exists`);
  }

  const workflow = await prisma.workflow.create({
    data: {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      status: 'draft',
      definition: JSON.stringify(definition)
    }
  });

  return toResponse(workflow as WorkflowRecord);
}

export async function updateWorkflow(workflowId: string, input: unknown) {
  const current = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!current) {
    throw new ApiError(404, 'workflow_not_found', 'Workflow not found');
  }

  if (current.status === 'published') {
    throw new ApiError(409, 'workflow_locked', 'Published workflows are frozen and cannot be edited');
  }

  const definition = await validateWorkflowDefinition(input, { expectedId: workflowId });

  const workflow = await prisma.workflow.update({
    where: { id: workflowId },
    data: {
      name: definition.name,
      description: definition.description,
      status: 'draft',
      definition: JSON.stringify(definition)
    }
  });

  return toResponse(workflow as WorkflowRecord);
}

export async function publishWorkflow(workflowId: string) {
  const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!workflow) {
    throw new ApiError(404, 'workflow_not_found', 'Workflow not found');
  }

  const definition = await validateWorkflowDefinition(JSON.parse(workflow.definition), { expectedId: workflowId });

  const published = await prisma.workflow.update({
    where: { id: workflowId },
    data: {
      name: definition.name,
      description: definition.description,
      status: 'published',
      definition: JSON.stringify(definition)
    }
  });

  return toResponse(published as WorkflowRecord);
}

/**
 * Validates a webhook secret against the workflow's trigger configuration.
 * Returns true if secret matches, false otherwise.
 */
export async function validateSecret(
  workflowId: string,
  providedSecret: string
): Promise<boolean> {
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId }
  });

  // Workflow not found → secret is invalid
  if (!workflow) {
    return false;
  }

  const definition = parseDefinition(workflow.definition);
  const workflowSecret = definition.trigger?.secret;

  // No secret configured → cannot match
  if (!workflowSecret) {
    return false;
  }

  // Optional: Use constant-time comparison to prevent timing attacks
  // For MVP, simple equality is fine
  return workflowSecret === providedSecret;
}

/**
 * Triggers a workflow run.
 * - Validates workflow exists and is published
 * - Creates a Run record with definition snapshot
 * - Enqueues a job for the worker
 * - Returns the run ID
 */
export async function triggerWorkflow(
  workflowId: string,
  triggerInput: unknown,
  triggerType: 'manual' | 'webhook' = 'manual'
): Promise<{ run_id: string }> {
  // Step 1: Load the workflow
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId }
  });

  if (!workflow) {
    throw new ApiError(404, 'workflow_not_found', `Workflow '${workflowId}' not found`);
  }

  // Step 2: Check that it's published (only published workflows can be triggered)
  if (workflow.status !== 'published') {
    throw new ApiError(
      409,
      'workflow_not_published',
      `Workflow '${workflowId}' is ${workflow.status}, not published`
    );
  }

  // Step 3: Parse the workflow definition from the snapshot
  const definition = parseDefinition(workflow.definition);

  // Step 4: Create a Run record
  // - definitionSnapshot: the entire workflow definition at trigger time
  // - input: the trigger body/input JSON
  // - status: starts as 'queued' (worker will move to 'running')
  // - currentNodeId: set to the entry node (where execution starts)
  // - triggerType: 'manual' or 'webhook'
  const run = await prisma.run.create({
    data: {
      workflowId,
      triggerType,
      definitionSnapshot: workflow.definition, // SNAPSHOT: immutable
      input: JSON.stringify(triggerInput), // Store input as JSON string
      status: 'queued',
      currentNodeId: definition.entry, // Which node to execute first
      stepsExecuted: 0,
      aiTokensUsed: 0,
      startedAt: new Date()
    }
  });

  // Step 5: Enqueue a job for the worker to pick up
  // The worker will see this job and start executing the run
  await prisma.queueJob.create({
    data: {
      type: 'run_step', // Type of job (used by worker on Day 5)
      status: 'queued', // Not yet picked up by worker
      payload: JSON.stringify({
        runId: run.id,
        workflowId,
        triggerType
      }),
      availableAt: new Date(), // Available immediately
      attempts: 0
    }
  });

  // Step 6: Return the run ID to the caller
  return { run_id: run.id };
} 