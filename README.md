# Relay Workflow Orchestrator

Relay is an AI-first workflow orchestrator built as the Airtribe capstone project. The implementation is being developed on a locked Node.js stack with durable execution, seeded workflows, approvals, AI nodes, and a lightweight console.

## Stack

- Node.js + TypeScript
- Express
- SQLite
- Prisma
- Zod for workflow-definition validation
- Ajv for JSON Schema enforcement on AI output
- In-process polling worker for Must Have durability
- Minimal HTML/JS console

## Current Status

The repo currently includes the application scaffold, SQLite/Prisma setup, seed loading, demo-token auth, and a `GET /workflows` endpoint that returns the seeded published workflows.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create or sync the SQLite database:

```bash
npm run prisma:push
```

3. Start the API:

```bash
npm run dev
```

Or run the compiled app:

```bash
npm run build
npm start
```

## Environment Variables

Copy [.env.example](.env.example) to `.env` and adjust if needed.

- `DATABASE_URL` - Prisma SQLite connection string, default `file:./dev.db`
- `PORT` - API port, default `8080`
- `MOCK_WORLD_URL` - mock external services base URL, default `http://localhost:9210`
- `DEMO_TOKEN` - bearer token for platform routes, default `demo-token`

## Useful Commands

Start the mock world:

```bash
python3 scripts/mock_world.py --port 9210
```

Validate the data pack:

```bash
python3 scripts/validate_pack.py
```

Run the platform smoke test:

```bash
python3 scripts/smoke_test.py --url http://localhost:8080 --token demo-token
```

Run the duplication check after the kill-and-resume drill:

```bash
python3 scripts/duplication_check.py --url http://localhost:9210
```

## Architecture Notes

- Workflows are stored as draft or published records in SQLite.
- Seed workflows from `data/seed_workflows.json` are loaded as published at startup.
- The API never executes workflow steps inline; execution is handled by a polling worker loop.
- Runs must persist a definition snapshot so later edits do not affect in-flight execution.
- Side-effect nodes will need stable idempotency keys so the mock world ledger can verify exactly-once behavior.

## Repository Layout

- `data/` - node catalog, seed workflows, sample payloads, and NL eval data
- `docs/` - API contract, data model, implementation guide, and evaluation guide
- `scripts/` - mock world, mock provider, smoke test, duplication check, and pack validation
- `src/` - Node.js application code
- `prisma/` - Prisma schema and migrations

## Next Milestones

- Workflow CRUD and publish validation
- Manual and webhook triggers
- Worker loop and deterministic node execution
- Approvals, retries, step caps, and AI schema enforcement
- Console views for workflows, runs, traces, and approvals

## Notes

This repository is intentionally self-contained so the project can be run locally without extra infrastructure. SQLite keeps setup simple for the demo, while Prisma keeps the schema and migrations explicit.
