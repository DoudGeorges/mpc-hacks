const APP_SHELL = document.querySelector('.app-shell');
const IS_ADMIN = APP_SHELL?.dataset.admin === '1';

const _nativeFetch = window.fetch.bind(window);
window.fetch = async function fetchWithAuth(input, init) {
    const res = await _nativeFetch(input, init);
    const url = typeof input === 'string' ? input : input?.url || '';
    if (res.status === 401 && !url.includes('/login')) {
        window.location.href = '/login';
    }
    return res;
};

const chat = document.getElementById('chat');
const input = document.getElementById('message-input');
const btn = document.getElementById('sendQuestion');
let currentConversationId = null;
let pendingAttachment = null;
let dashboardCharts = {};
let compareSelection = new Set();
let modalEmployeeName = null;
let modalCharts = {};
let compareChart = null;

function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function parseJsonResponse(res) {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
        return res.json();
    }
    const text = await res.text();
    if (/^\s*</.test(text)) {
        if (res.status === 401) throw new Error('Session expired ? please sign in again.');
        if (res.status === 403) throw new Error('You do not have permission to view this data.');
        if (res.status === 404) throw new Error('API not found ? restart the app with python app.py.');
        throw new Error(`Server error (${res.status}). Restart the app and try again.`);
    }
    throw new Error(text.slice(0, 160) || `Request failed (${res.status})`);
}

const CHART_COLORS = [
    '#5B9FED',
    '#FF7EB3',
    '#5CD6A8',
    '#FFAB5C',
    '#9B7FEA',
    '#56C4E8',
];

const PASTEL_COLORS = [
    '#B799FF', // lavender
    '#ACBCFF', // soft blue
    '#AEE2FF', // sky aqua
    '#B9F3E4', // sage mint
    '#FEFF86', // pale yellow
    '#FFD4B2', // peach
    '#FFAACF', // dusty rose
    '#FFCCE1', // baby pink
    '#C4B5FD', // periwinkle
    '#A8E6CF', // mint green
    '#FFF5BA', // lemon cream
    '#FFB8A8', // soft coral
    '#E2C6FF', // lilac
    '#B8E0FF', // powder blue
    '#D4C5F9', // muted violet
    '#FFF0DB', // warm cream
];

const ALERTS = [];
const APPROVALS = [];
let flagsLoaded = false;
let budgetLoaded = false;
let budgetPayload = null;
let budgetStale = true;
let budgetSelectedDept = null;
let settingsLoaded = false;
let settingsBudgetData = null;
let approvalsLoaded = false;
let purchasesLoaded = false;
let purchasesData = null;
let purchasesFilters = {
    search: '',
    department: '',
    category: '',
    flagged: '',
    sort: 'date-desc',
    page: 1,
    pageSize: 50,
};

function createBrimChartCard(url) {
    const card = document.createElement('div');
    card.className = 'brim-chart-card';
    card.innerHTML = `<img src="${escapeHtml(url)}" alt="Generated chart">`;
    return card;
}

function renderDepartmentList(departments, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = (departments || []).map((d) => `
        <div class="guardian-item">
            <strong>${escapeHtml(d.department)}</strong>
            <div>${escapeHtml(d.total_spent_fmt)} · ${d.transaction_count} txns · ${d.flagged_transactions} flagged</div>
            <div class="guardian-item-meta">Avg score ${Number(d.average_score).toFixed(1)}</div>
        </div>`).join('');
}

let flagsSeverityFilter = 'all';
let flagsSearchQuery = '';

function renderFlaggedTransactions(items, containerId = 'alerts-list') {
    const el = document.getElementById(containerId);
    if (!el) return;

    let filtered = items || [];
    if (flagsSeverityFilter !== 'all') {
        filtered = filtered.filter((f) => String(f.risk) === flagsSeverityFilter);
    }
    if (flagsSearchQuery) {
        const q = flagsSearchQuery.toLowerCase();
        filtered = filtered.filter((f) =>
            [f.employee, f.vendor, f.reason, f.department, f.flag_type, f.amount, f.location]
                .some((v) => String(v || '').toLowerCase().includes(q))
        );
    }

    if (!filtered.length) {
        el.innerHTML = `<div class="guardian-item">${items?.length ? 'Nothing matches that filter.' : 'No bad purchases found.'}</div>`;
        return;
    }

    el.innerHTML = `
        <table class="data-table tx-table">
            <thead>
                <tr>
                    <th>Risk</th>
                    <th>Employee</th>
                    <th>Vendor</th>
                    <th>Amt</th>
                    <th>Date</th>
                    <th>Reason</th>
                </tr>
            </thead>
            <tbody>
                ${filtered.map((f) => `
                    <tr class="tx-row--flagged">
                        <td><span class="guardian-item-meta guardian-risk--${String(f.risk).toLowerCase()}">${escapeHtml(f.risk || 'Low')}</span></td>
                        <td>
                            <strong>${escapeHtml(f.employee)}</strong>
                            <br><small>${escapeHtml(f.department || '')}</small>
                        </td>
                        <td>${escapeHtml(f.vendor)}</td>
                        <td><strong>${escapeHtml(f.amount)}</strong></td>
                        <td>${escapeHtml(f.date)}</td>
                        <td><small>${escapeHtml(f.reason)}${f.flag_type ? ` · ${escapeHtml(f.flag_type.replace(/_/g, ' '))}` : ''}</small></td>
                    </tr>`).join('')}
            </tbody>
        </table>`;
}

function renderOffenders(items) {
    const el = document.getElementById('offenders-list');
    if (!el) return;
    if (!items.length) {
        el.innerHTML = '<div class="guardian-item">No one on the problem list.</div>';
        return;
    }
    el.innerHTML = items.map((o, i) => `
        <div class="guardian-item">
            <strong>#${i + 1} ${escapeHtml(o.employee)} · ${escapeHtml(o.department)}</strong>
            <div>${o.violations} violation(s) · ${o.severe} high/severe${o.split_purchases ? ` · ${o.split_purchases} split` : ''}</div>
            <div class="guardian-item-meta">Score ${Number(o.credit_score).toFixed(1)} · CA$${Number(o.total_amount).toLocaleString(undefined, { maximumFractionDigits: 0 })} flagged</div>
        </div>`).join('');
}

function setupFlagsToolbar() {
    document.querySelectorAll('.flags-filter').forEach((btn) => {
        btn.addEventListener('click', () => {
            flagsSeverityFilter = btn.dataset.severity || 'all';
            document.querySelectorAll('.flags-filter').forEach((b) => {
                b.classList.toggle('flags-filter--active', b === btn);
            });
            renderFlaggedTransactions(ALERTS);
        });
    });
    document.getElementById('flags-search')?.addEventListener('input', (e) => {
        flagsSearchQuery = e.target.value.trim();
        renderFlaggedTransactions(ALERTS);
    });
}

function scrollToSection(sectionId) {
    const el = document.getElementById(sectionId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('.section-subnav-btn').forEach((btn) => {
        btn.classList.toggle('section-subnav-btn--active', btn.dataset.scroll === sectionId);
    });
}

function setupSectionSubnav() {
    document.querySelectorAll('.section-subnav-btn[data-scroll]').forEach((btn) => {
        btn.addEventListener('click', () => scrollToSection(btn.dataset.scroll));
    });
    setupFlagsToolbar();
}

let policyEditorState = null;

function policyFieldHtml(field, value) {
    const id = `policy-field-${field.key}`;
    const help = field.help ? `<small class="policy-field-help">${escapeHtml(field.help)}</small>` : '';
    if (field.type === 'boolean') {
        return `<label class="policy-field policy-field--check">
            <input type="checkbox" id="${id}" name="${field.key}" ${value ? 'checked' : ''}>
            <span>${escapeHtml(field.label)}</span>${help}
        </label>`;
    }
    if (field.type === 'keywords' || field.type === 'numbers') {
        const text = Array.isArray(value) ? value.join(', ') : '';
        return `<label class="policy-field policy-field--full">
            <span>${escapeHtml(field.label)}</span>${help}
            <textarea id="${id}" name="${field.key}" rows="3" placeholder="Comma or newline separated">${escapeHtml(text)}</textarea>
        </label>`;
    }
    const unit = field.unit ? `<span class="policy-field-unit">${escapeHtml(field.unit)}</span>` : '';
    return `<label class="policy-field">
        <span>${escapeHtml(field.label)}</span>${help}
        <div class="policy-field-input">${unit}<input type="number" step="any" id="${id}" name="${field.key}" value="${escapeHtml(value ?? '')}"></div>
    </label>`;
}

function renderPolicyEditorPanels(data) {
    policyEditorState = JSON.parse(JSON.stringify(data));
    const rules = policyEditorState.rules || {};
    const schema = data.schema || [];
    const bySection = {
        thresholds: schema.filter((f) => f.section === 'thresholds' || f.section === 'general' || f.section === 'fraud'),
        meals: schema.filter((f) => f.section === 'meals' || f.section === 'travel'),
        keywords: schema.filter((f) => f.section === 'keywords'),
    };
    Object.entries(bySection).forEach(([section, fields]) => {
        const panel = document.querySelector(`[data-policy-panel="${section}"]`);
        if (!panel) return;
        panel.innerHTML = `<div class="policy-field-grid">${fields.map((f) => policyFieldHtml(f, rules[f.key])).join('')}</div>`;
    });
    renderDeptOverridesEditor(rules, data.departments || [], data.dept_override_fields || []);
    renderRoleOverridesEditor(rules);
    const docEl = document.getElementById('policy-document-input');
    if (docEl) docEl.value = data.document || '';
}

function renderDeptOverridesEditor(rules, departments, fields) {
    const panel = document.querySelector('[data-policy-panel="departments"]');
    if (!panel) return;
    const overrides = rules.department_overrides || {};
    const rows = Object.entries(overrides).map(([dept, vals]) => deptOverrideRowHtml(dept, vals, fields)).join('');
    const options = departments.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    panel.innerHTML = `
        <p class="panel-subtitle">Set custom limits per department. Blank fields inherit company defaults.</p>
        <div class="policy-override-toolbar">
            <select id="policy-add-dept-select"><option value="">Add department?</option>${options}</select>
            <button type="button" class="btn-sm" id="policy-add-dept-btn">Add override</button>
        </div>
        <div id="policy-dept-overrides">${rows || '<div class="guardian-item">No department overrides yet.</div>'}</div>`;
    panel.querySelector('#policy-add-dept-btn')?.addEventListener('click', () => {
        const select = panel.querySelector('#policy-add-dept-select');
        const dept = select?.value;
        if (!dept) return;
        const container = panel.querySelector('#policy-dept-overrides');
        if (container.querySelector(`[data-dept="${CSS.escape(dept)}"]`)) return;
        if (container.querySelector('.guardian-item')) container.innerHTML = '';
        container.insertAdjacentHTML('beforeend', deptOverrideRowHtml(dept, {}, fields));
        bindDeptOverrideRows(panel);
    });
    bindDeptOverrideRows(panel);
}

function deptOverrideRowHtml(dept, vals, fields) {
    const fieldInputs = fields.map((f) => {
        const val = vals[f.key];
        if (f.type === 'boolean') {
            return `<label class="policy-override-field"><span>${escapeHtml(f.label)}</span>
                <input type="checkbox" data-override-key="${f.key}" ${val ? 'checked' : ''}></label>`;
        }
        return `<label class="policy-override-field"><span>${escapeHtml(f.label)}</span>
            <input type="number" step="any" data-override-key="${f.key}" value="${val != null ? escapeHtml(val) : ''}" placeholder="Default"></label>`;
    }).join('');
    return `<div class="policy-override-row" data-dept="${escapeHtml(dept)}">
        <div class="policy-override-head"><strong>${escapeHtml(dept)}</strong>
            <button type="button" class="btn-sm btn-deny policy-remove-override">Remove</button></div>
        <div class="policy-override-fields">${fieldInputs}</div>
    </div>`;
}

function bindDeptOverrideRows(panel) {
    panel.querySelectorAll('.policy-remove-override').forEach((btn) => {
        btn.onclick = () => btn.closest('.policy-override-row')?.remove();
    });
}

function renderRoleOverridesEditor(rules) {
    const panel = document.querySelector('[data-policy-panel="roles"]');
    if (!panel) return;
    const overrides = rules.role_overrides || {};
    const rows = Object.entries(overrides).map(([role, vals]) => roleOverrideRowHtml(role, vals)).join('');
    panel.innerHTML = `
        <p class="panel-subtitle">Optional per-role approval thresholds (e.g. Director, Manager).</p>
        <div class="policy-override-toolbar">
            <input type="text" id="policy-add-role-input" placeholder="Role name">
            <button type="button" class="btn-sm" id="policy-add-role-btn">Add role</button>
        </div>
        <div id="policy-role-overrides">${rows || '<div class="guardian-item">No role overrides yet.</div>'}</div>`;
    panel.querySelector('#policy-add-role-btn')?.addEventListener('click', () => {
        const input = panel.querySelector('#policy-add-role-input');
        const role = input?.value?.trim();
        if (!role) return;
        const container = panel.querySelector('#policy-role-overrides');
        if (container.querySelector(`[data-role="${CSS.escape(role)}"]`)) return;
        if (container.querySelector('.guardian-item')) container.innerHTML = '';
        container.insertAdjacentHTML('beforeend', roleOverrideRowHtml(role, {}));
        input.value = '';
        bindRoleOverrideRows(panel);
    });
    bindRoleOverrideRows(panel);
}

function roleOverrideRowHtml(role, vals) {
    return `<div class="policy-override-row" data-role="${escapeHtml(role)}">
        <div class="policy-override-head"><strong>${escapeHtml(role)}</strong>
            <button type="button" class="btn-sm btn-deny policy-remove-override">Remove</button></div>
        <div class="policy-override-fields">
            <label class="policy-override-field"><span>Approval threshold</span>
                <input type="number" step="any" data-override-key="manager_approval_threshold" value="${vals.manager_approval_threshold ?? ''}" placeholder="Default"></label>
            <label class="policy-override-field"><span>Pre-auth threshold</span>
                <input type="number" step="any" data-override-key="pre_auth_threshold" value="${vals.pre_auth_threshold ?? ''}" placeholder="Default"></label>
        </div>
    </div>`;
}

function bindRoleOverrideRows(panel) {
    panel.querySelectorAll('.policy-remove-override').forEach((btn) => {
        btn.onclick = () => btn.closest('.policy-override-row')?.remove();
    });
}

function collectPolicyFormRules() {
    const schema = policyEditorState?.schema || [];
    const rules = { ...(policyEditorState?.rules || {}) };
    schema.forEach((field) => {
        const el = document.querySelector(`[name="${field.key}"]`);
        if (!el) return;
        if (field.type === 'boolean') rules[field.key] = el.checked;
        else if (field.type === 'keywords' || field.type === 'numbers') {
            rules[field.key] = el.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
        } else rules[field.key] = el.value === '' ? rules[field.key] : Number(el.value);
    });

    rules.department_overrides = {};
    document.querySelectorAll('#policy-dept-overrides .policy-override-row').forEach((row) => {
        const dept = row.dataset.dept;
        if (!dept) return;
        const entry = {};
        row.querySelectorAll('[data-override-key]').forEach((input) => {
            const key = input.dataset.overrideKey;
            if (input.type === 'checkbox') {
                if (input.checked) entry[key] = true;
            } else if (input.value !== '') {
                entry[key] = Number(input.value);
            }
        });
        if (Object.keys(entry).length) rules.department_overrides[dept] = entry;
    });

    rules.role_overrides = {};
    document.querySelectorAll('#policy-role-overrides .policy-override-row').forEach((row) => {
        const role = row.dataset.role;
        if (!role) return;
        const entry = {};
        row.querySelectorAll('[data-override-key]').forEach((input) => {
            if (input.value !== '') entry[input.dataset.overrideKey] = Number(input.value);
        });
        if (Object.keys(entry).length) rules.role_overrides[role] = entry;
    });

    return rules;
}

function switchSettingsTab(tab) {
    document.querySelectorAll('#settings-subnav .section-subnav-btn[data-settings-tab]').forEach((btn) => {
        btn.classList.toggle('section-subnav-btn--active', btn.dataset.settingsTab === tab);
    });
    document.querySelectorAll('.settings-panel').forEach((panel) => {
        panel.classList.toggle('settings-panel--active', panel.id === `settings-panel-${tab}`);
    });
}

function renderBudgetSettingsEditor(data) {
    settingsBudgetData = data;
    const listEl = document.getElementById('settings-budget-list');
    const quarterEl = document.getElementById('settings-budget-quarter');
    if (quarterEl && data?.quarter) {
        quarterEl.textContent = `${data.quarter} ? set how much each department can spend (suggested amounts shown as hints)`;
    }
    if (!listEl) return;
    const rows = data?.departments || [];
    if (!rows.length) {
        listEl.innerHTML = '<div class="guardian-item">No departments found.</div>';
        return;
    }
    listEl.innerHTML = rows.map((d) => `
        <div class="settings-budget-row" data-dept="${escapeHtml(d.department)}">
            <div class="settings-budget-row-head">
                <strong>${escapeHtml(d.department)}</strong>
                <span class="settings-budget-spent">Spent ${escapeHtml(d.spent_fmt)} so far</span>
            </div>
            <label class="settings-budget-field">
                <span>Quarter budget (CAD)</span>
                <input type="number" step="any" min="0" class="settings-budget-input"
                    data-dept-input="${escapeHtml(d.department)}"
                    value="${Number(d.budget)}"
                    placeholder="${Number(d.auto_budget)}">
                <small>Suggested: ${escapeHtml(d.auto_budget_fmt)}${d.budget_source_quarter && d.budget_source_quarter !== data.quarter ? ` ? Using saved ${escapeHtml(d.budget_source_quarter)} cap` : ''}</small>
            </label>
        </div>`).join('');
}

function collectBudgetSettingsForm() {
    const budgets = {};
    document.querySelectorAll('.settings-budget-input').forEach((input) => {
        const dept = input.dataset.deptInput;
        if (!dept || input.value === '') return;
        budgets[dept] = Number(input.value);
    });
    return budgets;
}

async function saveBudgetSettings() {
    const status = document.getElementById('budget-save-status');
    const btn = document.getElementById('budget-save-btn');
    if (!settingsBudgetData?.quarter) return;
    if (status) status.textContent = 'Saving?';
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/settings/budgets', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quarter: settingsBudgetData.quarter,
                budgets: collectBudgetSettingsForm(),
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Save failed');
        renderBudgetSettingsEditor(data);
        budgetLoaded = false;
        budgetPayload = null;
        budgetStale = true;
        if (status) status.textContent = 'Saved ? open Budgets to see updates';
        refreshNavBadges();
        if (currentViewKey === 'budget') {
            await loadBudget(true);
            if (status) status.textContent = 'Saved';
        }
    } catch (err) {
        if (status) status.textContent = err.message;
    } finally {
        if (btn) btn.disabled = false;
    }
}

function resetBudgetSettingsForm() {
    document.querySelectorAll('.settings-budget-input').forEach((input) => {
        const dept = input.dataset.deptInput;
        const row = settingsBudgetData?.departments?.find((d) => d.department === dept);
        if (row) input.value = String(row.auto_budget);
    });
    const status = document.getElementById('budget-save-status');
    if (status) status.textContent = 'Reset ? suggested ? click Save budgets to apply';
}

async function loadSettings(force = false, tab = 'budgets') {
    if (settingsLoaded && !force) {
        switchSettingsTab(tab);
        return;
    }
    switchSettingsTab(tab);
    const listEl = document.getElementById('settings-budget-list');
    if (listEl) listEl.innerHTML = '<div class="guardian-item">Loading?</div>';
    try {
        const [budgetRes, policyRes] = await Promise.all([
            fetch('/api/settings/budgets'),
            fetch('/api/policy/rules'),
        ]);
        const budgetData = await budgetRes.json();
        const policyData = await policyRes.json();
        if (!budgetRes.ok) throw new Error(budgetData.error || 'Failed to load budgets');
        if (!policyRes.ok) throw new Error(policyData.error || 'Failed to load rules');
        renderBudgetSettingsEditor(budgetData);
        renderPolicyEditorPanels(policyData);
        settingsLoaded = true;
    } catch (err) {
        if (listEl) listEl.innerHTML = `<div class="guardian-item">${escapeHtml(err.message)}</div>`;
    }
}

