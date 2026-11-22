import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import pg from 'pg';
import { addWorkingMinutes, priorityTargets, sameWorkingDayDeadline } from '../src/business-clock.mjs';
import { startFrontdesk } from '../src/server.mjs';

const { Client } = pg;
const friday = '2026-11-20';
const tuesday = '2026-11-24';
const wednesday = '2026-11-25';
const holidays = new Set(['2026-11-23']);
const ist = (date, time) => new Date(`${date}T${time}:00+05:30`);
const databaseName = `frontdesk_test_${randomUUID().replaceAll('-', '')}`;
let admin;
let db;
let databaseCreated = false;
let testDatabaseUrl;
let app;
let origin;
let now = ist(friday, '12:00');
let agents;

before(async () => {
  const configuredUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  assert.ok(configuredUrl, 'Set DATABASE_URL or TEST_DATABASE_URL to a local PostgreSQL server.');
  const url = new URL(configuredUrl);
  url.searchParams.delete('dbname');
  url.searchParams.delete('database');
  url.pathname = '/postgres';
  admin = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  await admin.connect();
  // Only the randomly named database below is created, written to and dropped.
  await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  databaseCreated = true;
  url.pathname = `/${databaseName}`;
  testDatabaseUrl = url.href;
  db = new Client({ connectionString: testDatabaseUrl, connectionTimeoutMillis: 5000 });
  await db.connect();
  app = await startFrontdesk({ databaseUrl: testDatabaseUrl, port: 0, host: '127.0.0.1', now: () => now, sweepIntervalMs: 50 });
  origin = `http://127.0.0.1:${app.server.address().port}`;
  agents = (await api('/api/bootstrap')).agents;
}, { timeout: 20_000 });

after(async () => {
  try {
    try {
      await app?.close();
    } finally {
      await db?.end();
    }
  } finally {
    try {
      if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}"`);
    } finally {
      await admin?.end();
    }
  }
});

async function api(path, { method = 'GET', agent, body, raw, status = 200 } = {}) {
  const headers = {};
  if (agent) headers['x-agent-id'] = agent;
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  const result = await fetch(origin + path, {
    method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(5000),
  });
  const payload = await result.json();
  const actual = Array.isArray(status) ? status : [status];
  assert.ok(actual.includes(result.status), `${method} ${path} returned ${result.status}: ${JSON.stringify(payload)}`);
  return Array.isArray(status) ? { status: result.status, body: payload } : payload;
}

const detail = (id) => api(`/api/tickets/${id}`).then(({ ticket }) => ticket);
const customerDetail = (id) => api(`/api/customer/tickets/${id}`).then(({ ticket }) => ticket);
function ticketAction(id, action, agent, body, status = 200) {
  return api(`/api/tickets/${id}/${action}`, { method: 'POST', agent, body, status });
}
function transition(id, agent, action, status = 200) {
  return ticketAction(id, 'status', agent, { action }, status);
}
function agentReply(id, agent, body, visibility = 'public', status = 201) {
  return ticketAction(id, 'messages', agent, { body, visibility }, status);
}
function customerReply(id, body, status = 201) {
  return api(`/api/customer/tickets/${id}`, { method: 'POST', body: { body }, status });
}

async function createTicket({ created = now, priority = 'medium', owner = agents[0].id, subject = 'Test support request' } = {}) {
  const targets = priorityTargets(priority);
  const firstDue = addWorkingMinutes(created, targets.firstReplyMinutes, holidays);
  const resolutionDue = targets.sameDayResolution
    ? sameWorkingDayDeadline(created, holidays)
    : addWorkingMinutes(created, targets.resolutionMinutes, holidays);
  const { rows: [ticket] } = await db.query(
    `INSERT INTO tickets (subject, customer_name, customer_email, priority, assignee_id,
      created_at, updated_at, resolution_cycle_started_at, first_response_due_at, resolution_due_at)
     VALUES ($1,'Test Customer','customer@example.test',$2,$3,$4,$4,$4,$5,$6) RETURNING id`,
    [subject, priority, owner, created, firstDue, resolutionDue],
  );
  return ticket.id;
}

function events(ticket, action) {
  return ticket.audit.filter((event) => event.action === action);
}

test('serves the application, assets, seeded inbox and health endpoint', async () => {
  assert.deepEqual(await api('/api/health'), { ok: true, service: 'frontdesk' });
  const bootstrap = await api('/api/bootstrap');
  assert.equal(bootstrap.agents.length, 9);
  assert.equal(bootstrap.customerTickets.length, 4);
  assert.ok(bootstrap.holidays.some(({ date }) => date === '2026-11-23'));
  assert.equal(bootstrap.timezone, 'Asia/Kolkata');
  const { tickets } = await api('/api/tickets');
  assert.ok(tickets.some(({ sla }) => sla.resolution === 'overdue'));
  assert.ok(tickets.some(({ status, sla }) => status === 'waiting_customer' && sla.resolution === 'paused'));
  assert.ok(tickets.some(({ assigneeId, status }) => !assigneeId && status === 'open'));
  for (const [path, contentType, pattern] of [
    ['/', 'text/html', /id="ticket-list"/],
    ['/styles.css', 'text/css', /\.inbox-layout/],
    ['/app.js', 'text/javascript', /loadBootstrap/],
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(contentType));
    assert.match(await response.text(), pattern);
  }
});

