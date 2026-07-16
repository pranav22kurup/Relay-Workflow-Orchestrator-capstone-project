import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { requireDemoToken } from './middleware/auth.js';
import { ApiError } from './http/errors.js';
import { createWorkflow, getWorkflow, listWorkflows, publishWorkflow, updateWorkflow, triggerWorkflow, validateSecret} from './workflows/service.js';

export async function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(morgan('dev'));

  app.get('/health', (_request, response) => {
    response.json({ ok: true });
  });

// ===== NEW: Webhook Trigger (NO auth, secret in header) =====
  app.post('/hooks/:workflowId', async (request, response, next) => {
    try {
      const secret = request.header('X-Relay-Secret');

      if (!secret) {
        throw new ApiError(
          401,
          'missing_secret',
          'X-Relay-Secret header is required'
        );
      }

      const isValid = await validateSecret(request.params.workflowId, secret);
      if (!isValid) {
        throw new ApiError(
          401,
          'invalid_secret',
          'X-Relay-Secret is incorrect'
        );
      }

      const result = await triggerWorkflow(
        request.params.workflowId,
        request.body,
        'webhook'
      );
      response.status(202).json({ run_id: result.run_id });
    } catch (error) {
      next(error);
    }
  });


  // Everything below this line requires demo token
  app.use(requireDemoToken);

  // GET /workflows
  app.get('/workflows', async (_request, response, next) => {
    try {
      const workflows = await listWorkflows();
      response.json({ workflows });
    } catch (error) {
      next(error);
    }
  });

  // GET /workflows/:workflowId
  app.get('/workflows/:workflowId', async (request, response, next) => {
    try {
      const workflow = await getWorkflow(request.params.workflowId);
      response.json(workflow);
    } catch (error) {
      next(error);
    }
  });

  // POST /workflows
  app.post('/workflows', async (request, response, next) => {
    try {
      const workflow = await createWorkflow(request.body);
      response.status(201).json(workflow);
    } catch (error) {
      next(error);
    }
  });

  // PUT /workflows/:workflowId
  app.put('/workflows/:workflowId', async (request, response, next) => {
    try {
      const workflow = await updateWorkflow(request.params.workflowId, request.body);
      response.json(workflow);
    } catch (error) {
      next(error);
    }
  });

  // PATCH /workflows/:workflowId
  app.patch('/workflows/:workflowId', async (request, response, next) => {
    try {
      const workflow = await updateWorkflow(request.params.workflowId, request.body);
      response.json(workflow);
    } catch (error) {
      next(error);
    }
  });

  // POST /workflows/:workflowId/publish
  app.post('/workflows/:workflowId/publish', async (request, response, next) => {
    try {
      const workflow = await publishWorkflow(request.params.workflowId);
      response.json(workflow);
    } catch (error) {
      next(error);
    }
  });

  // ===== NEW: Manual Trigger (requires demo token) =====
  app.post('/workflows/:workflowId/trigger', async (request, response, next) => {
    try {
      const result = await triggerWorkflow(
        request.params.workflowId,
        request.body.input,
        'manual'
      );
      response.status(202).json({ run_id: result.run_id });
    } catch (error) {
      next(error);
    }
  });

  // Error handler (must be last)
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