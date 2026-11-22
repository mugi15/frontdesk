const state = {
  agents: [], tickets: [], customerTickets: [], holidays: [], selectedId: null,
  selectedCustomerId: null, agentId: localStorage.getItem('frontdesk-agent') || '',
  agentSignInRequired: false, signedInAgentId: null,
  mode: 'agent', agentPage: 'inbox', directoryKey: null, detailRequest: 0,
  filter: 'all', query: '', visibility: 'public', busy: false
};

const $ = (selector) => document.querySelector(selector);
const agentPages = {
  inbox: { selector: '#agent-view', title: 'Inbox' },
  customers: { selector: '#customers-view', title: 'Customers' },
  reports: { selector: '#reports-view', title: 'Reports' }
};
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const dateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
const shortDateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
const slaDateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const slaDayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
const slaTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function date(value, short = false) {
  if (!value) return '—';
  return (short ? shortDateFmt : dateFmt).format(new Date(value));
}

function humanRemaining(value) {
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 0) return 'Overdue';
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m left` : `${hours}h left`;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!state.agentSignInRequired && state.agentId && state.mode === 'agent') headers['X-Agent-Id'] = state.agentId;
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && state.agentSignInRequired && path.startsWith('/api/tickets')) {
    state.signedInAgentId = null;
    renderWorkspaceNavigation();
  }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function notify(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

async function loadBootstrap() {
  const data = await request('/api/bootstrap');
  state.agents = data.agents;
  state.holidays = data.holidays;
  state.customerTickets = data.customerTickets;
  state.agentSignInRequired = data.agentSignInRequired;
  state.signedInAgentId = data.signedInAgentId;
  if (state.signedInAgentId) state.agentId = state.signedInAgentId;
  else if (!state.agents.some((agent) => agent.id === state.agentId)) state.agentId = state.agents[0]?.id || '';
  localStorage.setItem('frontdesk-agent', state.agentId);
  renderAgentSelect();
  await setMode(state.mode);
  renderCustomerTickets();
}

async function refreshTickets() {
  const { tickets } = await request('/api/tickets');
  state.tickets = tickets;
  if (!tickets.some((ticket) => ticket.id === state.selectedId)) state.selectedId = null;
  renderStats();
  renderTicketList();
  if (state.mode !== 'agent') return;
  if (state.agentPage === 'customers') return renderCustomerDirectory();
  if (state.agentPage === 'reports') return renderReports();
  if (state.selectedId) await loadTicket(state.selectedId);
  else renderEmptyTicket();
}

function renderAgentSelect() {
  const options = state.agents.map((agent) => `<option value="${agent.id}" ${agent.id === state.agentId ? 'selected' : ''}>${escapeHtml(agent.name)}</option>`).join('');
  $('#agent-select').innerHTML = options;
  $('#sign-in-agent').innerHTML = options;
  const selected = state.agents.find((agent) => agent.id === state.agentId);
  $('.avatar.small').textContent = selected?.name?.slice(0, 1) || 'A';
}

function renderStats() {
  const overdue = state.tickets.filter(isOverdue).length;
  const unassigned = state.tickets.filter(isUnassigned).length;
  const waiting = state.tickets.filter(isWaiting).length;
  $('#stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">NEEDS ATTENTION</span><strong class="stat-value ${overdue ? 'danger-text' : ''}">${overdue.toString().padStart(2, '0')}</strong><span class="stat-note">SLA overdue</span></div>
    <div class="stat-card"><span class="stat-label">UNASSIGNED</span><strong class="stat-value">${unassigned.toString().padStart(2, '0')}</strong><span class="stat-note">Ready to claim</span></div>
    <div class="stat-card"><span class="stat-label">WITH CUSTOMER</span><strong class="stat-value">${waiting.toString().padStart(2, '0')}</strong><span class="stat-note">Clock paused</span></div>`;
}

function isOverdue(ticket) {
  return ticket.sla.firstReply === 'overdue' || ticket.sla.resolution === 'overdue';
}

function isWaiting(ticket) {
  return ticket.status === 'waiting_customer';
}

function isUnassigned(ticket) {
  return !ticket.assigneeId && (ticket.status === 'open' || isWaiting(ticket));
}

function filteredTickets() {
  const query = state.query.trim().toLowerCase();
  return state.tickets.filter((ticket) => {
    const matchesFilter = state.filter === 'all' ||
      (state.filter === 'unassigned' && isUnassigned(ticket)) ||
      (state.filter === 'mine' && ticket.assigneeId === state.agentId) ||
      (state.filter === 'waiting' && isWaiting(ticket)) ||
      (state.filter === 'overdue' && isOverdue(ticket));
    const matchesQuery = !query || `${ticket.subject} ${ticket.customerName} ${ticket.customerEmail}`.toLowerCase().includes(query);
    return matchesFilter && matchesQuery;
  });
}

function priorityLabel(priority) { return priority === 'urgent' ? 'Urgent' : priority === 'medium' ? 'Medium' : 'Low'; }
function statusLabel(status) { return ({ open: 'Open', waiting_customer: 'Waiting on customer', resolved: 'Resolved', closed: 'Auto-closed' })[status] || status; }