test('a new customer request starts both SLA clocks and enters the unassigned inbox', async () => {
  now = ist(friday, '18:00');
  const { ticketId } = await api('/api/customer/tickets', {
    method: 'POST',
    status: 201,
    body: {
      customerName: '  Avery Finch  ', customerEmail: 'avery@example.test',
      subject: ' Cannot open exports ', body: ' The export page shows an error. ',
    },
  });
  const inbox = await api('/api/tickets');
  assert.ok(inbox.tickets.some(({ id, assigneeId, status }) => id === ticketId && assigneeId === null && status === 'open'));
  const ticket = await detail(ticketId);
  assert.equal(ticket.priority, 'medium');
  assert.equal(ticket.customerEmail, 'avery@example.test');
  assert.equal(ticket.firstResponseAt, null);
  assert.equal(ticket.firstResponseDueAt, ist(tuesday, '13:30').toISOString());
  assert.equal(ticket.resolutionDueAt, ist('2026-11-26', '18:00').toISOString());
  const created = events(ticket, 'ticket_created');
  assert.equal(created.length, 1);
  assert.equal(created[0].actor_type, 'customer');
  assert.equal(created[0].actor_name, 'Avery Finch');
  const conversation = await customerDetail(ticketId);
  assert.equal(conversation.subject, 'Cannot open exports');
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0].body, 'The export page shows an error.');
  assert.equal(conversation.messages[0].sender_type, 'customer');
  assert.equal(conversation.messages[0].id, created[0].after_values.messageId);
  assert.equal(Object.hasOwn(conversation, 'customerEmail'), false);
});

test('invalid support requests leave the ticket list unchanged', async () => {
  const valid = { customerName: 'Avery Finch', customerEmail: 'avery@example.test', subject: 'Export failed', body: 'Details' };
  const before = (await api('/api/customer/tickets')).tickets.length;
  for (const input of [
    { customerName: ' ' },
    { customerEmail: 'bad-address' },
    { subject: 'a'.repeat(161) },
    { body: '' },
  ]) {
    await api('/api/customer/tickets', { method: 'POST', body: { ...valid, ...input }, status: 400 });
  }
  assert.equal((await api('/api/customer/tickets')).tickets.length, before);
});

test('the SLA explanation preserves the recorded calendar, pauses, and before-and-after deadlines', async () => {
  now = ist(friday, '18:00');
  const agent = agents[0].id;
  const { ticketId: id } = await api('/api/customer/tickets', {
    method: 'POST', status: 201,
    body: { customerName: 'Example Customer', customerEmail: 'calendar@example.test', subject: 'Holiday SLA', body: 'Help with exports' },
  });
  await ticketAction(id, 'claim', agent, {});
  await ticketAction(id, 'priority', agent, { priority: 'urgent' });
  let ticket = await detail(id);
  const original = ticket.slaExplanation.firstReply;
  assert.equal(original.calculation.dueAt, ist(tuesday, '11:00').toISOString());
  assert.equal(original.calculation.workingMinutes, 120);
  assert.deepEqual(original.calculation.days.map(({ kind, minutes }) => [kind, minutes]), [
    ['working', 30], ['weekend', undefined], ['weekend', undefined], ['holiday', undefined], ['working', 90],
  ]);
  assert.equal(original.calculation.recorded, true);
  assert.equal(original.history.at(-1).previousDueAt, ist(tuesday, '13:30').toISOString());
  assert.equal(original.history.at(-1).dueAt, ist(tuesday, '11:00').toISOString());
  assert.equal(ticket.slaExplanation.resolution.calculation.rule, 'same_day_cap');
  assert.equal(ticket.slaExplanation.resolution.calculation.workingMinutes, 30);

  const calendar = await db.query("DELETE FROM holidays WHERE holiday_date = '2026-11-23' RETURNING label");
  try {
    assert.deepEqual((await detail(id)).slaExplanation.firstReply.calculation, original.calculation);
  } finally {
    await db.query("INSERT INTO holidays (holiday_date, label) VALUES ('2026-11-23', $1)", [calendar.rows[0].label]);
  }
  assert.equal(Object.hasOwn(await customerDetail(id), 'slaExplanation'), false);

  now = ist(friday, '18:15');
  await transition(id, agent, 'waiting');
  ticket = await detail(id);
  assert.equal(ticket.slaExplanation.firstReply.remainingMinutes, 105);
  assert.equal(ticket.slaExplanation.resolution.remainingMinutes, 15);
  assert.equal(ticket.slaExplanation.firstReply.history.at(-1).kind, 'waiting_for_customer');
  assert.equal(ticket.slaExplanation.firstReply.history.at(-1).dueAt, null);
  now = ist(tuesday, '12:00');
  await customerReply(id, 'I sent the report.');
  ticket = await detail(id);
  const resumed = ticket.slaExplanation.firstReply;
  assert.equal(resumed.remainingMinutes, null);
  assert.equal(resumed.calculation.rule, 'remaining_budget');
  assert.equal(resumed.calculation.dueAt, ist(tuesday, '13:45').toISOString());
  assert.equal(resumed.history.at(-1).previousDueAt, ist(tuesday, '11:00').toISOString());
  assert.equal(resumed.history.at(-1).dueAt, ist(tuesday, '13:45').toISOString());
  assert.equal(ticket.slaExplanation.resolution.calculation.dueAt, ist(tuesday, '12:15').toISOString());
});

test('only one agent wins a simultaneous claim, and a retry adds no audit event', async () => {
  const [one, two] = agents;
  const id = await createTicket({ owner: null });
  const responses = await Promise.all([one, two].map(({ id: agent }) => ticketAction(id, 'claim', agent, {}, [200, 409])));
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
  const winner = responses.find(({ status }) => status === 200).body;
  const loser = [one, two].find(({ id: agent }) => agent !== winner.assigneeId);
  const retry = await ticketAction(id, 'claim', winner.assigneeId, {});
  assert.equal(retry.alreadyClaimed, true);
  await agentReply(id, loser.id, 'No permission', 'public', 409);
  await transition(id, loser.id, 'resolve', 409);
  await ticketAction(id, 'priority', loser.id, { priority: 'urgent' }, 409);
  const ticket = await detail(id);
  assert.equal(ticket.assigneeId, winner.assigneeId);
  assert.equal(ticket.firstResponseAt, null);
  const [event] = events(ticket, 'claimed');
  assert.equal(events(ticket, 'claimed').length, 1);
  assert.equal(event.actor_type, 'agent');
  assert.equal(event.actor_name, winner.assigneeName);
  assert.deepEqual(event.before_values, { assigneeId: null });
  assert.equal(event.after_values.assigneeId, winner.assigneeId);
  assert.ok(Number.isFinite(Date.parse(event.occurred_at)));
});

