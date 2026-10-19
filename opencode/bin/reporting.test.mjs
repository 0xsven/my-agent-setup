import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createReport, createV2Report } from './reporting.mjs';

function fixture(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT,
    model TEXT, time_created INTEGER, time_updated INTEGER, metadata TEXT
  );
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  return db;
}

function addSession(db, id, parentID, created, updated, options = {}) {
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, parentID, '/work', options.title ?? id, options.agent ?? 'build',
    JSON.stringify(options.model ?? {}), created, updated, JSON.stringify(options.metadata ?? {}),
  );
}

function addMessage(db, id, sessionID, created, data) {
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, sessionID, created, JSON.stringify(data));
}

function addPart(db, id, messageID, sessionID, created, data) {
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(id, messageID, sessionID, created, JSON.stringify(data));
}

function addUser(db, id, time, text) {
  addMessage(db, id, 'root', time, { role: 'user' });
  addPart(db, `${id}-text`, id, 'root', time, { type: 'text', text });
}

function addAssistant(db, id, sessionID, time, agent, modelID, tokens = {}, extra = {}) {
  addMessage(db, id, sessionID, time, {
    role: 'assistant', agent, providerID: 'openai', modelID, variant: 'high', tokens, cost: 0, ...extra,
  });
}

function report(db, now = 100) {
  return createReport(db, { directory: '/work', sessionID: 'root', now });
}

test('uses canonical nested cache tokens across Plan to Build switches', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 20, { agent: 'plan' });
  addUser(db, 'u', 2, 'implement');
  addAssistant(db, 'plan', 'root', 3, 'plan', 'planner', {
    input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 },
  });
  addAssistant(db, 'build', 'root', 4, 'build', 'builder', {
    input: 20, output: 6, reasoning: 7, cache: { read: 8, write: 9 },
  });
  const output = report(db);
  assert.match(output, /plan \(planning\).*10.*2.*3.*4.*5/);
  assert.match(output, /build \(implementation\).*20.*6.*7.*8.*9/);
  assert.match(output, /\*\*30\*\* \| \*\*8\*\* \| \*\*10\*\* \| \*\*12\*\* \| \*\*14\*\*/);
  db.close();
});

test('links a resumed worker by canonical input task_id and shows repeated invocation separately', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 50);
  addSession(db, 'worker', 'root', 1, 40, { agent: 'quick', model: { providerID: 'openai', modelID: 'luna' } });
  addUser(db, 'u', 10, 'continue work');
  addAssistant(db, 'root-a', 'root', 11, 'build', 'builder');
  addAssistant(db, 'worker-a', 'worker', 12, 'quick', 'luna');
  for (const id of ['task-1', 'task-2']) {
    addPart(db, id, 'root-a', 'root', 11, {
      type: 'tool', tool: 'task', state: {
        status: 'completed', input: { task_id: 'worker', subagent_type: 'quick', description: 'finish bounded fix' },
      },
    });
  }
  const output = report(db);
  assert.match(output, /Task invocations: 2; unique linked workers: 1; pre-existing workers: 1; created this run: 0\. Invocation modes: 0 new, 2 resumed, 0 unlinked\./);
  assert.ok(output.includes('| quick (bounded work) | openai/luna | finish bounded fix | resumed (worker) | completed |'));
  db.close();
});

test('does not spuriously link an unknown task ID to the first worker', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 30);
  addSession(db, 'worker', 'root', 1, 20);
  addUser(db, 'u', 10, 'work');
  addAssistant(db, 'a', 'root', 11, 'build', 'builder');
  addPart(db, 'task', 'a', 'root', 11, { type: 'tool', tool: 'task', state: { input: { subagent_type: 'quick' } } });
  const output = report(db);
  assert.match(output, /unique linked workers: 0/);
  assert.ok(output.includes('| quick (bounded work) | unknown | purpose unavailable | unlinked | unknown |'));
  db.close();
});