function renderTicketList() {
  const tickets = filteredTickets();
  $('#ticket-count').textContent = tickets.length;
  $('#all-count').textContent = state.tickets.length;
  if (!tickets.length) {
    $('#ticket-list').innerHTML = `<div class="list-empty">No tickets match this view.</div>`;
    return;
  }
  $('#ticket-list').innerHTML = tickets.map((ticket) => {
    const overdue = isOverdue(ticket);
    const slaText = overdue ? 'SLA overdue' : isWaiting(ticket) ? 'Clock paused' : ticket.status === 'closed' ? 'Auto-closed' : `Due ${date(ticket.resolutionDueAt, true)}`;
    return `<button class="ticket-row ${ticket.id === state.selectedId ? 'selected' : ''}" data-ticket-id="${ticket.id}">
      <span class="priority-mark ${ticket.priority}"></span>
      <span class="ticket-row-main"><span class="ticket-subject">${escapeHtml(ticket.subject)}</span><span class="ticket-customer">${escapeHtml(ticket.customerName)} <span>·</span> ${escapeHtml(ticket.assigneeName || 'Unassigned')}</span><span class="ticket-row-meta"><span class="mini-status ${ticket.status}">${escapeHtml(statusLabel(ticket.status))}</span><span class="ticket-sla ${overdue ? 'late' : ''}">${escapeHtml(slaText)}</span></span></span>
      <span class="ticket-row-time">${date(ticket.updatedAt, true)}</span>
    </button>`;
  }).join('');
}

function renderEmptyTicket() {
  $('#ticket-panel').classList.add('empty-panel');
  $('#ticket-panel').innerHTML = `<div class="empty-state"><div class="empty-illustration">✳</div><h3>Select a ticket</h3><p>Choose a conversation from your inbox to see its history and SLA clocks.</p></div>`;
  $('#insight-panel').innerHTML = `<div class="insight-empty"><div class="eyebrow">TICKET DETAILS</div><div class="detail-placeholder">Select a ticket to see its deadlines, ownership, and audit trail.</div></div>`;
}

async function loadTicket(id) {
  const requestId = ++state.detailRequest;
  state.selectedId = id;
  try {
    const { ticket } = await request(`/api/tickets/${id}`);
    if (requestId !== state.detailRequest || state.selectedId !== id || state.mode !== 'agent' || state.agentPage !== 'inbox') return;
    renderTicketList();
    renderTicketDetail(ticket);
  } catch (error) { notify(error.message, true); }
}

function customersFromTickets(tickets) {
  const customers = new Map();
  const newestFirst = [...tickets].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const ticket of newestFirst) {
    const key = ticket.customerEmail.trim().toLowerCase();
    if (!customers.has(key)) {
      customers.set(key, { key, email: ticket.customerEmail, name: ticket.customerName, tickets: [] });
    }
    customers.get(key).tickets.push(ticket);
  }
  return [...customers.values()].sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

function renderCustomerDirectory() {
  const query = $('#directory-search').value.trim().toLowerCase();
  const customers = customersFromTickets(state.tickets).filter(({ key, name, tickets }) =>
    !query || key.includes(query) || name.toLowerCase().includes(query)
    || tickets.some((ticket) => ticket.customerName.toLowerCase().includes(query))
  );
  const current = customers.find(({ key }) => state.directoryKey === key) ?? customers[0];
  state.directoryKey = current?.key ?? null;
  $('#directory-count').textContent = customers.length;
  $('#directory-list').innerHTML = customers.length ? customers.map((customer) => {
    const selected = customer.key === state.directoryKey;
    return `<button type="button" class="directory-row ${selected ? 'selected' : ''}" data-directory-key="${escapeHtml(customer.key)}" aria-pressed="${selected}">
      <span class="avatar directory-avatar" aria-hidden="true">${escapeHtml(customer.name.slice(0, 1).toUpperCase())}</span>
      <span class="directory-person"><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.email)}</small></span>
      <span class="count-pill">${customer.tickets.length}</span>
    </button>`;
  }).join('') : '<p class="list-empty">No customers match this search.</p>';
  $('#directory-profile').innerHTML = current
    ? renderCustomerProfile(current)
    : '<div class="directory-placeholder"><h3>Customer ticket history</h3><p>Search for a customer to see their tickets.</p></div>';
}

function renderCustomerProfile(customer) {
  const active = customer.tickets.filter((ticket) => ticket.status === 'open' || isWaiting(ticket)).length;
  const total = customer.tickets.length;
  return `<div class="directory-profile-header">
    <div class="avatar directory-avatar" aria-hidden="true">${escapeHtml(customer.name.slice(0, 1).toUpperCase())}</div>
    <div><h3>${escapeHtml(customer.name)}</h3><p>${escapeHtml(customer.email)}</p></div>
    <div class="directory-profile-count">${total} ${total === 1 ? 'ticket' : 'tickets'} · ${active} active</div>
  </div>
  <div class="directory-history"><h4>Ticket history</h4>${customer.tickets.map((ticket) =>
    `<button type="button" class="directory-ticket" data-directory-ticket="${ticket.id}">
      <span><strong>${escapeHtml(ticket.subject)}</strong><small>${priorityLabel(ticket.priority)} priority · Updated ${date(ticket.updatedAt, true)}</small></span>
      <span class="mini-status ${ticket.status}">${escapeHtml(statusLabel(ticket.status))}</span><span aria-hidden="true">›</span>
    </button>`
  ).join('')}</div>`;
}