test('customer, claim and internal activity do not stop the first reply clock, and private data stays out of customer responses', async () => {
  const agent = agents[0].id;
  now = ist(friday, '09:30');
  const id = await createTicket({ priority: 'urgent' });
  const privateText = 'private account context ' + randomUUID();
  await agentReply(id, agent, privateText, 'internal');
  await customerReply(id, 'Initial customer update');
  assert.equal((await detail(id)).firstResponseAt, null);
  now = ist(friday, '11:30');
  await agentReply(id, agent, '  First public reply  ');
  now = ist(friday, '12:00');
  await agentReply(id, agent, 'Second public reply');
  const ticket = await detail(id);
  assert.equal(ticket.firstResponseAt, ist(friday, '11:30').toISOString());
  assert.equal(ticket.sla.firstReply, 'met');
  assert.equal(ticket.sla.resolution, 'on_track');
  assert.equal(ticket.messages.filter(({ visibility }) => visibility === 'internal').length, 1);
  assert.equal(events(ticket, 'public_reply_posted').length, 2);
  assert.equal(events(ticket, 'internal_note_added').length, 1);
  const customer = await customerDetail(id);
  assert.deepEqual(customer.messages.map(({ body }) => body).sort(), [
    'First public reply', 'Initial customer update', 'Second public reply',
  ]);
  for (const response of [customer, await api('/api/customer/tickets'), await api('/api/bootstrap')]) {
    assert.ok(!JSON.stringify(response).includes(privateText));
  }
  for (const field of ['audit', 'resolutions', 'customerEmail', 'assigneeId', 'sla', 'resolutionDueAt']) {
    assert.equal(Object.hasOwn(customer, field), false, field);
  }
});

test('waiting preserves both budgets across a weekend, a holiday and a second pause', async () => {
  const agent = agents[0].id;
  now = ist(friday, '17:00');
  const id = await createTicket({ priority: 'urgent' });
  now = ist(friday, '17:30');
  const waiting = await transition(id, agent, 'waiting');
  assert.equal(waiting.autoCloseAt, ist('2026-11-30', '17:30').toISOString());
  assert.deepEqual((await detail(id)).sla, { firstReply: 'paused', resolution: 'paused' });
  await agentReply(id, agent, 'Second public ask', 'public', 409);
  await agentReply(id, agent, 'Note while waiting', 'internal');

  now = ist(tuesday, '11:00');
  assert.equal((await customerReply(id, 'First follow-up')).status, 'open');
  const resumed = await detail(id);
  assert.equal(resumed.firstResponseDueAt, ist(tuesday, '12:30').toISOString());
  assert.equal(resumed.resolutionDueAt, ist(tuesday, '12:00').toISOString());
  assert.equal(resumed.waitingSince, null);
  assert.equal(resumed.autoCloseAt, null);
  assert.equal(resumed.firstResponseAt, null);

  now = ist(tuesday, '11:30');
  await transition(id, agent, 'waiting');
  now = ist(tuesday, '12:00');
  await customerReply(id, 'Second follow-up');
  const ticket = await detail(id);
  assert.equal(ticket.firstResponseDueAt, ist(tuesday, '13:00').toISOString());
  assert.equal(ticket.resolutionDueAt, ist(tuesday, '12:30').toISOString());
  assert.equal(events(ticket, 'waiting_for_customer').length, 2);
  assert.equal(events(ticket, 'customer_replied_resumed_sla').length, 2);
  assert.deepEqual(ticket.audit.slice(-3).map(({ action }) => action), [
    'waiting_for_customer', 'customer_replied_resumed_sla', 'customer_reply_received',
  ]);
});

test('a customer can reply one millisecond before auto-close and a later sweep leaves the ticket open', async () => {
  const agent = agents[0].id;
  now = ist(friday, '12:00');
  const id = await createTicket();
  const { autoCloseAt } = await transition(id, agent, 'waiting');
  now = new Date(Date.parse(autoCloseAt) - 1);
  assert.equal((await customerReply(id, 'Just before cutoff')).status, 'open');
  now = new Date(autoCloseAt);
  await app.sweep();
  const ticket = await detail(id);
  assert.equal(ticket.status, 'open');
  assert.equal(events(ticket, 'auto_closed').length, 0);
});

test('a reply racing two auto-close sweeps at the cutoff records exactly one closure', async () => {
  const agent = agents[0].id;
  now = ist(friday, '12:00');
  const id = await createTicket();
  const { autoCloseAt } = await transition(id, agent, 'waiting');
  now = new Date(autoCloseAt);
  await Promise.all([customerReply(id, 'At cutoff', 409), app.sweep(), app.sweep()]);
  const ticket = await detail(id);
  assert.equal(ticket.status, 'closed');
  assert.equal(ticket.sla.resolution, 'not_completed');
  assert.equal(events(ticket, 'auto_closed').length, 1);
  assert.equal(events(ticket, 'auto_closed')[0].actor_type, 'system');
  assert.equal(events(ticket, 'customer_reply_received').length, 0);
  assert.equal(ticket.messages.length, 0);
  assert.equal((await customerDetail(id)).status, 'closed');
});

async function eventually(check, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(message);
}

