import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { jsonText, sha256, writeExclusiveFiles } from './artifact-io.ts';

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// Provider messages can echo prompts or credentials. Only known, content-free
// messages survive verbatim; all other text retains a fingerprint, not its body.
function safeMessage(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const message = value.trim();
  if (
    /^(?:Error: )?(?:Could not find home directory|Access is denied\. \(os error 5\)|Permission denied \(os error 13\))$/.test(
      message,
    ) ||
    message ===
      'WARNING: proceeding, even though we could not create PATH aliases: Could not find home directory'
  )
    return message;
  if (
    /^WARNING: (?:failed to clean up stale arg0 temp dirs|proceeding, even though we could not create PATH aliases): Access is denied\. \(os error 5\)/.test(
      message,
    )
  ) {
    return message.split('(os error 5)')[0] + '(os error 5) [path omitted]';
  }
  return /^(?:permission denied|access is denied|thread not found|thread not available|unknown fixture thread|incomplete page|method not found|connection refused)[.!]?$/i.test(
    message,
  )
    ? message
    : `[redacted sha256:${sha256(Buffer.from(value, 'utf8'))}]`;
}
function original(error: unknown) {
  const e = object(error) ? error : {};
  return {
    code:
      typeof e.code === 'number' ||
      (typeof e.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.code))
        ? e.code
        : undefined,
    message: safeMessage(e.message),
  };
}

async function diagnosticsDirectory(cwd: string) {
  let current = resolve(cwd);
  while (true) {
    const candidate =
      basename(current) === '.knownex' ? current : join(current, '.knownex');
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
      for (const name of ['internal', 'internal/diagnostics']) {
        const path = join(candidate, name);
        await mkdir(path).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'EEXIST') throw e;
        });
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
      }
      return join(candidate, 'internal/diagnostics');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export type NativeCall = (
  method: string,
  params: unknown,
) => Promise<Record<string, unknown>>;

async function resolvedExecutable(command: string, cwd: string) {
  const directories =
    isAbsolute(command) || /[/\\]/.test(command)
      ? ['']
      : (process.env.PATH ?? '').split(delimiter);
  for (const directory of directories) {
    const path = directory
      ? resolve(directory, command)
      : resolve(cwd, command);
    for (const suffix of process.platform === 'win32' && !/\.exe$/i.test(path)
      ? ['', '.exe']
      : ['']) {
      try {
        await access(path + suffix, constants.X_OK);
        return await realpath(path + suffix);
      } catch {
        /* Resolution is diagnostic only; spawn retains its original behavior. */
      }
    }
  }
  return null;
}

