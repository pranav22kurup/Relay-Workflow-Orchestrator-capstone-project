const TOKEN_STORAGE_KEY = 'relay_console_token';
const POLL_INTERVAL_MS = 4000;

const state = {
  tab: 'workflows',
  runFilter: '',
  currentRunId: null
};

const tokenInput = document.getElementById('token-input');
tokenInput.value = localStorage.getItem(TOKEN_STORAGE_KEY) || 'demo-token';
tokenInput.addEventListener('input', () => {
  localStorage.setItem(TOKEN_STORAGE_KEY, tokenInput.value);
});

function getToken() {
  return tokenInput.value.trim();
}

// --- fetch helper -----------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = body && body.error && body.error.message ? body.error.message : `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return body;
}

// --- error banner / toast ----------------------------------------------

const errorBanner = document.getElementById('error-banner');
function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}
function clearError() {
  errorBanner.hidden = true;
}

const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2500);
}

// --- formatting helpers --------------------------------------------------

function statusPill(status) {
  return `<span class="status-pill status-${status}">${status.replace(/_/g, ' ')}</span>`;
}

function fmtDate(value) {
  if (!value) return '&mdash;';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function fmtJson(value) {
  if (value === null || value === undefined) return '<span class="muted">null</span>';
  return JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- tabs -----------------------------------------------------------------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${tab}`));
  refreshActiveTab();
}

function refreshActiveTab() {
  clearError();
  if (state.tab === 'workflows') return loadWorkflows();
  if (state.tab === 'runs') return state.currentRunId ? loadRunDetail(state.currentRunId) : loadRuns();
  if (state.tab === 'approvals') return loadApprovals();
}

// --- workflows --------------------------------------------------------

async function loadWorkflows() {
  try {
    const { workflows } = await api('/workflows');
    const body = document.getElementById('workflows-body');
    if (workflows.length === 0) {
      body.innerHTML = `<tr><td colspan="5" class="empty-state">No workflows loaded.</td></tr>`;
      return;
    }
    body.innerHTML = workflows
      .map(
        (wf) => `
      <tr>
        <td class="mono">${escapeHtml(wf.id)}</td>
        <td>${escapeHtml(wf.name)}</td>
        <td>${statusPill(wf.status)}</td>
        <td>${fmtDate(wf.updatedAt)}</td>
        <td>${wf.status === 'published' ? `<button class="btn secondary" data-trigger="${wf.id}">Trigger&hellip;</button>` : ''}</td>
      </tr>`
      )
      .join('');

    body.querySelectorAll('[data-trigger]').forEach((btn) => {
      btn.addEventListener('click', () => openTriggerModal(btn.dataset.trigger));
    });
  } catch (error) {
    showError(error.message);
  }
}

// The trigger form lives in a modal outside the polled table on purpose:
// the workflows table is regenerated wholesale on every auto-refresh, which
// would otherwise wipe out an open form (or whatever the user had typed)
// mid-interaction if a poll happened to land while it was open.
const triggerModal = document.getElementById('trigger-modal');
const triggerModalWorkflowId = document.getElementById('trigger-modal-workflow-id');
const triggerModalInput = document.getElementById('trigger-modal-input');
const triggerModalError = document.getElementById('trigger-modal-error');
let triggerModalTargetId = null;

function openTriggerModal(workflowId) {
  triggerModalTargetId = workflowId;
  triggerModalWorkflowId.textContent = workflowId;
  triggerModalInput.value = '{}';
  triggerModalError.hidden = true;
  triggerModal.hidden = false;
  triggerModalInput.focus();
}

function closeTriggerModal() {
  triggerModal.hidden = true;
  triggerModalTargetId = null;
}

document.getElementById('trigger-modal-cancel').addEventListener('click', closeTriggerModal);
triggerModal.addEventListener('click', (event) => {
  if (event.target === triggerModal) closeTriggerModal();
});

document.getElementById('trigger-modal-send').addEventListener('click', async () => {
  let input;
  try {
    input = JSON.parse(triggerModalInput.value || '{}');
  } catch {
    triggerModalError.textContent = 'Input must be valid JSON.';
    triggerModalError.hidden = false;
    return;
  }
  try {
    const result = await api(`/workflows/${encodeURIComponent(triggerModalTargetId)}/trigger`, {
      method: 'POST',
      body: JSON.stringify({ input })
    });
    closeTriggerModal();
    showToast(`Triggered run ${result.run_id}`);
    switchTab('runs');
    viewRun(result.run_id);
  } catch (error) {
    triggerModalError.textContent = error.message;
    triggerModalError.hidden = false;
  }
});

// --- runs ---------------------------------------------------------------

const runsListView = document.getElementById('runs-list-view');
const runDetailView = document.getElementById('run-detail-view');
const runsFilterInput = document.getElementById('runs-filter-workflow');
let runsFilterTimer = null;
runsFilterInput.addEventListener('input', () => {
  clearTimeout(runsFilterTimer);
  runsFilterTimer = setTimeout(() => {
    state.runFilter = runsFilterInput.value.trim();
    loadRuns();
  }, 300);
});

async function loadRuns() {
  try {
    const query = state.runFilter ? `?workflowId=${encodeURIComponent(state.runFilter)}` : '';
    const { runs } = await api(`/runs${query}`);
    const body = document.getElementById('runs-body');
    if (runs.length === 0) {
      body.innerHTML = `<tr><td colspan="8" class="empty-state">No runs yet.</td></tr>`;
      return;
    }
    body.innerHTML = runs
      .map(
        (run) => `
      <tr class="run-row" data-run-id="${run.run_id}">
        <td class="mono">${escapeHtml(run.run_id)}</td>
        <td class="mono">${escapeHtml(run.workflow_id)}</td>
        <td>${statusPill(run.status)}</td>
        <td>${escapeHtml(run.trigger_type)}</td>
        <td>${run.steps_executed}</td>
        <td>${fmtDate(run.started_at)}</td>
        <td>${fmtDate(run.finished_at)}</td>
        <td><button class="btn secondary" data-view-run="${run.run_id}">View</button></td>
      </tr>`
      )
      .join('');
    body.querySelectorAll('[data-view-run]').forEach((btn) => {
      btn.addEventListener('click', () => viewRun(btn.dataset.viewRun));
    });
  } catch (error) {
    showError(error.message);
  }
}

function viewRun(runId) {
  state.currentRunId = runId;
  runsListView.hidden = true;
  runDetailView.hidden = false;
  loadRunDetail(runId);
}

document.getElementById('back-to-runs').addEventListener('click', () => {
  state.currentRunId = null;
  runDetailView.hidden = true;
  runsListView.hidden = false;
  loadRuns();
});

document.getElementById('refresh-run-detail').addEventListener('click', () => state.currentRunId && loadRunDetail(state.currentRunId));

document.getElementById('cancel-run-btn').addEventListener('click', async () => {
  if (!state.currentRunId) return;
  if (!confirm(`Cancel run ${state.currentRunId}?`)) return;
  try {
    await api(`/runs/${encodeURIComponent(state.currentRunId)}/cancel`, { method: 'POST' });
    showToast('Run cancelled');
    loadRunDetail(state.currentRunId);
  } catch (error) {
    showError(error.message);
  }
});

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

async function loadRunDetail(runId) {
  try {
    const trace = await api(`/runs/${encodeURIComponent(runId)}`);

    document.getElementById('run-detail-summary').innerHTML = `
      <dl class="summary-grid">
        <div><dt>Run ID</dt><dd class="mono">${escapeHtml(trace.run_id)}</dd></div>
        <div><dt>Workflow</dt><dd class="mono">${escapeHtml(trace.workflow_id)}</dd></div>
        <div><dt>Status</dt><dd>${statusPill(trace.status)}</dd></div>
        <div><dt>Trigger</dt><dd>${escapeHtml(trace.trigger_type)}</dd></div>
        <div><dt>Steps executed</dt><dd>${trace.steps_executed}</dd></div>
        <div><dt>AI tokens used</dt><dd>${trace.ai_tokens_used}</dd></div>
        <div><dt>Started</dt><dd>${fmtDate(trace.started_at)}</dd></div>
        <div><dt>Finished</dt><dd>${fmtDate(trace.finished_at)}</dd></div>
      </dl>
      ${trace.error ? `<div class="summary-error">${escapeHtml(trace.error)}</div>` : ''}
    `;

    document.getElementById('cancel-run-btn').disabled = TERMINAL_STATUSES.has(trace.status);

    const stepsEl = document.getElementById('run-detail-steps');
    stepsEl.innerHTML = trace.steps.length
      ? trace.steps.map(renderStepCard).join('')
      : `<div class="empty-state">No steps executed yet.</div>`;
  } catch (error) {
    showError(error.message);
  }
}

function renderStepCard(step) {
  const metaParts = [];
  if (step.idempotency_key) metaParts.push(`Idempotency-Key: <span class="mono">${escapeHtml(step.idempotency_key)}</span>`);
  if (step.tokens_prompt !== null && step.tokens_prompt !== undefined) {
    metaParts.push(`Tokens: ${step.tokens_prompt} prompt / ${step.tokens_completion} completion`);
  }
  if (step.approval_id) metaParts.push(`Approval: <span class="mono">${escapeHtml(step.approval_id)}</span>`);

  return `
    <div class="step-card">
      <div class="step-card-head">
        <span class="seq">#${step.sequence}</span>
        <span class="node-id">${escapeHtml(step.node_id)}</span>
        <span class="node-type">${escapeHtml(step.type)}</span>
        ${statusPill(step.status)}
        ${step.attempt > 1 ? `<span class="muted">attempt ${step.attempt}</span>` : ''}
        <span class="timing">${fmtDate(step.started_at)}${typeof step.duration_ms === 'number' ? ` &middot; ${step.duration_ms}ms` : ''}</span>
      </div>
      <div class="step-json-pair">
        <div><h4>Resolved input</h4><pre>${escapeHtml(fmtJson(step.input))}</pre></div>
        <div><h4>Output</h4><pre>${escapeHtml(fmtJson(step.output))}</pre></div>
      </div>
      ${metaParts.length ? `<div class="step-meta">${metaParts.join(' &nbsp;&middot;&nbsp; ')}</div>` : ''}
    </div>
  `;
}

// --- approvals --------------------------------------------------------

async function loadApprovals() {
  try {
    const approvals = await api('/approvals?status=pending');
    updateApprovalsBadge(approvals.length);

    const list = document.getElementById('approvals-list');
    if (approvals.length === 0) {
      list.innerHTML = `<div class="empty-state">No pending approvals.</div>`;
      return;
    }
    list.innerHTML = approvals
      .map(
        (approval) => `
      <div class="approval-card">
        <div class="body">
          <div class="message">${escapeHtml(approval.message)}</div>
          <div class="meta">run <span class="mono">${escapeHtml(approval.run_id)}</span> &middot; node <span class="mono">${escapeHtml(approval.node_id)}</span> &middot; ${fmtDate(approval.created_at)}</div>
        </div>
        <div class="approval-actions">
          <button class="btn secondary" data-view-run-from-approval="${approval.run_id}">View run</button>
          <button class="btn success" data-approve="${approval.id}">Approve</button>
          <button class="btn danger" data-reject="${approval.id}">Reject</button>
        </div>
      </div>`
      )
      .join('');

    list.querySelectorAll('[data-view-run-from-approval]').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab('runs');
        viewRun(btn.dataset.viewRunFromApproval);
      });
    });
    list.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.addEventListener('click', () => decideApproval(btn.dataset.approve, 'approve'));
    });
    list.querySelectorAll('[data-reject]').forEach((btn) => {
      btn.addEventListener('click', () => decideApproval(btn.dataset.reject, 'reject'));
    });
  } catch (error) {
    showError(error.message);
  }
}

async function decideApproval(approvalId, action) {
  try {
    await api(`/approvals/${encodeURIComponent(approvalId)}/${action}`, { method: 'POST' });
    showToast(action === 'approve' ? 'Approved' : 'Rejected');
    loadApprovals();
  } catch (error) {
    showError(error.message);
  }
}

function updateApprovalsBadge(count) {
  const badge = document.getElementById('approvals-badge');
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

async function pollApprovalsBadgeOnly() {
  try {
    const approvals = await api('/approvals?status=pending');
    updateApprovalsBadge(approvals.length);
  } catch {
    // Silent: the active tab's own refresh already surfaces connectivity errors.
  }
}

// --- wiring ---------------------------------------------------------------

document.getElementById('refresh-workflows').addEventListener('click', loadWorkflows);
document.getElementById('refresh-runs').addEventListener('click', loadRuns);
document.getElementById('refresh-approvals').addEventListener('click', loadApprovals);

refreshActiveTab();
setInterval(() => {
  refreshActiveTab();
  if (state.tab !== 'approvals') pollApprovalsBadgeOnly();
}, POLL_INTERVAL_MS);