test('shows a fresh worker followed by a resume of that same session in one run', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 40);
  addSession(db, 'worker', 'root', 12, 30, { agent: 'quick' });
  addUser(db, 'u', 10, 'work');
  addAssistant(db, 'a', 'root', 11, 'build', 'builder');
  addPart(db, 'first', 'a', 'root', 11, {
    type: 'tool', tool: 'task', state: { status: 'completed', input: { task_id: 'worker', subagent_type: 'quick', description: 'first pass' } },
  });
  addPart(db, 'second', 'a', 'root', 14, {
    type: 'tool', tool: 'task', state: { status: 'completed', input: { task_id: 'worker', subagent_type: 'quick', description: 'resume pass' } },
  });
  const output = report(db);
  assert.match(output, /pre-existing workers: 0; created this run: 1\. Invocation modes: 1 new, 1 resumed, 0 unlinked\./);
  assert.ok(output.includes('| quick (bounded work) | unknown | first pass | new (worker) | completed |'));
  assert.ok(output.includes('| quick (bounded work) | unknown | resume pass | resumed (worker) | completed |'));
  db.close();
});

test('limits an old resumed worker to its recorded task interval', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 50);
  addSession(db, 'worker', 'root', 1, 45, { agent: 'quick' });
  addUser(db, 'u', 10, 'work');
  addAssistant(db, 'root-a', 'root', 11, 'build', 'builder');
  addAssistant(db, 'inside', 'worker', 12, 'quick', 'luna', { output: 2 });
  addAssistant(db, 'unrelated', 'worker', 30, 'quick', 'luna', { output: 999 });
  addPart(db, 'task', 'root-a', 'root', 11, {
    type: 'tool', tool: 'task', state: {
      status: 'completed', time: { start: 11, end: 13 },
      input: { task_id: 'worker', subagent_type: 'quick', description: 'bounded resume' },
    },
  });
  const output = report(db, 50);
  const [latest, full] = output.split('# Full Session Usage To Cutoff');
  assert.ok(latest.includes('| quick (bounded work) | openai/luna (high) | 1 | 0 | 2 |'));
  assert.ok(!latest.includes('999'));
  assert.ok(full.includes('| quick (bounded work) | openai/luna (high) | 2 | 0 | 1,001 |'));
  db.close();
});

test('recognizes canonical command subtask sentinel and excludes reporting worker from later scopes', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 80);
  addSession(db, 'reporter', 'root', 20, 30, { agent: 'quick' });
  addUser(db, 'work-user', 2, 'real implementation');
  addAssistant(db, 'work-a', 'root', 3, 'build', 'builder', { input: 10 });
  addPart(db, 'work-text', 'work-a', 'root', 3, { type: 'text', text: 'Implemented the requested change.' });
  addUser(db, 'report-user', 20, '[[agent-usage-report-v1]]');
  addPart(db, 'command-subtask', 'report-user', 'root', 20, {
    type: 'subtask', command: 'agent-usage', agent: 'quick', model: { providerID: 'openai', modelID: 'gpt-5.6-luna' }, prompt: '[[agent-usage-report-v1]]',
  });
  addAssistant(db, 'report-a', 'reporter', 21, 'quick', 'gpt-5.6-luna', { input: 999 });
  addAssistant(db, 'task-a', 'root', 21, 'quick', 'gpt-5.6-luna');
  addPart(db, 'report-task', 'task-a', 'root', 21, { type: 'tool', tool: 'task', state: { status: 'completed', input: { command: 'agent-usage' }, metadata: { sessionId: 'reporter' } } });
  addUser(db, 'next-user', 40, 'actual work after report');
  addAssistant(db, 'next-a', 'root', 41, 'build', 'builder', { input: 7 });
  const output = report(db);
  assert.match(output, /Latest work run: .*in progress or latest snapshot/);
  assert.match(output, /\*\*7\*\*/);
  assert.doesNotMatch(output, /999/);
  db.close();
});