async function openPolicyEditor() {
    navigateTo('settings', { tab: 'rules' });
}

function closePolicyEditor() {
    /* editing is on the Settings page */
}

function switchPolicyEditorTab(tab) {
    document.querySelectorAll('.policy-editor-tab').forEach((btn) => {
        btn.classList.toggle('policy-editor-tab--active', btn.dataset.policyTab === tab);
    });
    document.querySelectorAll('.policy-editor-panel').forEach((panel) => {
        panel.classList.toggle('policy-editor-panel--active', panel.dataset.policyPanel === tab);
    });
}

async function savePolicyEditor() {
    const status = document.getElementById('policy-save-status');
    const btn = document.getElementById('policy-save-btn');
    if (status) status.textContent = 'Saving?';
    if (btn) btn.disabled = true;
    try {
        const rules = collectPolicyFormRules();
        const policyDoc = document.getElementById('policy-document-input')?.value ?? '';
        const res = await fetch('/api/policy/rules', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rules, document: policyDoc }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Save failed');
        if (status) status.textContent = 'Saved ? updating scans?';
        flagsLoaded = false;
        budgetLoaded = false;
        budgetPayload = null;
        budgetStale = true;
        await loadPolicyPanel();
        await loadFlags(true);
        refreshNavBadges();
        if (status) status.textContent = 'Saved';
    } catch (err) {
        if (status) status.textContent = err.message;
    } finally {
        if (btn) btn.disabled = false;
    }
}

function setupSettingsPage() {
    document.querySelectorAll('[data-settings-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (btn.dataset.insight === 'settings') {
                navigateTo('settings', { tab: btn.dataset.settingsTab || 'budgets' });
                return;
            }
            switchSettingsTab(btn.dataset.settingsTab);
        });
    });
    document.getElementById('budget-save-btn')?.addEventListener('click', saveBudgetSettings);
    document.getElementById('budget-reset-btn')?.addEventListener('click', resetBudgetSettingsForm);
    document.getElementById('policy-save-btn')?.addEventListener('click', savePolicyEditor);
    document.querySelectorAll('.policy-editor-tab').forEach((tab) => {
        tab.addEventListener('click', () => switchPolicyEditorTab(tab.dataset.policyTab));
    });
}

function setupPolicyEditor() {
    setupSettingsPage();
}

async function loadPolicyPanel() {
    try {
        const res = await fetch('/api/policy/offenders');
        const offenders = await res.json();
        if (!res.ok) throw new Error(offenders.error || 'Failed to load offenders');
        renderOffenders(offenders);
    } catch (err) {
        console.error(err);
    }
}

function renderOverviewStats(totals, containerId = 'dashboard-stats', personal = false) {
    const el = document.getElementById(containerId);
    if (!el || !totals) return;
    const items = personal
        ? [
            { label: 'My purchases', value: totals.transactions, nav: 'activity' },
            { label: 'Flagged', value: totals.flags ?? totals.flagged ?? 0, nav: 'activity' },
            { label: 'Total spend', value: moneyTick(totals.spend), nav: 'activity', static: true },
        ]
        : [
            { label: 'Purchases', value: totals.transactions, nav: 'activity' },
            { label: 'Problems', value: totals.flagged ?? totals.flags, nav: 'alerts' },
            { label: 'People', value: totals.employees, nav: 'people' },
            { label: 'Departments', value: totals.departments, nav: 'budget' },
        ];
    el.innerHTML = items.map((item) => `
        <button type="button" class="guardian-stat guardian-stat--link" data-insight="${item.nav}" title="Go to ${escapeHtml(item.label)}">
            <span>${escapeHtml(item.label)}</span>
            <strong>${item.static ? item.value : Number(item.value).toLocaleString()}</strong>
        </button>`).join('');
    el.querySelectorAll('[data-insight]').forEach((btn) => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.insight));
    });
}

function formatCreditScore(score) {
    if (score == null || Number.isNaN(Number(score))) return '?';
    const n = Number(score);
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function scoreClass(score) {
    if (score >= 80) return 'credit-score--good';
    if (score >= 60) return 'credit-score--mid';
    return 'credit-score--bad';
}

function scoreBarColor(score) {
    if (score >= 80) return '#34C759';
    if (score >= 60) return '#FF9500';
    return '#FF3B30';
}

function normalizeQuery(text) {
    return text.toLowerCase().replace(/[?.!,'"]/g, '').trim();
}

function formatCad(amount) {
    const n = Number(amount) || 0;
    return 'CA$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function moneyTick(v) {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 1000) return 'CA$' + (n / 1000).toFixed(1) + 'k';
    return 'CA$' + n.toLocaleString('en-CA', { maximumFractionDigits: 0 });
}

function projectOptionLabel(p) {
    return `${p.title} · ${p.spent_fmt || formatCad(0)} spent of ${p.requested_amount_fmt} budget`;
}

function buildChartConfig(chart) {
    const type = chart.type || 'bar';
    const isDoughnut = type === 'doughnut';
    const colors = chart.colors || (isDoughnut ? PASTEL_COLORS : CHART_COLORS);
    const sliceColors = isDoughnut
        ? (chart.labels || chart.values).map((_, i) => colors[i % colors.length])
        : (chart.colors || colors[0]);
    const dataset = {
        data: chart.values,
        borderRadius: type === 'bar' ? 10 : 0,
        tension: 0.35,
        fill: type === 'line',
        backgroundColor: sliceColors,
        borderColor: isDoughnut ? '#ffffff' : (type === 'line' ? colors[0] : undefined),
        borderWidth: isDoughnut ? 2 : undefined,
        hoverBorderColor: isDoughnut ? '#ffffff' : undefined,
        hoverBorderWidth: isDoughnut ? 2 : undefined,
    };

    return {
        type,
        data: { labels: chart.labels, datasets: [dataset] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: type === 'doughnut' },
            },
            scales: type === 'doughnut' ? {} : {
                y: {
                    ticks: { callback: moneyTick },
                },
            },
        },
    };
}

function renderChart(canvasId, chartData) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !chartData || typeof Chart === 'undefined') return;
    if (!chartData.labels?.length || !chartData.values?.length) return;
    if (dashboardCharts[canvasId]) {
        dashboardCharts[canvasId].destroy();
    }
    dashboardCharts[canvasId] = new Chart(canvas, buildChartConfig(chartData));
}

function renderChartSafe(canvasId, chartData, store = dashboardCharts) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !chartData || typeof Chart === 'undefined') return;
    if (!chartData.labels?.length || !chartData.values?.length) return;
    if (store[canvasId]) store[canvasId].destroy();
    store[canvasId] = new Chart(canvas, buildChartConfig(chartData));
}

function createInsightCard(insight) {
    const card = document.createElement('div');
    card.className = 'insight-card';

    const title = document.createElement('h4');
    title.textContent = insight.title || 'Spending Insight';
    card.appendChild(title);

    if (insight.summary) {
        const summary = document.createElement('div');
        summary.className = 'insight-summary';
        summary.innerHTML = insight.summary.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        card.appendChild(summary);
    }

    if (insight.chart) {
        const wrap = document.createElement('div');
        wrap.className = 'chart-wrap';
        const canvas = document.createElement('canvas');
        wrap.appendChild(canvas);
        card.appendChild(wrap);
        const render = () => {
            if (typeof Chart === 'undefined') return;
            try {
                new Chart(canvas, buildChartConfig(insight.chart));
            } catch (err) {
                console.error('Chat chart render failed:', err);
            }
        };
        requestAnimationFrame(() => {
            render();
            if (!wrap.clientHeight) setTimeout(render, 120);
        });
    }

    if (insight.table) {
        const table = document.createElement('table');
        table.className = 'data-table';
        const headers = Object.keys(insight.table[0] || {});
        table.innerHTML = `
            <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>${insight.table.map((r) => `
                <tr>${headers.map((h) => `<td>${r[h]}</td>`).join('')}</tr>
            `).join('')}</tbody>`;
        card.appendChild(table);
    }

    return card;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function createUserMessage(text, attachment) {
    const userMsg = document.createElement('div');
    userMsg.className = 'messages messages--user';

    if (text) {
        const textNode = document.createElement('div');
        textNode.textContent = text;
        userMsg.appendChild(textNode);
    }

    if (attachment) {
        const attachEl = document.createElement('div');
        attachEl.className = 'msg-attachment';
        if (attachment.isPdf) {
            attachEl.innerHTML = `
                <div class="msg-attachment-file">
                    <i class="fa-solid fa-file-pdf"></i>
                    <span>${attachment.name}</span>
                </div>`;
        } else {
            attachEl.innerHTML = `<img src="${attachment.previewUrl}" alt="Receipt attachment">`;
        }
        userMsg.appendChild(attachEl);
    }

    return userMsg;
}

let approvedProjectsCache = null;

async function loadApprovedProjects(force = false) {
    if (approvedProjectsCache && !force) return approvedProjectsCache;
    try {
        const res = await fetch('/api/proposals/approved');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load projects');
        approvedProjectsCache = data;
    } catch {
        approvedProjectsCache = [];
    }
    return approvedProjectsCache;
}

function fillProjectSelect(select, projects, emptyEl) {
    if (!select) return;
    if (!projects.length) {
        select.innerHTML = '<option value="">No approved projects</option>';
        select.disabled = true;
        emptyEl?.removeAttribute('hidden');
        return;
    }
    emptyEl?.setAttribute('hidden', '');
    select.disabled = false;
    select.innerHTML = `<option value="">Select a project?</option>${projects.map((p) =>
        `<option value="${p.id}">${escapeHtml(projectOptionLabel(p))}</option>`
    ).join('')}`;
}

function updateReceiptProjectHint(select, hintEl, projects) {
    if (!hintEl) return;
    const id = select?.value;
    if (!id) {
        hintEl.textContent = '';
        return;
    }
    const project = projects.find((p) => String(p.id) === String(id));
    if (!project) {
        hintEl.textContent = '';
        return;
    }
    hintEl.textContent = `${project.spent_fmt} spent on this project · ${project.remaining_fmt} left of ${project.requested_amount_fmt} budget`;
}

function syncReceiptsFormPurpose() {
    const form = document.getElementById('receipts-form');
    if (!form) return;
    const purpose = form.querySelector('input[name="spending_purpose"]:checked')?.value;
    const wrap = document.getElementById('receipts-project-wrap');
    const select = document.getElementById('receipts-project-select');
    const emptyEl = document.getElementById('receipts-project-empty');
    const saveBtn = form.querySelector('button[type="submit"]');
    const isProject = purpose === 'project';
    if (wrap) wrap.hidden = !isProject;
    if (select) select.required = isProject && !select.disabled;
    if (emptyEl && !isProject) emptyEl.hidden = true;
    if (saveBtn) saveBtn.disabled = isProject && !!select?.disabled;
}

async function refreshReceiptsProjectSelect() {
    const projects = await loadApprovedProjects(true);
    const select = document.getElementById('receipts-project-select');
    const hint = document.getElementById('receipts-project-spend-hint');
    fillProjectSelect(
        select,
        projects,
        document.getElementById('receipts-project-empty')
    );
    updateReceiptProjectHint(select, hint, projects);
    syncReceiptsFormPurpose();
}

async function createReceiptCard(data) {
    const projects = await loadApprovedProjects();
    const card = document.createElement('div');
    card.className = 'receipt-card';
    const violations = (data.violations || []).map((v) =>
        `<div class="receipt-violation receipt-violation--${escapeHtml(v.severity || 'low')}">${escapeHtml(v.description || v.type)}</div>`
    ).join('');
    const matchClass = data.matched_transaction_id ? 'receipt-match--ok' : 'receipt-match--info';
    const matchText = data.matched_transaction_id
        ? 'Matched to card transaction'
        : 'No card transaction matched ? you can still save this receipt';
    const projectOptions = projects.length
        ? `<option value="">Select a project?</option>${projects.map((p) =>
            `<option value="${p.id}">${escapeHtml(projectOptionLabel(p))}</option>`
        ).join('')}`
        : '<option value="">No approved projects</option>';
    const projectEmpty = projects.length
        ? ''
        : '<p class="receipts-project-empty">No approved projects yet. Submit one in <strong>My projects</strong> first.</p>';

    card.innerHTML = `
        <div class="receipt-card-header">
            <i class="fa-solid fa-receipt"></i>
            <strong>Receipt scanned</strong>
        </div>
        <div class="receipt-match ${matchClass}">${escapeHtml(matchText)}</div>
        ${violations}
        <div class="receipt-card-body">
            ${(data.fields || []).map((f) => `
                <div class="receipt-field">
                    <span>${escapeHtml(f.label)}</span>
                    <span>${escapeHtml(f.value)}</span>
                </div>
            `).join('')}
        </div>
        <fieldset class="receipt-card-purpose proposal-budget-question">
            <legend>Personal or project use?</legend>
            <label class="proposal-radio">
                <input type="radio" name="chat-spending-purpose" value="project" checked>
                <span>Project use</span>
                <small>Link to one of your approved projects.</small>
            </label>
            <label class="proposal-radio">
                <input type="radio" name="chat-spending-purpose" value="personal">
                <span>Personal use</span>
                <small>Personal purchase on a company card.</small>
            </label>
        </fieldset>
        <div class="receipt-card-project-wrap receipts-project-wrap">
            <label class="receipts-field receipts-field--wide">
                <span>Which approved project?</span>
                <select name="chat-project-id" ${projects.length ? '' : 'disabled'}>${projectOptions}</select>
            </label>
            <p class="receipts-project-spend-hint chat-project-spend-hint"></p>
            ${projectEmpty}
        </div>
        <div class="receipt-card-actions">
            <button type="button" class="btn-sm btn-approve receipt-card-save">Save receipt</button>
            <span class="receipt-card-save-status"></span>
        </div>
        <div class="receipt-card-footer">${escapeHtml(data.footer || '')}</div>
    `;

    const syncCardPurpose = () => {
        const purpose = card.querySelector('input[name="chat-spending-purpose"]:checked')?.value;
        const projectWrap = card.querySelector('.receipt-card-project-wrap');
        const select = card.querySelector('select[name="chat-project-id"]');
        const btn = card.querySelector('.receipt-card-save');
        const isProject = purpose === 'project';
        if (projectWrap) projectWrap.hidden = !isProject;
        if (select) select.required = isProject && !select.disabled;
        if (btn) btn.disabled = isProject && select?.disabled;
    };

    card.querySelectorAll('input[name="chat-spending-purpose"]').forEach((radio) => {
        radio.addEventListener('change', syncCardPurpose);
    });
    const chatSelect = card.querySelector('select[name="chat-project-id"]');
    const chatHint = card.querySelector('.chat-project-spend-hint');
    chatSelect?.addEventListener('change', () => updateReceiptProjectHint(chatSelect, chatHint, projects));
    updateReceiptProjectHint(chatSelect, chatHint, projects);
    syncCardPurpose();

    card.querySelector('.receipt-card-save')?.addEventListener('click', async () => {
        const statusEl = card.querySelector('.receipt-card-save-status');
        const btn = card.querySelector('.receipt-card-save');
        const purpose = card.querySelector('input[name="chat-spending-purpose"]:checked')?.value;
        const projectId = card.querySelector('select[name="chat-project-id"]')?.value;
        const ext = data.extracted_data || {};
        const payload = {
            merchant: ext.merchant_name,
            transaction_description: ext.transaction_description,
            date: ext.date ? String(ext.date).slice(0, 10) : '',
            amount: Number(ext.amount) || 0,
            category: ext.expense_category,
            tax: ext.tax,
            tip: ext.tip,
            merchant_city: ext.merchant_city,
            merchant_state: ext.merchant_state,
            matched_transaction_id: data.matched_transaction_id,
            spending_purpose: purpose,
            project_id: purpose === 'project' ? projectId : null,
        };
        if (btn) btn.disabled = true;
        if (statusEl) statusEl.textContent = 'Saving?';
        try {
            const res = await fetch('/api/receipts/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error || 'Save failed');
            if (statusEl) statusEl.textContent = 'Saved';
            approvedProjectsCache = null;
            loadPurchases(true);
            if (btn) btn.hidden = true;
            card.querySelector('.receipt-card-purpose')?.remove();
            card.querySelector('.receipt-card-project-wrap')?.remove();
        } catch (err) {
            if (statusEl) statusEl.textContent = err.message || 'Save failed';
            syncCardPurpose();
        }
    });

    return card;
}

function showTyping() {
    const typingBubble = document.createElement('div');
    typingBubble.className = 'messages messages--bot typing-indicator';
    typingBubble.innerHTML = '<span></span><span></span><span></span>';
    chat.appendChild(typingBubble);
    chat.scrollTop = chat.scrollHeight;
    return typingBubble;
}

function setAttachment(file) {
    if (!file) return;
    const isPdf = file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/');
    if (!isPdf && !isImage) return;

    if (pendingAttachment?.previewUrl) {
        URL.revokeObjectURL(pendingAttachment.previewUrl);
    }

    pendingAttachment = {
        file,
        name: file.name,
        isPdf,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
    };
    renderAttachmentPreview();
}

function clearAttachment(revokePreview = true) {
    if (revokePreview && pendingAttachment?.previewUrl) {
        URL.revokeObjectURL(pendingAttachment.previewUrl);
    }
    pendingAttachment = null;
    const preview = document.getElementById('attachment-preview');
    const fileInput = document.getElementById('receipt-input');
    if (preview) preview.hidden = true;
    if (fileInput) fileInput.value = '';
}

function renderAttachmentPreview() {
    const preview = document.getElementById('attachment-preview');
    const chip = document.getElementById('attachment-chip');
    if (!preview || !chip || !pendingAttachment) return;

    if (pendingAttachment.isPdf) {
        chip.innerHTML = `
            <div class="attachment-file-icon"><i class="fa-solid fa-file-pdf"></i></div>
            <div class="attachment-chip-info">
                <strong>${pendingAttachment.name}</strong>
                <span>PDF · ${formatFileSize(pendingAttachment.file.size)}</span>
            </div>`;
    } else {
        chip.innerHTML = `
            <img src="${pendingAttachment.previewUrl}" alt="Receipt preview">
            <div class="attachment-chip-info">
                <strong>${pendingAttachment.name}</strong>
                <span>Image · ${formatFileSize(pendingAttachment.file.size)}</span>
            </div>`;
    }
    preview.hidden = false;
}

async function scanReceiptAttachment(caption) {
    const attachment = pendingAttachment;
    const message = caption || (attachment.isPdf ? 'Scan this receipt PDF' : 'Scan this receipt');

    await ensureAssistantConversation();
    chat.appendChild(createUserMessage(message, attachment));
    input.value = '';
    clearAttachment(false);

    const typingBubble = showTyping();

    try {
        const formData = new FormData();
        formData.append('file', attachment.file);
        formData.append('message', message);
        formData.append('conversation_id', currentConversationId);

        const res = await fetch('/scan_receipt', { method: 'POST', body: formData });
        const data = await res.json();

        if (chat.contains(typingBubble)) chat.removeChild(typingBubble);

        if (data.reply) {
            const botMsg = document.createElement('div');
            botMsg.className = 'messages messages--bot';
            botMsg.textContent = data.reply;
            chat.appendChild(botMsg);
        }

        if (data.receipt) {
            chat.appendChild(await createReceiptCard(data.receipt));
        }

        chat.scrollTop = chat.scrollHeight;
    } catch (e) {
        if (chat.contains(typingBubble)) chat.removeChild(typingBubble);
        console.error('Receipt scan error:', e);
    }
}

function appendAssistantBotPayload(data) {
    if (data.reply && data.reply.trim().length > 0) {
        const botMsg = document.createElement('div');
        botMsg.className = 'messages messages--bot';
        botMsg.textContent = data.reply;
        chat.appendChild(botMsg);
    }

    if ((data.chart_urls || []).length) {
        (data.chart_urls || []).forEach((url) => {
            chat.appendChild(createBrimChartCard(url));
        });
    } else if (data.insight) {
        chat.appendChild(createInsightCard(data.insight));
    }

    chat.scrollTop = chat.scrollHeight;
}

async function ensureAssistantConversation() {
    if (!currentConversationId) {
        await startNewChat();
    }
}

function queueChatPersist(text, voice = false) {
    ensureAssistantConversation()
        .then(() => fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: text,
                conversation_id: currentConversationId,
                voice,
                current_view: currentViewKey,
                verbosity: voice ? 'less' : 'medium',
            }),
        }))
        .catch(() => {});
}

