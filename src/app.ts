import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { requireDemoToken } from './middleware/auth.js';
import { prisma } from './lib/prisma.js';
import { loadSeedWorkflows } from './bootstrap/seed.js';

export async function createApp() {
  await loadSeedWorkflows();

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
      const workflows = await prisma.workflow.findMany({
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          name: true,
          status: true,
          updatedAt: true
        }
      });
      response.json({ workflows });
    } catch (error) {
      next(error);
    }
  });

  app.get('/workflows/:workflowId', async (request, response, next) => {
    try {
      const workflow = await prisma.workflow.findUnique({
        where: { id: request.params.workflowId }
      });

      if (!workflow) {
        response.status(404).json({ error: { message: 'Workflow not found', code: 'not_found' } });
        return;
      }

      response.json(workflow);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);
    response.status(500).json({ error: { message: 'Internal server error', code: 'internal_error' } });
  });

  return app;
}