test('the background scheduler closes an expired ticket with no HTTP write request', async () => {
  const agent = agents[0].id;
  now = ist(friday, '12:00');
  const id = await createTicket();
  const { autoCloseAt } = await transition(id, agent, 'waiting');
  now = new Date(Date.parse(autoCloseAt) + 1);
  await eventually(async () => (await detail(id)).status === 'closed', 'The auto-close timer never closed the ticket.');
  assert.equal(events(await detail(id), 'auto_closed').length, 1);
});

test('late first reply and resolution remain in history after customer reopening and a second resolution', async () => {
  const agent = agents[0].id;
  now = ist(friday, '16:00');
  const id = await createTicket({ priority: 'urgent' });
  now = ist(friday, '18:31');
  await agentReply(id, agent, 'Late first response');
  const firstResolved = await transition(id, agent, 'resolve');
  assert.equal(firstResolved.resolvedAt, now.toISOString());
  assert.equal((await detail(id)).sla.firstReply, 'missed');
  now = ist('2026-11-27', '18:31');
  assert.equal((await customerReply(id, 'Still seeing the issue')).status, 'open');
  const reopened = await detail(id);
  assert.equal(reopened.reopenedCount, 1);
  assert.equal(reopened.firstResponseAt, ist(friday, '18:31').toISOString());
  assert.equal(reopened.resolutionDueAt, ist('2026-11-30', '18:30').toISOString());
  assert.equal(reopened.resolutionBreached, false);
  assert.equal(reopened.slaExplanation.resolution.history.at(-1).kind, 'reopened_by_customer');
  assert.equal(reopened.slaExplanation.resolution.history.at(-1).previousDueAt, ist(friday, '18:30').toISOString());
  assert.equal(reopened.slaExplanation.resolution.calculation.rule, 'same_working_day');
  assert.deepEqual(reopened.resolutions.map(({ cycle_number, first_response_breached, resolution_breached }) => [
    cycle_number, first_response_breached, resolution_breached,
  ]), [[1, true, true]]);
  now = ist('2026-11-30', '12:00');
  await transition(id, agent, 'resolve');
  const ticket = await detail(id);
  assert.deepEqual(ticket.resolutions.map(({ resolution_breached }) => resolution_breached), [false, true]);
  assert.equal(events(ticket, 'reopened_by_customer').length, 1);
});

test('agent reopening is allowed inside the window and both actors are rejected after it', async () => {
  const agent = agents[0].id;
  now = ist(friday, '11:00');
  const allowed = await createTicket();
  const expired = await createTicket();
  await transition(allowed, agent, 'resolve');
  await transition(expired, agent, 'resolve');
  now = ist(tuesday, '11:00');
  await transition(allowed, agent, 'reopen');
  assert.equal(events(await detail(allowed), 'reopened').length, 1);
  now = new Date(+ist('2026-11-27', '11:00') + 1);
  await transition(expired, agent, 'reopen', 409);
  await customerReply(expired, 'Outside the reopening window', 409);
  const ticket = await detail(expired);
  assert.equal(ticket.status, 'resolved');
  assert.equal(ticket.reopenedCount, 0);
  assert.equal(ticket.messages.length, 0);
});

test('resolving during a pause does not turn an unexpired resolution into a breach', async () => {
  const agent = agents[0].id;
  now = ist(friday, '16:00');
  const id = await createTicket({ priority: 'urgent' });
  await agentReply(id, agent, 'Checking the issue.');
  await transition(id, agent, 'waiting');
  now = ist(tuesday, '17:00');
  await transition(id, agent, 'resolve');
  const ticket = await detail(id);
  assert.equal(ticket.sla.resolution, 'met');
  assert.equal(ticket.autoCloseAt, null);
  assert.equal(ticket.resolutions[0].resolution_breached, false);
});

test('an urgent upgrade uses time already spent and keeps the first reply breach after downgrading', async () => {
  const agent = agents[0].id;
  now = ist(tuesday, '09:30');
  const id = await createTicket({ priority: 'low' });
  now = ist(tuesday, '12:00');
  await ticketAction(id, 'priority', agent, { priority: 'urgent' });
  const urgent = await detail(id);
  assert.equal(urgent.firstResponseBreached, true);
  assert.equal(urgent.sla.firstReply, 'overdue');
  assert.equal(urgent.resolutionDueAt, ist(tuesday, '18:30').toISOString());
  await ticketAction(id, 'priority', agent, { priority: 'medium' });
  const downgraded = await detail(id);
  assert.equal(downgraded.firstResponseDueAt, ist(tuesday, '14:00').toISOString());
  assert.equal(downgraded.sla.firstReply, 'overdue');
  assert.equal(downgraded.firstResponseBreached, true);
  const change = events(downgraded, 'priority_changed').find((event) => event.after_values.priority === 'urgent');
  assert.equal(change.before_values.priority, 'low');
  assert.equal(change.after_values.firstReplyConsumedWorkingMinutes, 150);
});

test('downgrading cannot erase a breach of the previous priority deadline', async () => {
  const agent = agents[0].id;
  now = ist(friday, '15:00');
  const id = await createTicket({ priority: 'urgent' });
  now = ist(friday, '18:31');
  await ticketAction(id, 'priority', agent, { priority: 'low' });
  const ticket = await detail(id);
  assert.equal(ticket.firstResponseBreached, true);
  assert.equal(ticket.resolutionBreached, true);
  assert.deepEqual(ticket.sla, { firstReply: 'overdue', resolution: 'overdue' });
});

test('upgrading a paused ticket to urgent uses the time to that working day’s close as its remaining budget', async () => {
  const agent = agents[0].id;
  now = ist(tuesday, '10:00');
  const id = await createTicket({ priority: 'medium' });
  now = ist(tuesday, '11:00');
  await transition(id, agent, 'waiting');
  now = ist(tuesday, '16:00');
  await ticketAction(id, 'priority', agent, { priority: 'urgent' });
  now = ist(wednesday, '10:00');
  await customerReply(id, 'Returning after the pause');
  const ticket = await detail(id);
  assert.equal(ticket.firstResponseDueAt, ist(wednesday, '11:00').toISOString());
  assert.equal(ticket.resolutionDueAt, ist(wednesday, '12:30').toISOString());
});