async function deliverInstantAssistantReply(text, instant, { voice = false, speak = false, attachment = null, popup = false } = {}) {
    await ensureAssistantConversation();

    chat.appendChild(createUserMessage(text, attachment));
    appendAssistantBotPayload(instant);
    chat.scrollTop = chat.scrollHeight;

    if (popup) {
        showVoicePanelContent(text, instant.reply || '');
    }

    if (input && !voice) input.value = '';

    const speakP = speak ? speakVoiceReply(instant.reply) : Promise.resolve();
    executeVoiceActions(instant.actions || []);
    queueChatPersist(text, voice);
    if (speak) await speakP;
    return instant;
}

async function submitAssistantQuery(message, options = {}) {
    const { voice = false, speak = false, attachment = null, popup = false } = options;
    const text = (message || '').trim();
    if (!text && !attachment) return null;

    const instant = tryClientInstantVoiceReply(text);
    if (instant) {
        return deliverInstantAssistantReply(text, instant, { voice, speak, attachment, popup });
    }

    await ensureAssistantConversation();

    chat.appendChild(createUserMessage(text, attachment));
    chat.scrollTop = chat.scrollHeight;
    if (input && !voice) input.value = '';

    if (popup) {
        showVoicePanelContent(text, '');
    }

    const typingBubble = voice ? null : showTyping();

    try {
        const res = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: text,
                conversation_id: currentConversationId,
                voice,
                current_view: currentViewKey,
                verbosity: voice ? 'less' : 'medium',
            }),
        });
        const data = await res.json();

        if (typingBubble && chat.contains(typingBubble)) chat.removeChild(typingBubble);
        if (!res.ok) throw new Error(data.reply || data.error || 'Request failed');

        appendAssistantBotPayload(data);
        if (popup) {
            showVoicePanelContent(text, data.reply || '');
        }
        const speakP = speak ? speakVoiceReply(data.reply) : Promise.resolve();
        executeVoiceActions(data.actions || []);
        if (speak) await speakP;
        return data;
    } catch (err) {
        if (typingBubble && chat.contains(typingBubble)) chat.removeChild(typingBubble);
        console.error('Assistant error:', err);
        const errText = err.message || 'Something went wrong. Please try again.';
        if (popup) {
            showVoicePanelContent(text, errText);
        }
        const errMsg = document.createElement('div');
        errMsg.className = 'messages messages--bot';
        errMsg.textContent = errText;
        chat.appendChild(errMsg);
        chat.scrollTop = chat.scrollHeight;
        return null;
    }
}

async function sendMessage() {
    const message = input.value.trim();

    if (pendingAttachment) {
        await scanReceiptAttachment(message);
        return;
    }

    if (!message) return;
    await submitAssistantQuery(message);
}

btn.addEventListener('click', sendMessage);
input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

document.getElementById('suggested-prompts')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.prompt-chip');
    if (!chip) return;
    input.value = chip.dataset.prompt;
    sendMessage();
});

async function startNewChat() {
    try {
        const res = await fetch('/newchat', { method: 'POST' });
        const data = await res.json();
        if (data.id) {
            input.value = '';
            clearAttachment();
            await openConversation(data.id);
        }
    } catch (e) {
        console.error(e);
    }
}

async function openConversation(id) {
    const res = await fetch('/conversation/' + id + '/messages');
    const messages = await res.json();
    currentConversationId = Number(id);
    const chatEl = document.getElementById('chat');
    chatEl.innerHTML = '';
    if (!messages.length) {
        chatEl.innerHTML = `<div class="messages messages--bot chat-welcome">What would you like to know?</div>`;
    } else {
        for (const m of messages) {
            if (m.role === 'user') {
                const div = document.createElement('div');
                div.className = 'messages messages--user';
                div.textContent = m.text;
                chatEl.appendChild(div);
            } else if (m.text && m.text.trim().length !== 0) {
                const div = document.createElement('div');
                div.className = 'messages messages--bot';
                div.textContent = m.text;
                chatEl.appendChild(div);
            }
        }
    }
    chatEl.scrollTop = chatEl.scrollHeight;
}

function renderAlerts(items = ALERTS) {
    renderFlaggedTransactions(items);
}

async function loadFlags(force = false) {
    const el = document.getElementById('alerts-list');
    if (!el) return;
    if (flagsLoaded && !force) return;
    el.innerHTML = '<div class="guardian-item">Loading flagged transactions?</div>';
    try {
        await loadPolicyPanel();
        const res = await fetch('/api/flags');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load flags');
        ALERTS.length = 0;
        ALERTS.push(...data);
        flagsLoaded = true;
        renderFlaggedTransactions(ALERTS);
    } catch (err) {
        el.innerHTML = `<div class="guardian-item">${escapeHtml(err.message)}</div>`;
    }
}

let reviewItems = [];
let reviewFiltered = [];
let reviewCurrentIdx = -1;
let reviewLoaded = false;
let reviewFilter = 'all';
let reviewKeyHandler = null;

function reviewRiskClass(item) {
    if (item.kind === 'fraud') {
        const score = item.fraud_score || 0;
        if (score >= 0.6) return 'review-score--high';
        if (score >= 0.35) return 'review-score--med';
        return 'review-score--low';
    }
    const risk = String(item.risk_label || '').toLowerCase();
    if (risk === 'severe' || risk === 'high') return 'review-score--high';
    if (risk === 'medium') return 'review-score--med';
    return 'review-score--low';
}

function applyReviewFilter() {
    reviewFiltered = reviewFilter === 'all'
        ? reviewItems
        : reviewItems.filter((item) => item.kind === reviewFilter);
    if (!reviewFiltered.length) {
        reviewCurrentIdx = -1;
    } else if (reviewCurrentIdx >= reviewFiltered.length) {
        reviewCurrentIdx = Math.max(0, reviewFiltered.length - 1);
    }
}

function renderReviewStats(stats) {
    const el = document.getElementById('review-stats');
    if (!el || !stats) return;
    el.innerHTML = `
        <div class="review-stat"><span>Waiting</span><strong>${stats.total_pending}</strong></div>
        <div class="review-stat"><span>Requests</span><strong>${stats.approvals_pending}</strong></div>
        <div class="review-stat"><span>Proposals</span><strong>${stats.proposals_pending || 0}</strong></div>
        <div class="review-stat"><span>Fraud</span><strong class="review-stat--warn">${stats.fraud_pending}</strong></div>
        <div class="review-stat"><span>Fraud resolved</span><strong class="review-stat--ok">${stats.fraud_resolved || 0}</strong></div>`;
}

function reviewProblemPreview(item) {
    if (item.kind === 'fraud') {
        const reasons = (item.explanation || '').split(' | ').filter(Boolean);
        return reasons[0] || 'Suspicious activity detected';
    }
    if (item.kind === 'proposal') {
        const ctx = item.context || [];
        return ctx[0] || item.description?.slice(0, 80) || 'Budget request';
    }
    const ctx = item.context || [];
    if (ctx.length) return ctx[0];
    return item.brief || 'Policy review required';
}

function reviewProblemsHtml(item) {
    if (item.kind === 'fraud') {
        const reasons = (item.explanation || '').split(' | ').filter(Boolean);
        if (!reasons.length) {
            return '<p class="review-problems-none">No specific flags listed.</p>';
        }
        return `<ul class="review-problems-list">${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`;
    }
    const problems = item.context?.length
        ? item.context
        : (item.brief ? [item.brief] : ['No issues listed']);
    return `<ul class="review-problems-list">${problems.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`;
}

function renderReviewQueue() {
    const queue = document.getElementById('review-queue');
    if (!queue) return;
    applyReviewFilter();

    if (!reviewFiltered.length) {
        queue.innerHTML = '<div class="review-queue-empty guardian-item">Nothing waiting ? you\'re all caught up!</div>';
        return;
    }

    queue.innerHTML = reviewFiltered.map((item, i) => {
        const kindLabel = item.kind === 'fraud' ? 'Fraud' : (item.kind === 'proposal' ? 'Proposal' : 'Request');
        const preview = reviewProblemPreview(item);
        return `
        <button type="button" class="review-queue-item ${i === reviewCurrentIdx ? 'review-queue-item--active' : ''}" data-review-idx="${i}">
            <div class="review-queue-item-top">
                <span class="review-kind review-kind--${item.kind}">${kindLabel}</span>
                <span class="review-queue-score ${reviewRiskClass(item)}">${escapeHtml(item.risk_label)}</span>
            </div>
            <strong class="review-queue-title">${escapeHtml(item.title)}</strong>
            <span class="review-queue-amount">${escapeHtml(item.amount)}</span>
            <span class="review-queue-meta">${escapeHtml(item.employee)} · ${escapeHtml(item.department)}</span>
            <p class="review-queue-preview">${escapeHtml(preview)}</p>
        </button>`;
    }).join('');
}

function renderReviewDetail(idx) {
    const detail = document.getElementById('review-detail');
    if (!detail) return;
    const item = reviewFiltered[idx];
    if (!item) {
        detail.hidden = true;
        return;
    }

    detail.hidden = false;

    if (item.kind === 'approval') {
        detail.innerHTML = `
            <header class="review-detail-head">
                <div>
                    <span class="review-kind review-kind--approval">Expense request</span>
                    <h3 class="panel-title">${escapeHtml(item.title)}</h3>
                    <p class="panel-subtitle">${escapeHtml(item.employee)} · ${escapeHtml(item.department)} · ${escapeHtml(item.amount)}</p>
                </div>
            </header>
            <div class="review-problems-block">
                <h4 class="review-problems-title">Problems</h4>
                ${reviewProblemsHtml(item)}
            </div>
            <p class="approval-brief">${escapeHtml(item.brief)}</p>
            <footer class="review-actions">
                <button type="button" class="btn-sm btn-approve" data-review-action="approve">Approve</button>
                <button type="button" class="btn-sm btn-deny" data-review-action="deny">Deny</button>
            </footer>`;
    } else if (item.kind === 'proposal') {
        detail.innerHTML = `
            <header class="review-detail-head">
                <div>
                    <span class="review-kind review-kind--proposal">Project proposal</span>
                    <h3 class="panel-title">${escapeHtml(item.title)}</h3>
                    <p class="panel-subtitle">${escapeHtml(item.employee)} · ${escapeHtml(item.department)} · ${escapeHtml(item.amount)} · ${escapeHtml(item.budget_source_label || '')}</p>
                </div>
            </header>
            <div class="proposal-detail-desc">
                <h4 class="review-problems-title">Budget type</h4>
                <p>${escapeHtml(item.budget_source_label || '?')}</p>
            </div>
            <div class="proposal-detail-desc">
                <h4 class="review-problems-title">Project description</h4>
                <p>${escapeHtml(item.description || '?')}</p>
            </div>
            <div class="review-problems-block">
                <h4 class="review-problems-title">Budget context</h4>
                ${reviewProblemsHtml(item)}
            </div>
            <p class="approval-brief">${escapeHtml(item.brief)}</p>
            <footer class="review-actions">
                <button type="button" class="btn-sm btn-approve" data-review-action="approve">Approve</button>
                <button type="button" class="btn-sm btn-deny" data-review-action="deny">Deny</button>
            </footer>`;
    } else {
        detail.innerHTML = `
            <header class="review-detail-head">
                <div>
                    <span class="review-kind review-kind--fraud">Fraud flag</span>
                    <h3 class="panel-title">${escapeHtml(item.title)}</h3>
                    <p class="panel-subtitle">${escapeHtml(item.employee)} · ${escapeHtml(item.department)} · ${escapeHtml(item.amount)} · Score <strong class="${reviewRiskClass(item)}">${escapeHtml(item.risk_label)}</strong></p>
                </div>
            </header>
            <div class="review-problems-block">
                <h4 class="review-problems-title">Problems</h4>
                ${reviewProblemsHtml(item)}
            </div>
            <div class="fraud-fields">
                <div class="fraud-field"><label>Transaction</label><div>${escapeHtml(item.transaction_id)}</div></div>
                <div class="fraud-field"><label>Date</label><div>${escapeHtml(item.timestamp || '?')}</div></div>
                <div class="fraud-field"><label>Category</label><div>${escapeHtml(item.merchant_category || '?')}</div></div>
                <div class="fraud-field"><label>Channel</label><div>${escapeHtml(item.channel || '?')}</div></div>
                <div class="fraud-field"><label>Countries</label><div>${escapeHtml(item.cardholder_country || '?')} · ${escapeHtml(item.merchant_country || '?')}</div></div>
            </div>
            <footer class="review-actions">
                <button type="button" class="btn-sm btn-approve" data-review-action="approve">Approve</button>
                <button type="button" class="btn-sm btn-deny" data-review-action="dismiss">Deny</button>
                <button type="button" class="btn-sm btn-dark" data-review-action="escalate">Escalate</button>
            </footer>`;
    }

    detail.querySelectorAll('[data-review-action]').forEach((btn) => {
        btn.addEventListener('click', () => submitReviewAction(btn.dataset.reviewAction));
    });
}

function showReviewItem(idx) {
    applyReviewFilter();
    if (!reviewFiltered.length) {
        reviewCurrentIdx = -1;
        renderReviewQueue();
        renderReviewDetail(-1);
        return;
    }
    if (idx < 0) {
        reviewCurrentIdx = -1;
        renderReviewQueue();
        renderReviewDetail(-1);
        return;
    }
    reviewCurrentIdx = Math.max(0, Math.min(idx, reviewFiltered.length - 1));
    renderReviewQueue();
    renderReviewDetail(reviewCurrentIdx);
    document.getElementById('review-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadReview(force = false) {
    const queue = document.getElementById('review-queue');
    const detail = document.getElementById('review-detail');
    if (!queue) return;
    if (reviewLoaded && !force) return;

    queue.innerHTML = '<div class="review-queue-empty guardian-item">Building review queue?</div>';
    if (detail) detail.hidden = true;

    try {
        const [queueRes, statsRes] = await Promise.all([
            fetch('/api/review/queue'),
            fetch('/api/review/stats'),
        ]);
        const items = await queueRes.json();
        const stats = await statsRes.json();
        if (!queueRes.ok) throw new Error(items.error || 'Failed to load review queue');

        reviewItems = items;
        reviewLoaded = true;
        renderReviewStats(stats);

        const slider = document.getElementById('fraud-threshold');
        const valEl = document.getElementById('fraud-threshold-val');
        if (slider && stats.threshold != null) {
            slider.value = String(stats.threshold);
            if (valEl) valEl.textContent = Number(stats.threshold).toFixed(2);
        }

        showReviewItem(-1);
        refreshNavBadges();
    } catch (err) {
        queue.innerHTML = `<div class="guardian-item">${escapeHtml(err.message)}</div>`;
    }
}

let proposalsLoaded = false;

function proposalStatusClass(status) {
    if (status === 'approved') return 'proposal-status--approved';
    if (status === 'denied') return 'proposal-status--denied';
    return 'proposal-status--pending';
}

function renderProposalList(items) {
    const el = document.getElementById('proposal-list');
    if (!el) return;
    if (!items.length) {
        el.innerHTML = '<div class="guardian-item">No proposals yet ? submit one using the form.</div>';
        return;
    }
    el.innerHTML = items.map((p) => `
        <article class="proposal-item">
            <div class="proposal-item-head">
                <strong>${escapeHtml(p.title)}</strong>
                <span class="proposal-status ${proposalStatusClass(p.status)}">${escapeHtml(p.status)}</span>
            </div>
            <div class="proposal-item-meta">${escapeHtml(p.requested_amount_fmt)} · ${escapeHtml(p.budget_source_label || '?')} · ${escapeHtml(p.quarter || '?')} · ${escapeHtml(p.submitted_at?.slice(0, 10) || '')}</div>
            ${p.status === 'approved' && p.spent_fmt ? `<div class="proposal-item-spend">${escapeHtml(p.spent_fmt)} spent · ${escapeHtml(p.remaining_fmt)} left of budget</div>` : ''}
            <p class="proposal-item-desc">${escapeHtml(p.description)}</p>
            ${p.decision_note ? `<p class="proposal-item-note"><strong>Note:</strong> ${escapeHtml(p.decision_note)}</p>` : ''}
        </article>
    `).join('');
}

async function loadProposals(force = false) {
    const list = document.getElementById('proposal-list');
    const hint = document.getElementById('proposal-budget-hint');
    if (!list) return;
    if (proposalsLoaded && !force) return;

    list.innerHTML = '<div class="guardian-item">Loading?</div>';
    try {
        const [mineRes, hintRes] = await Promise.all([
            fetch('/api/proposals/mine'),
            fetch('/api/proposals/budget-hint'),
        ]);
        const items = await mineRes.json();
        const budget = await hintRes.json();
        if (!mineRes.ok) throw new Error(items.error || 'Failed to load proposals');
        if (hint && hintRes.ok) {
            hint.textContent = `${budget.department} · ${budget.quarter}: ${budget.spent_fmt} spent of ${budget.budget_fmt} (${budget.remaining_fmt} left)`;
        } else if (hint) {
            hint.textContent = 'Department budget info unavailable.';
        }
        renderProposalList(items);
        proposalsLoaded = true;
    } catch (err) {
        list.innerHTML = `<div class="guardian-item">${escapeHtml(err.message)}</div>`;
    }
}

function setupProposalForm() {
    const form = document.getElementById('proposal-form');
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const statusEl = document.getElementById('proposal-form-status');
        const btn = document.getElementById('proposal-submit-btn');
        const title = document.getElementById('proposal-title')?.value?.trim();
        const amount = document.getElementById('proposal-amount')?.value;
        const description = document.getElementById('proposal-description')?.value?.trim();
        const budgetSource = form.querySelector('input[name="proposal-budget-source"]:checked')?.value;
        if (statusEl) statusEl.textContent = '';
        if (btn) btn.disabled = true;
        try {
            const res = await fetch('/api/proposals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    requested_amount: amount,
                    description,
                    budget_source: budgetSource,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Submit failed');
            form.reset();
            if (statusEl) statusEl.textContent = 'Submitted ? waiting for approval.';
            proposalsLoaded = false;
            await loadProposals(true);
        } catch (err) {
            if (statusEl) statusEl.textContent = err.message || 'Could not submit.';
        } finally {
            if (btn) btn.disabled = false;
        }
    });
}

let tripReportsLoaded = false;
let tripReportTransactions = [];
let tripReportSelectedKeys = new Set();
let tripReportPurchasePickerBound = false;

function tripReportStatusClass(status) {
    if (status === 'approved') return 'proposal-status--approved';
    if (status === 'rejected') return 'proposal-status--denied';
    return 'proposal-status--pending';
}

function tripReportStatusLabel(status) {
    const map = {
        pending_cfo: 'Pending review',
        approved: 'Approved',
        rejected: 'Rejected',
    };
    return map[status] || status;
}

