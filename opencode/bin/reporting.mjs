const ROLE_LABELS = {
  plan: 'planning',
  build: 'implementation',
  quick: 'bounded work',
  general: 'engineering',
  deep: 'difficult reasoning',
  visual: 'browser QA',
  explore: 'read-only research',
};

const V2_MAX_API_BYTES = 16 * 1024 * 1024;
const V2_MAX_MESSAGES = 2_000;
const V2_MAX_SESSIONS = 256;

export function createReport(database, { directory, sessionID, now } = {}) {
  const root = selectRoot(database, directory, sessionID);
  if (!root) {
    throw new Error(sessionID ? `Root session not found: ${sessionID}.` : 'No OpenCode root session was found for the current directory.');
  }

  const sessions = sessionTree(database, root.id);
  const data = loadData(database, root.id);
  return renderReport(root, sessions, data, { sessionID, now });
}

// V2 exposes projected session timelines, not the V1 session/message/part tables.
// api(path) is the authenticated `opencode api get` transport, injectable for tests.
export function createV2Report(api, { directory, sessionID, now, reporting = false } = {}) {
  const budget = { bytes: 0, messages: 0, sessions: 0 };
  const roots = sessionID ? [api(`/api/session/${encodeURIComponent(sessionID)}`).data] : pages(api, '/api/session', { parentID: 'null', directory }, budget, 'sessions');
  const root = sessionID ? roots[0] : roots.reduce((latest, item) =>
    !latest || item.time.updated > latest.time.updated ? item : latest, undefined);
  if (!root || root.parentID || (!sessionID && root.location?.directory && root.location.directory !== directory)) {
    throw new Error(sessionID ? `Root session not found: ${sessionID}.` : 'No OpenCode root session was found for the current directory.');
  }
  if (sessionID) countV2Page({ data: [root] }, budget, 'sessions');
  if (!Number.isFinite(root.time?.updated)) throw new Error('V2 session response has no update timestamp.');
  const sessions = [root];
  for (let index = 0; index < sessions.length; index += 1) {
    const children = pages(api, '/api/session', { parentID: sessions[index].id }, budget, 'sessions');
    for (const child of children) {
      if (child.parentID !== sessions[index].id || !Number.isFinite(child.time?.created)) throw new Error('V2 session response has an unexpected parent or timestamp.');
      sessions.push(child);
    }
  }
  const normalized = sessions.map((session) => ({
    id: session.id, parent_id: session.parentID ?? null,
    time_created: session.time.created, time_updated: session.time.updated,
    model: JSON.stringify(session.model ?? {}), metadata: JSON.stringify(session.metadata ?? {}),
  }));
  const messages = [];
  const parts = [];
  for (const session of sessions) {
    // The V2 CLI may truncate a large stdout response while still exiting 0.
    // Keep each projected transcript page small and validate every cursor.
    for (const item of pages(api, `/api/session/${encodeURIComponent(session.id)}/message`, { limit: '5' }, budget, 'messages')) {
      if (!item?.id || !Number.isFinite(item.time?.created) || !Array.isArray(item.content) && item.type === 'assistant') {
        throw new Error('V2 message response is missing required fields.');
      }
      if (!['user', 'synthetic', 'assistant'].includes(item.type)) continue;
      if (item.type === 'assistant' && (!item.tokens || !Number.isFinite(item.tokens.input) || !Number.isFinite(item.tokens.output))) {
        throw new Error('V2 assistant message has no recorded token usage; refusing incomplete totals.');
      }
      const message = {
        id: item.id, session_id: session.id, time_created: item.time.created,
        data: { role: item.type === 'assistant' ? 'assistant' : 'user',
          agent: item.agent, providerID: item.model?.providerID, modelID: item.model?.id,
          variant: item.model?.variant, tokens: item.tokens, cost: item.cost },
        text: '',
      };
      messages.push(message);
      if (item.type !== 'assistant') {
        message.text = item.text ?? '';
        parts.push({ id: `${item.id}:text`, message_id: item.id, session_id: session.id,
          time_created: item.time.created, data: { type: 'text', text: message.text, synthetic: item.type === 'synthetic' } });
      }
      for (const [index, content] of (item.content ?? []).entries()) {
        if (content.type === 'text') {
          message.text += `${message.text ? '\n' : ''}${content.text}`;
          parts.push({ id: `${item.id}:${index}`, message_id: item.id, session_id: session.id,
            time_created: content.time?.created ?? item.time.created, data: { type: 'text', text: content.text } });
        }
        if (content.type === 'tool') {
          parts.push({ id: content.id, message_id: item.id, session_id: session.id,
            time_created: content.time.created, data: {
              type: 'tool', tool: content.name,
              state: { ...content.state, output: (content.state.content ?? []).filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n'),
                time: { start: content.time.ran, end: content.time.completed } },
            } });
        }
      }
    }
  }
  // API pages arrive newest-first and child sessions are fetched separately.
  // Stable sorting keeps equal-timestamp events in their original API order.
  messages.sort((a, b) => a.time_created - b.time_created);
  parts.sort((a, b) => a.time_created - b.time_created);
  const messagesByID = new Map(messages.map((message) => [message.id, message]));
  const partsByMessage = new Map();
  for (const part of parts) {
    const list = partsByMessage.get(part.message_id) ?? [];
    list.push(part);
    partsByMessage.set(part.message_id, list);
  }
  if (reporting) {
    const lastUser = messages.filter((message) => message.session_id === root.id && message.data.role === 'user' &&
      !(partsByMessage.get(message.id) ?? []).every((part) => part.data.synthetic)).sort((a, b) => a.time_created - b.time_created).at(-1);
    // V2 evaluates shell substitutions before submitting this command's user
    // prompt. Normally the last user is the preceding work request. If a
    // reporting prompt already exists, however, it must carry our marker.
    if (lastUser && /^Return this local evidence report exactly as given\./.test(lastUser.text.trim()) &&
      !/^\[\[agent-usage-report-v2\]\]$/m.test(lastUser.text)) {
      throw new Error('V2 reporting prompt has no known marker; refusing to attribute its activity.');
    }
  }
  return renderReport(normalized[0], normalized, {
    messages, messagesByID, partsByMessage,
    rootMessages: messages.filter((message) => message.session_id === root.id),
    assistantMessages: messages.filter((message) => message.data.role === 'assistant'),
    toolParts: parts.filter((part) => part.data.type === 'tool'),
  }, { sessionID, now, v2: true });
}