test('repeated report sentinels return the preceding real work instead of reporter activity', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 60);
  addUser(db, 'work', 2, 'real work');
  addAssistant(db, 'work-a', 'root', 3, 'build', 'builder', { input: 5 });
  for (const time of [10, 20]) {
    addUser(db, `report-${time}`, time, '[[agent-usage-report-v1]]');
    addPart(db, `subtask-${time}`, `report-${time}`, 'root', time, {
      type: 'subtask', command: 'agent-usage', prompt: '[[agent-usage-report-v1]]',
    });
  }
  addAssistant(db, 'report-a', 'root', 21, 'quick', 'gpt-5.6-luna', { input: 999 });
  addPart(db, 'report-tool', 'report-a', 'root', 21, { type: 'tool', tool: 'task', state: { input: { command: 'agent-usage' } } });
  const output = report(db, 60);
  assert.match(output, /Latest work run: .*through 1970-01-01T00:00:00.010Z \(ended at reporting boundary\)/);
  assert.ok(output.includes('**5**'));
  assert.ok(!output.includes('999'));
  db.close();
});

test('does not treat ordinary discussion of report markers as reporting activity', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 30);
  addSession(db, 'worker', 'root', 11, 25, { agent: 'quick' });
  addUser(db, 'u', 10, 'Review the string [[agent-usage-report-v1]] but do normal work.');
  addAssistant(db, 'a', 'root', 11, 'build', 'builder', { input: 2 });
  addPart(db, 'task', 'a', 'root', 11, {
    type: 'tool', tool: 'task', state: { input: {
      task_id: 'worker', subagent_type: 'quick', prompt: 'Discuss [run-overview-command], do not run it.', description: 'normal review',
    } },
  });
  addAssistant(db, 'worker-a', 'worker', 12, 'quick', 'luna', { input: 3 });
  const output = report(db, 30);
  assert.match(output, /Task invocations: 1; unique linked workers: 1/);
  assert.ok(output.includes('| quick (bounded work) | openai/luna (high) | 1 | 3 |'));
  db.close();
});

test('excludes native synthetic report summaries and their parented root assistants without losing later work', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 80);
  addUser(db, 'work-1', 2, 'first work');
  addAssistant(db, 'work-a', 'root', 3, 'build', 'builder', { input: 5 });
  for (const [time, suffix] of [[10, 'one'], [20, 'two']]) {
    addUser(db, `report-${suffix}`, time, 'command invocation');
    addPart(db, `command-${suffix}`, `report-${suffix}`, 'root', time, {
      type: 'subtask', command: 'agent-usage', prompt: '[[agent-usage-report-v1]]',
    });
    addAssistant(db, `report-tool-${suffix}`, 'root', time + 1, 'quick', 'luna', { input: 100 });
    addPart(db, `tool-${suffix}`, `report-tool-${suffix}`, 'root', time + 1, {
      type: 'tool', tool: 'task', state: { input: { command: 'agent-usage' } },
    });
    addMessage(db, `summary-${suffix}`, 'root', time + 2, { role: 'user' });
    addPart(db, `summary-part-${suffix}`, `summary-${suffix}`, 'root', time + 2, {
      type: 'text', text: 'Summarize the task tool output above and continue with your task.', synthetic: true,
    });
    addAssistant(db, `summary-a-${suffix}`, 'root', time + 3, 'build', 'builder', { input: 200 }, { parentID: `summary-${suffix}` });
  }
  addUser(db, 'work-2', 40, 'later real work');
  addAssistant(db, 'later-a', 'root', 41, 'build', 'builder', { input: 7 });
  const output = report(db, 80);
  assert.match(output, /Latest work run: .*1970-01-01T00:00:00.040Z/);
  assert.ok(output.includes('**7**'));
  assert.ok(!output.includes('**100**'));
  assert.ok(!output.includes('**200**'));
  db.close();
});

