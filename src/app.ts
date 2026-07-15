import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { requireDemoToken } from './middleware/auth.js';
import { ApiError } from './http/errors.js';
import { createWorkflow, getWorkflow, listWorkflows, publishWorkflow, updateWorkflow } from './workflows/service.js';

export async function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(morgan('dev'));

  app.get('/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.use(requireDemoToken);

  app.get('/workflows', async (_request, response, next) => {
    try {
      const workflows = await listWorkflows();
      response.json({ workflows });
    } catch (error) {
      next(error);
    }
  });

  app.get('/workflows/:workflowId', async (request, response, next) => {
    try {
      const workflow = await getWorkflow(request.params.workflowId);
      response.json(workflow);
    } catch (error) {
      next(error);
    }
  });

  app.post('/workflows', async (request, response, next) => {
    try {
      const workflow = await createWorkflow(request.body);
      response.status(201).json(workflow);
    } catch (error) {
      next(error);
    }
  });

  app.put('/workflows/:workflowId', async (request, response, next) => {
    try {
      const workflow = await updateWorkflow(request.params.workflowId, request.body);
      response.json(workflow);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/workflows/:workflowId', async (request, response, next) => {
    try {
      const workflow = await updateWorkflow(request.params.workflowId, request.body);
      response.json(workflow);
    } catch (error) {
      next(error);
    }
  });

  app.post('/workflows/:workflowId/publish', async (request, response, next) => {
    try {
      const workflow = await publishWorkflow(request.params.workflowId);
      response.json(workflow);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      response.status(error.status).json({
        error: {
          message: error.message,
          code: error.code,
          ...(error.details !== undefined ? { details: error.details } : {})
        }
      });
      return;
    }

    console.error(error);
    response.status(500).json({ error: { message: 'Internal server error', code: 'internal_error' } });
  });

  return app;
}