test('validates required identity, ID, body, action and priority inputs', async () => {
  now = ist(friday, '12:00');
  const id = await createTicket();
  const agent = agents[0].id;
  const missing = randomUUID();
  await ticketAction(id, 'claim', undefined, {}, 401);
  await ticketAction(id, 'claim', missing, {}, 401);
  await ticketAction(id, 'claim', 'bad-agent-id', {}, 401);
  await api(`/api/tickets/${missing}`, { status: 404 });
  await api('/api/tickets/abc', { status: 404 });
  await api(`/api/customer/tickets/${missing}`, { status: 404 });
  await agentReply(id, agent, '  ', 'public', 400);
  await agentReply(id, agent, 'a'.repeat(4001), 'public', 400);
  await agentReply(id, agent, 'body', 'external', 400);
  await transition(id, agent, 'invalid', 400);
  await ticketAction(id, 'priority', agent, { priority: 'high' }, 400);
  await api(`/api/tickets/${id}/messages`, { method: 'POST', agent, raw: '{', status: 400 });
  await api(`/api/tickets/${id}/messages`, { method: 'POST', agent, raw: 'null', status: 400 });
  await api(`/api/customer/tickets/${id}`, { method: 'POST', body: { body: 'a'.repeat(70_000) }, status: 413 });
  assert.equal((await detail(id)).messages.length, 0);
});

test('audit rows reject updates, deletes and truncation under the application database role', async () => {
  const id = await createTicket({ owner: null });
  await ticketAction(id, 'claim', agents[0].id, {});
  await db.query('SET ROLE frontdesk_runtime');
  try {
    await assert.rejects(db.query('UPDATE audit_events SET action = $2 WHERE ticket_id = $1', [id, 'edited']), { code: '42501' });
    await assert.rejects(db.query('DELETE FROM audit_events WHERE ticket_id = $1', [id]), { code: '42501' });
    await assert.rejects(db.query('TRUNCATE audit_events'), { code: '42501' });
  } finally {
    await db.query('RESET ROLE');
  }
  assert.equal(events(await detail(id), 'claimed').length, 1);
});

test('a failed audit insert rolls back new requests, claim ownership and posted replies', async (t) => {
  const unowned = await createTicket({ owner: null });
  const owned = await createTicket();
  const agent = agents[0].id;
  const errorLog = t.mock.method(console, 'error', () => {});
  await db.query(`
    CREATE FUNCTION reject_audit_in_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Test forces audit insert to fail'; END $$;
    CREATE TRIGGER reject_audit_in_test BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_audit_in_test();
  `);
  try {
    await api('/api/customer/tickets', {
      method: 'POST', status: 500,
      body: { customerName: 'Test Customer', customerEmail: 'rollback@example.test', subject: 'Failed intake must roll back', body: 'Details' },
    });
    await ticketAction(unowned, 'claim', agent, {}, 500);
    await agentReply(owned, agent, 'Should roll back', 'public', 500);
  } finally {
    await db.query('DROP TRIGGER reject_audit_in_test ON audit_events; DROP FUNCTION reject_audit_in_test()');
  }
  const unclaimed = await detail(unowned);
  const unreplied = await detail(owned);
  assert.equal(unclaimed.assigneeId, null);
  assert.equal(unclaimed.audit.length, 0);
  assert.equal(unreplied.firstResponseAt, null);
  assert.equal(unreplied.messages.length, 0);
  assert.equal(unreplied.audit.length, 0);
  const { rows: [{ count }] } = await db.query('SELECT count(*)::int AS count FROM tickets WHERE customer_email = $1', ['rollback@example.test']);
  assert.equal(count, 0);
  assert.equal(errorLog.mock.callCount(), 3);
});

async function mountInbox(t) {
  const [html, script] = await Promise.all([
    fetch(origin).then((response) => response.text()),
    fetch(origin + '/app.js').then((response) => response.text()),
  ]);
  const dom = new JSDOM(html, { url: origin, runScripts: 'outside-only' });
  const { window } = dom;
  const requests = new Set();
  window.fetch = (path, options) => {
    const request = fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(5000) }).then(async (response) =>
      new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
    );
    requests.add(request);
    request.then(() => requests.delete(request), () => requests.delete(request));
    return request;
  };
  t.after(async () => {
    // Navigation may finish rendering after the response headers arrive.
    do {
      await Promise.allSettled([...requests]);
      await delay(0);
    } while (requests.size);
    dom.window.close();
  });
  window.eval(script);
  const element = (selector) => window.document.querySelector(selector);
  const click = (selector) => {
    const control = element(selector);
    assert.ok(control, `Expected a control matching ${selector}`);
    control.click();
  };
  function change(selector, value, eventType = 'change') {
    const control = element(selector);
    assert.ok(control, `Expected a field matching ${selector}`);
    control.value = value;
    control.dispatchEvent(new window.Event(eventType, { bubbles: true }));
  }
  await eventually(() => element('.ticket-row'), 'The inbox did not load tickets.');
  return { element, click, change };
}