function reportTable(headings, rows) {
  return `<div class="report-table-wrap" role="region" aria-label="${headings[0]} counts" tabindex="0"><table class="report-table">
    <thead><tr>${headings.map((heading) => `<th scope="col">${heading}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(({ key, label, counts }) => `<tr data-report-row="${key}"><th scope="row">${label}</th>${counts.map((count) => `<td>${count}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function renderReports() {
  const metrics = [
    { filter: 'overdue', label: 'SLA overdue', matches: isOverdue },
    { filter: 'waiting', label: 'Waiting on customer', matches: isWaiting },
    { filter: 'unassigned', label: 'Unassigned', matches: isUnassigned }
  ];
  $('#report-summary').innerHTML = metrics.map(({ filter, label, matches }) => {
    const count = state.tickets.filter(matches).length;
    return `<button type="button" class="panel report-metric" data-report-filter="${filter}">
      <span>${label}</span><strong class="${filter === 'overdue' && count > 0 ? 'danger-text' : ''}">${count}</strong><small>View tickets <span aria-hidden="true">↗</span></small>
    </button>`;
  }).join('');
  const commitments = {
    overdue: 'Overdue', on_track: 'On track', paused: 'Paused',
    met: 'Met', missed: 'Missed', not_completed: 'Not completed'
  };
  $('#report-sla').innerHTML = reportTable(['Commitment status', 'First reply', 'Resolution'],
    Object.entries(commitments).map(([status, label]) => ({
      key: status, label,
      counts: ['firstReply', 'resolution'].map((clock) => state.tickets.filter((ticket) => ticket.sla[clock] === status).length)
    }))
  );
  $('#report-priority').innerHTML = reportTable(['Priority', 'Open', 'Waiting', 'Resolved', 'Auto-closed'],
    ['urgent', 'medium', 'low'].map((priority) => {
      const tickets = state.tickets.filter((ticket) => ticket.priority === priority);
      return {
        key: priority, label: priorityLabel(priority),
        counts: ['open', 'waiting_customer', 'resolved', 'closed'].map((status) => tickets.filter((ticket) => ticket.status === status).length)
      };
    })
  );
}

function messageMarkup(message) {
  const internal = message.visibility === 'internal';
  const customer = message.sender_type === 'customer';
  return `<article class="message ${internal ? 'internal-message' : ''} ${customer ? 'customer-message' : 'agent-message'}">
    <div class="message-avatar ${customer ? 'customer-avatar' : internal ? 'internal-avatar' : 'agent-avatar'}">${escapeHtml(message.sender_name.slice(0, 1))}</div>
    <div class="message-content"><div class="message-heading"><strong>${escapeHtml(message.sender_name)}</strong>${internal ? '<span class="private-label">PRIVATE NOTE</span>' : customer ? '<span class="sender-label">CUSTOMER</span>' : '<span class="sender-label">SUPPORT</span>'}<time>${date(message.created_at)}</time></div><div class="message-bubble">${escapeHtml(message.body).replace(/\n/g, '<br>')}</div></div>
  </article>`;
}

function renderTicketDetail(ticket) {
  $('#ticket-panel').classList.remove('empty-panel');
  const owned = ticket.assigneeId === state.agentId;
  const waiting = ticket.status === 'waiting_customer';
  const canCompose = owned && (ticket.status === 'open' || waiting);
  const visibility = waiting ? 'internal' : state.visibility;
  const actions = [];
  if (ticket.status === 'open' && owned) actions.push(`<button class="button secondary" data-action="waiting">Waiting on customer</button>`);
  if (['open', 'waiting_customer'].includes(ticket.status) && owned) actions.push(`<button class="button primary" data-action="resolve">Resolve ticket <span>↗</span></button>`);
  if (ticket.status === 'resolved' && owned) actions.push(`<button class="button primary" data-action="reopen">Reopen ticket <span>↗</span></button>`);
  const claim = !ticket.assigneeId ? `<button class="button primary" data-action="claim">Claim ticket <span>↗</span></button>` : `<span class="assignee-pill"><span class="avatar mini">${escapeHtml(ticket.assigneeName?.slice(0, 1) || 'A')}</span>${escapeHtml(ticket.assigneeName)}</span>`;
  $('#ticket-panel').innerHTML = `
    <div class="ticket-detail-header"><div class="detail-label-row"><span class="priority-tag ${ticket.priority}"><span class="priority-mark ${ticket.priority}"></span>${priorityLabel(ticket.priority)} priority</span><span class="status-tag ${ticket.status}">${escapeHtml(statusLabel(ticket.status))}</span>${ticket.reopenedCount ? `<span class="reopen-tag">Reopened ${ticket.reopenedCount}×</span>` : ''}</div>
      <div class="detail-title-row"><div><h2>${escapeHtml(ticket.subject)}</h2><p class="customer-line">${escapeHtml(ticket.customerName)} <span>·</span> <a href="mailto:${escapeHtml(ticket.customerEmail)}">${escapeHtml(ticket.customerEmail)}</a></p></div><div class="ownership-action">${claim}</div></div>
      <div class="toolbar-row"><label class="priority-select"><span>Priority</span><select id="priority-select" ${!owned || ticket.status === 'closed' ? 'disabled' : ''}><option value="urgent" ${ticket.priority === 'urgent' ? 'selected' : ''}>Urgent</option><option value="medium" ${ticket.priority === 'medium' ? 'selected' : ''}>Medium</option><option value="low" ${ticket.priority === 'low' ? 'selected' : ''}>Low</option></select></label><div class="toolbar-actions">${actions.join('')}</div></div>
    </div>
    <div class="conversation-heading"><div><div class="eyebrow">CONVERSATION</div><span>${ticket.messages.length} messages · Opened ${date(ticket.createdAt)}</span></div><span class="conversation-lock">◉ Private notes visible to agents</span></div>
    <div id="message-list" class="message-list">${ticket.messages.map(messageMarkup).join('')}</div>
    ${canCompose ? renderComposer(visibility, waiting) : `<div class="read-only-notice">${waiting ? 'The SLA clock is paused while the customer prepares a reply.' : ticket.status === 'resolved' ? 'This ticket is resolved. Reopen it to continue the conversation.' : ticket.status === 'closed' ? 'This ticket was automatically closed after five working days without a customer reply.' : 'Claim this ticket before replying or adding an internal note.'}</div>`}`;
  const insights = $('#insight-panel');
  const expandedClocks = insights.dataset.ticketId === ticket.id
    ? new Set([...insights.querySelectorAll('[data-sla-explanation][open]')].map((element) => element.dataset.slaExplanation))
    : new Set();
  insights.dataset.ticketId = ticket.id;
  insights.innerHTML = renderInsights(ticket, expandedClocks);
  $('#ticket-panel').querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => handleTicketAction(ticket, button.dataset.action)));
  $('#ticket-panel').querySelectorAll('[data-visibility]').forEach((button) => button.addEventListener('click', () => { state.visibility = button.dataset.visibility; renderTicketDetail(ticket); }));
  $('#priority-select')?.addEventListener('change', (event) => handlePriority(ticket.id, event.target.value));
  $('#send-button')?.addEventListener('click', () => sendAgentMessage(ticket.id, visibility));
  const input = $('#reply-input');
  input?.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') sendAgentMessage(ticket.id, visibility); });
}

