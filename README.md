# Relay — AI Workflow Orchestrator

Relay is a durable, AI-first workflow orchestrator: workflows are typed nodes wired by `next`/`on_true`/`on_false` pointers, triggered by webhook or API call, and executed by a crash-safe background worker. An `ai` node can classify a payload and branch a run's path — but every safety property that matters (approval gates, exactly-once side effects, the step cap) is enforced by the **engine**, never trusted to whatever the model says.

Built as the Airtribe AI-First Software Engineering capstone. All Must-Have requirements are implemented and verified — see [VERIFICATION.md](VERIFICATION.md) for the current smoke test, duplication check, and test suite results.

## Stack

- Node.js + TypeScript, Express
- SQLite via Prisma (workflows, runs, steps, approvals, and the queue all live in one database)
- Zod for workflow-definition validation, Ajv for AI output schema enforcement
- An in-process polling worker (same process as the API — see [Acceptable Simplifications](RELAY_PROBLEM_STATEMENT.md))
- A dependency-free static console (`public/`) served from the same Express app

## Quick start

You need three things running: the mock world (external services), the Relay app (API + worker), and — only if you want to exercise the `ai` node with real output — an OpenAI-compatible model.

```bash
npm install
npm run prisma:push
```

Terminal 1 — mock world:

```bash
python3 scripts/mock_world.py --port 9210
```

Terminal 2 — the app (loads the seed workflows as Published, starts the worker):

```bash
npm run dev
```

Open `http://localhost:8080` for the console, or drive it via API:

```bash
curl -s http://localhost:8080/workflows -H "Authorization: Bearer demo-token"

curl -s -X POST http://localhost:8080/workflows/wf_expense_approval/trigger \
  -H "Authorization: Bearer demo-token" -H "Content-Type: application/json" \
  -d '{"input": {"employee_email": "dev1@example.com", "amount_usd": 250, "description": "Conference ticket"}}'
```

For a compiled/production-style run instead of `tsx watch`:

```bash
npm run build
npm start
```

### Exercising the `ai` node