test('inbox search, Unassigned and Mine filters, selection and agent switching work in the DOM', async (t) => {
  now = ist(tuesday, '11:00');
  const own = await createTicket({ subject: 'Unique inbox owner ticket', owner: agents[0].id });
  const other = await createTicket({ subject: 'Unique inbox colleague ticket', owner: agents[1].id });
  const unassigned = await createTicket({ subject: 'Unique inbox unassigned ticket', owner: null });
  const { element, click, change } = await mountInbox(t);
  change('#search-input', 'unique inbox', 'input');
  assert.equal(element('#ticket-count').textContent, '3');
  click('[data-filter="unassigned"]');
  assert.equal(element('#ticket-count').textContent, '1');
  assert.ok(element(`[data-ticket-id="${unassigned}"]`));
  click('[data-filter="mine"]');
  assert.ok(element(`[data-ticket-id="${own}"]`));
  assert.ok(!element(`[data-ticket-id="${other}"]`));
  change('#agent-select', agents[1].id);
  await eventually(() => element(`[data-ticket-id="${other}"]`), 'Mine did not update for the selected agent.');
  click(`[data-ticket-id="${other}"]`);
  await eventually(() => element('#ticket-panel h2')?.textContent === 'Unique inbox colleague ticket', 'The clicked ticket did not open.');
  assert.ok(element('#reply-input'));
  change('#search-input', 'nothing-matches-this', 'input');
  assert.match(element('#ticket-list').textContent, /No tickets match/);
});

test('Customers groups tickets by email, supports search and opens the selected ticket in the inbox', async (t) => {
  now = ist(wednesday, '11:00');
  const customer = { customerName: 'Maya Directory', customerEmail: 'maya.directory@example.test', body: 'Need help with my account.' };
  const { ticketId: first } = await api('/api/customer/tickets', {
    method: 'POST', status: 201, body: { ...customer, subject: 'Directory history first ticket' },
  });
  const { ticketId: second } = await api('/api/customer/tickets', {
    method: 'POST', status: 201, body: { ...customer, customerEmail: 'Maya.Directory@EXAMPLE.TEST', subject: 'Directory history second ticket' },
  });
  const { element, click, change } = await mountInbox(t);
  change('#mode-select', 'customer');
  click('#agent-nav [data-page="customers"]');
  assert.equal(element('#mode-select').value, 'agent');
  assert.equal(element('#agent-nav [data-page="customers"]').getAttribute('aria-current'), 'page');
  assert.equal(element('#customers-view').classList.contains('hidden'), false);
  assert.equal(element('#agent-view').classList.contains('hidden'), true);

  change('#directory-search', 'maya.directory@example.test', 'input');
  assert.equal(element('#directory-count').textContent, '1');
  const button = '[data-directory-key="maya.directory@example.test"]';
  click(button);
  const history = element('#directory-profile');
  assert.match(history.textContent, /2 tickets · 2 active/);
  assert.ok(history.querySelector(`[data-directory-ticket="${first}"]`));
  assert.ok(history.querySelector(`[data-directory-ticket="${second}"]`));
  click(`[data-directory-ticket="${second}"]`);
  await eventually(() => element('#ticket-panel h2')?.textContent === 'Directory history second ticket', 'The customer ticket did not open in the inbox.');
  assert.equal(element('#customers-view').classList.contains('hidden'), true);
  assert.equal(element('#agent-nav [data-page="inbox"]').getAttribute('aria-current'), 'page');
  assert.ok(element(`[data-ticket-id="${second}"].selected`));
  click('#agent-nav [data-page="customers"]');
  change('#directory-search', 'no matching customer', 'input');
  assert.match(element('#directory-list').textContent, /No customers match/);
  assert.equal(element('#directory-profile').querySelector('[data-directory-ticket]'), null);
});

test('Reports counts current commitments and opens the corresponding queue filters', async (t) => {
  now = ist(wednesday, '11:00');
  const overdueId = await createTicket({ created: ist(friday, '10:00'), priority: 'urgent' });
  const waitingId = await createTicket();
  await transition(waitingId, agents[0].id, 'waiting');
  const { tickets } = await api('/api/tickets');
  const overdue = tickets.filter(({ sla }) => sla.firstReply === 'overdue' || sla.resolution === 'overdue');
  const waiting = tickets.filter(({ status }) => status === 'waiting_customer');
  const unassigned = tickets.filter(({ assigneeId, status }) => !assigneeId && ['open', 'waiting_customer'].includes(status));
  const { element, click, change } = await mountInbox(t);
  change('#search-input', 'no matching ticket', 'input');
  click('#agent-nav [data-page="reports"]');
  assert.equal(element('#reports-view').classList.contains('hidden'), false);
  assert.equal(element('#agent-nav [data-page="reports"]').getAttribute('aria-current'), 'page');
  assert.equal(Number(element('[data-report-filter="overdue"] strong').textContent), overdue.length);
  assert.equal(Number(element('[data-report-filter="waiting"] strong').textContent), waiting.length);
  assert.equal(Number(element('[data-report-filter="unassigned"] strong').textContent), unassigned.length);
  const [firstCount, resolutionCount] = element('#report-sla [data-report-row="overdue"]').querySelectorAll('td');
  assert.equal(Number(firstCount.textContent), tickets.filter(({ sla }) => sla.firstReply === 'overdue').length);
  assert.equal(Number(resolutionCount.textContent), tickets.filter(({ sla }) => sla.resolution === 'overdue').length);
  const counts = [...element('#report-priority [data-report-row="urgent"]').querySelectorAll('td')].map((cell) => Number(cell.textContent));
  assert.equal(counts.reduce((a, b) => a + b, 0), tickets.filter(({ priority }) => priority === 'urgent').length);

  click('[data-report-filter="overdue"]');
  assert.equal(element('#search-input').value, '');
  assert.equal(element('[data-filter="overdue"]').getAttribute('aria-pressed'), 'true');
  assert.equal(Number(element('#ticket-count').textContent), overdue.length);
  assert.ok(element(`[data-ticket-id="${overdueId}"]`));
  assert.ok(!element(`[data-ticket-id="${waitingId}"]`));
  click('#agent-nav [data-page="reports"]');
  click('[data-report-filter="waiting"]');
  assert.equal(element('[data-filter="waiting"]').getAttribute('aria-pressed'), 'true');
  assert.ok(element(`[data-ticket-id="${waitingId}"]`));
  assert.ok(!element(`[data-ticket-id="${overdueId}"]`));

  await createTicket({ owner: null });
  click('#agent-nav [data-page="reports"]');
  click('#reports-view [data-refresh-agent]');
  await eventually(() => Number(element('[data-report-filter="unassigned"] strong').textContent) === unassigned.length + 1,
    'Refreshing the report did not include the newly unassigned ticket.');
  click('[data-report-filter="unassigned"]');
  assert.equal(element('[data-filter="unassigned"]').getAttribute('aria-pressed'), 'true');
  assert.equal(Number(element('#ticket-count').textContent), unassigned.length + 1);
});