function renderComposer(visibility, waiting) {
  const internal = visibility === 'internal';
  return `<div class="composer">
    <div class="composer-tabs">
      ${waiting ? '' : `<button class="composer-tab ${internal ? '' : 'active'}" data-visibility="public">↗ Reply to customer</button>`}
      <button class="composer-tab ${internal ? 'active' : ''}" data-visibility="internal">▤ Internal note</button>
      <span class="composer-hint">${internal ? 'Only agents can see this' : 'Visible to the customer'}</span>
    </div>
    <textarea id="reply-input" rows="3" placeholder="${internal ? 'Add context for your teammates…' : 'Write a clear, helpful reply…'}"></textarea>
    <div class="composer-bottom"><span>${waiting ? 'Public replies resume when the customer responds.' : 'Replies are recorded in the ticket history.'}</span>
      <button id="send-button" class="button ${internal ? 'note-button' : 'primary'}">${internal ? 'Add note' : 'Send reply'} <span>↗</span></button>
    </div>
  </div>`;
}

function formatWorkingDuration(minutes) {
  const rounded = Math.round(minutes);
  if (!rounded && minutes > 0) return 'under 1 min';
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (!hours) return `${remainder} min`;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function slaHistoryEvent(event) {
  const when = (value) => slaDateFmt.format(new Date(value));
  let label;
  switch (event.kind) {
    case 'ticket_created': label = 'Ticket opened'; break;
    case 'waiting_for_customer': label = 'Clock paused for the customer'; break;
    case 'customer_replied_resumed_sla': label = 'Clock resumed after a customer reply'; break;
    case 'priority_changed':
      label = `Priority changed from ${priorityLabel(event.fromPriority)} to ${priorityLabel(event.toPriority)}`;
      break;
    default: label = 'Ticket reopened with a new resolution clock';
  }
  let deadline;
  if (event.previousDueAt && event.dueAt && event.previousDueAt !== event.dueAt) {
    deadline = `Was due ${when(event.previousDueAt)}. Now due ${when(event.dueAt)}.`;
  } else if (event.dueAt) {
    deadline = `${event.previousDueAt ? 'Deadline unchanged' : 'Due'} ${when(event.dueAt)}.`;
  } else if (event.previousDueAt) {
    deadline = `Previously due ${when(event.previousDueAt)}.`;
  }
  const context = [
    deadline,
    event.consumedMinutes == null ? null : `${formatWorkingDuration(event.consumedMinutes)} of working time already counted.`,
    event.remainingMinutes == null ? null : `${formatWorkingDuration(event.remainingMinutes)} of working time left.`
  ].filter(Boolean).join(' ');
  return `<li><b>${label}</b><time datetime="${escapeHtml(event.at)}">${when(event.at)}</time>${context ? `<span>${context}</span>` : ''}</li>`;
}

function renderSlaExplanation(key, title, explanation, expanded) {
  if (!explanation) return '';
  const { calculation, history, remainingMinutes } = explanation;
  const rules = {
    working_time: 'Counts only working time.',
    same_working_day: 'Due at the close of the effective working day.',
    same_day_cap: 'The remaining budget cannot go past the close of the effective working day.',
    remaining_budget: 'The clock resumed with the unused working time.',
    budget_exhausted: 'The ticket had already used its working time when the priority changed.'
  };
  const skippedDays = { holiday: 'Holiday skipped', weekend: 'Weekend skipped', outside_hours: 'Outside working hours' };
  const days = calculation.days.map((day) => {
    const label = slaDayFmt.format(new Date(`${day.date}T12:00:00+05:30`));
    if (day.kind !== 'working') return `<li><span>${label}</span><span>${skippedDays[day.kind]}</span></li>`;
    const start = slaTimeFmt.format(new Date(day.startAt));
    const end = slaTimeFmt.format(new Date(day.endAt));
    return `<li><span>${label} <span class="sla-range">${start}–${end}</span></span><b>${formatWorkingDuration(day.minutes)}</b></li>`;
  }).join('');
  const dateLabel = remainingMinutes == null ? 'Scheduled deadline' : 'Last scheduled deadline';
  return `<details class="sla-explanation" data-sla-explanation="${key}" ${expanded ? 'open' : ''}>
    <summary aria-label="Why is ${title.toLowerCase()} due then?">Why is this due then?</summary>
    <div class="sla-explanation-body">
      ${remainingMinutes == null ? '' : `<p class="sla-pause-note">Paused with ${formatWorkingDuration(remainingMinutes)} of working time left. A new deadline is set when the customer replies.</p>`}
      <p>${rules[calculation.rule]} Hours are 09:30–18:30 IST, Monday to Friday.</p>
      <dl class="sla-calculation">
        <dt>Calculated from</dt><dd>${slaDateFmt.format(new Date(calculation.startAt))} IST</dd>
        <dt>${dateLabel}</dt><dd>${slaDateFmt.format(new Date(calculation.dueAt))} IST</dd>
        <dt>Working time in this calculation</dt><dd>${formatWorkingDuration(calculation.workingMinutes)}</dd>
      </dl>
      ${days ? `<ul class="sla-days">${days}</ul>` : ''}
      ${calculation.recorded ? '' : '<p class="sla-reconstruction">Calendar breakdown reconstructed from the saved deadline using the current holiday calendar.</p>'}
      ${history.length ? `<h4>Deadline history</h4><ol class="sla-history">${[...history].reverse().map(slaHistoryEvent).join('')}</ol>` : ''}
    </div>
  </details>`;
}

function slaCard(title, stateName, dueAt, breached, pauseAt, explanation) {
  const paused = stateName === 'paused';
  const notCompleted = stateName === 'not_completed';
  const late = stateName === 'overdue' || stateName === 'missed' || breached;
  const complete = stateName === 'met';
  const label = notCompleted ? 'NOT COMPLETED' : paused ? 'PAUSED' : stateName === 'missed' ? 'MISSED' : late ? 'OVERDUE' : complete ? 'MET' : 'ON TRACK';
  const helper = notCompleted ? 'Commitment not completed' : paused ? `Paused since ${date(pauseAt)}` : complete ? 'Commitment recorded' : late ? `Deadline ${date(dueAt)}` : `Due ${date(dueAt)}`;
  return `<div class="sla-card ${late ? 'sla-late' : paused ? 'sla-paused' : complete || notCompleted ? 'sla-complete' : ''}"><div class="sla-card-top"><span>${title}</span><span class="sla-state">${label}</span></div><strong>${notCompleted ? 'Not completed' : paused ? 'Waiting' : complete ? 'Complete' : late ? 'Needs attention' : humanRemaining(dueAt)}</strong><small>${helper}</small><div class="sla-track"><i class="${late ? 'late-bar' : paused ? 'paused-bar' : complete ? 'complete-bar' : notCompleted ? 'paused-bar' : ''}"></i></div>${explanation}</div>`;
}

function renderInsights(ticket, expandedClocks) {
  const firstState = ticket.firstResponseAt ? (ticket.firstResponseBreached ? 'missed' : 'met') : ticket.sla.firstReply;
  const resolutionState = ticket.sla.resolution;
  const events = [...(ticket.audit || [])].reverse().slice(0, 8);
  const resolutions = ticket.resolutions || [];
  return `<div class="insight-content"><div class="insight-heading"><div><div class="eyebrow">SLA & HISTORY</div><h3>Ticket health</h3></div><span class="timezone-pill">IST</span></div>
    ${slaCard('FIRST REPLY', firstState, ticket.firstResponseDueAt, ticket.firstResponseBreached, ticket.waitingSince,
      renderSlaExplanation('firstReply', 'the first reply', ticket.slaExplanation?.firstReply, expandedClocks.has('firstReply')))}
    ${slaCard('RESOLUTION', resolutionState, ticket.resolutionDueAt, ticket.resolutionBreached, ticket.waitingSince,
      renderSlaExplanation('resolution', 'resolution', ticket.slaExplanation?.resolution, expandedClocks.has('resolution')))}
    <div class="detail-section"><div class="detail-section-heading"><span>Ticket facts</span><span class="subtle">#${ticket.id.slice(0, 8).toUpperCase()}</span></div>
      <div class="fact-row"><span>Customer</span><strong>${escapeHtml(ticket.customerName)}</strong></div><div class="fact-row"><span>Owner</span><strong>${escapeHtml(ticket.assigneeName || 'Unassigned')}</strong></div>
      <div class="fact-row"><span>Opened</span><strong>${date(ticket.createdAt)}</strong></div><div class="fact-row"><span>Customer inactivity</span><strong>${ticket.autoCloseAt ? date(ticket.autoCloseAt) : '—'}</strong></div>
      ${ticket.reopenedCount ? `<div class="fact-row"><span>Resolution cycles</span><strong>${ticket.reopenedCount + 1}</strong></div>` : ''}
    </div>
    ${resolutions.length ? `<div class="detail-section"><div class="detail-section-heading"><span>Past resolutions</span></div>${resolutions.map((row) => `<div class="resolution-history"><span>Cycle ${row.cycle_number} <small>${date(row.resolved_at)}</small></span><span class="history-result ${row.resolution_breached ? 'late' : ''}">${row.resolution_breached ? 'SLA missed' : 'SLA met'}</span></div>`).join('')}</div>` : ''}
    <div class="detail-section audit-section"><div class="detail-section-heading"><span>Recent activity</span><span class="subtle">${ticket.audit?.length || 0} events</span></div>
      ${events.length ? `<div class="audit-list">${events.map((event) => `<div class="audit-event"><span class="audit-dot ${event.actor_type}"></span><div><strong>${escapeHtml(event.action.replaceAll('_', ' '))}</strong><span>${escapeHtml(event.actor_name)} · ${date(event.occurred_at)}</span></div></div>`).join('')}</div>` : '<div class="audit-empty">No recorded changes yet.</div>'}
    </div><div class="audit-footnote">Events are timestamped by the server and kept append-only.</div></div>`;
}

async function handleTicketAction(ticket, action) {
  if (state.busy) return;
  state.busy = true;
  try {
    if (action === 'claim') {
      await request(`/api/tickets/${ticket.id}/claim`, { method: 'POST', body: {} });
      notify('Ticket claimed. You can now reply or add a private note.');
    } else {
      await request(`/api/tickets/${ticket.id}/status`, { method: 'POST', body: { action } });
      notify(action === 'waiting' ? 'SLA clocks paused while waiting for the customer.' : action === 'resolve' ? 'Ticket resolved and resolution recorded.' : 'Ticket reopened with a fresh resolution deadline.');
    }
    await refreshTickets();
  } catch (error) { notify(error.message, true); } finally { state.busy = false; }
}

async function handlePriority(ticketId, priority) {
  try {
    await request(`/api/tickets/${ticketId}/priority`, { method: 'POST', body: { priority } });
    notify(`Priority changed to ${priorityLabel(priority)}. SLA deadlines recalculated.`);
    await refreshTickets();
  } catch (error) { notify(error.message, true); await loadTicket(ticketId); }
}

async function sendAgentMessage(ticketId, visibility) {
  const field = $('#reply-input');
  const body = field?.value.trim();
  if (!body) return notify('Write a message before sending.', true);
  const button = $('#send-button');
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    await request(`/api/tickets/${ticketId}/messages`, { method: 'POST', body: { body, visibility } });
    notify(visibility === 'internal' ? 'Private note added.' : 'Customer reply recorded as posted.');
    state.visibility = 'public';
    await refreshTickets();
  } catch (error) { notify(error.message, true); if (button) button.disabled = false; }
}