`wf_support_triage` needs a real model behind it (a mock that returns prose, not JSON, will fail schema validation every time — which is itself a valid thing to demo, see [Known Limitations](#known-limitations)). Point `AI_PROVIDER_URL` at any OpenAI-chat-completions-compatible endpoint:

```bash
# OpenRouter
AI_PROVIDER_URL=https://openrouter.ai/api AI_PROVIDER_MODEL=<model id from openrouter.ai/models> AI_PROVIDER_API_KEY=<key> npm run dev

# Groq (free tier)
AI_PROVIDER_URL=https://api.groq.com/openai AI_PROVIDER_MODEL=llama-3.1-8b-instant AI_PROVIDER_API_KEY=<key> npm run dev

# Ollama, local
AI_PROVIDER_URL=http://localhost:11434 AI_PROVIDER_MODEL=llama3.1 npm run dev

# The bundled mock provider (deterministic plumbing test, not schema-compliant output)
python3 scripts/mock_provider.py --port 9001 --name alpha
AI_PROVIDER_URL=http://localhost:9001 AI_PROVIDER_MODEL=alpha-small AI_PROVIDER_API_KEY=test-key npm run dev
```

Engine tests never hit a real provider — they inject an in-process fake via `setAiProvider()` (see [src/ai/provider.ts](src/ai/provider.ts)).

## Environment variables

Copy [.env.example](.env.example) to `.env` and adjust as needed. Every value has a working default except the AI provider ones.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | Prisma SQLite connection string |
| `PORT` | `8080` | API port |
| `MOCK_WORLD_URL` | `http://localhost:9210` | Base URL for `scripts/mock_world.py` |
| `DEMO_TOKEN` | `demo-token` | Bearer token for all platform routes (single token covers builder/operator/approver — role separation is Good-to-Have) |
| `ENGINE_HTTP_TIMEOUT_MS` | `5000` | Hard timeout on every outbound call (mock world, AI provider) — a hung dependency fails the step, never the engine |
| `NODE_MAX_ATTEMPTS` | `3` | Max attempts per node for transient failures (timeouts, network errors, 5xx/429) |
| `NODE_RETRY_BASE_DELAY_MS` | `200` | Exponential backoff base delay between retries |
| `NODE_RETRY_MAX_DELAY_MS` | `5000` | Backoff delay cap |
| `AI_PROVIDER_URL` | *(empty)* | Base URL of an OpenAI-chat-completions-compatible endpoint |
| `AI_PROVIDER_API_KEY` | *(empty)* | Bearer token for the AI provider, if it requires one |
| `AI_PROVIDER_MODEL` | *(empty)* | Model name to send in each request |

## API overview

The fixed contract in [docs/API_CONTRACT.md](docs/API_CONTRACT.md) — routes exercised by `scripts/smoke_test.py` — is implemented exactly as specified. Full route list:

| Method & Path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness |
| `POST /hooks/:workflowId` | `X-Relay-Secret` header | webhook trigger |
| `GET /workflows` | bearer | list workflows |
| `GET /workflows/:id` | bearer | get one workflow (full definition) |
| `POST /workflows` | bearer | create a Draft |
| `PUT` / `PATCH /workflows/:id` | bearer | edit a Draft (409 if already Published — Published is frozen) |
| `POST /workflows/:id/publish` | bearer | validate + publish |
| `POST /workflows/:id/trigger` | bearer | manual trigger, body `{"input": {...}}` |
| `GET /runs?workflowId=` | bearer | list runs, optional filter |
| `GET /runs/:runId` | bearer | full trace: every step with resolved input/output, attempt, timing, idempotency key, AI token usage |
| `POST /runs/:runId/cancel` | bearer | cancel (semantics below) |
| `GET /approvals?status=pending` | bearer | pending approvals |
| `POST /approvals/:id/approve` \| `/reject` | bearer | decide, resumes/ends the run |

Every route not in the fixed contract (list runs, the trace shape's exact field names, cancel's response shape) is documented here rather than in `API_CONTRACT.md`, per that doc's own "everything else is yours" clause.

## Architecture

### Process model

One Node process runs both the Express API and the worker loop (`startWorker()` in [src/index.ts](src/index.ts)). This is the Must-Have-acceptable simplification the spec explicitly allows — a separate worker process is the cleaner production shape, but a single process is sufficient as long as execution never happens inside a request handler, which it doesn't: `POST /trigger` and `POST /hooks/:id` only ever create a `Run` row and enqueue a `QueueJob` row, then return. The worker polls that table independently (500ms interval) and does the actual node-by-node execution.

```
 client / webhook
        │
        ▼
   Express API  ──creates──▶  Run (queued) + QueueJob (queued)
        │                              │
        ▼                              ▼
     console                     worker loop (poll every 500ms)
   (reads via                          │
    GET /runs,                         ▼
    GET /approvals)              runOnce(runId) — persist-then-advance
                                        │
                                        ▼
                              mock world / AI provider
                              (idempotency-keyed side effects)
```

### The run state machine

```
queued ──▶ running ──┬──▶ succeeded
                      ├──▶ failed
                      ├──▶ waiting_approval ──▶ running (approved) ──▶ ...
                      │                    └──▶ cancelled (rejected)
                      └──▶ cancelled (via POST /runs/:id/cancel)
```

- **`queued`**: created, not yet claimed by the worker. Cancelling here is free — `runOnce`'s first line no-ops on a terminal-or-cancelled run, so there's nothing to unwind.
- **`running`**: the worker is actively looping through nodes. Set on first pickup and re-set on every resume (including a resume out of `waiting_approval`), so "actively being processed" always means `running` regardless of how the run got there.
- **`waiting_approval`**: parked at an `approval` node. The `Step` row for that node sits in a `waiting` sub-state (not itself one of the six run statuses) until decided.
- **`succeeded` / `failed` / `cancelled`**: terminal. `failed` always carries a reason in `Run.error` (a validation error, an exhausted-retries error, or the step-cap message naming `limits.max_steps`).

Cancellation has three distinct paths depending on where the run is (`src/runs/service.ts`):
- `queued` → cancelled immediately, nothing to interrupt.
- `running` → **cooperative**: the worker loop re-reads the run's status from the database at the top of every iteration, before starting the next node. A step already in flight is allowed to finish; nothing after it starts.
- `waiting_approval` → cancelled, and the pending `Approval` row is closed (`status: 'cancelled'`, distinct from an explicit human `rejected` decision) so it stops appearing in `GET /approvals?status=pending`.

### Exactly-once recovery

This is the property the kill-and-resume drill exists to prove (see [VERIFICATION.md](VERIFICATION.md)).

**Persist-then-advance.** Every node execution writes its `Step` row (with resolved input, output, and — for side-effecting nodes — its idempotency key) *before* `Run.currentNodeId` moves to the next node. If the process dies between those two writes, the worst case on restart is redoing that one step; the run pointer never gets ahead of what's actually been recorded.

**Reclaim on boot.** A `QueueJob` stuck in `running` past a worker's lifetime is the crash signature — something claimed it and never finished. `reclaimInFlightJobs()` runs once at worker startup, resetting any such job back to `queued`. The run itself doesn't need special resume logic beyond that: `runOnce` always starts from `Run.currentNodeId` and `Run.stepsExecuted`, which are exactly where the last successful write left them.

**Idempotency keys.** Every side-effecting call (`notify`, `order_action` always; `http_request` only for mutating methods) carries an `Idempotency-Key` header:

```
{run_id}:{node_id}:{sequence}
```

This is a deliberate refinement of the "canonical" `{run_id}:{node_id}` the spec suggests. `sequence` is assigned once, before the first attempt at a node, and only advances after that node succeeds — so it's **stable across retries and resumes of one attempt** (a retry or a post-crash resume of the same node recomputes the identical key), but **distinct across loop iterations** (a workflow that revisits the same node via a backward jump gets a fresh key each time, because `sequence` has moved on). The mock world's replay detection absorbs a resumed retry as a no-op; a genuinely new loop iteration is correctly treated as a new side effect. This resolves an edge case the plain `{run_id}:{node_id}` form doesn't handle, flagged explicitly in `docs/IMPLEMENTATION_GUIDE.md`'s FAQ.

**The crash window** the data model calls out — side effect fires, then the process dies before the `Step` row is written — is handled the same way: on resume, the node re-executes with the identical key. If the first call reached the mock world, the replay is absorbed (same `reference_id`/`notification_id` comes back, `x-mockworld-replayed: true`). If it never arrived, the call just executes normally. Either way, exactly once. This is tested directly in `tests/engine.test.ts` by simulating the crash window (firing the side effect manually with the key the engine would compute, then letting `runOnce` "resume" into it) rather than only relying on real process kills.

### Retries vs. AI repair — two different mechanisms

These look similar but solve different problems and don't share a code path:

- **Transient-failure retry** (`src/engine/retry.ts`, wired into every node type via `withRetries` in `worker.ts`): exponential backoff for errors that might succeed on a second try — timeouts, network failures, 5xx/429 responses. Classified per error type (`isRetryableNodeError`); a 4xx business-rule rejection (already refunded, bad params) is never retried, since it'll fail identically again. `Step.attempt` records how many outer attempts this took.
- **AI schema repair** (`src/engine/nodes/ai.ts`): entirely internal to one node execution. If the model's output fails Ajv validation, the node calls the model a second time with the validation error appended, once. If that also fails, it throws a non-retryable error — the outer retry wrapper never sees this as transient, so a malformed response doesn't burn additional attempts re-asking an unchanged prompt. `Step.attempt` stays `1` for a run that needed a repair; the two-call cost shows up only in `tokensPrompt`/`tokensCompletion`, which are summed across both calls and charged to `Run.aiTokensUsed` even if the step ultimately fails.

### Approval gating is a database query, not a prompt instruction

`requires_approval` nodes (`order_action` in the current catalog) are gated by one check in the worker loop, before template resolution or executor lookup even run:

```ts
const hasApproval = (await prisma.approval.count({ where: { runId, status: 'approved' } })) > 0;
```

Nothing an `ai` node outputs can write an `Approval` row — that table is only ever written by the `approval` node itself (pending) and the approve/reject API (decided). `tests/ai.test.ts` proves this directly against the real `wf_support_triage` definition: both injection payloads (`pay_inject_001`, `pay_inject_002`) are run through a scripted classifier that never special-cases the attack text, and the gate holds regardless of what it outputs — including a case where the node's own params contain a fabricated "pre-approved by admin" claim, which the gate never reads at all.

### The `approval` node's two-phase lifecycle

Unlike every other node type, `approval` can't return synchronously — it has to pause the run. It's handled specially in `worker.ts` (`handleApprovalNode`) rather than through the generic executor registry:

1. **First encounter**: resolve the message template, create the `Approval` (pending) and the `Step` (`status: 'waiting'`) atomically in one transaction, park the run at `waiting_approval`.
2. **Re-entry after a decision**: the approve/reject API only flips the `Approval` row and re-enqueues a job — it never touches `Run` or `Step` state itself. When the worker picks that job back up, it lands on the same node, finds the decision, finalizes the same `Step` row (`waiting` → `succeeded`, with `{decision, decided_by}` as output), and either continues to `next` (approved) or ends the run `cancelled` (rejected).

All state transitions funnel through the same engine code path whether the run is progressing for the first time or resuming after a crash or an approval decision — there's no separate "resume" code to keep in sync with the "first run" code.

## Repository layout

```
data/            node catalog, seed workflows, sample payloads, NL eval set (unused)
docs/            API contract, data model, implementation guide, evaluation guide
scripts/         mock_world.py, mock_provider.py, smoke_test.py, duplication_check.py, validate_pack.py
prisma/          schema (Workflow, Run, Step, Approval, QueueJob)
public/          the console (index.html, app.js, style.css) — served statically by Express
src/
  ai/            AI provider adapter (OpenAI-compat HTTP client, swappable for tests) + Ajv schema helper
  approvals/     approve/reject/list-pending service
  bootstrap/     node catalog + seed workflow loading at startup
  engine/        the worker loop, template resolution, retry helper, httpClient, and one file per node type
  http/          ApiError
  middleware/    bearer-token auth
  runs/          trigger/list/trace/cancel service
  workflows/     CRUD + Zod/catalog publish validation
tests/           workflows, engine, approvals, ai, runs — one file per concern, run against the real dev.db
                 and a real scripts/mock_world.py, not mocked at the HTTP boundary
```

## Testing & verification

```bash
npm test
```

80 tests across 5 files, run with `--test-concurrency=1`. That flag is load-bearing, not incidental: every test file shares the same real SQLite database and the same `QueueJob` table, so running files concurrently (Node's default) causes genuine cross-file races on the queue — discovered and fixed during Day 9. Requires `scripts/mock_world.py` running on `:9210`; `scripts/mock_provider.py` on `:9001` is optional (one test skips gracefully if it's not up).

```bash
python3 scripts/smoke_test.py --url http://localhost:8080 --token demo-token --world http://localhost:9210
python3 scripts/duplication_check.py --url http://localhost:9210
```

The duplication check is only meaningful right after a real kill-and-resume: trigger `wf_slow_fulfillment`, confirm (via `GET /runs/:id` or direct DB read) it's sitting in `pack_delay`, kill the process, restart, wait for it to finish, then run the check. See [VERIFICATION.md](VERIFICATION.md) for the exact procedure and the current captured output of all three (test suite, smoke test, duplication check).

One Windows-specific note from running this drill: `tsx watch` spawns more than one `node.exe` process, so killing a single PID (even the one holding the listening socket) doesn't reliably crash the app — use `taskkill /F /IM node.exe` to kill all of them at once, or the drill will silently no-op and the run will just finish normally without ever having been interrupted.

## Known limitations

**Must-Have scope is complete** — see the audit in this repo's conversation history / grading notes: all eight Must-Have categories are implemented, including every catalog node type (`http_request`, `condition`, `delay`, `notify`, `ai`, `approval`, `order_action`). What follows is explicitly out of scope or deliberately simplified, not missing Must-Have work.

**Accepted Must-Have simplifications** (per `RELAY_PROBLEM_STATEMENT.md`'s own list):
- Single in-process worker, no leases — safe because there's only ever one poller. Multi-worker coordination is Stretch.
- `delay` is a real `setTimeout`, not a `resume_at` timestamp the worker polls. If a crash happens mid-delay, the resumed run re-sleeps the *full* configured duration rather than the remainder — no correctness issue (a delay has no side effect to duplicate), just a slightly longer wait, and it's exactly what the implementation guide's FAQ says is acceptable.
- A single demo token covers the builder/operator/approver personas; role separation is Good-to-Have.

**A real edge case worth knowing about:** an `approval` node revisited via a backward jump does *not* re-prompt. The engine looks up the existing `Approval` row by `(runId, nodeId)`, and if one already exists — even from an earlier loop iteration — it uses that decision rather than pausing again. No seed workflow loops through an approval node, so this never triggers in the provided demo flows, but a hand-authored workflow that did would silently skip re-approval on a second pass. Fixing it would mean keying approvals by `(runId, nodeId, sequence)` the same way idempotency keys already are.

**Good-to-Have, not attempted:**
- NL workflow compiler (highest-value Good-to-Have per the spec, deliberately skipped in favor of hardening every Must-Have node type — including `order_action`, which the initial plan under-scheduled and had to be slotted back in before Day 11).
- Cron/schedule triggers.
- Wall-clock timeout and AI token budget caps — only `limits.max_steps` is enforced. The seed definitions carry `timeout_seconds`/`max_ai_tokens` fields for an engine that implements them; this one doesn't yet.
- Immutable version history — one Draft/Published state per workflow id; publishing again isn't possible once published (it's genuinely frozen), so there's no version list to browse.
- Replay-from-failed-step, live SSE/WebSocket run view (the console polls every 4s instead), AI failure triage.

**Stretch, not attempted:** multi-worker leases, an `agent` node, parallel branches, sub-workflows, cost accounting, NL-driven editing, approval-over-email, real Slack/Gmail connectors, multi-tenancy.

**Console, by design, not by omission:** no drag-and-drop builder — the spec is explicit that workflows are authored as JSON via the API, and the console is "read-and-operate" only (workflow list, run history, trace view, pending approvals). It's a plain table-and-modal admin dashboard, not a node-canvas editor like n8n or a step-wizard like Zapier — UI polish was explicitly not a grading criterion.