function pages(api, path, params = {}, budget, kind) {
  const results = [];
  const seen = new Set();
  let cursor;
  do {
    const query = new URLSearchParams({ ...params, ...(cursor ? { cursor } : { order: 'desc' }) });
    const response = api(`${path}?${query}`);
    if (!Array.isArray(response?.data) || !response.cursor || !('next' in response.cursor)) {
      throw new Error('Unexpected V2 API page; refusing an incomplete usage report.');
    }
    countV2Page(response, budget, kind);
    results.push(...response.data);
    cursor = response.cursor.next;
    if (cursor && seen.has(cursor)) throw new Error('V2 API repeated a page cursor.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return results;
}

function countV2Page(response, budget, kind) {
  budget.bytes += Buffer.byteLength(JSON.stringify(response));
  budget[kind] += response.data.length;
  if (budget.bytes > V2_MAX_API_BYTES || budget.messages > V2_MAX_MESSAGES || budget.sessions > V2_MAX_SESSIONS) {
    throw new Error('V2 report exceeds safety limit (16 MiB API data, 2,000 messages, or 256 sessions); refusing a partial report.');
  }
}

function renderReport(root, sessions, data, { sessionID, now, v2 = false }) {
  const reportEvents = findReportEvents(data.partsByMessage, data.messagesByID, data.rootMessages);
  const reportWorkers = reportingWorkerIDs(reportEvents, sessions);
  const orderedUsers = data.rootMessages.filter((message) => message.data.role === 'user' && !isSyntheticUser(message, data.partsByMessage))
    .sort((a, b) => a.time_created - b.time_created);
  // V2 projects command prompts as user text, without V1's parent-message
  // chain. Previous reporting turns must not inflate later full-session totals.
  const reportingTurn = (timestamp) => v2 && orderedUsers.some((message, index) =>
    reportEvents.messageIDs.has(message.id) && timestamp >= message.time_created &&
    timestamp < (orderedUsers[index + 1]?.time_created ?? Infinity));
  const actualUsers = data.rootMessages.filter((message) =>
    message.data.role === 'user' &&
    !isSyntheticUser(message, data.partsByMessage) &&
    !reportEvents.messageIDs.has(message.id),
  );
  const boundary = actualUsers.at(-1);
  const snapshot = now ?? Math.max(root.time_updated ?? 0, ...data.messages.map((message) => message.time_created ?? 0));

  if (!boundary) {
    return noData(root, selectionLabel(sessionID));
  }

  const reportBoundary = reportEvents.times.find((time) => time > boundary.time_created);
  const cutoff = reportBoundary ?? snapshot;
  const fullCutoff = cutoff;
  // V2 messages have no V1 parentID chain. Exclude the entire reporting turn
  // at its boundary, including any reporter worker with an unknown link.
  const beforeReport = (value) => !v2 || reportBoundary === undefined || value < reportBoundary;
  const allTasks = data.toolParts.filter((part) => part.data.tool === 'task');
  const runTasks = allTasks.filter((part) => inWindow(part.time_created, boundary.time_created, cutoff) && beforeReport(part.time_created) && !reportingTurn(part.time_created) && !reportEvents.messageIDs.has(part.message_id));
  const runSessions = selectRunSessions(sessions, runTasks, boundary.time_created, cutoff, root.id, reportWorkers);
  const runSessionIDs = new Set(runSessions.map((session) => session.id));
  const runIntervals = taskIntervals(runTasks, sessions, cutoff);
  const runMessages = data.assistantMessages.filter((message) =>
    runSessionIDs.has(message.session_id) &&
    eventBelongsToRun(message, runSessions, runIntervals, boundary.time_created, cutoff, root.id) &&
    beforeReport(message.time_created) &&
    !reportingTurn(message.time_created) &&
    !reportEvents.messageIDs.has(message.id),
  );
  const fullMessages = data.assistantMessages.filter((message) =>
    message.time_created <= fullCutoff && beforeReport(message.time_created) && !reportingTurn(message.time_created) && !reportEvents.messageIDs.has(message.id) && !reportWorkers.has(message.session_id),
  );
  const runParts = data.toolParts.filter((part) =>
    runSessionIDs.has(part.session_id) &&
    eventBelongsToRun(part, runSessions, runIntervals, boundary.time_created, cutoff, root.id) &&
    beforeReport(part.time_created) &&
    !reportingTurn(part.time_created) &&
    !reportEvents.messageIDs.has(part.message_id),
  );

  const tasks = describeTasks(runTasks, sessions);
  const freshWorkers = new Set(tasks.filter((task) => task.workerID && task.workerCreated >= boundary.time_created).map((task) => task.workerID));
  const resumedWorkers = new Set(tasks.filter((task) => task.workerID && task.workerCreated < boundary.time_created).map((task) => task.workerID));
  const changed = successfulChangedFiles(runParts);
  const checks = verificationCandidates(runParts);
  const rootActions = meaningfulRootActions(runParts, root.id);

  return [
    '# Agent Usage',
    `Selection: root \`${root.id}\` (${selectionLabel(sessionID)}).`,
    `Latest work run: ${time(boundary.time_created)} through ${time(cutoff)} (${cutoff === snapshot ? 'in progress or latest snapshot' : 'ended at reporting boundary'}).`,
    `Full-session usage cutoff: ${time(fullCutoff)}; reporting messages/workers are excluded. Latest-run and full-session usage are separate scopes.`,
    '',
    '# What Happened',
    overview(runMessages, rootActions, changed, checks),
    '',
    '# Delegation',
    `Task invocations: ${tasks.length}; unique linked workers: ${new Set(tasks.map((task) => task.workerID).filter(Boolean)).size}; pre-existing workers: ${resumedWorkers.size}; created this run: ${freshWorkers.size}. Invocation modes: ${tasks.filter((task) => task.kind === 'new').length} new, ${tasks.filter((task) => task.kind === 'resumed').length} resumed, ${tasks.filter((task) => task.kind === 'unlinked').length} unlinked.`,
    ...taskLines(tasks),
    '',
    '# Verification',
    ...verificationLines(checks),
    '',
    '# Latest Run Usage',
    usageTable(aggregate(runMessages)),
    '',
    '# Full Session Usage To Cutoff',
    usageTable(aggregate(fullMessages)),
    '',
    'Token fields come from assistant-message metadata: input, output, reasoning, cache read, and cache write are separate. Recorded $0.0000 is recorded cost only, not a subscription allowance or quota estimate.',
    contextIsolation(runParts, root.id),
    'Limitations: task purposes and outcome labels use bounded task metadata/status only. Verification recognizes a small command allowlist and reports status/exit evidence; other tools, ctx_execute, and ctx_batch evidence remain unknown. Context isolation is an output-byte heuristic, not token or quota savings.',
  ].join('\n');
}

function selectRoot(database, directory, sessionID) {
  if (sessionID) return one(database, 'SELECT * FROM session WHERE id = ? AND parent_id IS NULL', [sessionID]);
  return one(database, 'SELECT * FROM session WHERE directory = ? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 1', [directory]);
}

function sessionTree(database, rootID) {
  return all(database, `WITH RECURSIVE tree AS (
    SELECT * FROM session WHERE id = ?
    UNION ALL
    SELECT child.* FROM session child JOIN tree parent ON child.parent_id = parent.id
  ) SELECT * FROM tree`, [rootID]);
}

function loadData(database, rootID) {
  const tree = `WITH RECURSIVE tree AS (
    SELECT id FROM session WHERE id = ?
    UNION ALL
    SELECT child.id FROM session child JOIN tree parent ON child.parent_id = parent.id
  )`;
  const messages = all(database, `${tree}
    SELECT message.* FROM message JOIN tree ON tree.id = message.session_id ORDER BY message.time_created`, [rootID])
    .map((message) => ({ ...message, data: parse(message.data) }));
  const parts = all(database, `${tree}
    SELECT part.* FROM part JOIN message ON message.id = part.message_id JOIN tree ON tree.id = message.session_id ORDER BY part.time_created`, [rootID])
    .map((part) => ({ ...part, data: parse(part.data) }));
  const messagesByID = new Map(messages.map((message) => [message.id, message]));
  const partsByMessage = new Map();
  for (const part of parts) {
    const list = partsByMessage.get(part.message_id) ?? [];
    list.push(part);
    partsByMessage.set(part.message_id, list);
  }
  for (const message of messages) {
    message.text = (partsByMessage.get(message.id) ?? [])
      .filter((part) => part.data.type === 'text' && typeof part.data.text === 'string')
      .map((part) => part.data.text)
      .join('\n');
  }
  return {
    messages,
    messagesByID,
    partsByMessage,
    rootMessages: messages.filter((message) => message.session_id === rootID),
    assistantMessages: messages.filter((message) => message.data.role === 'assistant'),
    toolParts: parts.filter((part) => part.data.type === 'tool'),
  };
}

function findReportEvents(partsByMessage, messagesByID, rootMessages) {
  const messageIDs = new Set();
  const workerIDs = new Set();
  const times = [];
  for (const [messageID, parts] of partsByMessage) {
    for (const part of parts) {
      if (!isReportPart(part.data)) continue;
      messageIDs.add(messageID);
      const message = messagesByID.get(messageID);
      if (message) times.push(message.time_created);
      for (const id of workerReferences(part.data)) workerIDs.add(id);
    }
  }
  const ordered = [...rootMessages].sort((a, b) => a.time_created - b.time_created);
  for (let index = 0; index < ordered.length; index += 1) {
    if (!messageIDs.has(ordered[index].id)) continue;
    const synthetic = ordered[index + 1];
    if (synthetic && isSyntheticUser(synthetic, partsByMessage)) messageIDs.add(synthetic.id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of rootMessages) {
      if (message.data.role === 'assistant' && message.data.parentID && messageIDs.has(message.data.parentID) && !messageIDs.has(message.id)) {
        messageIDs.add(message.id);
        changed = true;
      }
    }
  }
  return { messageIDs, workerIDs, times: times.sort((a, b) => a - b) };
}

function isReportPart(data) {
  const command = data.command ?? data.state?.input?.command;
  if ((data.type === 'subtask' || data.type === 'tool') && ['agent-usage', 'run-overview'].includes(command)) return true;
  if (data.type !== 'text' || typeof data.text !== 'string') return false;
  const text = data.text.trim();
  return text === '[run-overview-command]' ||
    (/^Return this local evidence report exactly as given\./.test(text) && /^\[\[agent-usage-report-v[12]\]\]$/m.test(text)) ||
    /^Return this local (usage|evidence) report exactly as given\.\s*Do not run additional tools or add commentary\./.test(text);
}

function isSyntheticUser(message, partsByMessage) {
  const parts = partsByMessage.get(message.id) ?? [];
  return parts.length > 0 && parts.every((part) => part.data.synthetic === true);
}

function workerReferences(data) {
  const state = data.state ?? {};
  const values = [
    state.input?.task_id,
    state.input?.taskID,
    state.metadata?.sessionId,
    state.metadata?.sessionID,
    state.metadata?.session_id,
    state.output?.sessionId,
    state.output?.sessionID,
    state.output?.session_id,
  ];
  return values.filter((value) => typeof value === 'string' && value.length > 0);
}

function reportingWorkerIDs(events, sessions) {
  const excluded = new Set(events.workerIDs);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (session.parent_id && excluded.has(session.parent_id) && !excluded.has(session.id)) {
        excluded.add(session.id);
        changed = true;
      }
    }
  }
  return excluded;
}

