# Relay Verification Report

Captured 2026-07-29 against the seed data in `data/`, with `scripts/mock_world.py` running locally.

## 1. Automated test suite

```
npm test
```

80/80 tests passing (0 skipped), covering publish validation, template resolution, condition/http_request/delay/notify/order_action/ai executors, crash recovery, idempotency, retries/backoff, approval gating, cancel semantics, and the run/approval read APIs. Run via `node --test --test-concurrency=1` — file-level concurrency is deliberately serialized since all test files share the same real SQLite database and queue table.

## 2. `scripts/smoke_test.py`

```
python3 scripts/smoke_test.py --url http://localhost:8080 --token demo-token --world http://localhost:9210
```

```
[1] Seed workflows loaded and published
  PASS  GET /workflows returns 200  (got 200)
  PASS  seed wf_support_triage present
  PASS  seed wf_expense_approval present
  PASS  seed wf_slow_fulfillment present
  PASS  seed wf_runaway present
  PASS  seeds are published  (expected status 'published' on seed workflows)

[2] Create, publish, trigger a minimal workflow
  PASS  create draft returns 2xx  (got 201)
  PASS  publish returns 2xx  (got 200)
  PASS  trigger returns a run id  (got 202: {'run_id': 'cms61vqfr0001bciez33hx93k'})
  PASS  run reaches succeeded  (got succeeded)
  PASS  trace has a step for node 'hello'  (1 steps)
  PASS  notify step visible in mock world ledger
  PASS  notify carried an Idempotency-Key  (required for exactly-once recovery)

[3] Publish validation rejects broken definitions
  PASS  rejects unknown node type (at create)  (got 422)
  PASS  rejects missing required param (at create)  (got 422)
  PASS  rejects reference to nonexistent node (at create)  (got 422)

[4] Webhook secret enforcement
  PASS  wrong secret rejected 401/403  (got 401)
  PASS  correct secret accepted with a run id  (got 202)

[5] Approval lifecycle (wf_expense_approval)
  PASS  small expense auto-approves (no gate)  (got succeeded)
  PASS  large expense triggered  (got 202)
  PASS  run pauses in waiting_approval  (got waiting_approval)
  PASS  pending approval listed for the run  (2 pending)
  PASS  approve returns 2xx  (got 200)
  PASS  approved run resumes and succeeds  (got succeeded)

[6] Run caps stop wf_runaway
  PASS  wf_runaway triggered  (got 202)
  PASS  runaway run is stopped (failed/cancelled)  (got failed)
  PASS  stop reason mentions the cap  (expected a cap-exceeded reason in the run record)

[7] Status vocabulary
  PASS  all observed statuses in documented set  (saw ['failed', 'queued', 'running', 'succeeded', 'waiting_approval'])

========================================================
  28 passed, 0 warnings, 0 failed
```

## 3. Kill-and-resume drill + `scripts/duplication_check.py`

Procedure:

1. Reset the mock world's ledger (`POST /admin/reset`).
2. Trigger `wf_slow_fulfillment` with `pay_201`'s payload (`{"order_id": "ord_2003", "customer_email": "lena@example.com"}`).
3. Confirmed via direct DB read the run was `running` with `currentNodeId: pack_delay` (inside the 20s delay) before proceeding.
4. Killed every `node.exe` process at once (`taskkill /F /IM node.exe`) — confirmed the port stopped responding and the run was left `status: running`, `finishedAt: null`, with its `QueueJob` stuck in `running` (the crash signature).
5. Restarted the app (`npm run dev`). Startup log confirmed: `Worker reclaimed 1 in-flight job(s) left over from a previous run`.
6. The delay re-ran its full duration from scratch (by design — see `docs/IMPLEMENTATION_GUIDE.md` FAQ on delay nodes), then the run completed: `confirm` was **not** re-executed (its Step row, sequence 1, was already persisted before the crash); `create_shipment` and `shipped_notice` ran once each.
7. Ran the duplication check:

```
python3 scripts/duplication_check.py --url http://localhost:9210
```

```
Ledger entries checked: 3 (executed: 3, replays absorbed: 0, rejected: 0)
  email.send: 2 executed
  shipment.create: 1 executed

PASS: every side effect executed exactly once.
```

Two `email.send` (the `confirm` and `shipped_notice` notifications) and one `shipment.create`, each exactly once — matching the workflow's four nodes minus the non-side-effecting `pack_delay`. No duplicates despite the mid-run crash.
