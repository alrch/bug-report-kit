export const STATUSES = ['new', 'triaged', 'in_progress', 'ready_for_check', 'closed', 'cancelled'];
export const PRIORITIES = ['low', 'normal', 'high', 'critical'];

const allowed = (actor, roles) => roles.includes(actor.role || 'admin');
const text = (value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function workflowError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function applyAction(row, body, actor, now) {
  const action = text(body.action, 40);
  if (!action) throw workflowError(400, 'Укажите действие с багом');
  const note = text(body.note, 2000);
  const next = {
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    agentState: row.agent_state,
    pendingQuestion: row.pending_question,
    rootCause: row.root_cause,
    resolution: row.resolution,
    fixEvidence: JSON.parse(row.fix_evidence),
    verificationNote: row.verification_note,
    acceptedAt: row.accepted_at,
    duplicateOf: row.duplicate_of,
  };

  if (action === 'triage') {
    if (!allowed(actor, ['reviewer', 'admin']) || !['new', 'triaged'].includes(row.status)) throw workflowError(409, 'Приоритет можно задать только новому или разобранному багу');
    const priority = body.priority || row.priority;
    if (!PRIORITIES.includes(priority)) throw workflowError(400, 'Неизвестный приоритет');
    next.status = 'triaged';
    next.priority = priority;
  } else if (action === 'claim') {
    if (!allowed(actor, ['developer', 'admin']) || !['new', 'triaged', 'in_progress'].includes(row.status)) throw workflowError(409, 'Баг нельзя взять в работу');
    if (row.assignee && row.assignee !== actor.name) throw workflowError(409, 'Баг уже назначен другому исполнителю');
    next.status = row.status === 'in_progress' ? 'in_progress' : 'triaged';
    next.assignee = actor.name;
    next.agentState = 'claimed';
  } else if (action === 'start') {
    if (!allowed(actor, ['developer', 'admin']) || row.status !== 'triaged' || row.assignee !== actor.name
      || row.agent_state === 'needs_decision') throw workflowError(409, 'Баг не назначен вам или ожидает ответа');
    next.status = 'in_progress';
  } else if (action === 'ask') {
    if (!allowed(actor, ['developer', 'admin']) || !['triaged', 'in_progress'].includes(row.status)
      || row.assignee !== actor.name || row.agent_state === 'needs_decision' || !note) {
      throw workflowError(409, 'Для вопроса нужен назначенный исполнитель без открытого вопроса и текст');
    }
    next.agentState = 'needs_decision';
    next.pendingQuestion = note;
  } else if (action === 'answer') {
    if (!allowed(actor, ['reviewer', 'admin']) || row.agent_state !== 'needs_decision' || !note) {
      throw workflowError(409, 'Ответить можно только на открытый вопрос');
    }
    next.agentState = 'claimed';
    next.pendingQuestion = '';
  } else if (action === 'resolve') {
    if (!allowed(actor, ['developer', 'admin']) || row.status !== 'in_progress'
      || row.assignee !== actor.name || row.agent_state === 'needs_decision') {
      throw workflowError(409, 'Баг не находится в вашей работе');
    }
    const rootCause = text(body.rootCause);
    const resolution = text(body.resolution);
    const evidence = body.fixEvidence;
    if (!rootCause || !resolution || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw workflowError(400, 'Укажите причину, исправление и подтверждение');
    }
    const repositories = Array.isArray(evidence.repositories) ? evidence.repositories.slice(0, 10).map((item) => ({
      name: text(item?.name, 120), ref: text(item?.ref, 200),
    })).filter((item) => item.name && item.ref) : [];
    const checks = Array.isArray(evidence.checks) ? evidence.checks.slice(0, 20).map((item) => ({
      name: text(item?.name, 200), result: text(item?.result, 400),
    })).filter((item) => item.name && item.result) : [];
    if (!repositories.length || !checks.length || checks.some((item) => item.result !== 'passed')) {
      throw workflowError(400, 'Нужны ссылка на изменение кода и успешно пройденные проверки (result: passed)');
    }
    next.status = 'ready_for_check';
    next.agentState = 'done';
    next.rootCause = rootCause;
    next.resolution = resolution;
    next.fixEvidence = {repositories, checks, contours: Array.isArray(evidence.contours)
      ? evidence.contours.slice(0, 10).map((item) => text(item, 120)).filter(Boolean) : []};
  } else if (action === 'accept') {
    if (!allowed(actor, ['reviewer', 'admin']) || row.status !== 'ready_for_check' || !note) {
      throw workflowError(409, 'Для приёмки нужен баг на проверке и результат проверки');
    }
    next.status = 'closed';
    next.verificationNote = note;
    next.acceptedAt = now;
  } else if (action === 'reject') {
    if (!allowed(actor, ['reviewer', 'admin']) || row.status !== 'ready_for_check' || !note) {
      throw workflowError(409, 'Для возврата нужен баг на проверке и замечание');
    }
    next.status = 'in_progress';
    next.agentState = 'claimed';
  } else if (action === 'cancel') {
    if (!allowed(actor, ['reviewer', 'admin']) || !['new', 'triaged'].includes(row.status) || !note) {
      throw workflowError(409, 'Отменить можно только новый или разобранный баг с причиной');
    }
    next.status = 'cancelled';
  } else if (action === 'reopen') {
    if (!allowed(actor, ['reviewer', 'admin']) || !['closed', 'cancelled'].includes(row.status) || !note) {
      throw workflowError(409, 'Повторно открыть можно только закрытый или отменённый баг');
    }
    next.status = 'triaged';
    next.agentState = 'idle';
    next.assignee = '';
    next.acceptedAt = null;
    next.rootCause = '';
    next.resolution = '';
    next.fixEvidence = {};
    next.verificationNote = '';
  } else if (action === 'group') {
    if (!allowed(actor, ['reviewer', 'admin']) || !note) throw workflowError(400, 'Укажите причину объединения');
    next.duplicateOf = text(body.duplicateOf, 80);
  } else {
    throw workflowError(400, 'Неизвестное действие');
  }

  const history = JSON.parse(row.history);
  history.push({at: now, actor: actor.name, action, from: row.status, status: next.status,
    note, ...(action === 'resolve' ? {fixEvidence: next.fixEvidence} : {})});
  return {...next, history};
}