function selectRunSessions(sessions, tasks, start, end, rootID, excluded) {
  const included = new Set([rootID]);
  for (const task of tasks) {
    const worker = taskWorker(task, sessions);
    if (worker && !excluded.has(worker.id)) included.add(worker.id);
  }
  // New descendants created in the run belong to it. Older descendants must have task linkage.
  for (const session of sessions) {
    if (session.id !== rootID && session.time_created >= start && session.time_created <= end && !excluded.has(session.id)) included.add(session.id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (session.parent_id && included.has(session.parent_id) && !excluded.has(session.id) && session.time_created >= start && session.time_created <= end && !included.has(session.id)) {
        included.add(session.id);
        changed = true;
      }
    }
  }
  return sessions.filter((session) => included.has(session.id));
}

function describeTasks(parts, sessions) {
  return parts.map((part) => {
    const state = part.data.state ?? {};
    const worker = taskWorker(part, sessions);
    return {
      agent: safeText(string(state.input?.subagent_type, 'unknown')),
      model: taskModel(part.data, worker),
      purpose: limit(safeText(string(state.input?.description, 'purpose unavailable')), 120),
      workerID: worker?.id,
      workerCreated: worker?.time_created,
      kind: worker ? (worker.time_created < part.time_created ? 'resumed' : 'new') : 'unlinked',
      outcome: taskOutcome(state),
    };
  });
}

