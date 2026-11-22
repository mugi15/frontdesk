import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  addWorkingMinutes, sameWorkingDayDeadline, priorityTargets,
  workingMinutesBetween
} from './business-clock.mjs';
import { deadlineCalculation, explainTicketDeadlines } from './sla-explanation.mjs';
import { createAuth } from './auth.mjs';

const { Pool } = pg;
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://frontdesk:frontdesk_local@localhost:5432/frontdesk';
let pool;
let clock;
let auth;
const PUBLIC_DIR = resolve(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function getHolidays(db = pool) {
  const { rows } = await db.query('SELECT holiday_date::text AS date FROM holidays ORDER BY holiday_date');
  return new Set(rows.map((row) => row.date));
}

async function dbNow(db) {
  if (clock) return new Date(clock());
  const { rows } = await db.query('SELECT clock_timestamp() AS value');
  return new Date(rows[0].value);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  if (Number(req.headers['content-length']) > MAX_JSON_BYTES) {
    req.resume();
    throw new HttpError(413, 'Request body is too large.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length <= MAX_JSON_BYTES) chunks.push(chunk);
  }
  if (length > MAX_JSON_BYTES) throw new HttpError(413, 'Request body is too large.');
  if (!length) return {};
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  return body;
}

function requireAgent(req) {
  if (auth.required) {
    const id = auth.agent(req);
    if (!id) throw new HttpError(401, 'Sign in to the agent workspace.');
    return id;
  }
  const agentId = req.headers['x-agent-id'];
  if (typeof agentId !== 'string' || !UUID.test(agentId)) throw new HttpError(401, 'Choose an agent first.');
  return agentId;
}

async function findAgent(db, id) {
  const { rows } = await db.query('SELECT id, name, email FROM agents WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(401, 'That agent account does not exist.');
  return rows[0];
}

async function appendAudit(db, { ticketId, actorType, actorId = null, actorName, action, before = {}, after = {} }) {
  await db.query(
    `INSERT INTO audit_events (ticket_id, actor_type, actor_id, actor_name, action, before_values, after_values)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [ticketId, actorType, actorId, actorName, action, JSON.stringify(before), JSON.stringify(after)]
  );
}

async function addMessage(db, { ticketId, senderType, senderId = null, senderName, visibility, body }) {
  const { rows } = await db.query(
    `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, sender_name, visibility, body)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ticketId, senderType, senderId, senderName, visibility, body.trim()]
  );
  return rows[0];
}

function validateText(value, label, max = 4000) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new HttpError(400, `${label} is required.`);
  if (value.trim().length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return value.trim();
}

async function loadTicket(db, ticketId, forUpdate = false, customerSession) {
  const scoped = customerSession !== undefined;
  const { rows } = await db.query(
    `SELECT t.*, a.name AS assignee_name
     FROM tickets t LEFT JOIN agents a ON a.id = t.assignee_id
     WHERE t.id = $1 ${scoped ? 'AND t.customer_session_id = $2' : ''} ${forUpdate ? 'FOR UPDATE OF t' : ''}`,
    scoped ? [ticketId, customerSession] : [ticketId]
  );
  if (!rows[0]) throw new HttpError(404, 'Ticket not found.');
  return rows[0];
}

function remainingMinutes(deadline, now, holidays) {
  if (!deadline || new Date(deadline) <= now) return 0;
  return Math.max(0, workingMinutesBetween(now, deadline, holidays));
}

function newTicketCalculations(startAt, firstDue, resolutionDue, targets, holidays) {
  return {
    firstReply: deadlineCalculation(startAt, firstDue, 'working_time', holidays),
    resolution: deadlineCalculation(startAt, resolutionDue, targets.sameDayResolution ? 'same_working_day' : 'working_time', holidays)
  };
}

async function closeExpiredWaitingTicket(db, ticket, now) {
  if (ticket.status !== 'waiting_customer' || !ticket.auto_close_at || new Date(ticket.auto_close_at) > now) return false;
  await db.query(
    `UPDATE tickets SET status = 'closed', auto_close_at = NULL, waiting_since = NULL, updated_at = $2 WHERE id = $1`,
    [ticket.id, now]
  );
  await appendAudit(db, {
    ticketId: ticket.id, actorType: 'system', actorName: 'Frontdesk automation', action: 'auto_closed',
    before: { status: 'waiting_customer', autoCloseAt: ticket.auto_close_at },
    after: { status: 'closed', closedAt: now.toISOString(), reason: 'five working days without a customer reply' }
  });
  return true;
}

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function slaState(ticket, now) {
  function statusFor({ completed, breached, due }) {
    if (completed) return breached ? 'missed' : 'met';
    if (ticket.status === 'closed' || ticket.status === 'resolved') return breached ? 'missed' : 'not_completed';
    if (ticket.status === 'waiting_customer') return 'paused';
    return breached || now > new Date(due) ? 'overdue' : 'on_track';
  }
  return {
    firstReply: statusFor({ completed: ticket.first_response_at, breached: ticket.first_response_breached, due: ticket.first_response_due_at }),
    resolution: statusFor({ completed: ticket.status === 'resolved', breached: ticket.resolution_breached, due: ticket.resolution_due_at })
  };
}

async function ticketListRow(ticket, now) {
  const state = slaState(ticket, now);
  return {
    id: ticket.id, subject: ticket.subject, customerName: ticket.customer_name, customerEmail: ticket.customer_email,
    priority: ticket.priority, status: ticket.status, assigneeId: ticket.assignee_id, assigneeName: ticket.assignee_name,
    createdAt: ticket.created_at, updatedAt: ticket.updated_at, firstResponseAt: ticket.first_response_at,
    firstResponseDueAt: ticket.first_response_due_at, resolutionDueAt: ticket.resolution_due_at,
    firstResponseBreached: ticket.first_response_breached, resolutionBreached: ticket.resolution_breached,
    waitingSince: ticket.waiting_since, autoCloseAt: ticket.auto_close_at, resolvedAt: ticket.resolved_at,
    reopenedCount: ticket.reopened_count, sla: state
  };
}

async function initializeDatabase(db) {
  await db.query('SELECT pg_advisory_xact_lock(482325139)');
  const schema = await readFile(resolve(ROOT, 'src/schema.sql'), 'utf8');
  await db.query(schema);
  await db.query(
    `INSERT INTO holidays (holiday_date, label) VALUES ('2026-11-23', 'Demo holiday - remove or replace for your calendar')
     ON CONFLICT (holiday_date) DO NOTHING`
  );

  const agentRows = [];
  for (const [name, email] of [
    ['Meera Shah', 'meera@example.test'], ['Arjun Rao', 'arjun@example.test'], ['Nisha Patel', 'nisha@example.test'],
    ['Kabir Das', 'kabir@example.test'], ['Ira Kapoor', 'ira@example.test'], ['Rohan Iyer', 'rohan@example.test'],
    ['Tara Menon', 'tara@example.test'], ['Neil Fernandes', 'neil@example.test'], ['Zoya Khan', 'zoya@example.test']
  ]) {
    const result = await db.query(
      `INSERT INTO agents (name, email) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id, name, email`,
      [name, email]
    );
    agentRows.push(result.rows[0]);
  }

  const count = Number((await db.query('SELECT count(*)::int AS n FROM tickets')).rows[0].n);
  if (count === 0) await seedTickets(db, agentRows);
  await db.query(`ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_immutable`);
}

async function seedTickets(db, agents) {
  const holidays = await getHolidays(db);
  const now = await dbNow(db);
  const samples = [
    { key: 'urgent-overdue', subject: 'Payments are failing at checkout', customer: 'Ritika Menon', email: 'ritika@example.test', priority: 'urgent', ageDays: 14, assignee: null },
    { key: 'waiting-customer', subject: 'Need the export format you expect', customer: 'Dev Khanna', email: 'dev@example.test', priority: 'medium', ageDays: 2, assignee: agents[0] },
    { key: 'ready-to-claim', subject: 'Invite link expired before my team joined', customer: 'Samira Bose', email: 'samira@example.test', priority: 'urgent', ageDays: 0, assignee: null },
    { key: 'assigned-low', subject: 'Can I change the weekly summary day?', customer: 'Aman Gill', email: 'aman@example.test', priority: 'low', ageDays: 1, assignee: agents[1] }
  ];
  for (const sample of samples) {
    const created = new Date(now.getTime() - sample.ageDays * 86400000);
    const targets = priorityTargets(sample.priority);
    const firstDue = addWorkingMinutes(created, targets.firstReplyMinutes, holidays);
    const resolutionDue = targets.sameDayResolution ? sameWorkingDayDeadline(created, holidays) : addWorkingMinutes(created, targets.resolutionMinutes, holidays);
    const responseAt = sample.key === 'waiting-customer' || sample.key === 'assigned-low' ? addWorkingMinutes(created, 30, holidays) : null;
    const status = sample.key === 'waiting-customer' ? 'waiting_customer' : 'open';
    const values = await db.query(
      `INSERT INTO tickets
         (subject, customer_name, customer_email, priority, status, assignee_id, created_at, updated_at,
          first_response_at, first_response_due_at, resolution_due_at, first_response_breached,
          resolution_cycle_started_at, resolution_breached, waiting_since, auto_close_at, paused_first_minutes, paused_resolution_minutes, seed_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$7,false,$12,$13,$14,$15,$16)
       RETURNING *`,
      [sample.subject, sample.customer, sample.email, sample.priority, status, sample.assignee?.id || null, created,
        responseAt, firstDue, resolutionDue, sample.key === 'urgent-overdue',
        status === 'waiting_customer' ? now : null,
        status === 'waiting_customer' ? addWorkingMinutes(now, 5 * 9 * 60, holidays) : null,
        null,
        status === 'waiting_customer' ? remainingMinutes(resolutionDue, now, holidays) : null,
        sample.key]
    );
    const ticket = values.rows[0];
    await addMessage(db, { ticketId: ticket.id, senderType: 'customer', senderName: sample.customer, visibility: 'public', body: 'Hello, could you help me with this? I have shared the details above and can provide anything else you need.' });
    if (responseAt) await addMessage(db, { ticketId: ticket.id, senderType: 'agent', senderId: sample.assignee.id, senderName: sample.assignee.name, visibility: 'public', body: 'Thanks for the details. I am looking into this and will follow up shortly.' });
    await appendAudit(db, {
      ticketId: ticket.id, actorType: 'system', actorName: 'Frontdesk setup', action: 'ticket_created',
      after: {
        status, priority: sample.priority, firstResponseDueAt: firstDue, resolutionDueAt: resolutionDue, demo: true,
        slaCalculations: newTicketCalculations(created, firstDue, resolutionDue, targets, holidays)
      }
    });
    if (sample.key === 'waiting-customer') {
      await addMessage(db, { ticketId: ticket.id, senderType: 'agent', senderId: sample.assignee.id, senderName: sample.assignee.name, visibility: 'internal', body: 'Demo private note: ask which export columns matter before sending a public reply.' });
      await appendAudit(db, {
        ticketId: ticket.id, actorType: 'agent', actorId: sample.assignee.id, actorName: sample.assignee.name, action: 'waiting_for_customer',
        before: { status: 'open', resolutionDueAt: resolutionDue },
        after: { status: 'waiting_customer', pausedAt: now, autoCloseAt: ticket.auto_close_at, remainingResolutionMinutes: Number(ticket.paused_resolution_minutes) }
      });
    }
  }
}

async function runAutoCloseSweep() {
  const cutoff = await dbNow(pool);
  const { rows } = await pool.query(
    `SELECT id FROM tickets WHERE status = 'waiting_customer' AND auto_close_at <= $1 ORDER BY auto_close_at LIMIT 100`,
    [cutoff]
  );
  for (const row of rows) {
    await transaction(async (client) => {
      const ticket = await loadTicket(client, row.id, true);
      const now = await dbNow(client);
      await closeExpiredWaitingTicket(client, ticket, now);
    });
  }
}

async function listTickets({ customerOnly = false, customerSession } = {}) {
  if (customerSession === null) return [];
  const now = await dbNow(pool);
  const { rows } = await pool.query(
    `SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN agents a ON a.id = t.assignee_id
     ${customerSession === undefined ? '' : 'WHERE t.customer_session_id = $1'}
     ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
       CASE t.status WHEN 'waiting_customer' THEN 3 WHEN 'resolved' THEN 4 ELSE 0 END,
       t.created_at ASC`,
    customerSession === undefined ? [] : [customerSession]
  );
  const mapped = await Promise.all(rows.map((ticket) => ticketListRow(ticket, now)));
  return customerOnly ? mapped.map(({ id, subject, customerName, priority, status, createdAt, updatedAt, firstResponseAt }) => ({ id, subject, customerName, priority, status, createdAt, updatedAt, firstResponseAt })) : mapped;
}

async function getTicketDetail(ticketId, customerOnly = false, customerSession) {
  const ticket = await loadTicket(pool, ticketId, false, customerSession);
  const now = await dbNow(pool);
  const [messages, audit, resolutions, holidays] = await Promise.all([
    pool.query(`SELECT id, sender_type, sender_name, visibility, body, created_at FROM ticket_messages WHERE ticket_id = $1 ${customerOnly ? "AND visibility = 'public'" : ''} ORDER BY created_at, id`, [ticketId]),
    customerOnly ? Promise.resolve({ rows: [] }) : pool.query('SELECT id, actor_type, actor_name, action, before_values, after_values, occurred_at FROM audit_events WHERE ticket_id = $1 ORDER BY event_order', [ticketId]),
    customerOnly ? Promise.resolve({ rows: [] }) : pool.query('SELECT cycle_number, resolved_at, priority, first_response_breached, resolution_breached FROM ticket_resolutions WHERE ticket_id = $1 ORDER BY cycle_number DESC', [ticketId]),
    customerOnly ? null : getHolidays()
  ]);
  if (customerOnly) return {
    id: ticket.id, subject: ticket.subject, customerName: ticket.customer_name,
    priority: ticket.priority, status: ticket.status, createdAt: ticket.created_at,
    updatedAt: ticket.updated_at, firstResponseAt: ticket.first_response_at,
    messages: messages.rows
  };
  const result = await ticketListRow(ticket, now);
  result.messages = messages.rows;
  result.audit = audit.rows;
  result.resolutions = resolutions.rows;
  result.slaExplanation = explainTicketDeadlines(ticket, audit.rows, holidays);
  result.holidayTimezone = 'Asia/Kolkata';
  return result;
}

async function claimTicket(ticketId, agentId) {
  return transaction(async (client) => {
    const agent = await findAgent(client, agentId);
    const { rows } = await client.query(
      `UPDATE tickets SET assignee_id = $2, updated_at = now()
       WHERE id = $1 AND assignee_id IS NULL AND status IN ('open','waiting_customer') RETURNING *`,
      [ticketId, agentId]
    );
    if (!rows[0]) {
      const current = await loadTicket(client, ticketId);
      if (current.assignee_id === agentId) return { ticketId, assigneeId: agentId, alreadyClaimed: true };
      throw new HttpError(409, 'Another agent has already claimed this ticket.', { assigneeName: current.assignee_name });
    }
    await appendAudit(client, { ticketId, actorType: 'agent', actorId: agentId, actorName: agent.name, action: 'claimed', before: { assigneeId: null }, after: { assigneeId: agentId, assigneeName: agent.name } });
    return { ticketId, assigneeId: agentId, assigneeName: agent.name };
  });
}

async function agentMessage(ticketId, agentId, body, visibility) {
  const content = validateText(body, 'Message');
  if (!['public', 'internal'].includes(visibility)) throw new HttpError(400, 'Choose public reply or internal note.');
  return transaction(async (client) => {
    const agent = await findAgent(client, agentId);
    const ticket = await loadTicket(client, ticketId, true);
    if (ticket.assignee_id !== agentId) throw new HttpError(409, 'Claim this ticket before replying.');
    if (ticket.status === 'resolved' || ticket.status === 'closed') throw new HttpError(409, 'Reopen this ticket before adding a message.');
    if (visibility === 'public' && ticket.status === 'waiting_customer') throw new HttpError(409, 'Wait for the customer to reply before sending another public response.');
    const now = await dbNow(client);
    const message = await addMessage(client, { ticketId, senderType: 'agent', senderId: agent.id, senderName: agent.name, visibility, body: content });
    const before = { firstResponseAt: ticket.first_response_at, status: ticket.status };
    if (visibility === 'public') {
      await client.query(
        `UPDATE tickets SET first_response_at = COALESCE(first_response_at, $2),
           first_response_breached = first_response_breached OR (first_response_at IS NULL AND $2 > first_response_due_at),
           updated_at = $2 WHERE id = $1`, [ticketId, now]
      );
    } else {
      await client.query('UPDATE tickets SET updated_at = $2 WHERE id = $1', [ticketId, now]);
    }
    await appendAudit(client, { ticketId, actorType: 'agent', actorId: agent.id, actorName: agent.name, action: visibility === 'public' ? 'public_reply_posted' : 'internal_note_added', before, after: { messageId: message.id, visibility, postedAt: now.toISOString() } });
    return { messageId: message.id, postedAt: message.created_at };
  });
}

async function changeTicketStatus(ticketId, agentId, action) {
  const holidays = await getHolidays(pool);
  return transaction(async (client) => {
    const agent = await findAgent(client, agentId);
    const ticket = await loadTicket(client, ticketId, true);
    if (ticket.assignee_id !== agentId) throw new HttpError(409, 'Only the current assignee can change this ticket.');
    const now = await dbNow(client);
    if (action === 'waiting') {
      if (ticket.status !== 'open') throw new HttpError(409, 'Only an open ticket can move to waiting on customer.');
      const firstBreached = ticket.first_response_breached || (!ticket.first_response_at && now > new Date(ticket.first_response_due_at));
      const resolutionBreached = ticket.resolution_breached || now > new Date(ticket.resolution_due_at);
      const firstRemaining = ticket.first_response_at ? null : remainingMinutes(ticket.first_response_due_at, now, holidays);
      const resolutionRemaining = remainingMinutes(ticket.resolution_due_at, now, holidays);
      const autoClose = addWorkingMinutes(now, 5 * 9 * 60, holidays);
      await client.query(
        `UPDATE tickets SET status='waiting_customer', waiting_since=$2, auto_close_at=$3,
         paused_first_minutes=$4, paused_resolution_minutes=$5,
         first_response_breached=$6, resolution_breached=$7, updated_at=$2 WHERE id=$1`,
        [ticketId, now, autoClose, firstRemaining, resolutionRemaining, firstBreached, resolutionBreached]
      );
      await appendAudit(client, { ticketId, actorType: 'agent', actorId: agent.id, actorName: agent.name, action: 'waiting_for_customer', before: { status: ticket.status, firstResponseDueAt: ticket.first_response_due_at, resolutionDueAt: ticket.resolution_due_at }, after: { status: 'waiting_customer', pausedAt: now.toISOString(), autoCloseAt: autoClose.toISOString(), remainingFirstMinutes: firstRemaining, remainingResolutionMinutes: resolutionRemaining } });
      return { status: 'waiting_customer', autoCloseAt: autoClose };
    }
    if (action === 'resolve') {
      if (['resolved', 'closed'].includes(ticket.status)) throw new HttpError(409, 'This ticket is already resolved or closed.');
      const paused = ticket.status === 'waiting_customer';
      const responseBreached = ticket.first_response_breached || (!ticket.first_response_at && !paused && now > new Date(ticket.first_response_due_at));
      const resolutionBreached = ticket.resolution_breached || (!paused && now > new Date(ticket.resolution_due_at));
      const cycle = ticket.reopened_count + 1;
      const reopenUntil = new Date(now.getTime() + 7 * 86400000);
      await client.query(
        `INSERT INTO ticket_resolutions (ticket_id, cycle_number, resolved_at, priority, first_response_breached, resolution_breached)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (ticket_id, cycle_number) DO NOTHING`,
        [ticketId, cycle, now, ticket.priority, responseBreached, resolutionBreached]
      );
      await client.query(
        `UPDATE tickets SET status='resolved', resolved_at=$2, reopen_until=$5,
         auto_close_at=NULL, waiting_since=NULL, paused_first_minutes=NULL, paused_resolution_minutes=NULL, first_response_breached=$3,
         resolution_breached=$4, updated_at=$2 WHERE id=$1`,
        [ticketId, now, responseBreached, resolutionBreached, reopenUntil]
      );
      await appendAudit(client, { ticketId, actorType: 'agent', actorId: agent.id, actorName: agent.name, action: 'resolved', before: { status: ticket.status, resolutionDueAt: ticket.resolution_due_at }, after: { status: 'resolved', resolvedAt: now.toISOString(), reopenUntil: reopenUntil.toISOString(), cycle, resolutionBreached } });
      return { status: 'resolved', resolvedAt: now };
    }
    if (action === 'reopen') {
      if (ticket.status !== 'resolved' || !ticket.reopen_until || now > new Date(ticket.reopen_until)) throw new HttpError(409, 'This ticket is outside its seven-day reopening window.');
      const targets = priorityTargets(ticket.priority);
      const resolutionDue = targets.sameDayResolution ? sameWorkingDayDeadline(now, holidays) : addWorkingMinutes(now, targets.resolutionMinutes, holidays);
      await client.query(
        `UPDATE tickets SET status='open', resolved_at=NULL, reopen_until=NULL, resolution_due_at=$2,
         resolution_breached=false, resolution_wait_minutes=0, resolution_cycle_started_at=$3,
         reopened_count=reopened_count+1, updated_at=$3 WHERE id=$1`,
        [ticketId, resolutionDue, now]
      );
      await appendAudit(client, {
        ticketId, actorType: 'agent', actorId: agent.id, actorName: agent.name, action: 'reopened',
        before: { status: ticket.status, resolvedAt: ticket.resolved_at, resolutionBreached: ticket.resolution_breached, resolutionDueAt: ticket.resolution_due_at },
        after: {
          status: 'open', resolutionDueAt: resolutionDue, reopenedAt: now, slaCycle: ticket.reopened_count + 2,
          slaCalculations: { resolution: deadlineCalculation(now, resolutionDue, targets.sameDayResolution ? 'same_working_day' : 'working_time', holidays) }
        }
      });
      return { status: 'open', resolutionDueAt: resolutionDue };
    }
    throw new HttpError(400, 'Unsupported status change.');
  });
}

async function changePriority(ticketId, agentId, priority) {
  if (!['urgent', 'medium', 'low'].includes(priority)) throw new HttpError(400, 'Choose urgent, medium, or low priority.');
  const holidays = await getHolidays(pool);
  return transaction(async (client) => {
    const agent = await findAgent(client, agentId);
    const ticket = await loadTicket(client, ticketId, true);
    if (ticket.assignee_id !== agentId) throw new HttpError(409, 'Only the current assignee can change priority.');
    if (!['open', 'waiting_customer'].includes(ticket.status)) throw new HttpError(409, 'Only active tickets can change priority.');
    const now = await dbNow(client);
    const targets = priorityTargets(priority);
    const waiting = ticket.status === 'waiting_customer';
    const activeWaitMinutes = ticket.waiting_since ? workingMinutesBetween(ticket.waiting_since, now, holidays) : 0;
    const firstElapsed = Math.max(0, workingMinutesBetween(ticket.created_at, now, holidays) - Number(ticket.first_reply_wait_minutes || 0) - (ticket.first_response_at ? 0 : activeWaitMinutes));
    const resolutionElapsed = Math.max(0, workingMinutesBetween(ticket.resolution_cycle_started_at || ticket.created_at, now, holidays) - Number(ticket.resolution_wait_minutes || 0) - activeWaitMinutes);
    const firstBudget = targets.firstReplyMinutes - firstElapsed;
    const resolutionBudget = targets.resolutionMinutes - resolutionElapsed;
    const firstRemaining = Math.max(0, firstBudget);
    const resolutionRemaining = Math.max(0, targets.sameDayResolution
      ? Math.min(resolutionBudget, remainingMinutes(sameWorkingDayDeadline(now, holidays), now, holidays))
      : resolutionBudget);
    const firstDue = ticket.first_response_at || waiting ? ticket.first_response_due_at
      : firstBudget < 0 ? now : addWorkingMinutes(now, firstRemaining, holidays);
    const resolutionDue = waiting ? ticket.resolution_due_at
      : resolutionBudget < 0 ? now : addWorkingMinutes(now, resolutionRemaining, holidays);
    const responseBreached = ticket.first_response_breached || (!ticket.first_response_at
      && (firstBudget < 0 || (!waiting && now > new Date(ticket.first_response_due_at))));
    const resolutionBreached = ticket.resolution_breached || resolutionBudget < 0
      || (!waiting && now > new Date(ticket.resolution_due_at));
    await client.query(
      `UPDATE tickets SET priority=$2, first_response_due_at=$3, resolution_due_at=$4,
       paused_first_minutes=$5, paused_resolution_minutes=$6, first_response_breached=$7,
       resolution_breached=$8, updated_at=$9 WHERE id=$1`,
      [ticketId, priority, firstDue, resolutionDue,
        waiting && !ticket.first_response_at ? firstRemaining : null,
        waiting ? resolutionRemaining : null,
        responseBreached, resolutionBreached, now]
    );
    const calculations = {};
    if (!waiting) {
      if (!ticket.first_response_at) {
        calculations.firstReply = deadlineCalculation(now, firstDue, firstBudget < 0 ? 'budget_exhausted' : 'working_time', holidays);
      }
      const rule = resolutionBudget < 0 ? 'budget_exhausted' : targets.sameDayResolution ? 'same_day_cap' : 'working_time';
      calculations.resolution = deadlineCalculation(now, resolutionDue, rule, holidays);
    }
    await appendAudit(client, {
      ticketId, actorType: 'agent', actorId: agent.id, actorName: agent.name, action: 'priority_changed',
      before: { priority: ticket.priority, firstResponseDueAt: ticket.first_response_due_at, resolutionDueAt: ticket.resolution_due_at },
      after: {
        priority, changedAt: now, firstResponseDueAt: firstDue, resolutionDueAt: resolutionDue,
        firstReplyConsumedWorkingMinutes: firstElapsed, resolutionConsumedWorkingMinutes: resolutionElapsed,
        remainingFirstMinutes: waiting && !ticket.first_response_at ? firstRemaining : undefined,
        remainingResolutionMinutes: waiting ? resolutionRemaining : undefined,
        slaCalculations: calculations
      }
    });
    return { priority, firstResponseDueAt: firstDue, resolutionDueAt: resolutionDue };
  });
}

async function createCustomerTicket({ customerName, customerEmail, subject, body }, customerSession) {
  const name = validateText(customerName, 'Name', 100);
  const email = validateText(customerEmail, 'Email', 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  const title = validateText(subject, 'Subject', 160);
  const content = validateText(body, 'Description');
  const priority = 'medium';
  const targets = priorityTargets(priority);

  return transaction(async (client) => {
    const now = await dbNow(client);
    const holidays = await getHolidays(client);
    const firstDue = addWorkingMinutes(now, targets.firstReplyMinutes, holidays);
    const resolutionDue = addWorkingMinutes(now, targets.resolutionMinutes, holidays);
    const { rows: [{ id: ticketId }] } = await client.query(
      `INSERT INTO tickets (subject, customer_name, customer_email, priority, created_at, updated_at,
         resolution_cycle_started_at, first_response_due_at, resolution_due_at, customer_session_id)
       VALUES ($1, $2, $3, $4, $5, $5, $5, $6, $7, $8)
       RETURNING id`,
      [title, name, email, priority, now, firstDue, resolutionDue, customerSession]
    );
    const message = await addMessage(client, {
      ticketId, senderType: 'customer', senderName: name, visibility: 'public', body: content
    });
    await appendAudit(client, {
      ticketId, actorType: 'customer', actorName: name, action: 'ticket_created',
      after: {
        status: 'open', priority, firstResponseDueAt: firstDue, resolutionDueAt: resolutionDue, messageId: message.id,
        slaCalculations: newTicketCalculations(now, firstDue, resolutionDue, targets, holidays)
      }
    });
    return { ticketId };
  });
}

async function customerReply(ticketId, body, customerSession) {
  const content = validateText(body, 'Reply');
  const holidays = await getHolidays(pool);
  const result = await transaction(async (client) => {
    let ticket = await loadTicket(client, ticketId, true, customerSession);
    const now = await dbNow(client);
    if (await closeExpiredWaitingTicket(client, ticket, now)) return { cutoffReached: true };
    if (ticket.status === 'closed') throw new HttpError(409, 'This ticket is closed.');
    if (ticket.status === 'resolved') {
      if (!ticket.reopen_until || now > new Date(ticket.reopen_until)) throw new HttpError(409, 'The seven-day reopening window has ended.');
      const targets = priorityTargets(ticket.priority);
      const resolutionDue = targets.sameDayResolution ? sameWorkingDayDeadline(now, holidays) : addWorkingMinutes(now, targets.resolutionMinutes, holidays);
      await client.query(`UPDATE tickets SET status='open', resolved_at=NULL, reopen_until=NULL, resolution_due_at=$2, resolution_breached=false, resolution_wait_minutes=0, resolution_cycle_started_at=$3, reopened_count=reopened_count+1, updated_at=$3 WHERE id=$1`, [ticketId, resolutionDue, now]);
      await appendAudit(client, {
        ticketId, actorType: 'customer', actorName: ticket.customer_name, action: 'reopened_by_customer',
        before: { status: 'resolved', resolvedAt: ticket.resolved_at, resolutionDueAt: ticket.resolution_due_at },
        after: {
          status: 'open', resolutionDueAt: resolutionDue, reopenedAt: now, slaCycle: ticket.reopened_count + 2,
          slaCalculations: { resolution: deadlineCalculation(now, resolutionDue, targets.sameDayResolution ? 'same_working_day' : 'working_time', holidays) }
        }
      });
      ticket = { ...ticket, status: 'open', resolution_due_at: resolutionDue, reopened_count: ticket.reopened_count + 1 };
    } else if (ticket.status === 'waiting_customer') {
      const firstDue = ticket.first_response_at ? ticket.first_response_due_at : addWorkingMinutes(now, Number(ticket.paused_first_minutes || 0), holidays);
      const resolutionDue = addWorkingMinutes(now, Number(ticket.paused_resolution_minutes || 0), holidays);
      const waitMinutes = workingMinutesBetween(ticket.waiting_since, now, holidays);
      await client.query(
        `UPDATE tickets SET status='open', waiting_since=NULL, auto_close_at=NULL,
         first_response_due_at=$2, resolution_due_at=$3, paused_first_minutes=NULL,
         paused_resolution_minutes=NULL,
         first_reply_wait_minutes=first_reply_wait_minutes + CASE WHEN first_response_at IS NULL THEN $5::numeric ELSE 0 END,
         resolution_wait_minutes=resolution_wait_minutes + $5::numeric, updated_at=$4 WHERE id=$1`,
        [ticketId, firstDue, resolutionDue, now, waitMinutes]
      );
      const calculations = { resolution: deadlineCalculation(now, resolutionDue, 'remaining_budget', holidays) };
      if (!ticket.first_response_at) calculations.firstReply = deadlineCalculation(now, firstDue, 'remaining_budget', holidays);
      await appendAudit(client, {
        ticketId, actorType: 'customer', actorName: ticket.customer_name, action: 'customer_replied_resumed_sla',
        before: { status: 'waiting_customer', firstResponseDueAt: ticket.first_response_due_at, resolutionDueAt: ticket.resolution_due_at },
        after: {
          status: 'open', firstResponseDueAt: firstDue, resolutionDueAt: resolutionDue, repliedAt: now,
          remainingFirstMinutes: ticket.paused_first_minutes == null ? undefined : Number(ticket.paused_first_minutes),
          remainingResolutionMinutes: Number(ticket.paused_resolution_minutes), slaCalculations: calculations
        }
      });
      ticket = { ...ticket, status: 'open', first_response_due_at: firstDue, resolution_due_at: resolutionDue };
    }
    const message = await addMessage(client, { ticketId, senderType: 'customer', senderName: ticket.customer_name, visibility: 'public', body: content });
    await client.query('UPDATE tickets SET updated_at=$2 WHERE id=$1', [ticketId, now]);
    await appendAudit(client, { ticketId, actorType: 'customer', actorName: ticket.customer_name, action: 'customer_reply_received', after: { messageId: message.id, receivedAt: now.toISOString() } });
    return { messageId: message.id, status: ticket.status };
  });
  if (result.cutoffReached) throw new HttpError(409, 'This ticket reached its inactivity cutoff and is now closed.');
  return result;
}

async function serveStatic(pathname, res) {
  const assetPath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const path = resolve(PUBLIC_DIR, assetPath);
  const fromPublic = relative(PUBLIC_DIR, path);
  if (isAbsolute(fromPublic) || fromPublic === '..' || fromPublic.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new HttpError(404, 'Not found.');
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    throw new HttpError(404, 'Not found.');
  }
}

async function route(req, res, serverless = false) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const forwarded = url.searchParams.get('__frontdesk_path');
  const path = serverless && forwarded ? `/api/${forwarded}` : url.pathname;
  const agent = auth.agent(req);
  const customerSession = auth.required && !agent ? auth.customer(req) : undefined;
  if (req.method === 'GET' && path === '/api/health') {
    await pool.query('SELECT 1');
    return json(res, 200, { ok: true, service: 'frontdesk' });
  }
  if (req.method === 'GET' && path === '/api/cron/auto-close') {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'Unauthorized.');
    await runAutoCloseSweep();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/api/session/agent') {
    const { agentId, password } = await readJson(req);
    if (!auth.checkAgentPassword(password) || typeof agentId !== 'string' || !UUID.test(agentId)) {
      throw new HttpError(401, 'Check the agent and reviewer password.');
    }
    const signedIn = await findAgent(pool, agentId);
    auth.signInAgent(res, signedIn.id);
    return json(res, 200, { agentId: signedIn.id });
  }
  if (req.method === 'POST' && path === '/api/session/sign-out') {
    if (auth.required) auth.signOutAgent(res);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && path === '/api/bootstrap') {
    if (serverless && (agent || customerSession)) await runAutoCloseSweep();
    const [agents, holidays, tickets] = await Promise.all([
      pool.query('SELECT id, name FROM agents ORDER BY name'),
      pool.query('SELECT holiday_date::text AS date, label FROM holidays ORDER BY holiday_date'),
      listTickets({ customerOnly: true, customerSession })
    ]);
    return json(res, 200, {
      agents: agents.rows, holidays: holidays.rows, customerTickets: tickets, timezone: 'Asia/Kolkata',
      agentSignInRequired: auth.required, signedInAgentId: agent
    });
  }
  if (req.method === 'GET' && path === '/api/tickets') {
    if (auth.required) requireAgent(req);
    if (serverless) await runAutoCloseSweep();
    return json(res, 200, { tickets: await listTickets() });
  }
  if (req.method === 'GET' && path === '/api/customer/tickets') {
    if (serverless && (agent || customerSession)) await runAutoCloseSweep();
    return json(res, 200, { tickets: await listTickets({ customerOnly: true, customerSession }) });
  }
  if (req.method === 'POST' && path === '/api/customer/tickets') {
    const body = await readJson(req);
    return json(res, 201, await createCustomerTicket(body, auth.rememberCustomer(req, res)));
  }

  const customerMatch = path.match(/^\/api\/customer\/tickets\/([0-9a-f-]+)$/i);
  if (customerMatch && !UUID.test(customerMatch[1])) throw new HttpError(404, 'Ticket not found.');
  if (req.method === 'GET' && customerMatch) return json(res, 200, { ticket: await getTicketDetail(customerMatch[1], true, customerSession) });
  if (req.method === 'POST' && customerMatch) {
    const body = await readJson(req);
    return json(res, 201, await customerReply(customerMatch[1], body.body, customerSession));
  }

  const ticketMatch = path.match(/^\/api\/tickets\/([0-9a-f-]+)(?:\/(claim|messages|status|priority))?$/i);
  if (ticketMatch) {
    const [, ticketId, action] = ticketMatch;
    if (!UUID.test(ticketId)) throw new HttpError(404, 'Ticket not found.');
    if (req.method === 'GET' && !action) {
      if (auth.required) requireAgent(req);
      return json(res, 200, { ticket: await getTicketDetail(ticketId) });
    }
    if (req.method === 'POST' && action === 'claim') return json(res, 200, await claimTicket(ticketId, requireAgent(req)));
    if (req.method === 'POST' && action === 'messages') {
      const body = await readJson(req);
      return json(res, 201, await agentMessage(ticketId, requireAgent(req), body.body, body.visibility));
    }
    if (req.method === 'POST' && action === 'status') {
      const body = await readJson(req);
      return json(res, 200, await changeTicketStatus(ticketId, requireAgent(req), body.action));
    }
    if (req.method === 'POST' && action === 'priority') {
      const body = await readJson(req);
      return json(res, 200, await changePriority(ticketId, requireAgent(req), body.priority));
    }
  }

  if (!serverless && req.method === 'GET' && !path.startsWith('/api/')) return serveStatic(path, res);
  throw new HttpError(404, 'Not found.');
}