test('both SLA cards explain the deadline and a refresh keeps the selected explanation open', async (t) => {
  now = ist(friday, '18:00');
  const id = await createTicket({ priority: 'urgent' });
  const { element, click } = await mountInbox(t);
  click(`[data-ticket-id="${id}"]`);
  const first = '[data-sla-explanation="firstReply"]';
  const resolution = '[data-sla-explanation="resolution"]';
  await eventually(() => element(first), 'The first reply explanation did not render.');
  assert.ok(element(resolution));
  assert.equal(element(first).open, false);
  click(`${first} summary`);
  assert.equal(element(first).open, true);
  assert.match(element(first).textContent, /Holiday skipped/);
  assert.match(element(first).textContent, /30 min/);
  assert.match(element(first).textContent, /1 h 30 min/);
  assert.match(element(first).textContent, /11:00 IST/);
  assert.match(element(first).textContent, /reconstructed/);
  assert.match(element(resolution).textContent, /close of the effective working day/);
  const expanded = element(first);
  click('#refresh-button');
  await eventually(() => element(first) && element(first) !== expanded, 'The ticket details did not refresh.');
  assert.equal(element(first).open, true);
  assert.equal(element(resolution).open, false);
});

test('a first-time customer can submit a request and an agent can claim it from the inbox', async (t) => {
  now = ist(wednesday, '11:00');
  const { element, click, change } = await mountInbox(t);
  change('#mode-select', 'customer');
  click('#new-request-button');
  assert.equal(element('#new-request-panel').classList.contains('hidden'), false);
  const subject = 'Submit support from the customer portal';
  change('#new-request-form [name=customerName]', 'Jamie Moss');
  change('#new-request-form [name=customerEmail]', 'jamie@example.test');
  change('#new-request-form [name=subject]', subject);
  change('#new-request-form [name=body]', 'Please help me open a report.');
  click('#submit-new-request');
  await eventually(() => element('#customer-conversation h2')?.textContent === subject, 'The submitted conversation did not open.');
  assert.equal(element('#new-request-panel').classList.contains('hidden'), true);
  assert.match(element('#customer-conversation').textContent, /Please help me open a report/);

  change('#mode-select', 'agent');
  click('[data-filter="unassigned"]');
  change('#search-input', subject, 'input');
  await eventually(() => element('.ticket-row'), 'The new request did not appear under Unassigned.');
  click('.ticket-row');
  await eventually(() => element('[data-action="claim"]'), 'The new request did not offer Claim.');
  click('[data-action="claim"]');
  await eventually(() => element('#reply-input'), 'The agent could not claim the new request.');
});

test('agent and customer screens refresh the same conversation through claim, note, reply, wait, resolve and reopen', async (t) => {
  now = ist(wednesday, '11:00');
  const subject = 'End-to-end conversation check';
  const id = await createTicket({ subject, owner: null });
  const { element, click, change } = await mountInbox(t);
  change('#mode-select', 'customer');
  await eventually(() => element(`[data-customer-id="${id}"]`), 'The customer list did not load the new request.');
  click(`[data-customer-id="${id}"]`);
  await eventually(() => element('#customer-conversation h2')?.textContent === subject, 'The customer request did not open.');
  change('#mode-select', 'agent');
  click(`[data-ticket-id="${id}"]`);
  await eventually(() => element('[data-action="claim"]'), 'The unassigned ticket did not show Claim.');
  click('[data-action="claim"]');
  await eventually(() => element('#reply-input'), 'The assignee did not get the reply composer.');
  click('[data-visibility="internal"]');
  element('#reply-input').value = 'Shared with agents only';
  click('#send-button');
  await eventually(() => element('#message-list')?.textContent.includes('Shared with agents only'), 'The private note did not appear for the agent.');
  element('#reply-input').value = 'Please send the file name.';
  click('#send-button');
  await eventually(() => element('#message-list')?.textContent.includes('Please send the file name.'), 'The public reply did not appear for the agent.');
  click('[data-action="waiting"]');
  await eventually(() => element('#ticket-panel .status-tag')?.textContent === 'Waiting on customer', 'The agent view did not show the waiting status.');
  assert.ok(!element('[data-visibility="public"]'));
  element('#reply-input').value = 'Waiting follow-up for agents only';
  click('#send-button');
  await eventually(() => element('#message-list')?.textContent.includes('Waiting follow-up for agents only'), 'The waiting ticket did not accept a private note.');
  change('#mode-select', 'customer');
  await eventually(() => element('#customer-conversation')?.textContent.includes('Please send the file name.'), 'The customer preview did not refresh after the agent replied.');
  assert.ok(!element('#customer-conversation').textContent.includes('Shared with agents only'));
  assert.ok(!element('#customer-conversation').textContent.includes('Waiting follow-up for agents only'));
  assert.equal(element('#customer-conversation .status-tag').textContent, 'Waiting on customer');
  element('#customer-reply').value = 'The file is report.csv.';
  click('#customer-send');
  await eventually(() => element('#customer-conversation')?.textContent.includes('The file is report.csv.'), 'The customer reply did not appear.');
  change('#mode-select', 'agent');
  await eventually(() => element('#message-list')?.textContent.includes('The file is report.csv.'), 'The agent view did not refresh after the customer replied.');
  assert.equal(element('#ticket-panel .status-tag').textContent, 'Open');
  click('[data-action="resolve"]');
  await eventually(() => element('#ticket-panel .status-tag')?.textContent === 'Resolved', 'The ticket did not resolve.');
  click('[data-action="reopen"]');
  await eventually(() => element('#ticket-panel .reopen-tag'), 'Reopening the ticket did not show the new cycle.');
  assert.equal(element('#ticket-panel .status-tag').textContent, 'Open');
  assert.match(element('#insight-panel').textContent, /Past resolutions/);
});