function taskIntervals(parts, sessions, cutoff) {
  const intervals = new Map();
  for (const part of parts) {
    const worker = taskWorker(part, sessions);
    if (!worker) continue;
    const timing = part.data.state?.time ?? {};
    const start = numeric(timing.start) || part.time_created;
    const end = numeric(timing.end) || cutoff;
    const list = intervals.get(worker.id) ?? [];
    list.push([start, end]);
    intervals.set(worker.id, list);
  }
  return intervals;
}

function eventBelongsToRun(event, sessions, intervals, start, end, rootID) {
  if (!inWindow(event.time_created, start, end)) return false;
  if (event.session_id === rootID) return true;
  const session = sessions.find((candidate) => candidate.id === event.session_id);
  if (!session) return false;
  if (session.time_created >= start) return true;
  return (intervals.get(session.id) ?? []).some(([intervalStart, intervalEnd]) => inWindow(event.time_created, intervalStart, intervalEnd));
}

function taskLines(tasks) {
  if (!tasks.length) return ['No task invocations observed in the latest work run.'];
  return [
    '| Agent (role) | Model | Purpose | Worker | Outcome |',
    '| --- | --- | --- | --- | --- |',
    ...tasks.map((task) => `| ${task.agent} (${ROLE_LABELS[task.agent] ?? 'other'}) | ${safeText(task.model)} | ${task.purpose} | ${task.kind}${task.workerID ? ` (${safeText(task.workerID)})` : ''} | ${task.outcome} |`),
  ];
}