function reportHttpError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) console.error(error);
  const message = status >= 500 ? 'Frontdesk could not complete the request.' : error.message;
  json(res, status, { error: message, ...(error.details ? { details: error.details } : {}) });
}

async function configureApplication(databaseUrl, now, authOptions) {
  if (pool) throw new Error('Frontdesk is already running in this process.');
  clock = now;
  auth = createAuth(authOptions);
  pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 8000 });
  try {
    await transaction(initializeDatabase);
    await pool.end();
    pool = new Pool({
      connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 8000,
      onConnect: (client) => client.query('SET ROLE frontdesk_runtime')
    });
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => {});
    pool = undefined;
    clock = undefined;
    throw error;
  }
}

export function createVercelHandler() {
  let initialization;
  return async (req, res) => {
    try {
      const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error('Configure a direct PostgreSQL connection for the Vercel project.');
      initialization ??= configureApplication(databaseUrl, undefined, { required: true, secureCookies: true })
        .catch((error) => {
          initialization = undefined;
          throw error;
        });
      await initialization;
      await route(req, res, true);
    } catch (error) {
      reportHttpError(res, error);
    }
  };
}

export async function startFrontdesk({
  databaseUrl = DATABASE_URL, host = HOST, port = PORT, now, authOptions, sweepIntervalMs = 60_000
} = {}) {
  await configureApplication(databaseUrl, now, authOptions);
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      reportHttpError(res, error);
    }
  });

  try {
    server.listen(port, host);
    await once(server, 'listening');
  } catch (error) {
    await pool.end().catch(() => {});
    pool = undefined;
    clock = undefined;
    throw error;
  }

  let activeSweep;
  function sweepInBackground() {
    if (activeSweep) return;
    activeSweep = runAutoCloseSweep()
      .catch((error) => console.error('Auto-close sweep failed:', error))
      .finally(() => { activeSweep = undefined; });
  }
  const timer = sweepIntervalMs > 0 ? setInterval(sweepInBackground, sweepIntervalMs) : undefined;
  timer?.unref();
  sweepInBackground();

  return {
    server,
    sweep: runAutoCloseSweep,
    async close() {
      clearInterval(timer);
      await new Promise((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
        server.closeIdleConnections();
      });
      await activeSweep;
      await pool.end();
      pool = undefined;
      clock = undefined;
    }
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const app = await startFrontdesk();
  console.log(`Frontdesk listening on http://${HOST}:${app.server.address().port}`);
  const shutdown = () => {
    setTimeout(() => process.exit(1), 5000).unref();
    app.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