function updateTripReportSelectionSummary() {
    const totalEl = document.getElementById('trip-report-txn-total');
    if (!totalEl) return;
    const keys = [...tripReportSelectedKeys];
    if (!keys.length) {
        totalEl.hidden = true;
        totalEl.textContent = '';
        return;
    }
    let sum = 0;
    keys.forEach((key) => {
        const row = tripReportTransactions.find((t) => t.key === key);
        if (row) sum += Number(row.amount_raw) || 0;
    });
    totalEl.hidden = false;
    totalEl.textContent = `${keys.length} purchase${keys.length === 1 ? '' : 's'} selected · ${formatCad(sum)} total`;
}

function tripReportPurchaseSearchText(t) {
    return [t.vendor, t.category, t.date, t.location, t.amount].join(' ').toLowerCase();
}

function filterTripReportPurchases(query) {
    const q = query.trim().toLowerCase();
    return tripReportTransactions.filter((t) => {
        if (tripReportSelectedKeys.has(t.key)) return false;
        if (!q) return true;
        return tripReportPurchaseSearchText(t).includes(q);
    });
}

function renderTripReportSelectedPurchases() {
    const chipsEl = document.getElementById('trip-report-purchases-selected');
    if (!chipsEl) return;
    const keys = [...tripReportSelectedKeys];
    if (!keys.length) {
        chipsEl.innerHTML = '';
        chipsEl.hidden = true;
        return;
    }
    chipsEl.hidden = false;
    chipsEl.innerHTML = keys.map((key) => {
        const t = tripReportTransactions.find((row) => row.key === key);
        if (!t) return '';
        const label = `${t.vendor} · ${t.date} · ${t.amount}`;
        return `
            <span class="proposal-colleague-chip colleague-picker-chip${t.flagged ? ' trip-purchase-chip--flagged' : ''}">
                <span>${escapeHtml(label)}</span>
                <button type="button" class="colleague-picker-remove" data-purchase-key="${escapeHtml(key)}" aria-label="Remove ${escapeHtml(t.vendor)}">?</button>
            </span>`;
    }).join('');
    chipsEl.querySelectorAll('[data-purchase-key]').forEach((btn) => {
        btn.addEventListener('click', () => removeTripReportPurchase(btn.dataset.purchaseKey));
    });
}

function renderTripReportPurchaseDropdown(query = '') {
    const dropdown = document.getElementById('trip-report-purchase-dropdown');
    const search = document.getElementById('trip-report-purchase-search');
    if (!dropdown) return;
    const items = filterTripReportPurchases(query);
    if (!items.length) {
        dropdown.innerHTML = '<div class="colleague-picker-empty">No matching purchases</div>';
        dropdown.hidden = false;
        if (search) search.setAttribute('aria-expanded', 'true');
        return;
    }
    dropdown.innerHTML = items.map((t) => `
        <button type="button" class="colleague-picker-option${t.flagged ? ' trip-purchase-option--flagged' : ''}" role="option" data-purchase-key="${escapeHtml(t.key)}">
            <span class="colleague-picker-option-name">${escapeHtml(t.vendor)}</span>
            <span class="colleague-picker-option-dept">${escapeHtml(t.date)} · ${escapeHtml(t.category)} · ${escapeHtml(t.amount)}${t.flagged ? ' · Flagged' : ''}</span>
        </button>
    `).join('');
    dropdown.hidden = false;
    if (search) search.setAttribute('aria-expanded', 'true');
    dropdown.querySelectorAll('[data-purchase-key]').forEach((btn) => {
        btn.addEventListener('click', () => addTripReportPurchase(btn.dataset.purchaseKey));
    });
}

function hideTripReportPurchaseDropdown() {
    const dropdown = document.getElementById('trip-report-purchase-dropdown');
    const search = document.getElementById('trip-report-purchase-search');
    if (dropdown) dropdown.hidden = true;
    if (search) search.setAttribute('aria-expanded', 'false');
}

function addTripReportPurchase(key) {
    if (!tripReportTransactions.some((t) => t.key === key)) return;
    tripReportSelectedKeys.add(key);
    const search = document.getElementById('trip-report-purchase-search');
    if (search) search.value = '';
    renderTripReportSelectedPurchases();
    renderTripReportPurchaseDropdown('');
    updateTripReportSelectionSummary();
}

function removeTripReportPurchase(key) {
    tripReportSelectedKeys.delete(key);
    renderTripReportSelectedPurchases();
    const search = document.getElementById('trip-report-purchase-search');
    renderTripReportPurchaseDropdown(search?.value || '');
    updateTripReportSelectionSummary();
}

function resetTripReportPurchasePicker() {
    tripReportSelectedKeys = new Set();
    const search = document.getElementById('trip-report-purchase-search');
    if (search) search.value = '';
    hideTripReportPurchaseDropdown();
    renderTripReportSelectedPurchases();
    updateTripReportSelectionSummary();
}

function syncTripReportFormPurpose() {
    const form = document.getElementById('trip-report-form');
    if (!form) return;
    const purpose = form.querySelector('input[name="trip_spending_purpose"]:checked')?.value;
    const wrap = document.getElementById('trip-report-project-wrap');
    const select = document.getElementById('trip-report-project-select');
    const emptyEl = document.getElementById('trip-report-project-empty');
    const submitBtn = document.getElementById('trip-report-submit-btn');
    const isProject = purpose === 'project';
    if (wrap) wrap.hidden = !isProject;
    if (select) select.required = isProject && !select.disabled;
    if (emptyEl && !isProject) emptyEl.hidden = true;
    if (submitBtn) submitBtn.disabled = isProject && !!select?.disabled;
}

async function refreshTripReportProjectSelect() {
    const projects = await loadApprovedProjects(true);
    const select = document.getElementById('trip-report-project-select');
    const hint = document.getElementById('trip-report-project-spend-hint');
    fillProjectSelect(
        select,
        projects,
        document.getElementById('trip-report-project-empty')
    );
    updateReceiptProjectHint(select, hint, projects);
    syncTripReportFormPurpose();
}

function setupTripReportPurchasePicker() {
    if (tripReportPurchasePickerBound) return;
    const search = document.getElementById('trip-report-purchase-search');
    const picker = document.getElementById('trip-report-purchase-picker');
    if (!search || !picker) return;
    tripReportPurchasePickerBound = true;

    search.addEventListener('focus', () => {
        renderTripReportPurchaseDropdown(search.value);
    });
    search.addEventListener('input', () => {
        renderTripReportPurchaseDropdown(search.value);
    });
    search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideTripReportPurchaseDropdown();
            search.blur();
        }
    });
    document.addEventListener('click', (e) => {
        if (!picker.contains(e.target)) hideTripReportPurchaseDropdown();
    });
}

function renderTripReportTransactions(items) {
    const hintEl = document.getElementById('trip-report-txn-hint');
    const picker = document.getElementById('trip-report-purchase-picker');
    const emptyEl = document.getElementById('trip-report-purchase-empty');
    tripReportTransactions = Array.isArray(items) ? items : [];
    setupTripReportPurchasePicker();
    if (hintEl) {
        hintEl.textContent = tripReportTransactions.length
            ? `${tripReportTransactions.length} purchase${tripReportTransactions.length === 1 ? '' : 's'} available to add`
            : 'No eligible purchases right now. Use card spend from a recent trip, then return here.';
    }
    const hasItems = tripReportTransactions.length > 0;
    if (picker) picker.hidden = !hasItems;
    if (emptyEl) emptyEl.hidden = hasItems;
    if (!hasItems) {
        resetTripReportPurchasePicker();
        return;
    }
    renderTripReportSelectedPurchases();
    hideTripReportPurchaseDropdown();
    updateTripReportSelectionSummary();
}

function renderTripReportList(items) {
    const el = document.getElementById('trip-report-list');
    if (!el) return;
    if (!items.length) {
        el.innerHTML = '<div class="guardian-item">No trip reports yet ? submit one using the form.</div>';
        return;
    }
    el.innerHTML = items.map((r) => `
        <article class="proposal-item">
            <div class="proposal-item-head">
                <strong>${escapeHtml(r.trip_name)}</strong>
                <span class="proposal-status ${tripReportStatusClass(r.status)}">${escapeHtml(tripReportStatusLabel(r.status))}</span>
            </div>
            <div class="proposal-item-meta">${escapeHtml(r.total_formatted)} · ${escapeHtml(String(r.transaction_count))} purchases · ${escapeHtml(r.date_range || '')} · ${escapeHtml(r.submitted_at?.slice(0, 10) || '')}${r.spending_purpose === 'project' && r.project_title ? ` · ${escapeHtml(r.project_title)}` : r.spending_purpose === 'personal' ? ' · Personal' : ''}</div>
            ${(r.tags || []).length ? `<div class="report-tags">${r.tags.slice(0, 4).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
            <p class="proposal-item-desc">${escapeHtml(r.purpose || '')}</p>
            ${r.decision_note ? `<p class="proposal-item-note"><strong>Note:</strong> ${escapeHtml(r.decision_note)}</p>` : ''}
            <div class="report-actions">
                <button type="button" class="btn-sm" data-trip-report-id="${r.id}">View details</button>
            </div>
        </article>
    `).join('');
    el.querySelectorAll('[data-trip-report-id]').forEach((btn) => {
        btn.addEventListener('click', () => openEmployeeTripReportModal(Number(btn.dataset.tripReportId)));
    });
}

async function openEmployeeTripReportModal(reportId) {
    const modal = document.getElementById('report-detail-modal');
    const body = document.getElementById('report-modal-body');
    const footer = document.getElementById('report-modal-footer');
    const title = document.getElementById('report-modal-title');
    if (!modal || !body) return;
    body.innerHTML = '<div class="guardian-item">Loading report?</div>';
    if (footer) footer.innerHTML = '';
    modal.hidden = false;
    try {
        const res = await fetch(`/api/trip-reports/${reportId}`);
        const r = await res.json();
        if (!res.ok) throw new Error(r.error || 'Failed to load report');
        if (title) title.textContent = r.title || r.trip_name || 'Trip report';
        const txRows = (r.transactions || []).map((t) => `
            <tr><td>${escapeHtml(t.date)}</td><td>${escapeHtml(t.vendor)}</td><td>${escapeHtml(t.category)}</td><td>${escapeHtml(t.amount)}</td></tr>
        `).join('');
        body.innerHTML = `
            <p><strong>${escapeHtml(r.employee)}</strong> · ${escapeHtml(r.department)} · ${escapeHtml(r.date_range || '')}</p>
            ${r.spending_purpose === 'project' && r.project_title ? `<p><strong>Project:</strong> ${escapeHtml(r.project_title)}</p>` : r.spending_purpose === 'personal' ? '<p><strong>Personal</strong> travel</p>' : ''}
            ${r.purpose ? `<p>${escapeHtml(r.purpose)}</p>` : ''}
            <p>${escapeHtml(r.policy_summary || '')}</p>
            ${(r.violations || []).length ? `<ul class="approval-context">${r.violations.map((v) => `<li>${escapeHtml(v)}</li>`).join('')}</ul>` : ''}
            <div class="tx-table-wrap"><table class="tx-table"><thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th>Amount</th></tr></thead><tbody>${txRows}</tbody></table></div>
        `;
        if (footer) {
            footer.innerHTML = `<span class="tag tag--status">${escapeHtml(tripReportStatusLabel(r.status))}</span>`;
        }
    } catch (err) {
        body.innerHTML = `<div class="guardian-item">${escapeHtml(err.message)}</div>`;
    }
}

async function loadTripReports(force = false) {
    const list = document.getElementById('trip-report-list');
    if (!list) return;
    if (tripReportsLoaded && !force) return;

    list.innerHTML = '<div class="guardian-item">Loading?</div>';
    const picker = document.getElementById('trip-report-purchase-picker');
    const emptyEl = document.getElementById('trip-report-purchase-empty');
    if (picker && !tripReportTransactions.length) picker.hidden = true;
    if (emptyEl && !tripReportTransactions.length) {
        emptyEl.hidden = false;
        emptyEl.textContent = 'Loading purchases?';
    }
    try {
        const [mineRes, txnRes] = await Promise.all([
            fetch('/api/trip-reports/mine'),
            fetch('/api/trip-reports/transactions'),
            refreshTripReportProjectSelect(),
        ]);
        const items = await mineRes.json();
        const txns = await txnRes.json();
        if (!mineRes.ok) throw new Error(items.error || 'Failed to load trip reports');
        if (!txnRes.ok) throw new Error(txns.error || 'Failed to load purchases');
        renderTripReportTransactions(txns);
        renderTripReportList(items);
        tripReportsLoaded = true;
    } catch (err) {
        list.innerHTML = `<div class="guardian-item">${escapeHtml(err.message)}</div>`;
        if (emptyEl) {
            emptyEl.hidden = false;
            emptyEl.textContent = err.message;
        }
    }
}

function setupTripReportForm() {
    const form = document.getElementById('trip-report-form');
    if (!form || form.dataset.bound) return;
    form.dataset.bound = '1';
    form.querySelectorAll('input[name="trip_spending_purpose"]').forEach((radio) => {
        radio.addEventListener('change', syncTripReportFormPurpose);
    });
    const projectSelect = document.getElementById('trip-report-project-select');
    projectSelect?.addEventListener('change', async () => {
        const projects = await loadApprovedProjects();
        updateReceiptProjectHint(
            projectSelect,
            document.getElementById('trip-report-project-spend-hint'),
            projects
        );
    });
    setupTripReportPurchasePicker();
    syncTripReportFormPurpose();
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const statusEl = document.getElementById('trip-report-form-status');
        const btn = document.getElementById('trip-report-submit-btn');
        const tripName = document.getElementById('trip-report-name')?.value?.trim();
        const purpose = document.getElementById('trip-report-purpose')?.value?.trim();
        const spendingPurpose = form.querySelector('input[name="trip_spending_purpose"]:checked')?.value || 'personal';
        const projectId = document.getElementById('trip-report-project-select')?.value;
        const keys = [...tripReportSelectedKeys];
        if (statusEl) statusEl.textContent = '';
        if (!keys.length) {
            if (statusEl) statusEl.textContent = 'Select at least one purchase for this trip.';
            return;
        }
        if (spendingPurpose === 'project' && !projectId) {
            if (statusEl) statusEl.textContent = 'Select which approved project this trip is for.';
            return;
        }
        if (btn) btn.disabled = true;
        try {
            const payload = {
                trip_name: tripName,
                purpose,
                transaction_keys: keys,
                spending_purpose: spendingPurpose,
            };
            if (spendingPurpose === 'project') payload.project_id = Number(projectId);
            const res = await fetch('/api/trip-reports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Submit failed');
            form.reset();
            resetTripReportPurchasePicker();
            syncTripReportFormPurpose();
            await refreshTripReportProjectSelect();
            if (statusEl) statusEl.textContent = 'Submitted ? waiting for finance review.';
            tripReportsLoaded = false;
            tripReportTransactions = [];
            await loadTripReports(true);
        } catch (err) {
            if (statusEl) statusEl.textContent = err.message || 'Could not submit.';
        } finally {
            if (btn) btn.disabled = false;
            syncTripReportFormPurpose();
        }
    });
}

async function submitReviewAction(action) {
    const item = reviewFiltered[reviewCurrentIdx];
    if (!item) return;
    const res = await fetch('/api/review/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, action }),
    });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || 'Action failed');
        return;
    }
    reviewLoaded = false;
    await loadReview(true);
}

function setupReviewWorkspace() {
    const queue = document.getElementById('review-queue');
    const slider = document.getElementById('fraud-threshold');
    const valEl = document.getElementById('fraud-threshold-val');

    queue?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-review-idx]');
        if (!btn) return;
        showReviewItem(Number(btn.dataset.reviewIdx));
    });

    document.querySelectorAll('[data-review-filter]').forEach((btn) => {
        btn.addEventListener('click', () => {
            reviewFilter = btn.dataset.reviewFilter || 'all';
            document.querySelectorAll('[data-review-filter]').forEach((b) => {
                b.classList.toggle('review-filter--active', b === btn);
            });
            showReviewItem(-1);
        });
    });

    let thresholdTimer = null;
    slider?.addEventListener('input', () => {
        if (valEl) valEl.textContent = Number(slider.value).toFixed(2);
        clearTimeout(thresholdTimer);
        thresholdTimer = setTimeout(async () => {
            await fetch('/api/fraud/threshold', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threshold: Number(slider.value) }),
            });
            reviewLoaded = false;
            await loadReview(true);
        }, 350);
    });

    if (reviewKeyHandler) document.removeEventListener('keydown', reviewKeyHandler);
    reviewKeyHandler = (e) => {
        if (currentViewKey !== 'approvals') return;
        if (e.target.matches('input, textarea, select')) return;
        if (!reviewFiltered.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            showReviewItem(reviewCurrentIdx < 0 ? 0 : reviewCurrentIdx + 1);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            showReviewItem(reviewCurrentIdx <= 0 ? -1 : reviewCurrentIdx - 1);
            return;
        }
        const item = reviewFiltered[reviewCurrentIdx];
        if (!item) return;
        if (e.key === 'a' || e.key === 'A') { e.preventDefault(); submitReviewAction('approve'); return; }
        if (item.kind === 'fraud') {
            if (e.key === 'd' || e.key === 'D') { e.preventDefault(); submitReviewAction('dismiss'); }
            if (e.key === 'e' || e.key === 'E') { e.preventDefault(); submitReviewAction('escalate'); }
        } else if (e.key === 'd' || e.key === 'D') {
            e.preventDefault();
            submitReviewAction('deny');
        }
    };
    document.addEventListener('keydown', reviewKeyHandler);
}

function budgetStatusLabel(status, outcome) {
    if (outcome === 'projected_exceed' || outcome === 'exceeded' || status === 'critical') return 'Problem';
    if (status === 'warn' || outcome === 'projected_exceed') return 'Watch out';
    return 'OK';
}

function renderBudgetSummary(summary, quarter) {
    const el = document.getElementById('budget-summary-stats');
    if (!el || !summary) return;
    const items = [
        { label: 'Spent', value: summary.total_spent_fmt },
        { label: 'Left', value: summary.total_remaining_fmt },
        { label: 'Limit', value: summary.total_budget_fmt },
    ];
    el.innerHTML = items.map((item) => `
        <div class="guardian-stat">
            <span>${escapeHtml(item.label)}</span>
            <strong>${escapeHtml(String(item.value))}</strong>
        </div>`).join('');
}

function budgetDeptNote(d) {
    if (d.forecast_outcome === 'on_track' && d.status === 'ok') return '';
    const msg = (d.forecast_message || '').trim();
    if (!msg) return '';
    const short = msg.includes('.') ? msg.split('.')[0] : msg;
    return short.length > 72 ? `${short.slice(0, 69)}?` : short;
}

function renderBudgetDepartments(departments) {
    const el = document.getElementById('budget-dept-list');
    if (!el) return;
    if (!departments?.length) {
        el.innerHTML = '<div class="guardian-item">No department budget data.</div>';
        return;
    }
    el.innerHTML = departments.map((d) => {
        const statusWord = budgetStatusLabel(d.status, d.forecast_outcome);
        const statusClass = statusWord === 'OK' ? 'ok' : (statusWord === 'Watch out' ? 'warn' : 'critical');
        const note = budgetDeptNote(d);
        const selected = budgetSelectedDept === d.department;
        return `
        <button type="button"
            class="budget-dept-item budget-dept-item--${statusClass}${selected ? ' budget-dept-item--selected' : ''}"
            data-dept="${escapeHtml(d.department)}"
            aria-pressed="${selected ? 'true' : 'false'}"
            title="Show ${escapeHtml(d.department)} projection">
            <div class="budget-dept-head">
                <strong>${escapeHtml(d.department)}</strong>
                <span class="budget-status-pill budget-status-pill--${statusClass}">${statusWord}</span>
            </div>
            <div class="budget-dept-amount">${escapeHtml(d.spent_fmt)} <span>/ ${escapeHtml(d.budget_fmt)}</span></div>
            <div class="budget-progress" title="${Math.round(d.pct_used)}% used">
                <div class="budget-progress-fill budget-progress-fill--${escapeHtml(d.status)}" style="width:${Math.min(d.pct_used, 100)}%"></div>
            </div>
            ${note ? `<p class="budget-dept-note budget-dept-note--${escapeHtml(d.forecast_outcome || d.status)}">${escapeHtml(note)}</p>` : ''}
        </button>`;
    }).join('');
}

function getBudgetProjectionChart(dept = budgetSelectedDept) {
    if (!budgetPayload) return null;
    if (!dept) return budgetPayload.forecast_chart || null;
    return budgetPayload.forecast_charts?.[dept] || null;
}

function selectBudgetProjection(dept) {
    if (!budgetPayload) return;
    budgetSelectedDept = budgetSelectedDept === dept ? null : dept;
    renderBudgetProjection(getBudgetProjectionChart());
    renderBudgetDepartments(budgetPayload.departments);
}

function renderBudgetProjection(fc) {
    const projectionCard = document.getElementById('budget-projection-card');
    const titleEl = document.getElementById('budget-forecast-title');
    const subtitleEl = document.getElementById('budget-forecast-subtitle');
    const footnoteEl = document.getElementById('budget-forecast-footnote');

    if (projectionCard) {
        projectionCard.hidden = !fc?.labels?.length;
    }
    if (!fc?.labels?.length) {
        if (dashboardCharts['chart-budget-forecast']) {
            dashboardCharts['chart-budget-forecast'].destroy();
            delete dashboardCharts['chart-budget-forecast'];
        }
        return;
    }

    if (titleEl) {
        titleEl.textContent = fc.department
            ? `Budget projection ? ${fc.department}`
            : 'Budget projection';
    }
    if (subtitleEl) {
        const parts = [fc.quarter || 'This quarter', `${fc.spent_fmt || ''} spent so far`.trim()];
        if (fc.weekly_burn_fmt) parts.push(`${fc.weekly_burn_fmt}/wk burn`);
        if (fc.projected_eoq_fmt) parts.push(`${fc.projected_eoq_fmt} projected EoQ`);
        subtitleEl.textContent = parts.filter(Boolean).join(' · ');
    }
    if (footnoteEl) {
        const today = fc.today_date ? `through ${fc.today_date}` : (fc.current_week_label ? `through week of ${fc.current_week_label}` : 'to date');
        let note = `Solid line = actual cumulative spend ${today}. Dashed line = projected path if burn stays at ${fc.weekly_burn_fmt || 'current rate'}. Red line = ${fc.budget_fmt || 'budget'} cap.`;
        if (fc.exceed_date) {
            note += ` On this path, spending exceeds the cap around ${fc.exceed_date}.`;
        } else if (fc.outcome === 'on_track') {
            note += ' On this path, spending stays within the cap.';
        }
        if (budgetSelectedDept) {
            note += ' Click the department again to return to the company-wide view.';
        } else {
            note += ' Click a department below to drill into its projection.';
        }
        footnoteEl.textContent = note;
    }
    renderBudgetForecastChart(fc);
}

function renderBudgetHero(data) {
    const hero = document.getElementById('budget-hero');
    const headline = data.summary?.forecast_headline;

    if (hero) {
        if (headline) {
            hero.hidden = false;
            hero.innerHTML = `<i class="fa-solid fa-lightbulb" aria-hidden="true"></i><p>${escapeHtml(headline)}</p>`;
        } else {
            hero.hidden = true;
            hero.innerHTML = '';
        }
    }

    renderBudgetProjection(getBudgetProjectionChart());
}

function renderBudgetForecasts(data) {
    renderBudgetHero(data);
}

function renderBudgetForecastChart(fc) {
    const canvas = document.getElementById('chart-budget-forecast');
    if (!canvas || !fc.labels?.length || typeof Chart === 'undefined') return;
    if (dashboardCharts['chart-budget-forecast']) dashboardCharts['chart-budget-forecast'].destroy();

    const todayIdx = Math.max(0, (fc.current_week || 1) - 1);
    const exceedIdx = fc.exceed_week && fc.exceed_week >= 1 ? fc.exceed_week - 1 : -1;
    const todayLabel = fc.today_date || 'Today';
    const exceedLabel = fc.exceed_date || 'Over cap';

    const todayPlugin = {
        id: 'budgetTodayLine',
        afterDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            if (!chartArea || !scales.x) return;
            const x = scales.x.getPixelForValue(todayIdx);
            ctx.save();
            ctx.strokeStyle = 'rgba(107, 114, 128, 0.55)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.stroke();
            ctx.fillStyle = '#6b7280';
            ctx.font = '600 10px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(todayLabel, x, chartArea.top + 12);
            ctx.restore();
        },
    };

    const exceedPlugin = {
        id: 'budgetExceedLine',
        afterDraw(chart) {
            if (exceedIdx < 0) return;
            const { ctx, chartArea, scales } = chart;
            if (!chartArea || !scales.x) return;
            const x = scales.x.getPixelForValue(exceedIdx);
            ctx.save();
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.stroke();
            ctx.fillStyle = '#ef4444';
            ctx.font = '600 10px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(exceedLabel, x, chartArea.top + (exceedIdx === todayIdx ? 26 : 12));
            ctx.restore();
        },
    };

    dashboardCharts['chart-budget-forecast'] = new Chart(canvas, {
        type: 'line',
        data: {
            labels: fc.labels,
            datasets: [
                {
                    label: 'Actual spend',
                    data: fc.actual || [],
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.14)',
                    fill: true,
                    tension: 0.15,
                    pointRadius: 2,
                    pointHoverRadius: 4,
                    borderWidth: 2.5,
                },
                {
                    label: 'Projected path',
                    data: fc.projected || [],
                    borderColor: '#60a5fa',
                    borderDash: [8, 5],
                    backgroundColor: 'transparent',
                    fill: false,
                    tension: 0,
                    pointRadius: (ctx) => (ctx.dataIndex === todayIdx ? 5 : 2),
                    pointBackgroundColor: (ctx) => (ctx.dataIndex === todayIdx ? '#2563eb' : '#60a5fa'),
                    borderWidth: 2,
                },
                {
                    label: 'Budget cap',
                    data: fc.budget || [],
                    borderColor: '#ef4444',
                    borderDash: [5, 5],
                    pointRadius: 0,
                    borderWidth: 1.5,
                    fill: false,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                    filter: (item) => item.parsed.y != null,
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${moneyTick(ctx.parsed.y)}`,
                    },
                },
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Week starting',
                        font: { size: 11 },
                        color: '#6b7280',
                    },
                },
                y: {
                    title: {
                        display: true,
                        text: 'Cumulative spend',
                        font: { size: 11 },
                        color: '#6b7280',
                    },
                    ticks: { callback: moneyTick },
                },
            },
        },
        plugins: [todayPlugin, exceedPlugin],
    });
}

