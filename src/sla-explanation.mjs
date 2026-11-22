import { workingTimeBreakdown } from './business-clock.mjs';

export function deadlineCalculation(startAt, dueAt, rule, holidays) {
  const days = workingTimeBreakdown(startAt, dueAt, holidays);
  return {
    startAt, dueAt, rule, days,
    workingMinutes: days.reduce((total, day) => total + (day.minutes ?? 0), 0)
  };
}

// Older tickets retain their recorded deadlines. Their day-by-day breakdown
// can be reconstructed from the recorded clock changes and current calendar.
export function explainTicketDeadlines(ticket, audit, holidays) {
  const creation = audit.find((event) => event.action === 'ticket_created')?.after_values;
  const firstPriorityChange = audit.find((event) => event.action === 'priority_changed')?.before_values;
  let priority = creation?.priority ?? firstPriorityChange?.priority ?? ticket.priority;
  const clocks = [
    { key: 'firstReply', dueKey: 'firstResponseDueAt', dueAt: ticket.first_response_due_at,
      pausedMinutes: ticket.paused_first_minutes, remainingKey: 'remainingFirstMinutes', consumedKey: 'firstReplyConsumedWorkingMinutes' },
    { key: 'resolution', dueKey: 'resolutionDueAt', dueAt: ticket.resolution_due_at,
      pausedMinutes: ticket.paused_resolution_minutes, remainingKey: 'remainingResolutionMinutes', consumedKey: 'resolutionConsumedWorkingMinutes' }
  ];
  const explanations = Object.fromEntries(clocks.map((clock) => [clock.key, {
    calculation: null,
    remainingMinutes: ticket.status === 'waiting_customer' && clock.pausedMinutes != null ? Number(clock.pausedMinutes) : null,
    history: []
  }]));
  const anchors = { firstReply: ticket.created_at, resolution: ticket.created_at };
  const ruleFor = (key) => key === 'resolution' && priority === 'urgent' ? 'same_working_day' : 'working_time';
  const rules = { firstReply: ruleFor('firstReply'), resolution: ruleFor('resolution') };

  for (const event of audit) {
    const before = event.before_values;
    const after = event.after_values;
    const at = after.pausedAt ?? after.repliedAt ?? after.reopenedAt ?? after.changedAt ?? event.occurred_at;
    const kind = event.action;
    if (kind === 'ticket_created' || kind === 'priority_changed') priority = after.priority ?? priority;

    for (const clock of clocks) {
      const explanation = explanations[clock.key];
      const firstReply = clock.key === 'firstReply';
      const firstAlreadySent = firstReply && ticket.first_response_at && +new Date(ticket.first_response_at) < +new Date(at);
      const previous = before[clock.dueKey] ?? null;
      const next = after[clock.dueKey] ?? null;
      const calculation = after.slaCalculations?.[clock.key];
      const reopening = kind === 'reopened' || kind === 'reopened_by_customer';
      let renew = false;
      switch (kind) {
        case 'ticket_created':
          if (!next) continue;
          renew = true;
          break;
        case 'waiting_for_customer':
          if (after[clock.remainingKey] == null && (firstAlreadySent || !previous)) continue;
          break;
        case 'customer_replied_resumed_sla':
          if (!next || (firstAlreadySent && !calculation && previous === next)) continue;
          renew = true;
          break;
        case 'priority_changed':
          if (firstAlreadySent && !calculation && previous === next) continue;
          renew = Boolean(calculation) || Boolean(next && previous !== next);
          break;
        case 'reopened':
        case 'reopened_by_customer':
          if (firstReply || !next) continue;
          renew = true;
          break;
        default:
          continue;
      }
      if (renew) {
        anchors[clock.key] = kind === 'ticket_created' ? ticket.created_at : at;
        rules[clock.key] = kind === 'customer_replied_resumed_sla' ? 'remaining_budget' : ruleFor(clock.key);
        explanation.calculation = calculation ? { ...calculation, recorded: true } : null;
      }
      explanation.history.push({
        kind, at: kind === 'ticket_created' ? ticket.created_at : at,
        previousDueAt: previous, dueAt: next,
        fromPriority: before.priority, toPriority: after.priority,
        remainingMinutes: after[clock.remainingKey], consumedMinutes: after[clock.consumedKey]
      });
    }
  }

  for (const clock of clocks) {
    const explanation = explanations[clock.key];
    const stored = explanation.calculation;
    if (!stored || +new Date(stored.dueAt) !== +new Date(clock.dueAt)) {
      explanation.calculation = {
        ...deadlineCalculation(anchors[clock.key], clock.dueAt, rules[clock.key], holidays),
        recorded: false
      };
    }
  }
  return explanations;
}
