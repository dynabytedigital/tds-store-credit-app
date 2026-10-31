// Frontend State
let customers = [];
let activeFilter = 'all';
let searchQuery = '';

// DOM Elements
const kpiTotal = document.getElementById('kpi-total');
const kpiSent = document.getElementById('kpi-sent');
const kpiPending = document.getElementById('kpi-pending');
const kpiFailed = document.getElementById('kpi-failed');
const kpiValueDelivered = document.getElementById('kpi-value-delivered');
const kpiFailedText = document.getElementById('kpi-failed-text');
const btnRetryFailed = document.getElementById('btn-retry-failed');

const progressStatusText = document.getElementById('progress-status-text');
const progressCounts = document.getElementById('progress-counts');
const progressFill = document.getElementById('progress-fill');

const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnResume = document.getElementById('btn-resume');
const btnRefresh = document.getElementById('btn-refresh');

const testEmailInput = document.getElementById('test-email');
const testNameInput = document.getElementById('test-name');
const btnSendTest = document.getElementById('btn-send-test');
const testFeedback = document.getElementById('test-feedback');

const terminalBody = document.getElementById('terminal-body');
const btnClearLogs = document.getElementById('btn-clear-logs');

const tableBody = document.getElementById('customer-table-body');
const searchInput = document.getElementById('search-input');
const tabButtons = document.querySelectorAll('.tab');