function renderCustomerTickets() {
  const host = $('#customer-ticket-list');
  if (!state.customerTickets.length) {
    state.selectedCustomerId = null;
    host.innerHTML = '<div class="list-empty">No requests are available in this demo.</div>';
    return;
  }
  if (!state.selectedCustomerId || !state.customerTickets.some((ticket) => ticket.id === state.selectedCustomerId)) state.selectedCustomerId = state.customerTickets[0].id;
  host.innerHTML = state.customerTickets.map((ticket) => `<button class="customer-ticket-row ${ticket.id === state.selectedCustomerId ? 'selected' : ''}" data-customer-id="${ticket.id}"><span class="customer-ticket-mark ${ticket.status}"></span><span><strong>${escapeHtml(ticket.subject)}</strong><small>${escapeHtml(statusLabel(ticket.status))} · Updated ${date(ticket.updatedAt, true)}</small></span><span>›</span></button>`).join('');
  host.querySelectorAll('[data-customer-id]').forEach((button) => button.addEventListener('click', () => {
    showNewRequest(false);
    loadCustomerTicket(button.dataset.customerId);
  }));
}

async function refreshCustomerTickets() {
  const { tickets } = await request('/api/customer/tickets');
  if (state.mode !== 'customer') return;
  state.customerTickets = tickets;
  renderCustomerTickets();
  if (state.selectedCustomerId) await loadCustomerTicket(state.selectedCustomerId);
}