test('uses task metadata model per invocation instead of the worker current model', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 30);
  addSession(db, 'worker', 'root', 1, 25, { model: { providerID: 'other', modelID: 'latest' } });
  addUser(db, 'u', 10, 'work');
  addAssistant(db, 'a', 'root', 11, 'build', 'builder');
  addPart(db, 'old-model', 'a', 'root', 11, { type: 'tool', tool: 'task', state: {
    status: 'completed', input: { task_id: 'worker', subagent_type: 'quick', description: 'first' }, metadata: { model: { providerID: 'openai', modelID: 'first-model' } },
  } });
  addPart(db, 'new-model', 'a', 'root', 12, { type: 'tool', tool: 'task', state: {
    status: 'completed', input: { task_id: 'worker', subagent_type: 'quick', description: 'second' }, metadata: { model: { providerID: 'openai', id: 'second-model' } },
  } });
  const output = report(db, 30);
  assert.ok(output.includes('| quick (bounded work) | openai/first-model | first | resumed (worker) | completed |'));
  assert.ok(output.includes('| quick (bounded work) | openai/second-model | second | resumed (worker) | completed |'));
  assert.ok(!output.includes('other/latest'));
  db.close();
});

test('redacts free text and never prints shell arguments or Markdown delimiters', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 30);
  addUser(db, 'u', 2, 'work');
  addAssistant(db, 'a', 'root', 3, 'build', 'builder');
  addPart(db, 'text', 'a', 'root', 3, { type: 'text', text: 'Token=super-secret | `inject` <tag>' });
  addPart(db, 'task', 'a', 'root', 3, { type: 'tool', tool: 'task', state: { input: { subagent_type: 'quick', description: 'PASSWORD=hunter2 | `table`' } } });
  addPart(db, 'verify', 'a', 'root', 3, { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'API_KEY=secret npm test -- --token secret' } } });
  const output = report(db, 30);
  assert.ok(output.includes('[redacted]'));
  assert.ok(output.includes('`npm test`'));
  assert.ok(!output.includes('hunter2'));
  assert.ok(!output.includes('API_KEY=secret'));
  assert.ok(!output.includes('--token secret'));
  db.close();
});

test('redacts URI userinfo, authorization headers, quoted secrets, and unsafe overview labels before truncation', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 30);
  addUser(db, 'u', 2, 'work');
  addAssistant(db, 'a', 'root', 3, 'agent|name', 'model|name', {}, {
    providerID: 'provider|name', id: 'model|name',
  });
  addPart(db, 'text', 'a', 'root', 3, {
    type: 'text',
    text: 'DATABASE_URL=postgres://user:password@host Authorization: Basic dXNlcjpwYXNz PASSWORD="correct horse battery staple',
  });
  addPart(db, 'task', 'a', 'root', 3, {
    type: 'tool', tool: 'task', state: { input: { subagent_type: 'quick', description: 'secret=bare-value PASSWORD="correct horse' } },
  });
  const output = report(db, 30);
  for (const secret of ['user:password', 'dXNlcjpwYXNz', 'correct horse', 'bare-value']) assert.ok(!output.includes(secret));
  assert.ok(output.includes('postgres://[redacted]@host'));
  assert.ok(output.includes('Authorization: [redacted]'));
  assert.ok(output.includes('agent\\|name'));
  assert.ok(output.includes('provider\\|name/model\\|name'));
  db.close();
});

test('recognizes exact legacy expansion while marker mentions remain ordinary text', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 30);
  addUser(db, 'work', 2, 'work');
  addAssistant(db, 'a', 'root', 3, 'build', 'builder', { input: 5 });
  addUser(db, 'legacy', 10, 'legacy command');
  addPart(db, 'legacy-template', 'legacy', 'root', 10, {
    type: 'text', text: 'Return this local usage report exactly as given.\n\nDo not run additional tools or add commentary.',
  });
  addAssistant(db, 'legacy-a', 'root', 11, 'quick', 'luna', { input: 999 });
  const output = report(db, 30);
  assert.ok(output.includes('**5**'));
  assert.ok(!output.includes('999'));
  db.close();
});

