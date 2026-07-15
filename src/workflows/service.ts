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