async function loadCustomerTicket(id) {
  try {
    state.selectedCustomerId = id;
    const { ticket } = await request(`/api/customer/tickets/${id}`);
    if (id !== state.selectedCustomerId || state.mode !== 'customer') return;
    renderCustomerTickets();
    const writable = !['closed'].includes(ticket.status);
    $('#customer-conversation').innerHTML = `<div class="customer-conversation-header"><div class="eyebrow">SUPPORT REQUEST</div><h2 tabindex="-1">${escapeHtml(ticket.subject)}</h2><div class="customer-status-row"><span class="status-tag ${ticket.status}">${escapeHtml(statusLabel(ticket.status))}</span><span>Request opened ${date(ticket.createdAt)}</span></div></div><div class="customer-message-list">${ticket.messages.map(messageMarkup).join('')}</div>${writable ? `<div class="customer-reply-box"><label for="customer-reply">Reply to support</label><textarea id="customer-reply" rows="3" placeholder="Add details or answer a question…"></textarea><div class="customer-reply-bottom"><span>Your reply is visible to the support team.</span><button id="customer-send" class="button primary">Send reply <span>↗</span></button></div></div>` : '<div class="read-only-notice">This request is closed. Use New request if you still need help.</div>'}`;
    $('#customer-conversation').querySelector('#customer-send')?.addEventListener('click', () => sendCustomerMessage(id));
  } catch (error) { notify(error.message, true); }
}