test('uses latest directory root by default but honors an explicit root selection', () => {
  const db = fixture();
  addSession(db, 'old', null, 1, 10);
  addSession(db, 'new', null, 2, 20);
  addMessage(db, 'old-user', 'old', 2, { role: 'user' });
  addPart(db, 'old-user-text', 'old-user', 'old', 2, { type: 'text', text: 'old work' });
  addAssistant(db, 'old-a', 'old', 3, 'build', 'old-model', { input: 1 });
  addMessage(db, 'new-user', 'new', 4, { role: 'user' });
  addPart(db, 'new-user-text', 'new-user', 'new', 4, { type: 'text', text: 'new work' });
  addAssistant(db, 'new-a', 'new', 5, 'build', 'new-model', { input: 2 });
  const fallback = createReport(db, { directory: '/work', now: 20 });
  const explicit = createReport(db, { directory: '/work', sessionID: 'old', now: 10 });
  assert.match(fallback, /root `new` \(latest root in current directory fallback\)/);
  assert.match(explicit, /root `old` \(explicit session selection\)/);
  assert.ok(explicit.includes('openai/old-model'));
  db.close();
});

test('keeps malformed message and part JSON from reaching SQLite JSON functions', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 30);
  addSession(db, 'child', 'root', 11, 25);
  addUser(db, 'u', 10, 'work');
  addAssistant(db, 'a', 'root', 11, 'build', 'builder');
  db.prepare("INSERT INTO message VALUES ('bad-child', 'child', 12, 'not-json')").run();
  db.prepare("INSERT INTO part VALUES ('bad-root-text', 'u', 'root', 10, 'not-json')").run();
  db.prepare("INSERT INTO part VALUES ('bad-tool', 'a', 'root', 11, 'not-json')").run();
  assert.doesNotThrow(() => report(db));
  db.close();
});

test('reports verification candidate status and exit evidence without treating completed as pass', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 30);
  addUser(db, 'u', 2, 'work');
  addAssistant(db, 'a', 'root', 3, 'build', 'builder');
  addPart(db, 'test', 'a', 'root', 3, { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' } } });
  addPart(db, 'status', 'a', 'root', 3, { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'git status' }, metadata: { exitCode: 0 } } });
  const output = report(db);
  assert.match(output, /npm test.*status completed; exit result unavailable \(execution result unknown\)/);
  assert.doesNotMatch(output, /git status.*success recorded/);
  db.close();
});

test('uses canonical bash metadata.exit while retaining unknown and nonzero distinctions', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 30);
  addUser(db, 'u', 2, 'work');
  addAssistant(db, 'a', 'root', 3, 'build', 'builder');
  addPart(db, 'success', 'a', 'root', 3, { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'node --test' }, metadata: { exit: 0 } } });
  addPart(db, 'failure', 'a', 'root', 3, { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, metadata: { exit: 2 } } });
  const output = report(db, 30);
  assert.match(output, /`node --test`: status completed; exit 0 \(success recorded\)/);
  assert.match(output, /`npm test`: status completed; exit 2 \(nonzero\)/);
  db.close();
});

test('does not count equal-timestamp reporting task parts as root actions or context', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 30);
  addUser(db, 'work', 2, 'work');
  addAssistant(db, 'work-a', 'root', 3, 'build', 'builder', { input: 5 });
  addUser(db, 'report', 10, 'report');
  addPart(db, 'subtask', 'report', 'root', 10, { type: 'subtask', command: 'agent-usage', prompt: '[[agent-usage-report-v1]]' });
  addAssistant(db, 'report-a', 'root', 10, 'quick', 'luna', { input: 999 });
  addPart(db, 'report-task', 'report-a', 'root', 10, { type: 'tool', tool: 'task', state: { input: { command: 'agent-usage' }, output: 'report handoff' } });
  const output = report(db, 30);
  assert.ok(output.includes('Meaningful root actions: none observed.'));
  assert.ok(output.includes('Context isolation heuristic: no child tool-output bytes recorded.'));
  assert.ok(!output.includes('999'));
  db.close();
});