/** One ephemeral, read-only App Server; never retries or resumes a thread. */
export async function withNativeRpc<T>(
  cwd: string,
  publicCode: string,
  operation: (call: NativeCall) => Promise<T>,
) {
  const started = Date.now();
  const executable = process.env.KNOWNEX_CODEX_BIN || 'codex';
  // Rust home discovery fails under the Windows restricted token even when
  // USERPROFILE is valid. Use the existing Node-resolved home, never a new store
  // or an elevation; explicit CODEX_HOME always wins and ACLs remain enforced.
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const diagnostic: Record<string, unknown> = {
    version: 1,
    publicCode,
    executable,
    cwd,
    codexHome,
    homeSource:
      process.env.CODEX_HOME === undefined ? 'node-default' : 'explicit',
    initialized: false,
    phase: 'spawn',
    method: null,
    spawned: false,
  };
  const child = spawn(executable, ['app-server'], {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((r) => child.once('close', () => r()));
  let stopped = false,
    next = 0,
    bytes = 0,
    buffer = '',
    stderr = '';
  let failed: unknown;
  let rejectFailure: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const pending = new Map<number, (v: Record<string, unknown>) => void>();
  const stop = (reason: string, error?: unknown) => {
    if (stopped) return;
    stopped = true;
    diagnostic.reason = reason;
    if (reason === 'spawn') diagnostic.phase = 'spawn';
    diagnostic.original = original(error);
    rejectFailure(Object.assign(new Error(publicCode), { code: publicCode }));
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => stop('timeout'), 6000);
  child.on('spawn', () => {
    diagnostic.spawned = true;
  });
  child.on('error', (e) => stop('spawn', e));
  child.on('exit', (code, signal) => {
    diagnostic.termination = { code, signal };
    stop('exit');
  });
  child.on('close', (code, signal) => {
    diagnostic.termination = { code, signal };
  });
  child.stdin.on('error', (e) => stop('stdin', e));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024) return stop('output-limit');
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const v: unknown = JSON.parse(line);
        if (!object(v)) return stop('protocol');
        if (typeof v.id === 'number' && pending.has(v.id)) {
          const callback = pending.get(v.id)!;
          pending.delete(v.id);
          callback(v);
        } else if ('id' in v) return stop('protocol');
      } catch (e) {
        stop('decode', e);
      }
    }
  });
  const call: NativeCall = async (method, params) => {
    diagnostic.phase = method === 'initialize' ? 'initialize' : 'rpc';
    diagnostic.method = method;
    diagnostic.threadId =
      object(params) &&
      typeof params.threadId === 'string' &&
      /^[a-f0-9-]{36}$/i.test(params.threadId)
        ? params.threadId
        : undefined;
    const n = ++next;
    const response = new Promise<Record<string, unknown>>((r) =>
      pending.set(n, r),
    );
    child.stdin.write(JSON.stringify({ id: n, method, params }) + '\n');
    const value = await Promise.race([response, failure]);
    if (value.error || !object(value.result)) {
      diagnostic.reason = value.error ? 'rpc-error' : 'protocol';
      diagnostic.original = original(value.error);
      throw Object.assign(new Error(publicCode), { code: publicCode });
    }
    return value.result;
  };
  try {
    await call('initialize', {
      clientInfo: { name: 'knownex_history_reader', title: null, version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    diagnostic.initialized = true;
    child.stdin.write('{"method":"initialized"}\n');
    return await operation(call);
  } catch (error) {
    failed = error;
    if (!diagnostic.reason) {
      diagnostic.reason = 'validation';
      diagnostic.original = original(error);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    stopped = true;
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGKILL'), 250);
    pending.clear();
    await closed;
    clearTimeout(kill);
    if (failed) {
      diagnostic.durationMs = Date.now() - started;
      diagnostic.resolvedExecutable = await resolvedExecutable(executable, cwd);
      diagnostic.stderr = stderr
        ? stderr.split(/\r?\n/).filter(Boolean).slice(-16).map(safeMessage)
        : [];
      diagnostic.stderrTruncated = Buffer.byteLength(stderr) >= 4096;
      const stage = diagnostic.initialized
        ? typeof diagnostic.method === 'string' &&
          diagnostic.method.startsWith('thread/')
          ? 'history'
          : 'rpc'
        : 'initialize';
      const source = object(diagnostic.original) ? diagnostic.original : {};
      diagnostic.failureKind = !diagnostic.spawned
        ? 'start-failed'
        : !diagnostic.initialized &&
            /Error: Could not find home directory/.test(stderr)
          ? 'initialize-home-unavailable'
          : !diagnostic.initialized &&
              /Error: (?:Access is denied\. \(os error 5\)|Permission denied \(os error 13\))/.test(
                stderr,
              )
            ? 'initialize-permission-denied'
            : stage === 'history' &&
                /^(?:thread not found|thread not available|unknown fixture thread)[.!]?$/i.test(
                  String(source.message),
                )
              ? 'history-unavailable'
              : `${stage}-${diagnostic.reason}`;
      try {
        const directory = await diagnosticsDirectory(cwd);
        if (directory) {
          const path = join(directory, `native-rpc-${randomUUID()}.json`);
          await writeExclusiveFiles([
            { path, text: jsonText(diagnostic, 2) + '\n' },
          ]);
          if (object(failed)) failed.diagnostic = path;
        }
      } catch {
        /* Diagnostics can neither authorize publication nor mask the public failure. */
      }
    }
  }
}