async function sendCustomerMessage(id) {
  const field = $('#customer-reply');
  const body = field?.value.trim();
  if (!body) return notify('Write a reply before sending.', true);
  const button = $('#customer-send');
  button.disabled = true;
  try {
    await request(`/api/customer/tickets/${id}`, { method: 'POST', body: { body } });
    notify('Your reply was added to the conversation.');
    await refreshCustomerTickets();
  } catch (error) { notify(error.message, true); button.disabled = false; }
}

function showNewRequest(open) {
  $('#new-request-panel').classList.toggle('hidden', !open);
  $('#customer-conversation').classList.toggle('hidden', open);
  $('#new-request-button').setAttribute('aria-expanded', String(open));
  if (open) $('#new-request-form').elements.customerName.focus();
}

async function submitNewRequest(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#submit-new-request');
  if (button.disabled) return;

  const errorNotice = $('#new-request-error');
  errorNotice.hidden = true;
  button.disabled = true;
  $('#cancel-new-request').disabled = true;
  let ticketId;
  try {
    const result = await request('/api/customer/tickets', {
      method: 'POST',
      body: Object.fromEntries(new FormData(form))
    });
    ticketId = result.ticketId;
  } catch (error) {
    errorNotice.textContent = error.message;
    errorNotice.hidden = false;
    return;
  } finally {
    button.disabled = false;
    $('#cancel-new-request').disabled = false;
  }

  form.reset();
  state.selectedCustomerId = ticketId;
  showNewRequest(false);
  notify('Support request submitted.');
  try {
    await refreshCustomerTickets();
    if (state.mode === 'customer') $('#customer-conversation h2')?.focus();
  } catch {
    notify('Request submitted. Refresh to see it in your list.');
  }
}