test('counts only completed mutations as changed files and includes final timestamp equality', () => {
  const db = fixture();
  addSession(db, 'root', null, 1, 20);
  addUser(db, 'u', 2, 'work');
  addAssistant(db, 'a', 'root', 20, 'build', 'builder', { output: 1 });
  addPart(db, 'failed', 'a', 'root', 20, { type: 'tool', tool: 'apply_patch', state: { status: 'error', input: { patchText: '*** Update File: failed.js' } } });
  addPart(db, 'done', 'a', 'root', 20, { type: 'tool', tool: 'apply_patch', state: { status: 'completed', input: { patchText: '*** Update File: good.js' } } });
  const output = report(db, 20);
  assert.match(output, /Successful changed files: good\.js/);
  assert.doesNotMatch(output, /failed\.js/);
  assert.match(output, /\*\*1\*\*/);
  db.close();
});

test('CLI rejects missing session values and unknown arguments without fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-usage-'));
  const databasePath = join(dir, 'fixture.db');
  fixture(databasePath).close();
  const script = new URL('./agent-usage.mjs', import.meta.url).pathname;
  for (const args of [['--session'], ['--bad']]) {
    assert.throws(() => execFileSync(process.execPath, [script, ...args], {
      env: { ...process.env, OPENCODE_DB_PATH: databasePath },
      stdio: 'pipe',
    }));
  }
  rmSync(dir, { recursive: true, force: true });
});

test('V2 reads paginated projected timelines and excludes the reporting turn at its boundary', () => {
  const root = { id: 'ses_root', time: { created: 1, updated: 90 }, location: { directory: '/work' } };
  const child = { id: 'ses_child', parentID: root.id, time: { created: 12, updated: 30 } };
  const user = (id, time, text) => ({ id, time: { created: time }, type: 'user', text });
  const assistant = (id, time, agent, input, content = []) => ({
    id, time: { created: time }, type: 'assistant', agent,
    model: { providerID: 'openai', id: 'model' }, tokens: { input, output: 1, reasoning: 0, cache: { read: 2, write: 0 } }, cost: 0,
    content,
  });
  const task = { id: 'tool_1', type: 'tool', name: 'task', time: { created: 11, ran: 11, completed: 25 },
    state: { status: 'completed', input: { subagent_type: 'quick', description: 'bounded fix', task_id: 'ses_child' }, content: [{ type: 'text', text: 'done' }] } };
  const responses = {
    '/api/session?parentID=null&directory=%2Fwork&order=desc': { data: [root], cursor: { next: null } },
    '/api/session?parentID=ses_root&order=desc': { data: [child], cursor: { next: null } },
    '/api/session?parentID=ses_child&order=desc': { data: [], cursor: { next: null } },
    '/api/session/ses_root/message?limit=5&order=desc': { data: [user('msg_u', 10, 'work'), assistant('msg_a', 11, 'build', 5, [task])], cursor: { next: 'next-root' } },
    '/api/session/ses_root/message?limit=5&cursor=next-root': { data: [
      user('msg_prior_report', 4, 'Return this local evidence report exactly as given.\n[[agent-usage-report-v2]]'),
      assistant('msg_prior_reporting', 5, 'quick', 888),
      user('msg_report', 40, 'Return this local evidence report exactly as given.\n[[agent-usage-report-v2]]'),
      assistant('msg_reporting', 40, 'quick', 999),
    ], cursor: { next: null } },
    '/api/session/ses_child/message?limit=5&order=desc': { data: [assistant('msg_child', 13, 'quick', 7)], cursor: { next: null } },
  };
  const visited = [];
  const output = createV2Report((path) => { visited.push(path); assert.ok(responses[path], path); return responses[path]; }, { directory: '/work', now: 90 });
  assert.ok(visited.includes('/api/session/ses_root/message?limit=5&cursor=next-root'));
  assert.match(output, /Task invocations: 1; unique linked workers: 1/);
  assert.match(output, /\| quick \(bounded work\) \| openai\/model \| 1 \| 7 \| 1 \| 0 \| 2/);
  assert.doesNotMatch(output, /999/);
  assert.doesNotMatch(output, /888/);
  assert.match(output, /ended at reporting boundary/);
});