function taskWorker(part, sessions) {
  const state = part.data?.state ?? {};
  const taskID = state.input?.task_id ?? state.input?.taskID;
  const references = workerReferences(part.data);
  return sessions.find((session) =>
    (typeof taskID === 'string' && taskID.length > 0 && session.id === taskID) ||
    references.some((reference) => reference === session.id) ||
    (typeof taskID === 'string' && taskID.length > 0 && taskMetadataID(session) === taskID),
  );
}

function taskMetadataID(session) {
  const metadata = parse(session.metadata);
  return metadata.task_id ?? metadata.taskID;
}

function taskModel(data, worker) {
  const model = data.state?.metadata?.model ?? data.model;
  const normalized = normalizeModel(model);
  if (normalized) return normalized;
  return modelName(worker?.model ? parse(worker.model) : {});
}

function normalizeModel(model) {
  if (!model || typeof model !== 'object') return undefined;
  const id = model.modelID ?? model.id;
  if (!id) return undefined;
  return model.providerID ? `${model.providerID}/${id}` : String(id);
}

function taskOutcome(state) {
  if (state.status === 'completed') return 'completed';
  if (state.status === 'error' || state.status === 'failed' || state.error) return 'error';
  return 'unknown';
}

function meaningfulRootActions(parts, rootID) {
  const actions = [];
  if (successfulChangedFiles(parts.filter((part) => part.session_id === rootID)).length) actions.push('successful root file mutation');
  if (parts.some((part) => part.session_id === rootID && part.data.tool === 'task')) actions.push('delegation');
  return actions;
}