function renderBudgetCharts(data) {
    const chart = data.chart || {};
    const burn = data.burn || {};
    const barCanvas = document.getElementById('chart-budget-bar');
    if (barCanvas && chart.labels?.length && typeof Chart !== 'undefined') {
        if (dashboardCharts['chart-budget-bar']) dashboardCharts['chart-budget-bar'].destroy();
        dashboardCharts['chart-budget-bar'] = new Chart(barCanvas, {
            type: 'bar',
            data: {
                labels: chart.labels,
                datasets: [
                {
                    label: 'Spent so far',
                    data: chart.spent,
                    backgroundColor: '#3b82f6',
                    borderRadius: 8,
                },
                {
                    label: 'Allowed',
                    data: chart.budget,
                    backgroundColor: '#e5e7eb',
                    borderRadius: 8,
                },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom' } },
                scales: {
                    y: { ticks: { callback: moneyTick } },
                },
            },
        });
    }
}

function renderBudget(data) {
    if (!data) return;
    budgetPayload = data;
    budgetSelectedDept = null;
    const subtitle = document.getElementById('budget-chart-subtitle');
    const quarterLabel = document.getElementById('budget-quarter-label');
    if (subtitle) subtitle.textContent = data.quarter;
    if (quarterLabel) {
        const atRisk = data.summary?.departments_at_risk || 0;
        quarterLabel.textContent = atRisk > 0 ? `${atRisk} need attention` : `${data.summary?.department_count || 0} departments`;
    }
    renderBudgetSummary(data.summary, data.quarter);
    renderBudgetForecasts(data);
    renderBudgetDepartments(data.departments);
    renderBudgetCharts(data);
}

async function loadBudget(force = false) {
    if (!force && !budgetStale && budgetLoaded && budgetPayload) {
        renderBudget(budgetPayload);
        return;
    }
    const listEl = document.getElementById('budget-dept-list');
    if (listEl) listEl.innerHTML = '<div class="guardian-item">Loading budgets?</div>';
    try {
        const res = await fetch(`/api/budget?_=${Date.now()}`, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load budgets');
        budgetLoaded = true;
        budgetStale = false;
        renderBudget(data);
    } catch (err) {
        if (listEl) listEl.innerHTML = `<div class="guardian-item">${escapeHtml(err.message)}</div>`;
    }
}

async function loadApprovals(force = false) {
    reviewLoaded = force ? false : reviewLoaded;
    await loadReview(force);
}

async function handleApproval(itemKey, approved) {
    const res = await fetch('/api/review/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: `approval:${itemKey}`, action: approved ? 'approve' : 'deny' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Decision failed');
    reviewLoaded = false;
    await loadReview(true);
    refreshNavBadges();
}

function renderTeamRoster(employees) {
    const el = document.getElementById('employee-roster');
    if (!el) return;
    el.innerHTML = (employees || []).map((e) => {
        const initials = e.name.split(' ').map((p) => p[0]).join('').slice(0, 2);
        return `
        <div class="team-row credit-row--clickable" data-employee="${e.name}" role="button" tabindex="0">
            <input type="checkbox" class="compare-select" data-employee="${e.name}" ${compareSelection.has(e.name) ? 'checked' : ''} aria-label="Compare ${e.name}">
            <div class="credit-avatar credit-avatar--team">${initials}</div>
            <div class="team-info credit-info">
                <button type="button" class="emp-link credit-name" data-employee="${e.name}">${e.name}</button>
                <div class="roster-meta">${e.employee_id} · ${escapeHtml(e.department || '?')} · ${e.transaction_count} txns · ${e.total_spend_fmt}</div>
                <div class="credit-bar"><div class="credit-bar-fill" style="width:${e.credit_score}%;background:${scoreBarColor(e.credit_score)}"></div></div>
            </div>
            <div class="credit-score ${scoreClass(e.credit_score)}">${formatCreditScore(e.credit_score)}</div>
        </div>`;
    }).join('');
}

function renderActivityFeed(recent) {
    const el = document.getElementById('activity-feed');
    if (!el) return;
    el.innerHTML = (recent || []).slice(0, 12).map((r) => {
        const initials = r.employee.split(' ').map((p) => p[0]).join('').slice(0, 2);
        const flagged = r.flagged
            ? ` <span class="tag tag--violation">${escapeHtml(r.risk_level || 'Flagged')}</span>`
            : '';
        return `
        <div class="activity-item">
            <div class="activity-avatar">${initials}</div>
            <div class="activity-body">
                <button type="button" class="emp-link" data-employee="${r.employee}">${r.employee}</button>
                spent <strong>${r.amount}</strong> at ${r.vendor}${flagged}
            </div>
            <span class="activity-time">${r.date}</span>
        </div>`;
    }).join('');
}

function renderTxTable(recent) {
    /* Home dashboard preview only ? full list uses renderPurchasesTable */
    const el = document.getElementById('tx-table');
    if (!el || purchasesLoaded) return;
    if (!recent?.length) {
        el.innerHTML = '<div class="guardian-item">No purchases yet.</div>';
        return;
    }
    el.innerHTML = `
        <table class="data-table tx-table">
            <thead>
                <tr><th>Date</th><th>Who</th><th>What</th><th>How</th><th>Amt</th></tr>
            </thead>
            <tbody>
                ${recent.slice(0, 12).map((r) => `
                    <tr class="${r.flagged ? 'tx-row--flagged' : ''}">
                        <td>${r.date}</td>
                        <td>
                            <button type="button" class="emp-link" data-employee="${escapeHtml(r.employee)}">${escapeHtml(r.employee)}</button>
                            <br><small>${escapeHtml(r.department || r.category || '')}</small>
                        </td>
                        <td>${escapeHtml(r.vendor)}</td>
                        <td>${escapeHtml(r.category)}${r.flagged && r.flag_reason ? `<br><small>${escapeHtml(r.flag_reason)}</small>` : ''}<br><small>${escapeHtml(r.location)}</small></td>
                        <td>${r.amount}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
}

function applyPurchasesFilters(rows) {
    let list = [...(rows || [])];
    const q = (purchasesFilters.search || '').trim().toLowerCase();
    if (q) {
        list = list.filter((r) => (
            r.vendor?.toLowerCase().includes(q)
            || r.employee?.toLowerCase().includes(q)
            || r.department?.toLowerCase().includes(q)
            || r.category?.toLowerCase().includes(q)
            || r.location?.toLowerCase().includes(q)
            || r.street_address?.toLowerCase().includes(q)
            || r.flag_reason?.toLowerCase().includes(q)
        ));
    }
    if (purchasesFilters.department) {
        list = list.filter((r) => r.department === purchasesFilters.department);
    }
    if (purchasesFilters.category) {
        list = list.filter((r) => r.category === purchasesFilters.category);
    }
    if (purchasesFilters.flagged === 'flagged') {
        list = list.filter((r) => r.flagged);
    } else if (purchasesFilters.flagged === 'clean') {
        list = list.filter((r) => !r.flagged);
    }

    const sort = purchasesFilters.sort || 'date-desc';
    const cmp = {
        'date-desc': (a, b) => b.date_sort.localeCompare(a.date_sort),
        'date-asc': (a, b) => a.date_sort.localeCompare(b.date_sort),
        'amount-desc': (a, b) => b.amount_raw - a.amount_raw,
        'amount-asc': (a, b) => a.amount_raw - b.amount_raw,
        'vendor-asc': (a, b) => a.vendor.localeCompare(b.vendor),
        'employee-asc': (a, b) => a.employee.localeCompare(b.employee),
    }[sort] || ((a, b) => b.date_sort.localeCompare(a.date_sort));
    list.sort(cmp);
    return list;
}

function renderPurchasesTable() {
    const el = document.getElementById('tx-table');
    const countEl = document.getElementById('purchases-count');
    const pageInfo = document.getElementById('purchases-page-info');
    const prevBtn = document.getElementById('purchases-prev');
    const nextBtn = document.getElementById('purchases-next');
    if (!el || !purchasesData) return;

    const filtered = applyPurchasesFilters(purchasesData.purchases);
    const total = filtered.length;
    const pageSize = purchasesFilters.pageSize;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (purchasesFilters.page > totalPages) purchasesFilters.page = totalPages;
    if (purchasesFilters.page < 1) purchasesFilters.page = 1;

    const start = (purchasesFilters.page - 1) * pageSize;
    const pageRows = filtered.slice(start, start + pageSize);

    if (countEl) {
        countEl.textContent = total === purchasesData.total
            ? `${total} purchases`
            : `${total} of ${purchasesData.total} purchases`;
    }
    if (pageInfo) pageInfo.textContent = `Page ${purchasesFilters.page} of ${totalPages}`;
    if (prevBtn) prevBtn.disabled = purchasesFilters.page <= 1;
    if (nextBtn) nextBtn.disabled = purchasesFilters.page >= totalPages;

    if (!pageRows.length) {
        el.innerHTML = '<div class="guardian-item">No purchases match your filters.</div>';
        return;
    }

    el.innerHTML = `
        <table class="data-table tx-table purchases-table">
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Who</th>
                    <th>Vendor</th>
                    <th>Category</th>
                    <th>Address</th>
                    <th>Amt</th>
                </tr>
            </thead>
            <tbody>
                ${pageRows.map((r) => `
                    <tr class="${r.flagged ? 'tx-row--flagged' : ''}">
                        <td>${escapeHtml(r.date)}</td>
                        <td>
                            <button type="button" class="emp-link" data-employee="${escapeHtml(r.employee)}">${escapeHtml(r.employee)}</button>
                            <br><small>${escapeHtml(r.department)}</small>
                        </td>
                        <td>${escapeHtml(r.vendor)}</td>
                        <td>${escapeHtml(r.category)}${r.flagged ? '<br><small class="tx-flag-tag">Flagged</small>' : ''}</td>
                        <td>
                            ${r.street_address ? `<span>${escapeHtml(r.street_address)}</span><br>` : ''}
                            <small>${escapeHtml(r.location)}</small>
                            ${r.flagged && r.flag_reason ? `<br><small>${escapeHtml(r.flag_reason)}</small>` : ''}
                        </td>
                        <td>${escapeHtml(r.amount)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
}

function populatePurchasesFilters(data) {
    const deptEl = document.getElementById('purchases-dept-filter');
    const catEl = document.getElementById('purchases-cat-filter');
    if (deptEl && deptEl.options.length <= 1) {
        (data.departments || []).forEach((d) => {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = d;
            deptEl.appendChild(opt);
        });
    }
    if (catEl && catEl.options.length <= 1) {
        (data.categories || []).forEach((c) => {
            const opt = document.createElement('option');
            opt.value = c;
            opt.textContent = c;
            catEl.appendChild(opt);
        });
    }
}

let receiptsPageFile = null;
let receiptsScanResult = null;
let receiptsPreviewUrl = null;

function clearReceiptsPageFile() {
    if (receiptsPreviewUrl) {
        URL.revokeObjectURL(receiptsPreviewUrl);
        receiptsPreviewUrl = null;
    }
    receiptsPageFile = null;
    receiptsScanResult = null;
    const input = document.getElementById('receipts-file-input');
    if (input) input.value = '';
    document.getElementById('receipts-dropzone-empty')?.removeAttribute('hidden');
    document.getElementById('receipts-dropzone-preview')?.setAttribute('hidden', '');
    document.getElementById('receipts-scan-btn')?.setAttribute('disabled', '');
    document.getElementById('receipts-status')?.replaceChildren();
    document.getElementById('receipts-result-empty')?.removeAttribute('hidden');
    document.getElementById('receipts-result-body')?.setAttribute('hidden', '');
}

function setReceiptsPageFile(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
        document.getElementById('receipts-status').textContent = 'File too large (max 10 MB).';
        return;
    }
    clearReceiptsPageFile();
    receiptsPageFile = file;
    const isImage = file.type.startsWith('image/');
    document.getElementById('receipts-dropzone-empty')?.setAttribute('hidden', '');
    const previewWrap = document.getElementById('receipts-dropzone-preview');
    const previewImg = document.getElementById('receipts-preview-img');
    const meta = document.getElementById('receipts-file-meta');
    previewWrap?.removeAttribute('hidden');
    if (isImage) {
        receiptsPreviewUrl = URL.createObjectURL(file);
        if (previewImg) {
            previewImg.src = receiptsPreviewUrl;
            previewImg.hidden = false;
        }
    } else if (previewImg) {
        previewImg.hidden = true;
    }
    if (meta) meta.textContent = `${file.name} · ${formatFileSize(file.size)}`;
    document.getElementById('receipts-scan-btn')?.removeAttribute('disabled');
    document.getElementById('receipts-status').textContent = '';
}

function fillReceiptsForm(ext, matched) {
    const form = document.getElementById('receipts-form');
    if (!form) return;
    const amount = Number(ext.amount) || 0;
    const tax = Number(ext.tax) || 0;
    const tip = Number(ext.tip) || 0;
    const subtotal = amount - tax - tip;
    form.merchant.value = ext.merchant_name || '';
    form.description.value = ext.transaction_description || '';
    form.date.value = ext.date ? String(ext.date).slice(0, 10) : '';
    form.category.value = ext.expense_category || '';
    form.amount.value = amount ? String(amount) : '';
    form.tax.value = tax ? String(tax) : '';
    form.tip.value = tip ? String(tip) : '';
    form.city.value = ext.merchant_city || '';
    form.state.value = ext.merchant_state || '';
    form.dataset.subtotal = subtotal > 0 ? String(Math.round(subtotal * 100) / 100) : '';
    form.dataset.matchedId = matched?.transaction_id || '';
    const projectRadio = form.querySelector('input[name="spending_purpose"][value="project"]');
    if (projectRadio) projectRadio.checked = true;
}

function renderReceiptsScanResult(result) {
    const empty = document.getElementById('receipts-result-empty');
    const body = document.getElementById('receipts-result-body');
    const matchBanner = document.getElementById('receipts-match-banner');
    const violationsEl = document.getElementById('receipts-violations');
    if (!body || !empty) return;

    const ext = result.extracted_data || {};
    if (ext.error) {
        empty.innerHTML = `<p class="receipts-error">${escapeHtml(ext.error)}</p>`;
        empty.hidden = false;
        body.hidden = true;
        return;
    }

    empty.hidden = true;
    body.hidden = false;

    const matched = result.matched_transaction;
    if (matchBanner) {
        if (matched) {
            matchBanner.className = 'receipts-match-banner receipts-match-banner--ok';
            matchBanner.innerHTML = `<i class="fa-solid fa-circle-check"></i> Matched to transaction · ${escapeHtml(matched.merchant_name || '')} · ${moneyTick(matched.amount_cad)} · ${escapeHtml(matched.transaction_date || '')}`;
        } else {
            matchBanner.className = 'receipts-match-banner receipts-match-banner--info';
            matchBanner.innerHTML = '<i class="fa-solid fa-circle-info"></i> No card transaction matched ? review the details below and save if they look correct';
        }
    }

    if (violationsEl) {
        const violations = result.violations || [];
        violationsEl.innerHTML = violations.length
            ? violations.map((v) => `<div class="receipt-violation receipt-violation--${escapeHtml(v.severity || 'low')}">${escapeHtml(v.description || v.type)}</div>`).join('')
            : '';
    }

    fillReceiptsForm(ext, matched);
    refreshReceiptsProjectSelect();
}

async function scanReceiptsPageFile() {
    if (!receiptsPageFile) return;
    const statusEl = document.getElementById('receipts-status');
    const scanBtn = document.getElementById('receipts-scan-btn');
    if (statusEl) statusEl.textContent = 'Analyzing receipt?';
    if (scanBtn) scanBtn.disabled = true;

    try {
        const formData = new FormData();
        formData.append('file', receiptsPageFile);
        const res = await fetch('/api/receipts/scan', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Scan failed');
        receiptsScanResult = data;
        renderReceiptsScanResult(data);
        if (statusEl) statusEl.textContent = 'Scan complete';
    } catch (err) {
        if (statusEl) statusEl.textContent = err.message;
    } finally {
        if (scanBtn) scanBtn.disabled = false;
    }
}

async function saveReceiptsPageForm(e) {
    e.preventDefault();
    const form = e.target;
    const statusEl = document.getElementById('receipts-status');
    const payload = {
        merchant: form.merchant.value,
        transaction_description: form.description.value,
        date: form.date.value,
        amount: parseFloat(form.amount.value) || 0,
        category: form.category.value,
        tax: form.tax.value !== '' ? parseFloat(form.tax.value) : null,
        tip: form.tip.value !== '' ? parseFloat(form.tip.value) : null,
        subtotal: form.dataset.subtotal ? parseFloat(form.dataset.subtotal) : null,
        merchant_city: form.city.value,
        merchant_state: form.state.value,
        matched_transaction_id: form.dataset.matchedId || receiptsScanResult?.matched_transaction?.transaction_id || null,
        spending_purpose: form.querySelector('input[name="spending_purpose"]:checked')?.value,
        project_id: form.querySelector('input[name="spending_purpose"]:checked')?.value === 'project'
            ? form.project_id.value
            : null,
    };

    if (statusEl) statusEl.textContent = 'Saving?';
    try {
        const res = await fetch('/api/receipts/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Save failed');
        if (statusEl) statusEl.textContent = 'Receipt saved';
        approvedProjectsCache = null;
        loadPurchases(true);
        clearReceiptsPageFile();
        await loadReceiptsHistory();
    } catch (err) {
        if (statusEl) statusEl.textContent = err.message;
    }
}

async function loadReceiptsHistory() {
    const list = document.getElementById('receipts-history-list');
    if (!list) return;
    try {
        const res = await fetch('/api/receipts');
        const records = await res.json();
        if (!res.ok) throw new Error(records.error || 'Failed to load receipts');
        if (!records.length) {
            list.innerHTML = '<div class="guardian-item">No saved receipts yet.</div>';
            return;
        }
        list.innerHTML = records.map((r) => {
            const d = r.receipt_data || {};
            const purpose = r.spending_purpose_label || (d.spending_purpose === 'personal' ? 'Personal use' : 'Project use');
            const projectLine = r.project_title || d.project_title
                ? `<span class="receipts-history-project">Project: ${escapeHtml(r.project_title || d.project_title)}</span>`
                : '';
            return `<div class="receipts-history-item">
                <strong>${escapeHtml(d.merchant || 'Receipt')}</strong>
                <span class="receipts-purpose-tag receipts-purpose-tag--${escapeHtml(r.spending_purpose || d.spending_purpose || 'project')}">${escapeHtml(purpose)}</span>
                ${projectLine}
                <span>${escapeHtml(d.date || '')} · ${escapeHtml(formatCad(d.amount))}</span>
                <span class="receipts-history-meta">${escapeHtml(r.employee_name || '')} · ${escapeHtml(r.confirmed_at || '')}</span>
            </div>`;
        }).join('');
    } catch (err) {
        list.innerHTML = `<div class="guardian-item">${escapeHtml(err.message)}</div>`;
    }
}

function loadReceiptsPage() {
    loadReceiptsHistory();
    refreshReceiptsProjectSelect();
}

function setupReceiptsPage() {
    const dropzone = document.getElementById('receipts-dropzone');
    const fileInput = document.getElementById('receipts-file-input');
    document.querySelectorAll('#receipts-form input[name="spending_purpose"]').forEach((radio) => {
        radio.addEventListener('change', syncReceiptsFormPurpose);
    });
    document.getElementById('receipts-project-select')?.addEventListener('change', async () => {
        const projects = await loadApprovedProjects();
        updateReceiptProjectHint(
            document.getElementById('receipts-project-select'),
            document.getElementById('receipts-project-spend-hint'),
            projects
        );
    });
    dropzone?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) setReceiptsPageFile(file);
    });
    dropzone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('receipts-dropzone--drag');
    });
    dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('receipts-dropzone--drag'));
    dropzone?.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('receipts-dropzone--drag');
        const file = e.dataTransfer.files?.[0];
        if (file) setReceiptsPageFile(file);
    });
    document.getElementById('receipts-remove-file')?.addEventListener('click', clearReceiptsPageFile);
    document.getElementById('receipts-scan-btn')?.addEventListener('click', scanReceiptsPageFile);
    document.getElementById('receipts-form')?.addEventListener('submit', saveReceiptsPageForm);
    document.getElementById('receipts-cancel-btn')?.addEventListener('click', clearReceiptsPageFile);
}