test('V2 chooses the newest real user across descending pages and sorts child usage chronologically', () => {
  const root = { id: 'ses_root', time: { created: 1, updated: 40 }, location: { directory: '/work' } };
  const child = { id: 'ses_child', parentID: root.id, time: { created: 11, updated: 23 } };
  const user = (id, created) => ({ id, type: 'user', time: { created }, text: 'work' });
  const assistant = (id, created, input, content = [], agent = 'build') => ({
    id, type: 'assistant', time: { created }, agent, model: { providerID: 'test', id: 'model' },
    tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, content,
  });
  const task = { id: 'tool_task', type: 'tool', name: 'task', time: { created: 21, ran: 21, completed: 23 },
    state: { status: 'completed', input: { task_id: 'ses_child', subagent_type: 'quick' }, content: [{ type: 'text', text: 'done' }] } };
  const responses = {
    '/api/session?parentID=null&directory=%2Fwork&order=desc': { data: [root], cursor: { next: null } },
    '/api/session?parentID=ses_root&order=desc': { data: [child], cursor: { next: null } },
    '/api/session?parentID=ses_child&order=desc': { data: [], cursor: { next: null } },
    '/api/session/ses_root/message?limit=5&order=desc': { data: [assistant('msg_new', 21, 7, [task]), user('msg_latest', 20)], cursor: { next: 'older' } },
    '/api/session/ses_root/message?limit=5&cursor=older': { data: [assistant('msg_old', 12, 2), user('msg_old_user', 10)], cursor: { next: null } },
    '/api/session/ses_child/message?limit=5&order=desc': { data: [assistant('msg_child_new', 22, 11, [], 'quick')], cursor: { next: 'older' } },
    '/api/session/ses_child/message?limit=5&cursor=older': { data: [assistant('msg_child_old', 13, 3, [], 'quick')], cursor: { next: null } },
  };
  const output = createV2Report((path) => responses[path] ?? assert.fail(path), { directory: '/work', now: 40 });
  const [latest, full] = output.split('# Full Session Usage To Cutoff');
  assert.match(latest, /Latest work run: 1970-01-01T00:00:00\.020Z/);
  assert.match(latest, /\| \*\*Total\*\* \|  \| \*\*2\*\* \| \*\*18\*\*/);
  assert.match(full, /\| \*\*Total\*\* \|  \| \*\*4\*\* \| \*\*23\*\*/);
  assert.match(output, /Task invocations: 1; unique linked workers: 1/);
});

test('V2 keeps equal-timestamp message order stable', () => {
  const root = { id: 'ses_root', time: { created: 1, updated: 10 }, location: { directory: '/work' } };
  const assistant = (id, text) => ({ id, type: 'assistant', time: { created: 3 }, agent: 'build',
    model: { providerID: 'test', id: 'model' }, tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0, content: [{ type: 'text', text }] });
  const api = (path) => {
    if (path.includes('/message?')) return { data: [assistant('msg_first', 'first response'), assistant('msg_second', 'second response'),
      { id: 'msg_user', type: 'user', time: { created: 2 }, text: 'work' }], cursor: { next: null } };
    return { data: path.includes('parentID=null') ? [root] : [], cursor: { next: null } };
  };
  assert.match(createV2Report(api, { directory: '/work' }), /Last bounded assistant response: second response/);
});

