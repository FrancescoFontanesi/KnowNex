import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Deterministic native RPC peer; no model or semantic oracle. */
export async function nativeFixture(directory: string) {
  await mkdir(directory, { recursive: true });
  const state = join(directory, 'native-state.json');
  await writeFile(
    join(directory, 'app-server'),
    `
const fs = require('node:fs'), readline = require('node:readline');
const counts = new Map();
readline.createInterface({input: process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  if (!('id' in r)) return;
  const config = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
  fs.appendFileSync(${JSON.stringify(join(directory, 'native-calls.jsonl'))}, JSON.stringify({method:r.method,params:r.params})+'\\n');
  let result = {}, error;
  const threadId = r.params?.threadId, t = config.threads[threadId];
  if (r.method === 'initialize') result = {userAgent:'deterministic-fixture'};
  else if (!t) error = {code:-1,message:'Unknown fixture thread'};
  else if (r.method === 'thread/read') result = {thread:{id:threadId,sessionId:t.sessionId || threadId,historyMode:'paginated'}};
  else if (r.method === 'thread/turns/list') {
    let offset = r.params.cursor ? Number(r.params.cursor.split('_').at(-1)) : 0;
    const count = counts.get(threadId) || 0; counts.set(threadId,count+1);
    const ids = config.mode === 'changed' && count > 0 ? ['changed'] : t.turns;
    if (config.mode === 'late-error' && offset > 0) error = {code:-1,message:'Incomplete page'};
    else result = {data:ids.slice(offset,offset+2).map(id=>({id,status:'completed'})),nextCursor:offset+2<ids.length ? (config.mode === 'long-cursor' ? 'x'.repeat(300)+'_' : '')+(offset+2) : null};
    if (config.mode === 'loop') result = {data:[],nextCursor:'0'};
  } else error = {code:-1,message:'Non-read method forbidden'};
  process.stdout.write(JSON.stringify({id:r.id,...(error?{error}:{result})})+'\\n');
});
`,
  );
  const threads: Record<string, { sessionId?: string; turns: string[] }> = {};
  let mode = 'normal';
  const save = () => writeFileSync(state, JSON.stringify({ threads, mode }));
  save();
  return {
    set(threadId: string, turns: string[], sessionId?: string) {
      threads[threadId] = { turns, ...(sessionId ? { sessionId } : {}) };
      save();
    },
    retain(threadId: string, turnId: string) {
      const prior = threads[threadId]?.turns ?? [];
      if (!prior.includes(turnId)) this.set(threadId, [...prior, turnId]);
    },
    mode(value: string) {
      mode = value;
      save();
    },
  };
}