function setupPurchasesPage() {
    document.getElementById('purchases-search')?.addEventListener('input', (e) => {
        purchasesFilters.search = e.target.value;
        purchasesFilters.page = 1;
        renderPurchasesTable();
    });
    document.getElementById('purchases-dept-filter')?.addEventListener('change', (e) => {
        purchasesFilters.department = e.target.value;
        purchasesFilters.page = 1;
        renderPurchasesTable();
    });
    document.getElementById('purchases-cat-filter')?.addEventListener('change', (e) => {
        purchasesFilters.category = e.target.value;
        purchasesFilters.page = 1;
        renderPurchasesTable();
    });
    document.getElementById('purchases-flag-filter')?.addEventListener('change', (e) => {
        purchasesFilters.flagged = e.target.value;
        purchasesFilters.page = 1;
        renderPurchasesTable();
    });
    document.getElementById('purchases-sort')?.addEventListener('change', (e) => {
        purchasesFilters.sort = e.target.value;
        purchasesFilters.page = 1;
        renderPurchasesTable();
    });
    document.getElementById('purchases-prev')?.addEventListener('click', () => {
        purchasesFilters.page -= 1;
        renderPurchasesTable();
        document.getElementById('tx-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('purchases-next')?.addEventListener('click', () => {
        purchasesFilters.page += 1;
        renderPurchasesTable();
        document.getElementById('tx-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

async function loadPurchases(force = false) {
    const el = document.getElementById('tx-table');
    if (!el) return;
    if (purchasesLoaded && !force) {
        renderPurchasesTable();
        return;
    }
    el.innerHTML = '<div class="guardian-item">Loading all purchases?</div>';
    try {
        const res = await fetch('/api/purchases');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load purchases');
        purchasesData = data;
        purchasesLoaded = true;
        populatePurchasesFilters(data);
        renderPurchasesTable();
    } catch (err) {
        el.innerHTML = `<div class="guardian-item">${escapeHtml(err.message)}</div>`;
    }
}

function renderModalTransactions(transactions) {
    const el = document.getElementById('modal-tx-table');
    if (!el) return;
    el.innerHTML = `
        <table class="data-table tx-table">
            <thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th>Amt</th></tr></thead>
            <tbody>
                ${(transactions || []).map((tx) => `
                    <tr class="${tx.flagged ? 'tx-row--flagged' : ''}">
                        <td>${tx.date}</td>
                        <td>${tx.vendor}</td>
                        <td>${tx.category}</td>
                        <td>${tx.amount}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
}

function updateCompareUI() {
    const chips = document.getElementById('compare-chips');
    const btnCompare = document.getElementById('btn-run-compare');
    const names = [...compareSelection];

    if (chips) {
        chips.innerHTML = names.length
            ? names.map((n) => `
                <span class="compare-chip">${n.split(' ')[0]}
                    <button type="button" data-remove-compare="${n}" aria-label="Remove">×</button>
                </span>`).join('')
            : '<span class="compare-label" style="font-weight:500;text-transform:none">Select people to compare</span>';
    }

    const btnPdf = document.getElementById('btn-compare-pdf');
    if (btnCompare) btnCompare.disabled = names.length < 2;
    if (btnPdf) btnPdf.disabled = names.length < 1;

    document.querySelectorAll('.compare-select').forEach((cb) => {
        cb.checked = compareSelection.has(cb.dataset.employee);
    });

    const modalCheck = document.getElementById('modal-compare-check');
    if (modalCheck && modalEmployeeName) {
        modalCheck.checked = compareSelection.has(modalEmployeeName);
    }
}

async function openEmployeeModal(name) {
    if (!name) return;
    modalEmployeeName = name;
    const modal = document.getElementById('employee-modal');
    modal.hidden = false;

    document.getElementById('modal-employee-name').textContent = name;
    document.getElementById('modal-employee-meta').textContent = 'Loading Guardian employee data?';
    document.getElementById('modal-stats').innerHTML = '';
    renderModalTransactions([]);

    try {
        const res = await fetch('/api/employee?name=' + encodeURIComponent(name));
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load employee');

        document.getElementById('modal-employee-meta').textContent =
            `${data.employee_id} · ${escapeHtml(data.department || '?')} · Credit score ${formatCreditScore(data.credit_score)}`;
        document.getElementById('modal-stats').innerHTML = `
            <div class="modal-stat"><span>Total</span><strong>${data.total_spend_fmt}</strong></div>
            <div class="modal-stat"><span>Txns</span><strong>${data.transaction_count}</strong></div>
            <div class="modal-stat"><span>Flagged</span><strong>${data.flagged_count}</strong></div>
            <div class="modal-stat"><span>Score</span><strong>${formatCreditScore(data.credit_score)}</strong></div>
        `;

        const cityChart = data.by_city || { labels: [], values: [] };
        renderChartInModal('modal-chart-city', { type: 'doughnut', labels: cityChart.labels, values: cityChart.values });
        renderChartInModal('modal-chart-month', { type: 'line', labels: data.by_month?.labels || [], values: data.by_month?.values || [] });
        renderModalTransactions(data.recent_transactions);
        updateCompareUI();
    } catch (e) {
        document.getElementById('modal-employee-meta').textContent = e.message;
    }
}

function renderChartInModal(canvasId, chartData) {
    renderChartSafe(canvasId, chartData, modalCharts);
}

function closeEmployeeModal() {
    document.getElementById('employee-modal').hidden = true;
    modalEmployeeName = null;
    Object.values(modalCharts).forEach((c) => c.destroy());
    modalCharts = {};
}

async function openCompareModal() {
    const names = [...compareSelection];
    if (names.length < 2) return;

    const modal = document.getElementById('compare-modal');
    modal.hidden = false;
    document.getElementById('compare-modal-subtitle').textContent = names.join(' vs ');

    try {
        const res = await fetch('/api/compare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ names }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Compare failed');

        const canvas = document.getElementById('compare-chart');
        if (compareChart) compareChart.destroy();

        const comp = data.comparison?.by_city || { labels: [], datasets: [] };
        if (!comp.labels?.length) {
            document.getElementById('compare-summary-table').innerHTML =
                '<div class="guardian-item">No city comparison data available.</div>';
            return;
        }
        compareChart = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: comp.labels,
                datasets: comp.datasets.map((ds, i) => ({
                    label: ds.name,
                    data: ds.values,
                    backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
                    borderRadius: 6,
                })),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: true, position: 'bottom' } },
                scales: { y: { ticks: { callback: moneyTick } } },
            },
        });

        document.getElementById('compare-summary-table').innerHTML = `
            <table class="data-table tx-table">
                <thead><tr><th>Employee</th><th>Total</th><th>Txns</th><th>Flagged</th><th>Score</th></tr></thead>
                <tbody>
                    ${data.employees.map((e) => `
                        <tr>
                            <td><button type="button" class="emp-link" data-employee="${e.name}">${e.name}</button></td>
                            <td>${e.total_spend_fmt}</td>
                            <td>${e.transaction_count}</td>
                            <td>${e.flagged_count}</td>
                            <td>${formatCreditScore(e.credit_score)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>`;
    } catch (e) {
        document.getElementById('compare-modal-subtitle').textContent = e.message;
    }
}

function closeCompareModal() {
    document.getElementById('compare-modal').hidden = true;
    if (compareChart) {
        compareChart.destroy();
        compareChart = null;
    }
}

function filenameFromDisposition(header) {
    if (!header) return null;
    const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8) return decodeURIComponent(utf8[1]);
    const plain = header.match(/filename="?([^";]+)"?/i);
    return plain ? plain[1] : null;
}

async function downloadPdfReport(names) {
    if (!names.length) return;
    try {
        const res = await fetch('/api/report/pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ names }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'PDF failed');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filenameFromDisposition(res.headers.get('Content-Disposition'))
            || `mpc-spending-${names.length > 1 ? 'comparison' : names[0].toLowerCase().replace(/\s+/g, '-')}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        alert(e.message);
    }
}

function toggleCompareName(name, checked) {
    if (!name) return;
    if (checked) compareSelection.add(name);
    else compareSelection.delete(name);
    updateCompareUI();
}

function setupEmployeeInteractions() {
    document.body.addEventListener('click', (e) => {
        const empBtn = e.target.closest('[data-employee]');
        if (empBtn && !e.target.closest('.compare-select') && !e.target.closest('[data-remove-compare]')) {
            if (empBtn.classList.contains('compare-select')) return;
            const name = empBtn.dataset.employee;
            if (name && !e.target.closest('#compare-modal')) {
                openEmployeeModal(name);
            }
        }

        if (e.target.closest('[data-close-modal]')) closeEmployeeModal();
        if (e.target.closest('[data-close-compare]')) closeCompareModal();

        const removeBtn = e.target.closest('[data-remove-compare]');
        if (removeBtn) {
            compareSelection.delete(removeBtn.dataset.removeCompare);
            updateCompareUI();
            document.querySelectorAll('.compare-select').forEach((cb) => {
                if (cb.dataset.employee === removeBtn.dataset.removeCompare) cb.checked = false;
            });
        }
    });

    document.body.addEventListener('change', (e) => {
        if (e.target.classList.contains('compare-select')) {
            toggleCompareName(e.target.dataset.employee, e.target.checked);
        }
        if (e.target.id === 'modal-compare-check' && modalEmployeeName) {
            toggleCompareName(modalEmployeeName, e.target.checked);
        }
    });

    document.getElementById('btn-run-compare')?.addEventListener('click', openCompareModal);
    document.getElementById('btn-compare-pdf')?.addEventListener('click', () => {
        downloadPdfReport([...compareSelection]);
    });
    document.getElementById('modal-download-pdf')?.addEventListener('click', () => {
        if (modalEmployeeName) downloadPdfReport([modalEmployeeName]);
    });
    document.getElementById('compare-download-pdf')?.addEventListener('click', () => {
        downloadPdfReport([...compareSelection]);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeEmployeeModal();
            closeCompareModal();
        }
    });
}

function bindEmpChartClick(labels) {
    const chart = dashboardCharts['chart-emp'];
    if (!chart || !labels?.length) return;
    chart.options.onClick = (_, elements) => {
        if (elements.length) openEmployeeModal(labels[elements[0].index]);
    };
    chart.update();
}

let peopleChartLoaded = false;

async function loadDashboard() {
    const statsEl = document.getElementById('dashboard-stats');
    try {
        if (typeof Chart === 'undefined') {
            throw new Error('Chart.js failed to load. Check your network connection and refresh.');
        }

        const [dashRes, empRes] = await Promise.all([
            fetch('/api/dashboard'),
            fetch('/api/employees'),
        ]);
        const data = await dashRes.json().catch(() => ({}));
        const employees = await empRes.json().catch(() => []);

        if (!dashRes.ok || !empRes.ok) {
            throw new Error(data.error || `API error (dashboard ${dashRes.status}, employees ${empRes.status})`);
        }
        if (!data.totals || !Array.isArray(data.recent)) {
            throw new Error('Dashboard returned unexpected data. Restart the Flask server after running python new_transactions.py.');
        }

        renderOverviewStats(data.totals, 'dashboard-stats', data.scope === 'employee');
        renderDepartmentList(data.departments, 'dashboard-departments');
        renderTeamRoster(employees);
        renderActivityFeed(data.recent);
        updateCompareUI();
        refreshNavBadges();

        const deptChart = data.scope === 'employee'
            ? { labels: data.by_category?.labels || [], values: data.by_category?.values || [] }
            : { labels: data.by_employee?.labels || [], values: data.by_employee?.values || [] };
        renderChart('chart-dept', { type: 'doughnut', labels: deptChart.labels, values: deptChart.values });
        renderChart('chart-month', {
            type: 'line',
            labels: data.by_month?.labels || [],
            values: data.by_month?.cumulative || data.by_month?.values || [],
        });
        dashboardPayload = data;
        peopleChartLoaded = false;
    } catch (e) {
        console.error('Dashboard load error:', e);
        if (statsEl) {
            statsEl.innerHTML = `<div class="guardian-item dashboard-error">${escapeHtml(e.message)}</div>`;
        }
    }
}

function loadPeopleChart(data) {
    if (peopleChartLoaded || !data) return;
    renderChart('chart-emp', {
        type: 'bar',
        labels: data.by_employee_all?.labels || [],
        values: data.by_employee_all?.values || [],
    });
    bindEmpChartClick(data.by_employee_all?.labels || []);
    peopleChartLoaded = true;
}

let dashboardPayload = null;