test('V2 stops before retaining an unbounded session-tree transcript', () => {
  const root = { id: 'ses_root', time: { created: 1, updated: 10 }, location: { directory: '/work' } };
  let pagesRead = 0;
  const api = (path) => {
    if (path.includes('/message?')) {
      pagesRead += 1;
      const data = Array.from({ length: 5 }, (_, index) => ({
        id: `msg_${pagesRead}_${index}`, type: 'user', time: { created: pagesRead * 5 + index }, text: 'work',
      }));
      return { data, cursor: { next: String(pagesRead) } };
    }
    return { data: path.includes('parentID=null') ? [root] : [], cursor: { next: null } };
  };
  assert.throws(() => createV2Report(api, { directory: '/work' }), /exceeds safety limit.*refusing a partial report/);
  assert.equal(pagesRead, 401);
});

test('V2 rejects oversized projected content before normalizing tool output', () => {
  const root = { id: 'ses_root', time: { created: 1, updated: 10 }, location: { directory: '/work' } };
  const api = (path) => {
    if (path.includes('/message?')) return { data: [{ id: 'msg_user', type: 'user', time: { created: 2 }, text: 'x'.repeat(16 * 1024 * 1024) }], cursor: { next: null } };
    return { data: path.includes('parentID=null') ? [root] : [], cursor: { next: null } };
  };
  assert.throws(() => createV2Report(api, { directory: '/work' }), /exceeds safety limit.*refusing a partial report/);
});

test('V2 rejects incomplete pagination and explicit child selection', () => {
  assert.throws(() => createV2Report(() => ({ data: [] }), { directory: '/work' }), /incomplete usage report/);
  assert.throws(() => createV2Report(() => ({ data: { id: 'ses_child', parentID: 'ses_root' } }), { sessionID: 'ses_child' }), /Root session not found/);
});

test('CLI legacy mode reads a V1 fixture and rejects a different schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-usage-'));
  const databasePath = join(dir, 'fixture.db');
  const db = fixture(databasePath);
  addSession(db, 'root', null, 1, 10);
  addUser(db, 'u', 2, 'work');
  addAssistant(db, 'a', 'root', 3, 'build', 'model', { input: 5 });
  db.close();
  const script = new URL('./agent-usage.mjs', import.meta.url).pathname;
  try {
    const output = execFileSync(process.execPath, [script, '--legacy-db', '--session', 'root'], {
      env: { ...process.env, OPENCODE_DB_PATH: databasePath }, encoding: 'utf8',
    });
    assert.match(output, /openai\/model/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI bounds V2 message pages and fails closed on truncated JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-usage-api-'));
  const binary = join(dir, 'opencode');
  const script = new URL('./agent-usage.mjs', import.meta.url).pathname;
  writeFileSync(binary, `#!/usr/bin/env node
const path = process.argv[4];
const root = { id: 'ses_root', time: { created: 1, updated: 10 }, location: { directory: process.cwd() } };
const user = { id: 'msg_user', type: 'user', time: { created: 2 }, text: 'work' };
const assistant = { id: 'msg_assistant', type: 'assistant', time: { created: 3 }, agent: 'build', model: { id: 'model', providerID: 'test' }, tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, content: [] };
if (path.startsWith('/api/session/ses_root/message?')) {
  if (!path.includes('limit=5')) { process.stdout.write('{"data":['); process.exit(0); }
  if (process.env.TRUNCATE_API === '1') { process.stdout.write('{"data":['); process.exit(0); }
  process.stdout.write(JSON.stringify({ data: [user, assistant], cursor: { next: null } }));
} else {
  process.stdout.write(JSON.stringify({ data: path.includes('parentID=null') ? [root] : [], cursor: { next: null } }));
}
`, { mode: 0o755 });
  try {
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    const success = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /\*\*2\*\*/);
    const truncated = spawnSync(process.execPath, [script], { env: { ...env, TRUNCATE_API: '1' }, encoding: 'utf8' });
    assert.equal(truncated.status, 1);
    assert.equal(truncated.stdout, '');
    assert.match(truncated.stderr, /not JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