function setInboxFilter(filter, resetSearch = false) {
  state.filter = filter;
  if (resetSearch) {
    state.query = '';
    $('#search-input').value = '';
  }
  $('#filters').querySelectorAll('[data-filter]').forEach((button) => {
    const active = button.dataset.filter === filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  renderTicketList();
}

async function openAgentPage(page, { filter, ticketId } = {}) {
  state.agentPage = page;
  if (filter) {
    state.selectedId = ticketId ?? null;
    setInboxFilter(filter, true);
    renderEmptyTicket();
  }
  await setMode('agent');
  if (state.mode === 'agent' && state.agentPage === 'inbox' && filter) {
    const target = ticketId ? $('#ticket-panel h2') : $('#filters .active');
    if (target) {
      if (ticketId) target.tabIndex = -1;
      target.focus();
    }
  }
}

function renderWorkspaceNavigation() {
  const customer = state.mode === 'customer';
  const signedOut = state.agentSignInRequired && !state.signedInAgentId;
  $('#mode-select').value = state.mode;
  for (const [page, { selector }] of Object.entries(agentPages)) {
    const active = !customer && !signedOut && state.agentPage === page;
    $(selector).classList.toggle('hidden', !active);
    const button = $(`#agent-nav [data-page="${page}"]`);
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('#customer-view').classList.toggle('hidden', !customer);
  $('#sign-in-view').classList.toggle('hidden', customer || !signedOut);
  $('#agent-control').classList.toggle('hidden', customer || signedOut);
  $('#agent-sign-out').classList.toggle('hidden', customer || !state.agentSignInRequired || signedOut);
  $('#page-title').textContent = customer ? 'Customer portal' : agentPages[state.agentPage].title;
}

async function setMode(mode) {
  state.mode = mode;
  const customer = mode === 'customer';
  renderWorkspaceNavigation();
  if (!customer && state.agentSignInRequired && !state.signedInAgentId) return;
  if (!customer && state.agentPage === 'customers') renderCustomerDirectory();
  if (!customer && state.agentPage === 'reports') renderReports();
  try {
    await (customer ? refreshCustomerTickets() : refreshTickets());
  } catch (error) {
    notify(error.message, true);
  }
}

$('#agent-sign-in').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const feedback = $('#sign-in-error');
  feedback.hidden = true;
  button.disabled = true;
  try {
    const { agentId } = await request('/api/session/agent', {
      method: 'POST',
      body: { agentId: $('#sign-in-agent').value, password: $('#agent-password').value }
    });
    state.signedInAgentId = agentId;
    state.agentId = agentId;
    localStorage.setItem('frontdesk-agent', agentId);
    form.reset();
    renderAgentSelect();
    await setMode('agent');
  } catch (error) {
    feedback.textContent = error.message;
    feedback.hidden = false;
  } finally {
    button.disabled = false;
  }
});
$('#agent-sign-out').addEventListener('click', async () => {
  try {
    await request('/api/session/sign-out', { method: 'POST' });
    state.signedInAgentId = null;
    state.tickets = [];
    state.selectedId = null;
    renderTicketList();
    renderEmptyTicket();
    await setMode('agent');
  } catch (error) {
    notify(error.message, true);
  }
});

$('#mode-select').addEventListener('change', (event) => setMode(event.target.value));
$('#agent-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]');
  if (button) openAgentPage(button.dataset.page);
});
$('#directory-search').addEventListener('input', renderCustomerDirectory);
$('#directory-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-directory-key]');
  if (!button) return;
  state.directoryKey = button.dataset.directoryKey;
  renderCustomerDirectory();
  $('#directory-list [aria-pressed="true"]')?.focus();
});
$('#directory-profile').addEventListener('click', (event) => {
  const button = event.target.closest('[data-directory-ticket]');
  if (button) openAgentPage('inbox', { filter: 'all', ticketId: button.dataset.directoryTicket });
});
$('#report-summary').addEventListener('click', (event) => {
  const button = event.target.closest('[data-report-filter]');
  if (button) openAgentPage('inbox', { filter: button.dataset.reportFilter });
});
$('#new-request-button').addEventListener('click', () => showNewRequest(true));
$('#new-request-form').addEventListener('submit', submitNewRequest);
$('#cancel-new-request').addEventListener('click', () => {
  $('#new-request-form').reset();
  $('#new-request-error').hidden = true;
  showNewRequest(false);
  $('#new-request-button').focus();
});
$('#agent-select').addEventListener('change', async (event) => {
  state.agentId = event.target.value;
  localStorage.setItem('frontdesk-agent', state.agentId);
  if (state.agentSignInRequired) {
    try {
      await request('/api/session/sign-out', { method: 'POST' });
      state.signedInAgentId = null;
      state.tickets = [];
      state.selectedId = null;
      renderTicketList();
      renderEmptyTicket();
      renderAgentSelect();
      await setMode('agent');
    } catch (error) {
      state.agentId = state.signedInAgentId;
      renderAgentSelect();
      notify(error.message, true);
    }
    return;
  }
  renderAgentSelect();
  await refreshTickets();
});
$('#filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (button) setInboxFilter(button.dataset.filter);
});
$('#ticket-list').addEventListener('click', (event) => {
  const row = event.target.closest('[data-ticket-id]');
  if (row) loadTicket(row.dataset.ticketId);
});
$('#search-input').addEventListener('input', (event) => { state.query = event.target.value; renderTicketList(); });
for (const button of document.querySelectorAll('#refresh-button, [data-refresh-agent]')) {
  button.addEventListener('click', async () => {
    try {
      await refreshTickets();
      notify(`${agentPages[state.agentPage].title} refreshed.`);
    } catch (error) {
      notify(error.message, true);
    }
  });
}

loadBootstrap().catch((error) => {
  notify(error.message || 'Could not load Frontdesk. Check that PostgreSQL is running and refresh.', true);
  $('#ticket-list').innerHTML = `<div class="connection-error"><strong>Could not reach the support desk.</strong><span>${escapeHtml(error.message)}</span><button class="button secondary" id="retry-button">Try again</button></div>`;
  $('#retry-button')?.addEventListener('click', () => loadBootstrap().catch((again) => notify(again.message, true)));
});