function overview(messages, actions, changed, checks) {
  const agents = [...new Set(messages.map((message) => string(message.data.agent, 'unknown')))];
  const models = [...new Set(messages.map((message) => modelName(message.data)))];
  const excerpt = messages.slice().reverse().map((message) => textOf(message)).find(Boolean);
  return [
    `Observed agents/models: ${agents.map(safeText).join(', ') || 'none'} / ${models.map(safeText).join(', ') || 'none'}.`,
    `Meaningful root actions: ${actions.join(', ') || 'none observed'}.`,
    `Successful changed files: ${changed.length ? changed.slice(0, 10).map(safeText).join(', ') : 'none observed'}.`,
    `Verification candidates: ${checks.length}.`,
    excerpt ? `Last bounded assistant response: ${limit(safeText(excerpt.replace(/\s+/g, ' ')), 240)}` : 'Last bounded assistant response: unavailable.',
  ].join(' ');
}

function textOf(message) {
  return message.text;
}

function successfulChangedFiles(parts) {
  const files = new Set();
  for (const part of parts) {
    if (!completed(part.data) || !['apply_patch', 'edit', 'write'].includes(part.data.tool)) continue;
    const input = part.data.state?.input ?? {};
    if (typeof input.patchText === 'string') {
      for (const match of input.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.add(match[1]);
    }
    if (typeof input.filePath === 'string') files.add(input.filePath);
  }
  return [...files];
}

function verificationCandidates(parts) {
  return parts.filter((part) => {
    if (part.data.tool !== 'bash') return false;
    const command = part.data.state?.input?.command;
    return typeof command === 'string' && /\b(node --test|npm (?:run )?(?:test|lint|check)|pnpm (?:test|lint|check)|yarn (?:test|lint|check)|vitest|eslint|tsc|typecheck)\b/i.test(command);
  }).map((part) => ({
    operation: verificationOperation(part.data.state.input.command),
    status: string(part.data.state?.status, 'unknown'),
    exit: exitCode(part.data.state),
  }));
}

function verificationLines(checks) {
  if (!checks.length) return ['No recognized verification candidates observed.'];
  return checks.map((check) => `- \`${check.operation}\`: status ${check.status}; ${check.exit === undefined ? 'exit result unavailable (execution result unknown)' : `exit ${check.exit}${check.exit === 0 ? ' (success recorded)' : ' (nonzero)'}`}.`);
}

function verificationOperation(command) {
  const match = command.match(/\b(node --test|npm (?:run )?(?:test|lint|check)|pnpm (?:test|lint|check)|yarn (?:test|lint|check)|vitest|eslint|tsc|typecheck)\b/i);
  return match ? match[0] : 'recognized verification operation';
}

function exitCode(state) {
  const value = state?.metadata?.exit ?? state?.metadata?.exitCode ?? state?.metadata?.exit_code ?? state?.output?.exitCode ?? state?.output?.exit_code;
  return Number.isInteger(value) ? value : undefined;
}

function aggregate(messages) {
  const groups = new Map();
  for (const message of messages) {
    const tokens = object(message.data.tokens);
    const cache = object(tokens.cache);
    const agent = string(message.data.agent, 'unknown');
    const model = modelName(message.data);
    const key = `${agent}\u0000${model}`;
    const entry = groups.get(key) ?? { agent, model, calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    entry.calls += 1;
    entry.input += numeric(tokens.input);
    entry.output += numeric(tokens.output);
    entry.reasoning += numeric(tokens.reasoning);
    entry.cacheRead += numeric(cache.read ?? tokens.cacheRead ?? tokens.cache_read);
    entry.cacheWrite += numeric(cache.write ?? tokens.cacheWrite ?? tokens.cache_write);
    entry.cost += numeric(message.data.cost);
    groups.set(key, entry);
  }
  const rows = [...groups.values()].sort((a, b) => totalTokens(b) - totalTokens(a));
  return { rows, total: rows.reduce(addUsage, emptyUsage()) };
}

function usageTable(usage) {
  const lines = [
    '| Agent (role) | Model | Calls | Input | Output | Reasoning | Cache read | Cache write | Recorded cost |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...usage.rows.map((row) => `| ${safeText(row.agent)} (${ROLE_LABELS[row.agent] ?? 'other'}) | ${safeText(row.model)} | ${number(row.calls)} | ${number(row.input)} | ${number(row.output)} | ${number(row.reasoning)} | ${number(row.cacheRead)} | ${number(row.cacheWrite)} | ${currency(row.cost)} |`),
    `| **Total** |  | **${number(usage.total.calls)}** | **${number(usage.total.input)}** | **${number(usage.total.output)}** | **${number(usage.total.reasoning)}** | **${number(usage.total.cacheRead)}** | **${number(usage.total.cacheWrite)}** | **${currency(usage.total.cost)}** |`,
  ];
  return lines.join('\n');
}

function contextIsolation(parts, rootID) {
  const childOutput = parts.filter((part) => part.session_id !== rootID).reduce((sum, part) => sum + bytes(part.data.state?.output), 0);
  const handoff = parts.filter((part) => part.session_id === rootID && part.data.tool === 'task').reduce((sum, part) => sum + bytes(part.data.state?.output), 0);
  return childOutput ? `Context isolation heuristic: ${formatBytes(Math.max(0, childOutput - handoff))} child tool-output bytes were not in task handoffs (${formatBytes(handoff)} handoff bytes).` : 'Context isolation heuristic: no child tool-output bytes recorded.';
}

function completed(data) { return data.state?.status === 'completed'; }
function inWindow(value, start, end) { return value >= start && value <= end; }
function parse(value) { try { const parsed = JSON.parse(value); return object(parsed); } catch { return {}; } }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function all(database, sql, parameters) { return database.prepare(sql).all(...parameters); }
function one(database, sql, parameters) { return database.prepare(sql).get(...parameters); }
function string(value, fallback) { return typeof value === 'string' && value ? value : fallback; }
function numeric(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function modelName(data) {
  const id = data.modelID ?? data.id;
  const name = data.providerID && id ? `${data.providerID}/${id}` : string(id, 'unknown');
  return data.variant ? `${name} (${data.variant})` : name;
}
function emptyUsage() { return { calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }; }
function addUsage(total, value) { for (const key of Object.keys(total)) total[key] += value[key] ?? 0; return total; }
function totalTokens(value) { return value.input + value.output + value.reasoning + value.cacheRead + value.cacheWrite; }
function bytes(value) { return typeof value === 'string' ? Buffer.byteLength(value) : 0; }
function limit(value, length) { return value.length <= length ? value : `${value.slice(0, length)}...`; }
function safeText(value) {
  return String(value)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/\bAuthorization\s*:\s*(?:[A-Za-z]+\s+)?[^\s|,;]+/gi, 'Authorization: [redacted]')
    .replace(/\b(?:[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)|token|api[_-]?key|password|secret)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|"[^\r\n]*|'[^\r\n]*|[^\s|,;]+)/gi, '[redacted]')
    .replace(/(Bearer\s+)[^\s|,;]+/gi, '$1[redacted]')
    .replace(/([`\\|<>])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ');
}
function number(value) { return new Intl.NumberFormat('en-US').format(value); }
function currency(value) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value); }
function formatBytes(value) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; }
function time(value) { return Number.isFinite(value) ? new Date(value).toISOString() : 'unknown time'; }
function selectionLabel(sessionID) { return sessionID ? 'explicit session selection' : 'latest root in current directory fallback'; }
function noData(root, selection) { return `# Agent Usage\nSelection: root \`${root.id}\` (${selection}).\n\nNo non-reporting user request was found. Reporting events are excluded.`; }