// Append Log to Terminal
function appendLog(entry) {
  const div = document.createElement('div');
  div.className = `log-entry log-${entry.level || 'info'}`;
  div.innerHTML = `<span class="log-time">[${entry.timestamp || new Date().toLocaleTimeString()}]</span> ${escapeHtml(entry.msg)}`;
  terminalBody.appendChild(div);
  terminalBody.scrollTop = terminalBody.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Update UI Stats & Progress
function updateStats(stats) {
  kpiTotal.textContent = stats.total.toLocaleString();
  kpiSent.textContent = stats.sent.toLocaleString();
  kpiPending.textContent = stats.pending.toLocaleString();
  kpiFailed.textContent = stats.failed.toLocaleString();

  const gbpValue = (stats.sent * 10).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
  kpiValueDelivered.textContent = `${gbpValue} value distributed`;

  if (stats.failed > 0) {
    kpiFailedText.style.display = 'none';
    btnRetryFailed.style.display = 'inline-block';
    btnRetryFailed.textContent = `Retry ${stats.failed} Failed`;
  } else {
    kpiFailedText.style.display = 'inline';
    btnRetryFailed.style.display = 'none';
  }

  // Update tabs counter
  document.getElementById('tab-count-all').textContent = stats.total;
  if (document.getElementById('tab-count-ready')) {
    document.getElementById('tab-count-ready').textContent = stats.withEmailTotal || (stats.total - (stats.noEmail || 0));
  }
  document.getElementById('tab-count-sent').textContent = stats.sent;
  document.getElementById('tab-count-pending').textContent = stats.pending;
  document.getElementById('tab-count-failed').textContent = stats.failed;
  if (document.getElementById('tab-count-no-email')) {
    document.getElementById('tab-count-no-email').textContent = stats.noEmail || 0;
  }

  // Progress Bar
  const emailTotal = stats.withEmailTotal || (stats.total - (stats.noEmail || 0));
  progressCounts.textContent = `${stats.sent} / ${emailTotal} sent (${stats.progressPercent}%)`;
  progressFill.style.width = `${stats.progressPercent}%`;

  if (stats.isSending) {
    if (stats.isPaused) {
      progressStatusText.textContent = 'Status: Paused';
      btnStart.style.display = 'none';
      btnPause.style.display = 'none';
      btnResume.style.display = 'inline-flex';
    } else {
      progressStatusText.textContent = 'Status: Dispatching £10 store credit in progress...';
      btnStart.style.display = 'none';
      btnPause.style.display = 'inline-flex';
      btnResume.style.display = 'none';
    }
  } else {
    if (stats.sent === emailTotal && emailTotal > 0) {
      progressStatusText.textContent = 'Status: Completed! All customers received £10 store credit.';
    } else {
      progressStatusText.textContent = `Status: Ready to send (${emailTotal} customers with email)`;
    }
    btnStart.style.display = 'inline-flex';
    btnPause.style.display = 'none';
    btnResume.style.display = 'none';
  }
}

// Render Customer Table
function renderTable() {
  const filtered = customers.filter(c => {
    // Tab filter
    if (activeFilter === 'ready') {
      if (!c.email) return false;
    } else if (activeFilter === 'no_email') {
      if (c.status !== 'no_email') return false;
    } else if (activeFilter !== 'all' && c.status !== activeFilter) {
      return false;
    }
    
    // Search query
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const name = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase();
      const email = (c.email || '').toLowerCase();
      const phone = (c.phone || '').toLowerCase();
      const code = (c.code || '').toLowerCase();
      if (!name.includes(q) && !email.includes(q) && !phone.includes(q) && !code.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="6" class="table-empty">No customers found matching filter.</td></tr>`;
    return;
  }

  // Render top 300 for smooth DOM performance
  const rows = filtered.slice(0, 300).map(c => {
    const fullName = `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Customer';
    const emailDisplay = c.email 
      ? escapeHtml(c.email) 
      : `<span style="color:#f59e0b; font-size:12px;">📱 ${escapeHtml(c.phone || 'Phone only')}</span>`;
    
    let creditTag = '<span style="color:#64748b">—</span>';
    if (c.status === 'sent') {
      creditTag = `<span class="code-badge" style="background:rgba(16,185,129,0.15); color:#10b981; border-color:rgba(16,185,129,0.3);">&check; &pound;10.00 Active Balance</span>`;
    } else if (c.email) {
      creditTag = `<span style="color:#38bdf8; font-size:12px;">&pound;10.00 Ready to Credit</span>`;
    }

    let statusClass = c.status;
    let statusLabel = c.status;
    if (c.status === 'no_email') {
      statusClass = 'no_email';
      statusLabel = 'Phone Only';
    } else if (c.status === 'sent') {
      statusLabel = 'Credited & Sent';
    }
    const statusTag = `<span class="status-tag ${statusClass}">${statusLabel}</span>`;
    const sentDate = c.sentAt ? new Date(c.sentAt).toLocaleString() : '<span style="color:#64748b">—</span>';
    const errText = c.error ? `<span class="error-text" title="${escapeHtml(c.error)}">${escapeHtml(c.error.substring(0, 45))}</span>` : '<span style="color:#64748b">—</span>';

    return `
      <tr>
        <td><strong>${escapeHtml(fullName)}</strong></td>
        <td>${emailDisplay}</td>
        <td>${creditTag}</td>
        <td>${statusTag}</td>
        <td>${sentDate}</td>
        <td>${errText}</td>
      </tr>
    `;
  }).join('');

  tableBody.innerHTML = rows;
}

// Fetch Full Customer List
async function loadCustomers() {
  try {
    const res = await fetch('/api/customers');
    const data = await res.json();
    customers = data.customers || [];
    updateStats(data.stats);
    renderTable();
  } catch (err) {
    console.error('Error loading customers:', err);
  }
}

// SSE Connection
function initSSE() {
  const evtSource = new EventSource('/api/stream-logs');

  evtSource.addEventListener('initial_logs', e => {
    const logs = JSON.parse(e.data);
    terminalBody.innerHTML = '';
    logs.forEach(appendLog);
  });

  evtSource.addEventListener('log', e => {
    const entry = JSON.parse(e.data);
    appendLog(entry);
  });

  evtSource.addEventListener('progress', e => {
    const stats = JSON.parse(e.data);
    updateStats(stats);
  });

  evtSource.addEventListener('customer_update', e => {
    const updated = JSON.parse(e.data);
    const idx = customers.findIndex(c => c.id === updated.id);
    if (idx !== -1) {
      customers[idx] = updated;
    } else {
      customers.push(updated);
    }
    renderTable();
  });

  evtSource.addEventListener('batch_complete', e => {
    const stats = JSON.parse(e.data);
    updateStats(stats);
    alert('Store credit distribution has finished successfully!');
  });

  evtSource.onerror = () => {
    console.warn('SSE connection lost, reconnecting...');
  };
}

// Event Listeners

// 1-Click Start
btnStart.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to send £10 store credit to all customers now?')) return;
  try {
    const res = await fetch('/api/start', { method: 'POST' });
    const data = await res.json();
    if (data.error) alert(data.error);
  } catch (err) {
    alert('Error starting batch: ' + err.message);
  }
});

// Pause
btnPause.addEventListener('click', async () => {
  await fetch('/api/pause', { method: 'POST' });
});

// Resume
btnResume.addEventListener('click', async () => {
  await fetch('/api/resume', { method: 'POST' });
});

