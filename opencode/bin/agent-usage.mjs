#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createReport, createV2Report } from './reporting.mjs';

try {
  const { sessionID, legacyDB, reporting } = parseArgs(process.argv.slice(2));
  if (reporting && legacyDB) throw new Error('--reporting requires the V2 API; use --legacy-db directly for V1 history.');
  if (legacyDB) {
    const databasePath = process.env.OPENCODE_DB_PATH ?? join(
      process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'opencode.db',
    );
    if (!existsSync(databasePath)) throw new Error(`V1 OpenCode database not found at ${databasePath}.`);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = (table) => database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      if (!['id', 'session_id', 'data', 'time_created'].every((name) => columns('message').includes(name)) ||
        !['id', 'message_id', 'session_id', 'data', 'time_created'].every((name) => columns('part').includes(name)) ||
        !['id', 'parent_id', 'directory', 'time_created', 'time_updated'].every((name) => columns('session').includes(name))) {
        throw new Error('This database is not the V1 session/message/part schema; use the V2 API instead.');
      }
      console.log(createReport(database, { directory: process.cwd(), sessionID }));
    } finally {
      database.close();
    }
  } else {
    const api = (path) => {
      let output;
      try {
        output = execFileSync('opencode', ['api', 'get', path], {
          encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        throw new Error('V2 API unavailable. Check `opencode api get /api/info` or use --legacy-db for a V1 database.');
      }
      try { return JSON.parse(output); }
      catch { throw new Error('Unexpected V2 API response (not JSON); no usage report generated.'); }
    };
    console.log(createV2Report(api, { directory: process.cwd(), sessionID, reporting }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(args) {
  let sessionID;
  let legacyDB = false;
  let reporting = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--legacy-db' && !legacyDB) legacyDB = true;
    else if (args[index] === '--reporting' && !reporting) reporting = true;
    else if (args[index] === '--session' && args[index + 1] && !args[index + 1].startsWith('--') && !sessionID) sessionID = args[++index];
    else throw new Error('Usage: agent-usage.mjs [--session <root-session-id>] [--legacy-db | --reporting]');
  }
  return { sessionID, legacyDB, reporting };
}