test('the normal startup command serves a real claim and audit entry against PostgreSQL', { timeout: 20_000 }, async (t) => {
  const id = await createTicket({ owner: null, created: new Date() });
  const child = spawn(process.execPath, ['--env-file=.env', 'src/server.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl, HOST: '127.0.0.1', PORT: '0' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  let output = '';
  let errors = '';
  let startupError;
  let address;
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
  child.once('error', (error) => { startupError = error; });
  await eventually(() => {
    if (startupError) throw startupError;
    if (child.exitCode !== null) assert.fail(`Frontdesk exited during startup: ${errors}`);
    address = output.match(/Frontdesk listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    return address;
  }, 'The startup command did not bind to a local port.', 10_000);

  const read = await fetch(address + '/api/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { ok: true, service: 'frontdesk' });
  const agent = agents[0];
  const claim = await fetch(`${address}/api/tickets/${id}/claim`, {
    method: 'POST',
    headers: { 'x-agent-id': agent.id },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(claim.status, 200, await claim.clone().text());
  assert.equal((await claim.json()).assigneeId, agent.id);
  const ticket = await detail(id);
  assert.equal(ticket.assigneeId, agent.id);
  assert.equal(events(ticket, 'claimed').length, 1);
});

test('the Vercel API protects agent data, scopes customer tickets, and authorizes the scheduled sweep', { timeout: 20_000 }, async (t) => {
  const password = randomBytes(18).toString('hex');
  const cronSecret = randomBytes(24).toString('hex');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import http from 'node:http';
    import dispatch from './api/dispatch.mjs';
    const server = http.createServer(dispatch);
    server.listen(0, '127.0.0.1', () => console.log('API_PORT=' + server.address().port));
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL_UNPOOLED: testDatabaseUrl,
      FRONTDESK_AGENT_PASSWORD: password,
      FRONTDESK_SESSION_SECRET: randomBytes(32).toString('hex'),
      CRON_SECRET: cronSecret,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  let stdout = '';
  let stderr = '';
  let port;
  let processError;
  child.once('error', (error) => { processError = error; });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  await eventually(() => {
    if (processError) throw processError;
    if (child.exitCode !== null) assert.fail(stderr);
    port = stdout.match(/API_PORT=(\d+)\r?\n/)?.[1];
    return port;
  }, 'The hosted request handler did not start.');

  async function remote(path, { method = 'GET', headers = {}, body, status = 200 } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/api/dispatch?__frontdesk_path=${encodeURIComponent(path)}`, {
      method, headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    const payload = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(payload)}\n${stderr}`);
    return { payload, cookie: response.headers.get('set-cookie') };
  }
  const { payload: boot } = await remote('bootstrap');
  const [first, second] = boot.agents;
  assert.equal(boot.agentSignInRequired, true);
  assert.equal(boot.signedInAgentId, null);
  assert.deepEqual(boot.customerTickets, []);
  await remote('tickets', { headers: { 'x-agent-id': first.id }, status: 401 });
  await remote('session/agent', { method: 'POST', status: 401, body: { agentId: first.id, password: 'wrong' } });
  const { cookie: agentCookie } = await remote('session/agent', { method: 'POST', body: { agentId: first.id, password } });
  assert.match(agentCookie, /HttpOnly; SameSite=Lax; Secure/);
  const agentHeaders = { cookie: agentCookie.split(';')[0], 'x-agent-id': second.id };
  const { payload: request, cookie: customerCookie } = await remote('customer/tickets', {
    method: 'POST', status: 201,
    body: { customerName: 'Reviewer Test', customerEmail: 'reviewer@example.test', subject: 'Isolated ticket', body: 'Customer message' }
  });
  const customerHeaders = { cookie: customerCookie.split(';')[0] };
  const id = request.ticketId;
  await remote(`tickets/${id}`, { headers: customerHeaders, status: 401 });
  await remote(`customer/tickets/${id}`, { status: 404 });
  await remote(`customer/tickets/${id}`, { method: 'POST', status: 404, body: { body: 'Wrong session' } });
  const { payload: claim } = await remote(`tickets/${id}/claim`, { method: 'POST', headers: agentHeaders });
  assert.equal(claim.assigneeId, first.id);
  await remote(`tickets/${id}/messages`, {
    method: 'POST', status: 201, headers: agentHeaders, body: { body: 'Staff-only detail', visibility: 'internal' }
  });
  const { payload: detailForCustomer } = await remote(`customer/tickets/${id}`, { headers: customerHeaders });
  assert.deepEqual(detailForCustomer.ticket.messages.map(({ body }) => body), ['Customer message']);
  const { payload: detailForAgent } = await remote(`tickets/${id}`, { headers: agentHeaders });
  assert.ok(detailForAgent.ticket.messages.some(({ body }) => body === 'Staff-only detail'));
  await remote('cron/auto-close', { status: 401 });
  await remote('cron/auto-close', { headers: { authorization: `Bearer ${cronSecret}` } });
});