function setupAttachmentInput() {
    const attachBtn = document.getElementById('attach-btn');
    const fileInput = document.getElementById('receipt-input');
    const removeBtn = document.getElementById('attachment-remove');
    const composer = document.querySelector('.composer');

    attachBtn?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) setAttachment(file);
    });

    removeBtn?.addEventListener('click', clearAttachment);

    composer?.addEventListener('dragover', (e) => {
        e.preventDefault();
        composer.classList.add('composer--drag');
    });

    composer?.addEventListener('dragleave', (e) => {
        if (!composer.contains(e.relatedTarget)) {
            composer.classList.remove('composer--drag');
        }
    });

    composer?.addEventListener('drop', (e) => {
        e.preventDefault();
        composer.classList.remove('composer--drag');
        const file = e.dataTransfer.files?.[0];
        if (file) setAttachment(file);
    });
}

const PAGE_TITLES = {
    overview: 'Home',
    people: 'People',
    activity: 'All purchases',
    receipts: 'Receipts',
    proposals: 'My projects',
    'trip-reports': 'Travel reports',
    budget: 'Budgets',
    map: 'Map',
    alerts: 'Problems',
    approvals: 'Review',
    chat: 'Friday',
    settings: 'Settings',
};

const PAGE_SUBTITLES = {
    overview: 'Pick what you want to do ? everything is one click away.',
    people: 'Tap a name for details. Check boxes to compare people.',
    activity: 'Search, filter, and sort every purchase.',
    receipts: 'Scan receipts, match to transactions, and save confirmations.',
    proposals: 'Request budget for a project ? your manager or CEO will review it.',
    'trip-reports': 'Bundle travel purchases and submit them for reimbursement review.',
    budget: 'See if departments are running out of money.',
    map: 'Where purchases happened around the world.',
    alerts: 'Repeat offenders and purchases that look wrong.',
    approvals: 'Pending requests and fraud-flagged purchases in one priority queue.',
    chat: '',
    settings: 'Set department budgets and spending rules in one place.',
};

const COMMAND_ITEMS = [
    { id: 'overview', label: 'Home', group: 'Pages', icon: 'fa-house', keywords: 'home start dashboard' },
    { id: 'budget', label: 'Budgets', group: 'Pages', icon: 'fa-wallet', keywords: 'money budget remaining forecast' },
    { id: 'activity', label: 'All purchases', group: 'Pages', icon: 'fa-receipt', keywords: 'transactions purchases list' },
    { id: 'receipts', label: 'Receipts', group: 'Pages', icon: 'fa-camera', keywords: 'receipt scan ocr upload photo' },
    { id: 'proposals', label: 'My projects', group: 'Pages', icon: 'fa-folder-open', keywords: 'project budget request proposal submit my projects' },
    { id: 'trip-reports', label: 'Travel reports', group: 'Pages', icon: 'fa-suitcase-rolling', keywords: 'travel trip expense report reimbursement submit' },
    { id: 'people', label: 'People', group: 'Pages', icon: 'fa-users', keywords: 'department employees roster' },
    { id: 'map', label: 'Map', group: 'Pages', icon: 'fa-map-location-dot', keywords: 'location cities map' },
    { id: 'alerts', label: 'Problems', group: 'Pages', icon: 'fa-triangle-exclamation', keywords: 'flags policy violations bad purchases' },
    { id: 'approvals', label: 'Review', group: 'Pages', icon: 'fa-clipboard-check', keywords: 'pending approve deny fraud review queue' },
    { id: 'chat', label: 'Friday', group: 'Pages', icon: 'fa-comments', keywords: 'ai chat ask question help voice friday' },
    { id: 'settings', label: 'Settings', group: 'Setup', icon: 'fa-gear', keywords: 'department budget rules policy edit configure' },
    { id: 'settings:budgets', label: 'Settings: Department budgets', group: 'Setup', icon: 'fa-wallet', view: 'settings', settingsTab: 'budgets' },
    { id: 'settings:rules', label: 'Settings: Spending rules', group: 'Setup', icon: 'fa-pen', view: 'settings', settingsTab: 'rules' },
    { id: 'chat:marketing', label: 'Ask: Marketing spend', group: 'Quick questions', icon: 'fa-comment', action: 'prompt', prompt: 'What did Marketing spend on software last quarter?' },
    { id: 'section-offenders', label: 'Repeat offenders', group: 'On Problems page', icon: 'fa-user-xmark', view: 'alerts', scroll: 'section-offenders' },
    { id: 'section-flags', label: 'Bad purchases', group: 'On Problems page', icon: 'fa-flag', view: 'alerts', scroll: 'section-flags' },
];

let navigateTo = () => {};
let currentViewKey = 'overview';

function updateNavBadges(counts) {
    const setBadge = (id, n, warn = false) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (!n || n <= 0) {
            el.hidden = true;
            return;
        }
        el.hidden = false;
        el.textContent = n > 99 ? '99+' : String(n);
        el.classList.toggle('nav-badge--warn', warn);
    };
    setBadge('nav-badge-flags', counts?.flags);
    const reviewTotal = counts?.review_pending ?? ((counts?.approvals || 0) + (counts?.fraud_pending || 0));
    setBadge('nav-badge-approvals', reviewTotal, true);
}

async function refreshNavBadges() {
    try {
        const res = await fetch('/api/nav');
        if (res.ok) {
            const data = await res.json();
            cachedNavCounts = data;
            updateNavBadges(data);
        }
    } catch (e) {
        console.warn('Nav badges:', e);
    }
}

function setupQuickNavCards() {
    document.querySelectorAll(
        '.home-action-card[data-insight], .home-action-link[data-insight], .quick-nav-card[data-insight], .panel-link[data-insight], .page-help-link[data-insight]'
    ).forEach((card) => {
        card.addEventListener('click', () => {
            const tab = card.dataset.settingsTab;
            navigateTo(card.dataset.insight, tab ? { tab } : {});
        });
    });
}

function setupWorkflowStrip() {
    /* workflow strip removed ? sidebar + home actions are enough */
}

function setupSidebarToggle() {
    const shell = document.querySelector('.app-shell');
    const toggle = document.getElementById('sidebar-toggle');
    if (!shell || !toggle) return;

    if (window.matchMedia('(max-width: 900px)').matches) {
        shell.classList.add('sidebar-collapsed');
    }

    toggle.addEventListener('click', () => {
        shell.classList.toggle('sidebar-collapsed');
    });

    document.querySelector('.sidebar-nav')?.addEventListener('click', (e) => {
        const item = e.target.closest('.nav-item[data-insight]');
        if (item && window.matchMedia('(max-width: 900px)').matches) {
            shell.classList.add('sidebar-collapsed');
        }
    });
}

function openCommandPalette() {
    const palette = document.getElementById('command-palette');
    const input = document.getElementById('command-palette-input');
    if (!palette || !input) return;
    palette.hidden = false;
    input.value = '';
    renderCommandList('');
    input.focus();
}

function closeCommandPalette() {
    const palette = document.getElementById('command-palette');
    if (palette) palette.hidden = true;
}

function renderCommandList(query) {
    const list = document.getElementById('command-palette-list');
    if (!list) return;
    const q = query.trim().toLowerCase();
    const matches = COMMAND_ITEMS.filter((item) => {
        if (!q) return true;
        return (
            item.label.toLowerCase().includes(q)
            || item.group.toLowerCase().includes(q)
            || (item.keywords || '').includes(q)
        );
    });

    if (!matches.length) {
        list.innerHTML = '<li class="command-empty">No matches</li>';
        return;
    }

    let lastGroup = '';
    list.innerHTML = matches.map((item) => {
        const groupHeader = item.group !== lastGroup
            ? `<li class="command-group">${escapeHtml(item.group)}</li>`
            : '';
        lastGroup = item.group;
        return `${groupHeader}<li>
            <button type="button" class="command-item" data-command-id="${escapeHtml(item.id)}">
                <i class="fa-solid ${item.icon}"></i>
                <span>${escapeHtml(item.label)}</span>
            </button>
        </li>`;
    }).join('');

    list.querySelectorAll('.command-item').forEach((btn) => {
        btn.addEventListener('click', () => runCommand(btn.dataset.commandId));
    });
}

function runCommand(commandId) {
    const item = COMMAND_ITEMS.find((c) => c.id === commandId);
    if (!item) return;
    closeCommandPalette();

    if (item.action === 'prompt') {
        navigateTo('chat');
        const input = document.getElementById('message-input');
        if (input) {
            input.value = item.prompt;
            input.focus();
        }
        return;
    }

    if (item.action === 'policy-editor') {
        navigateTo('settings', { tab: 'rules' });
        return;
    }

    if (item.view) {
        navigateTo(item.view, { scroll: item.scroll, tab: item.settingsTab });
        return;
    }

    navigateTo(item.id, { scroll: item.scroll, tab: item.settingsTab });
}

function setupCommandPalette() {
    document.getElementById('quick-jump-btn')?.addEventListener('click', openCommandPalette);
    document.querySelectorAll('[data-close-palette]').forEach((el) => {
        el.addEventListener('click', closeCommandPalette);
    });

    const input = document.getElementById('command-palette-input');
    input?.addEventListener('input', (e) => renderCommandList(e.target.value));
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeCommandPalette();
        if (e.key === 'Enter') {
            const first = document.querySelector('.command-item');
            if (first) runCommand(first.dataset.commandId);
        }
    });

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            openCommandPalette();
        }
        if (e.key === 'Escape') closeCommandPalette();
    });
}
let expenseMap = null;
let expenseMapCityMarkers = [];
let expenseMapMerchantMarkers = [];
let expenseMapCityData = null;
let expenseMapLoaded = false;
let googleMapsLoading = null;
let mapMerchantFetchTimer = null;
let mapMerchantFetchSeq = 0;
const MAP_MERCHANT_ZOOM = 7;
const MAP_DENSITY_COLORS = ['#BAFFC9', '#BAE1FF', '#ACBCFF', '#B799FF', '#FFD4B2', '#FFAACF', '#EF4444'];

function hexToRgb(hex) {
    const value = hex.replace('#', '');
    return {
        r: parseInt(value.slice(0, 2), 16),
        g: parseInt(value.slice(2, 4), 16),
        b: parseInt(value.slice(4, 6), 16),
    };
}

function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

function interpolateColor(start, end, amount) {
    const from = hexToRgb(start);
    const to = hexToRgb(end);
    const t = Math.max(0, Math.min(1, amount));
    return rgbToHex(
        Math.round(from.r + (to.r - from.r) * t),
        Math.round(from.g + (to.g - from.g) * t),
        Math.round(from.b + (to.b - from.b) * t),
    );
}

function merchantCountColor(count, maxCount) {
    if (!count || maxCount <= 1) return MAP_DENSITY_COLORS[0];
    const palette = MAP_DENSITY_COLORS;
    const position = ((count - 1) / (maxCount - 1)) * (palette.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(palette.length - 1, lower + 1);
    const blend = position - lower;
    return interpolateColor(palette[lower], palette[upper], blend);
}

function merchantCountScale(count, maxCount) {
    if (!count || maxCount <= 1) return 7;
    return 7 + Math.round((count / maxCount) * 12);
}

function getGoogleMapsApiKey() {
    return document.querySelector('.app-shell')?.dataset.mapsKey || '';
}

function loadGoogleMapsScript() {
    if (window.google?.maps) return Promise.resolve();
    if (googleMapsLoading) return googleMapsLoading;

    const apiKey = getGoogleMapsApiKey();
    if (!apiKey) return Promise.reject(new Error('Google Maps API key is not configured.'));

    googleMapsLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}`;
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load Google Maps.'));
        document.head.appendChild(script);
    });

    return googleMapsLoading;
}

function clearExpenseMapCityMarkers() {
    expenseMapCityMarkers.forEach((marker) => marker.setMap(null));
    expenseMapCityMarkers = [];
}

function clearExpenseMapMerchantMarkers() {
    expenseMapMerchantMarkers.forEach((marker) => marker.setMap(null));
    expenseMapMerchantMarkers = [];
}

function createCircleMarker(position, color, scale, title, map) {
    return new google.maps.Marker({
        position,
        map,
        title,
        icon: {
            path: google.maps.SymbolPath.CIRCLE,
            fillColor: color,
            fillOpacity: 0.9,
            strokeColor: '#ffffff',
            strokeWeight: 2,
            scale,
        },
    });
}

function renderCityMarkers(locations, map) {
    clearExpenseMapCityMarkers();
    if (!locations.length) return;

    const maxMerchants = Math.max(...locations.map((loc) => loc.merchant_count || 1));
    locations.forEach((loc) => {
        const position = { lat: loc.lat, lng: loc.lng };
        const merchantCount = loc.merchant_count || 1;
        const scale = merchantCountScale(merchantCount, maxMerchants);
        const color = merchantCountColor(merchantCount, maxMerchants);
        const marker = createCircleMarker(
            position,
            color,
            scale,
            loc.location,
            map,
        );

        const info = new google.maps.InfoWindow({
            content: `
                <div class="map-info">
                    <strong>${escapeHtml(loc.location)}</strong>
                    <div>${merchantCount} merchants · ${loc.transactions} transactions</div>
                    <div>${escapeHtml(loc.spend_fmt)} total spend</div>
                    ${loc.flagged ? `<div class="map-info-flag">${loc.flagged} flagged</div>` : ''}
                    <div class="map-info-team">${escapeHtml(loc.employees.slice(0, 4).join(', '))}${loc.employees.length > 4 ? '?' : ''}</div>
                    <div class="map-info-hint">Zoom in to see each purchase</div>
                </div>`,
        });

        marker.addListener('click', () => info.open({ anchor: marker, map }));
        expenseMapCityMarkers.push(marker);
    });
}

function purchaseMarkerScale(zoom, flagged) {
    const base = flagged ? 7 : 5;
    if (zoom < 10) return base + 3;
    if (zoom < 12) return base + 1;
    return base;
}

function renderMerchantMarkers(merchants, map) {
    clearExpenseMapMerchantMarkers();
    if (!merchants.length) return;

    const zoom = map.getZoom();

    merchants.forEach((item) => {
        const position = { lat: item.lat, lng: item.lng };
        const scale = purchaseMarkerScale(zoom, item.flagged);
        const color = item.flagged ? '#EF4444' : '#2563EB';
        const marker = createCircleMarker(
            position,
            color,
            scale,
            item.vendor,
            map,
        );

        const info = new google.maps.InfoWindow({
            content: `
                <div class="map-info">
                    <strong>${escapeHtml(item.vendor)}</strong>
                    <div>${escapeHtml(item.employee || '')}${item.department ? ` · ${escapeHtml(item.department)}` : ''}</div>
                    ${item.street_address ? `<div>${escapeHtml(item.street_address)}</div>` : ''}
                    <div>${escapeHtml(item.location)}${item.postal ? ` · ${escapeHtml(item.postal)}` : ''}</div>
                    <div>${escapeHtml(item.spend_fmt)} · ${escapeHtml(item.date || '')}</div>
                    ${item.flagged ? `<div class="map-info-flag">Flagged purchase</div>` : ''}
                </div>`,
        });

        marker.addListener('click', () => info.open({ anchor: marker, map }));
        expenseMapMerchantMarkers.push(marker);
    });
}

async function fetchMerchantsInView(map) {
    const bounds = map.getBounds();
    if (!bounds) return;

    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const params = new URLSearchParams({
        north: ne.lat(),
        south: sw.lat(),
        east: ne.lng(),
        west: sw.lng(),
        limit: '400',
        _: String(Date.now()),
    });

    const noteEl = document.getElementById('map-note');
    const fetchId = ++mapMerchantFetchSeq;
    if (noteEl) noteEl.textContent = 'Loading purchases in this area?';

    const res = await fetch(`/api/map-merchants?${params.toString()}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load purchases on map');
    if (fetchId !== mapMerchantFetchSeq) return;

    if (map.getZoom() >= MAP_MERCHANT_ZOOM) {
        renderMerchantMarkers(data.merchants || [], map);
        updateMapSummary(data, true);
    }
}

function updateMapSummary(data, merchantMode) {
    const summaryEl = document.getElementById('map-summary');
    const noteEl = document.getElementById('map-note');
    if (!summaryEl) return;

    if (merchantMode) {
        summaryEl.textContent =
            `${data.plotted} purchases in view · ${data.total_in_view} total here · ${data.total_merchants} mapped purchases`;
        if (noteEl) {
            noteEl.textContent = 'Each circle is one purchase at its merchant street address. Red = flagged. More addresses geocode as you explore the map.';
        }
        return;
    }

    summaryEl.textContent =
        `${data.plotted} areas · ${data.mapped_spend_fmt} mapped spend · ${data.total_locations} locations in data`;
    if (noteEl) {
        noteEl.textContent = 'Zoom in to see a circle for each purchase at its street address from the CSV.';
    }
}

function scheduleMerchantRefresh() {
    if (!expenseMap) return;
    clearTimeout(mapMerchantFetchTimer);
    mapMerchantFetchTimer = setTimeout(async () => {
        if (!expenseMap || expenseMap.getZoom() < MAP_MERCHANT_ZOOM) return;
        try {
            await fetchMerchantsInView(expenseMap);
        } catch (err) {
            console.error('Merchant map load error:', err);
        }
    }, 250);
}

function updateMapLayers() {
    if (!expenseMap) return;

    const zoom = expenseMap.getZoom();
    const showMerchants = zoom >= MAP_MERCHANT_ZOOM;

    expenseMapCityMarkers.forEach((marker) => {
        marker.setMap(showMerchants ? null : expenseMap);
    });

    if (showMerchants) {
        scheduleMerchantRefresh();
        return;
    }

    clearExpenseMapMerchantMarkers();
    if (expenseMapCityData?.locations?.length) {
        updateMapSummary(expenseMapCityData, false);
    }
}

function renderExpenseMap(data) {
    const mapEl = document.getElementById('expense-map');
    const summaryEl = document.getElementById('map-summary');
    const noteEl = document.getElementById('map-note');
    if (!mapEl || !window.google?.maps) return;

    clearExpenseMapCityMarkers();
    clearExpenseMapMerchantMarkers();

    const locations = data?.locations || [];
    expenseMapCityData = data;
    if (!locations.length) {
        mapEl.innerHTML = '<div class="map-empty">No mappable locations found for the current data.</div>';
        if (summaryEl) summaryEl.textContent = 'No locations to display.';
        if (noteEl) noteEl.textContent = '';
        return;
    }

    mapEl.innerHTML = '';

    expenseMap = new google.maps.Map(mapEl, {
        center: { lat: 39.8283, lng: -98.5795 },
        zoom: 4,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        styles: [
            { featureType: 'poi', stylers: [{ visibility: 'off' }] },
        ],
    });

    const bounds = new google.maps.LatLngBounds();
    locations.forEach((loc) => bounds.extend({ lat: loc.lat, lng: loc.lng }));

    renderCityMarkers(locations, expenseMap);
    expenseMap.fitBounds(bounds, 48);
    updateMapSummary(data, false);

    google.maps.event.addListener(expenseMap, 'zoom_changed', updateMapLayers);
    google.maps.event.addListener(expenseMap, 'dragend', scheduleMerchantRefresh);
    google.maps.event.addListener(expenseMap, 'idle', () => {
        if (expenseMap.getZoom() >= MAP_MERCHANT_ZOOM) scheduleMerchantRefresh();
    });
}

async function loadExpenseMap() {
    const mapEl = document.getElementById('expense-map');
    const summaryEl = document.getElementById('map-summary');
    if (!mapEl) return;

    if (!getGoogleMapsApiKey()) {
        mapEl.innerHTML = '<div class="map-empty">Add GOOGLE_MAPS_API_KEY to your .env file to enable Google Maps.</div>';
        if (summaryEl) summaryEl.textContent = 'Google Maps API key required.';
        return;
    }

    mapEl.innerHTML = '<div class="map-loading">Loading map?</div>';

    try {
        await loadGoogleMapsScript();
        const res = await fetch('/api/map-locations');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load map data');
        renderExpenseMap(data);
        expenseMapLoaded = true;
    } catch (err) {
        mapEl.innerHTML = `<div class="map-empty">${err.message}</div>`;
        if (summaryEl) summaryEl.textContent = 'Unable to load map.';
        console.error('Map load error:', err);
    }
}