// Refresh / Sync Customers
btnRefresh.addEventListener('click', async () => {
  btnRefresh.disabled = true;
  btnRefresh.textContent = 'Syncing...';
  try {
    const res = await fetch('/api/refresh-customers', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      await loadCustomers();
    }
  } catch (err) {
    alert('Sync error: ' + err.message);
  } finally {
    btnRefresh.disabled = false;
    btnRefresh.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> Sync Customers`;
  }
});

// Retry Failed
btnRetryFailed.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/retry-failed', { method: 'POST' });
    const data = await res.json();
    alert(`Retrying ${data.count} failed deliveries.`);
    await loadCustomers();
  } catch (err) {
    alert('Retry error: ' + err.message);
  }
});

// Auto-detect customer name when typing email
testEmailInput.addEventListener('input', e => {
  const query = e.target.value.trim().toLowerCase();
  if (query && customers.length > 0) {
    const matched = customers.find(c => c.email && c.email.toLowerCase() === query);
    if (matched && matched.first_name) {
      testNameInput.value = matched.first_name;
    }
  }
});

// Send Test Email
btnSendTest.addEventListener('click', async () => {
  const email = testEmailInput.value.trim();
  const firstName = testNameInput.value.trim() || null;

  if (!email) {
    alert('Please enter a recipient email address.');
    testEmailInput.focus();
    return;
  }

  btnSendTest.disabled = true;
  btnSendTest.textContent = 'Sending Test Email...';
  testFeedback.style.display = 'none';

  try {
    const res = await fetch('/api/test-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, firstName })
    });
    const data = await res.json();

    if (data.success) {
      testFeedback.className = 'feedback-msg feedback-success';
      testFeedback.innerHTML = `<strong>Success!</strong> &pound;10.00 store credit officially credited in Shopify and email dispatched to <code>${escapeHtml(email)}</code>. Balance is active!`;
      testFeedback.style.display = 'block';
    } else {
      throw new Error(data.error || 'Failed to send test email');
    }
  } catch (err) {
    testFeedback.className = 'feedback-msg feedback-error';
    testFeedback.innerHTML = `<strong>Error:</strong> ${escapeHtml(err.message)}`;
    testFeedback.style.display = 'block';
  } finally {
    btnSendTest.disabled = false;
    btnSendTest.textContent = 'Send Test £10 Credit Email';
  }
});

// Clear Logs
btnClearLogs.addEventListener('click', () => {
  terminalBody.innerHTML = '';
});

// Table Filter Tabs
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    renderTable();
  });
});

// Search Filter
searchInput.addEventListener('input', e => {
  searchQuery = e.target.value.trim();
  renderTable();
});

// ========================================================
// EMAIL TEMPLATE LIVE EDITOR (SIDE-BY-SIDE + VIEWPORT PREVIEW)
// ========================================================
const templateCode = document.getElementById('template-code');
const tplSubjectInput = document.getElementById('tplSubjectInput');
const btnSaveTemplate = document.getElementById('btn-save-template');
const btnResetTemplate = document.getElementById('btn-reset-template');
const templateLastSaved = document.getElementById('template-last-saved');
const editorCharCount = document.getElementById('editor-char-count');
const editorLineCount = document.getElementById('editor-line-count');
const templateSaveAlert = document.getElementById('template-save-alert');
const previewIframe = document.getElementById('templateLivePreviewIframe');
const previewViewportFrame = document.getElementById('previewViewportFrame');
const btnPreviewDesktop = document.getElementById('btnPreviewDesktop');
const btnPreviewMobile = document.getElementById('btnPreviewMobile');

function updateLivePreview() {
  if (!previewIframe || !templateCode) return;
  const rawHtml = templateCode.value || '';
  // Replace template variables for realistic live preview
  const rendered = rawHtml
    .replace(/\{\{FIRST_NAME\}\}/g, 'Marc')
    .replace(/\{\{first_name\}\}/gi, 'Marc')
    .replace(/\{\{store_credit\}\}/gi, '£10.00')
    .replace(/\{\{shop_name\}\}/gi, 'The Dental Shaman');
  previewIframe.srcdoc = rendered;
}

function switchPreviewDevice(device) {
  if (!previewViewportFrame || !btnPreviewDesktop || !btnPreviewMobile) return;
  if (device === 'mobile') {
    previewViewportFrame.className = 'preview-viewport-frame mobile';
    btnPreviewMobile.classList.add('active');
    btnPreviewDesktop.classList.remove('active');
  } else {
    previewViewportFrame.className = 'preview-viewport-frame desktop';
    btnPreviewDesktop.classList.add('active');
    btnPreviewMobile.classList.remove('active');
  }
}

// Make switchPreviewDevice globally accessible for onclick
window.switchPreviewDevice = switchPreviewDevice;

function updateEditorMetrics() {
  if (!templateCode) return;
  const val = templateCode.value || '';
  const lines = val ? val.split('\n').length : 0;
  if (editorCharCount) editorCharCount.textContent = `${val.length.toLocaleString()} chars`;
  if (editorLineCount) editorLineCount.textContent = `${lines.toLocaleString()} lines`;
}

function showTemplateAlert(msg, type = 'success') {
  if (!templateSaveAlert) return;
  templateSaveAlert.className = `template-save-alert ${type}`;
  templateSaveAlert.innerHTML = type === 'success' ? `✓ ${msg}` : `⚠ ${msg}`;
  templateSaveAlert.style.display = 'inline-flex';
  setTimeout(() => {
    templateSaveAlert.style.display = 'none';
  }, 4500);
}

async function loadTemplate() {
  if (!templateCode) return;
  try {
    const res = await fetch('/api/template');
    const data = await res.json();
    if (data.success) {
      if (data.html) templateCode.value = data.html;
      if (data.subject && tplSubjectInput) tplSubjectInput.value = data.subject;
      updateEditorMetrics();
      updateLivePreview();
      if (data.lastModified) {
        const timeStr = new Date(data.lastModified).toLocaleTimeString();
        templateLastSaved.textContent = `Last saved: ${timeStr}`;
      }
    }
  } catch (err) {
    console.error('Failed to load template:', err);
    showTemplateAlert('Failed to load email template: ' + err.message, 'error');
  }
}

if (templateCode) {
  templateCode.addEventListener('input', () => {
    updateEditorMetrics();
    updateLivePreview();
  });

  // Tab key indentation support
  templateCode.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = templateCode.selectionStart;
      const end = templateCode.selectionEnd;
      templateCode.value = templateCode.value.substring(0, start) + '  ' + templateCode.value.substring(end);
      templateCode.selectionStart = templateCode.selectionEnd = start + 2;
      updateEditorMetrics();
      updateLivePreview();
    }
  });
}

if (tplSubjectInput) {
  tplSubjectInput.addEventListener('input', updateLivePreview);
}

// Save Template Button
if (btnSaveTemplate) {
  btnSaveTemplate.addEventListener('click', async () => {
    const html = templateCode.value;
    const subject = tplSubjectInput ? tplSubjectInput.value.trim() : '';

    if (!html.trim()) {
      alert('Template content cannot be empty.');
      return;
    }

    btnSaveTemplate.disabled = true;
    btnSaveTemplate.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin"><circle cx="12" cy="12" r="10"/></svg> Saving...`;

    try {
      const res = await fetch('/api/template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, subject })
      });
      const data = await res.json();
      if (data.success) {
        showTemplateAlert('Template & subject saved successfully! Live preview active.', 'success');
        const now = new Date().toLocaleTimeString();
        templateLastSaved.textContent = `Last saved: ${now}`;
        updateLivePreview();
      } else {
        throw new Error(data.error || 'Failed to save template');
      }
    } catch (err) {
      showTemplateAlert('Save failed: ' + err.message, 'error');
    } finally {
      btnSaveTemplate.disabled = false;
      btnSaveTemplate.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Template`;
    }
  });
}

// Reset Template Button
if (btnResetTemplate) {
  btnResetTemplate.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to revert the template back to the default £10 Store Credit layout? Any unsaved edits will be lost.')) {
      return;
    }

    try {
      const res = await fetch('/api/template/reset', { method: 'POST' });
      const data = await res.json();
      if (data.success && data.html) {
        templateCode.value = data.html;
        if (data.subject && tplSubjectInput) tplSubjectInput.value = data.subject;
        updateEditorMetrics();
        updateLivePreview();
        showTemplateAlert('Template & subject restored to default!', 'success');
        templateLastSaved.textContent = `Restored default at ${new Date().toLocaleTimeString()}`;
      }
    } catch (err) {
      showTemplateAlert('Reset error: ' + err.message, 'error');
    }
  });
}

// Initial boot
loadCustomers();
loadTemplate();
initSSE();