function setupSidebarNav() {
    const views = {
        overview: document.getElementById('insight-overview'),
        people: document.getElementById('insight-people'),
        activity: document.getElementById('insight-activity'),
        receipts: document.getElementById('insight-receipts'),
        proposals: document.getElementById('insight-proposals'),
        'trip-reports': document.getElementById('insight-trip-reports'),
        budget: document.getElementById('insight-budget'),
        map: document.getElementById('insight-map'),
        alerts: document.getElementById('insight-alerts'),
        approvals: document.getElementById('insight-approvals'),
        chat: document.getElementById('insight-chat'),
        settings: document.getElementById('insight-settings'),
    };
    const tabs = document.querySelectorAll('.nav-item[data-insight]');
    const pageTitle = document.getElementById('page-title');
    const pageSubtitle = document.getElementById('page-subtitle');

    const ADMIN_VIEWS = new Set(['budget', 'people', 'alerts', 'approvals', 'settings']);

    function switchView(key, options = {}) {
        if (key === 'fraud') {
            key = 'approvals';
            options.reviewFilter = 'fraud';
        }
        if (!IS_ADMIN && ADMIN_VIEWS.has(key)) {
            key = 'overview';
        }
        if (!key || !views[key]) return;
        currentViewKey = key;
        Object.values(views).forEach((v) => v?.classList.remove('insight-view--active'));
        views[key].classList.add('insight-view--active');
        tabs.forEach((t) => t.classList.toggle('nav-item--active', t.dataset.insight === key));

        const title = PAGE_TITLES[key] || 'Home';
        if (pageTitle) pageTitle.textContent = title;
        if (pageSubtitle) {
            pageSubtitle.textContent = PAGE_SUBTITLES[key] || '';
            pageSubtitle.hidden = key === 'chat' || !PAGE_SUBTITLES[key];
        }
        document.body.classList.toggle('view-chat', key === 'chat');

        if (key !== 'overview') {
            history.replaceState(null, '', `#/${key}`);
        } else {
            history.replaceState(null, '', window.location.pathname);
        }

        if (key === 'people') loadPeopleChart(dashboardPayload);
        if (key === 'activity') loadPurchases();
        if (key === 'receipts') loadReceiptsPage();
        if (key === 'proposals') loadProposals();
        if (key === 'trip-reports') loadTripReports();
        if (key === 'budget') loadBudget();
        if (key === 'settings') loadSettings(false, options.tab || 'budgets');
        if (key === 'alerts') loadFlags();
        if (key === 'approvals') {
            if (options.reviewFilter) {
                reviewFilter = options.reviewFilter;
                document.querySelectorAll('[data-review-filter]').forEach((b) => {
                    b.classList.toggle('review-filter--active', b.dataset.reviewFilter === reviewFilter);
                });
            }
            loadReview(options.forceReview);
        }
        if (key === 'map' && !expenseMapLoaded) loadExpenseMap();
        if (key === 'map' && expenseMapLoaded && expenseMap) {
            google.maps.event.trigger(expenseMap, 'resize');
            const allMarkers = [...expenseMapCityMarkers, ...expenseMapMerchantMarkers];
            if (allMarkers.length) {
                const bounds = new google.maps.LatLngBounds();
                allMarkers.forEach((marker) => bounds.extend(marker.getPosition()));
                expenseMap.fitBounds(bounds, 48);
            }
        }

        if (options.scroll) {
            requestAnimationFrame(() => scrollToSection(options.scroll));
        }
        if (options.tab && key === 'settings') {
            requestAnimationFrame(() => switchSettingsTab(options.tab));
        }

        document.querySelector('.main-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });

        const voiceRoot = document.getElementById('voice-assistant');
        if (voiceRoot) voiceRoot.classList.toggle('voice-assistant--on-chat', key === 'chat');
    }

    navigateTo = switchView;

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => switchView(tab.dataset.insight));
    });

    const hash = window.location.hash.replace(/^#\/?/, '');
    if (hash && (views[hash] || hash === 'fraud')) {
        switchView(hash, hash === 'fraud' ? { reviewFilter: 'fraud' } : {});
    } else {
        switchView('overview');
    }

    window.addEventListener('hashchange', () => {
        const view = window.location.hash.replace(/^#\/?/, '');
        if (view && (views[view] || view === 'fraud') && view !== currentViewKey) {
            switchView(view, view === 'fraud' ? { reviewFilter: 'fraud' } : {});
        }
    });
}

function setupBudgetDeptList() {
    document.getElementById('budget-dept-list')?.addEventListener('click', (e) => {
        const item = e.target.closest('.budget-dept-item[data-dept]');
        if (!item) return;
        selectBudgetProjection(item.dataset.dept);
    });
}

function setupInsightTabs() {
    setupSidebarNav();
    setupBudgetDeptList();
    setupQuickNavCards();
    setupWorkflowStrip();
    setupSectionSubnav();
    setupReviewWorkspace();
    setupProposalForm();
    setupTripReportForm();
    setupSidebarToggle();
    setupCommandPalette();
}

let voiceRecognition = null;
let voiceListening = false;
let voiceSpeaking = false;
let voiceAudioEl = null;
let voiceAudioUrl = null;
let elevenLabsReady = false;
let cachedNavCounts = null;

const VOICE_DATA_HINTS = /\b(how much|how many|who|what did|tell me|explain|compare|spend|total|count|why|when|which|list)\b/i;

function stripForSpeech(text) {
    return (text || '')
        .replace(/\*\*|__|\*|_|`|#+\s?/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function stopVoiceAudio() {
    if (voiceAudioEl) {
        voiceAudioEl.pause();
        voiceAudioEl.src = '';
        voiceAudioEl = null;
    }
    if (voiceAudioUrl) {
        URL.revokeObjectURL(voiceAudioUrl);
        voiceAudioUrl = null;
    }
    speechSynthesis.cancel();
}

function warmElevenLabs() {
    if (elevenLabsReady) return;
    elevenLabsReady = true;
    fetch('/api/voice/ready', { credentials: 'same-origin' }).catch(() => {});
}

function waitSourceBuffer(sourceBuffer) {
    if (!sourceBuffer.updating) return Promise.resolve();
    return new Promise((resolve) => {
        sourceBuffer.addEventListener('updateend', resolve, { once: true });
    });
}

function playBlobAudio(blob) {
    return new Promise((resolve, reject) => {
        stopVoiceAudio();
        voiceAudioEl = new Audio();
        voiceAudioUrl = URL.createObjectURL(blob);
        voiceAudioEl.src = voiceAudioUrl;
        voiceSpeaking = true;
        updateVoiceUiState();
        voiceAudioEl.onended = () => {
            voiceSpeaking = false;
            updateVoiceUiState();
            resolve();
        };
        voiceAudioEl.onerror = () => {
            voiceSpeaking = false;
            updateVoiceUiState();
            reject(new Error('Audio playback failed'));
        };
        voiceAudioEl.play().catch(reject);
    });
}

async function playStreamingMp3(response) {
    if (!window.MediaSource || !MediaSource.isTypeSupported('audio/mpeg') || !response.body) {
        return playBlobAudio(await response.blob());
    }

    return new Promise((resolve, reject) => {
        stopVoiceAudio();
        const mediaSource = new MediaSource();
        voiceAudioUrl = URL.createObjectURL(mediaSource);
        voiceAudioEl = new Audio();
        voiceAudioEl.src = voiceAudioUrl;
        voiceSpeaking = true;
        updateVoiceUiState();

        const finish = (err) => {
            voiceSpeaking = false;
            updateVoiceUiState();
            if (err) reject(err);
            else resolve();
        };

        voiceAudioEl.onended = () => finish();
        voiceAudioEl.onerror = () => finish(new Error('Streaming audio failed'));

        mediaSource.addEventListener('sourceopen', async () => {
            try {
                const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
                const reader = response.body.getReader();
                voiceAudioEl.play().catch(() => {});

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        await waitSourceBuffer(sourceBuffer);
                        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
                        break;
                    }
                    await waitSourceBuffer(sourceBuffer);
                    sourceBuffer.appendBuffer(value);
                }
            } catch (err) {
                finish(err);
            }
        }, { once: true });
    });
}

function speakWebSpeechFallback(text) {
    if (!('speechSynthesis' in window)) return Promise.resolve();
    speechSynthesis.cancel();
    return new Promise((resolve) => {
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1.05;
        utter.onend = () => {
            voiceSpeaking = false;
            updateVoiceUiState();
            resolve();
        };
        utter.onerror = () => {
            voiceSpeaking = false;
            updateVoiceUiState();
            resolve();
        };
        voiceSpeaking = true;
        updateVoiceUiState();
        speechSynthesis.speak(utter);
    });
}

async function speakVoiceReply(text) {
    const cleaned = stripForSpeech(text);
    if (!cleaned) return;

    stopVoiceAudio();

    try {
        const res = await fetch('/api/voice/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ text: cleaned }),
        });
        if (!res.ok) throw new Error(`TTS ${res.status}`);
        await playStreamingMp3(res);
    } catch (err) {
        console.warn('ElevenLabs unavailable, using browser speech:', err);
        await speakWebSpeechFallback(cleaned);
    }
}

function detectVoiceNavFromTranscript(transcript) {
    const low = transcript.toLowerCase();
    const normalized = low
        .replace(/\b(the|a|an|section|page|tab|area|screen|panel|part)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const navTriggers = [
        'open', 'go to', 'show me', 'take me to', 'take me', 'navigate to',
        'switch to', 'bring me to', 'pull up', 'jump to', 'head to',
    ];
    const wantsNav = navTriggers.some((t) => low.includes(t))
        || /\b(go|open|show|view|see)\s+(me\s+)?(the\s+)?/.test(low);
    if (!wantsNav) return null;

    const views = [
        ['receipts', /\b(receipts?|receipt scan|scan receipt|upload receipt)\b/],
        ['proposals', /\b(my projects|proposals?|project proposals?|budget request)\b/],
        ['approvals', /\b(review|approve|approval|approvals|pending requests?|fraud|fraud detection|suspicious purchases?|scam|fraud hunter)\b/],
        ['budget', /\bbudgets?\b/],
        ['alerts', /\b(problems?|flags?|flagged|violations?|offenders?)\b/],
        ['people', /\b(people|employees?|roster|staff)\b/],
        ['activity', /\b(purchases?|transactions?|all purchases|activity|my purchases)\b/],
        ['map', /\b(map|locations?)\b/],
        ['trip-reports', /\b(travel report|trip report|submit.*trip|my trip)\b/],
        ['approvals', /\b(trip reports?|expense reports?|cfo reports?)\b/],
        ['chat', /\b(chat|ask anything|text chat)\b/],
        ['settings', /\b(settings|spending rules|configure|setup)\b/],
        ['overview', /\b(home|dashboard|overview|main page)\b/],
    ];

    for (const [view, pattern] of views) {
        if (pattern.test(normalized) || pattern.test(low)) {
            const action = { type: 'navigate', view };
            if (view === 'settings') {
                if (/rule|policy/.test(low)) action.tab = 'rules';
                else if (/budget/.test(low)) action.tab = 'budgets';
            }
            if (view === 'approvals' && /\b(fraud|suspicious|scam)\b/.test(low)) {
                action.reviewFilter = 'fraud';
            }
            return action;
        }
    }
    return null;
}

function isNavOnlyQuery(transcript) {
    const nav = detectVoiceNavFromTranscript(transcript);
    return Boolean(nav && !VOICE_DATA_HINTS.test(transcript));
}

function tryClientInstantVoiceReply(transcript) {
    const low = transcript.toLowerCase();
    const nav = detectVoiceNavFromTranscript(transcript);

    if (nav && isNavOnlyQuery(transcript)) {
        const label = PAGE_TITLES[nav.view] || nav.view;
        return { reply: `Opening ${label}.`, actions: [nav], engine: 'instant' };
    }

    if (cachedNavCounts) {
        if (/\b(how many|count|number of).*\b(approval|pending)\b/i.test(low)) {
            const n = cachedNavCounts.approvals || 0;
            const word = n === 1 ? 'approval' : 'approvals';
            return {
                reply: `You have ${n} pending ${word}.`,
                actions: /\b(show|open|go)\b/i.test(low) ? [{ type: 'navigate', view: 'approvals' }] : [],
                engine: 'instant',
            };
        }
        if (/\b(how many|count|number of).*\b(flag|problem)\b/i.test(low)) {
            const n = cachedNavCounts.flags || 0;
            return {
                reply: `There are ${n} flagged purchases.`,
                actions: /\b(show|open|go)\b/i.test(low) ? [{ type: 'navigate', view: 'alerts' }] : [],
                engine: 'instant',
            };
        }
    }

    const totals = dashboardPayload?.totals;
    if (totals) {
        if (/\b(total spend|overall spend|how much (have we )?spent|company spend)\b/i.test(low)) {
            const amt = totals.spend_fmt || formatCad(totals.spend);
            return { reply: `Total spend is ${amt}.`, engine: 'instant' };
        }
        if (/\b(what needs my attention|what's pending|what should i (do|review|look at))\b/i.test(low) && cachedNavCounts) {
            const a = cachedNavCounts.approvals || 0;
            const f = cachedNavCounts.flags || 0;
            const reviewTotal = cachedNavCounts.review_pending ?? a;
            return {
                reply: `You have ${reviewTotal} items in the review queue and ${f} flagged purchases.`,
                engine: 'instant',
            };
        }
    }

    return null;
}

function executeVoiceActions(actions = []) {
    actions.forEach((action) => {
        if (action.type === 'navigate' && action.view) {
            navigateTo(action.view, {
                tab: action.tab,
                scroll: action.scroll,
                reviewFilter: action.reviewFilter,
            });
        }
    });
}

function isOnChatPage() {
    return currentViewKey === 'chat';
}

function openVoicePanel() {
    const panel = document.getElementById('voice-panel');
    if (panel) panel.hidden = false;
}

function closeVoicePanel() {
    const panel = document.getElementById('voice-panel');
    if (panel) panel.hidden = true;
    if (voiceListening && voiceRecognition) voiceRecognition.stop();
    stopVoiceAudio();
    voiceSpeaking = false;
    voiceListening = false;
    const root = document.getElementById('voice-assistant');
    if (root) root.dataset.thinking = '0';
    updateVoiceUiState('');
}

function showVoicePanelContent(transcript, reply) {
    const transcriptEl = document.getElementById('voice-transcript');
    const replyEl = document.getElementById('voice-reply');
    if (transcriptEl) {
        transcriptEl.hidden = !transcript;
        if (transcript) transcriptEl.textContent = transcript;
    }
    if (replyEl) {
        replyEl.hidden = !reply;
        if (reply) replyEl.textContent = reply;
    }
}

function updateVoiceUiState(statusText) {
    const root = document.getElementById('voice-assistant');
    const statusEl = document.getElementById('voice-status');
    const chatMic = document.getElementById('chat-mic-btn');
    if (!root) return;

    root.classList.toggle('voice-assistant--listening', voiceListening);
    root.classList.toggle('voice-assistant--speaking', voiceSpeaking);
    root.classList.toggle('voice-assistant--thinking', Boolean(root.dataset.thinking === '1'));
    if (chatMic) chatMic.classList.toggle('chat-mic-btn--active', voiceListening || voiceSpeaking);

    const icon = document.getElementById('voice-orb-icon');
    if (icon) {
        if (voiceListening) icon.className = 'fa-solid fa-microphone-lines voice-orb-icon';
        else if (voiceSpeaking) icon.className = 'fa-solid fa-volume-high voice-orb-icon';
        else icon.className = 'fa-solid fa-microphone voice-orb-icon';
    }

    if (statusEl) {
        statusEl.textContent = statusText || '';
        statusEl.hidden = !statusText;
    }
}

async function sendVoiceQuery(transcript, { popup = false } = {}) {
    const root = document.getElementById('voice-assistant');
    if (!transcript.trim()) return;

    const instant = tryClientInstantVoiceReply(transcript);
    if (instant) {
        root.dataset.thinking = '0';
        await deliverInstantAssistantReply(transcript, instant, { voice: true, speak: true, popup });
        return;
    }

    root.dataset.thinking = '1';
    updateVoiceUiState('Thinking?');

    try {
        await submitAssistantQuery(transcript, { voice: true, speak: true, popup });
    } finally {
        root.dataset.thinking = '0';
        updateVoiceUiState();
    }
}

function setupVoiceAssistant() {
    const root = document.getElementById('voice-assistant');
    const orb = document.getElementById('voice-orb');
    const chatMic = document.getElementById('chat-mic-btn');
    if (!root || !orb) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const speechSupported = Boolean(SpeechRecognition);

    function toggleListen(fromChatComposer = false) {
        if (!speechSupported) {
            navigateTo('chat');
            input?.focus();
            return;
        }

        if (!fromChatComposer && !isOnChatPage()) {
            openVoicePanel();
        }

        if (voiceListening) {
            voiceRecognition.stop();
            return;
        }
        if (voiceSpeaking) {
            stopVoiceAudio();
            voiceSpeaking = false;
        }
        warmElevenLabs();
        try {
            voiceRecognition.start();
        } catch (err) {
            updateVoiceUiState('Tap again to start listening.');
        }
    }

    if (speechSupported) {
        voiceRecognition = new SpeechRecognition();
        voiceRecognition.lang = 'en-US';
        voiceRecognition.interimResults = false;
        voiceRecognition.maxAlternatives = 1;

        voiceRecognition.onstart = () => {
            voiceListening = true;
            stopVoiceAudio();
            voiceSpeaking = false;
            warmElevenLabs();
            updateVoiceUiState('Listening?');
        };

        voiceRecognition.onend = () => {
            voiceListening = false;
            if (root.dataset.thinking !== '1') {
                updateVoiceUiState('');
            }
        };

        voiceRecognition.onerror = (event) => {
            voiceListening = false;
            const msg = event.error === 'not-allowed'
                ? 'Microphone blocked ? allow access in browser settings.'
                : 'Could not hear you ? try again.';
            updateVoiceUiState(msg);
        };

        voiceRecognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript.trim();
            if (!transcript) return;
            const usePopup = !isOnChatPage();
            if (usePopup) openVoicePanel();
            sendVoiceQuery(transcript, { popup: usePopup });
        };
    }

    orb.addEventListener('click', () => toggleListen(false));
    orb.addEventListener('mouseenter', warmElevenLabs, { once: true });
    chatMic?.addEventListener('click', () => toggleListen(true));
    document.getElementById('voice-panel-close')?.addEventListener('click', closeVoicePanel);
    document.getElementById('voice-open-chat')?.addEventListener('click', () => {
        closeVoicePanel();
        navigateTo('chat');
    });

    document.addEventListener('keydown', (e) => {
        if (e.altKey && e.key.toLowerCase() === 'v') {
            e.preventDefault();
            toggleListen(isOnChatPage());
        }
    });

    updateVoiceUiState('');
}

document.addEventListener('DOMContentLoaded', () => {
    if (!APP_SHELL) return;
    setupInsightTabs();
    setupVoiceAssistant();
    setupPurchasesPage();
    setupReceiptsPage();
    setupAttachmentInput();
    setupEmployeeInteractions();
    setupPolicyEditor();
    loadDashboard();
    document.querySelectorAll('[data-close-report-modal]').forEach((el) => {
        el.addEventListener('click', () => {
            const modal = document.getElementById('report-detail-modal');
            if (modal) modal.hidden = true;
        });
    });
});

(async function init() {
    if (!APP_SHELL) return;
    await startNewChat();
})();
