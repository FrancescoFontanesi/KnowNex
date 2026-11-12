import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { acquireJournalLock } from './journal-lock.ts';
import { workspaceLayout } from './layout.ts';
import {
  preparedCheckpoint,
  type DelegationResult,
} from './native-checkpoint.ts';

export type Provider = 'codex' | 'claude';
export interface LaunchOptions {
  provider: Provider;
  model?: string;
  effort?: string;
}
export interface ProviderRun {
  exitCode: number | null;
  error?: string;
}
export type RunProvider = (
  command: string,
  args: string[],
  cwd: string,
  input: string,
) => Promise<ProviderRun>;

// shortcut: one fixed ceiling per curation; make it an option if real batches need longer.
const TIMEOUT_MS = 60 * 60 * 1000;

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/** argv of a non-interactive, unpersisted provider session that reads its task from stdin. */
export function providerCommand(
  options: LaunchOptions,
  workspace: string,
): [string, string[]] {
  // Values reach a TOML override (codex -c) and provider argv: keep them to plain identifiers.
  for (const value of [options.model, options.effort])
    if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))
      fail('CHECKPOINT_ARGUMENT_INVALID');
  const { model, effort } = options;
  if (options.provider === 'codex')
    return [
      'codex',
      [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '-C',
        workspace,
        '-s',
        'workspace-write',
        ...(model ? ['-m', model] : []),
        ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
        '-',
      ],
    ];
  if (options.provider === 'claude')
    return [
      'claude',
      [
        '-p',
        '--no-session-persistence',
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Bash(node:*)',
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
      ],
    ];
  return fail('CHECKPOINT_ARGUMENT_INVALID');
}

/** Runs the provider with capture disabled; only the exit status and a last error line come back. */
export const spawnProvider: RunProvider = (command, args, cwd, input) =>
  new Promise((done) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, KNOWNEX_CAPTURE: '0' },
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ exitCode: null, error: e.code ?? e.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const last = stderr.trim().split(/\r?\n/).at(-1);
      done({
        exitCode: code,
        ...(code !== 0
          ? { error: signal ? 'TIMEOUT' : last || 'exit ' + code }
          : {}),
      });
    });
    child.stdin.end(input);
  });

/**
 * One checkpoint end to end: prepare, a fresh provider session that only curates the frozen
 * run, then complete. The session leaves no memory and is not captured into the feed.
 */
export async function launchCheckpoint(
  workspace: string,
  options: LaunchOptions,
  run: RunProvider = spawnProvider,
): Promise<DelegationResult> {
  workspace = resolve(workspace);
  const [command, args] = providerCommand(options, workspace);
  let release;
  try {
    // One curation per workspace: a second launch stops instead of curating the same batch.
    release = await acquireJournalLock(
      join(workspaceLayout(workspace).internal, 'checkpoint.lock'),
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      status: 'ERROR',
      through: null,
      code:
        code === 'DESTINATION_BUSY'
          ? 'CHECKPOINT_BUSY'
          : code === 'ENOENT'
            ? 'KNOWNEX_WORKSPACE_REQUIRED'
            : (code ?? 'CHECKPOINT_FAILED'),
    };
  }
  try {
    const work = workspaceLayout(workspace).work;
    const prepared = await preparedCheckpoint(work, { stage: 'prepare' });
    if (prepared.status !== 'READY') return prepared;
    const session = await run(
      command,
      args,
      workspace,
      await readFile(prepared.requestFile, 'utf8'),
    );
    const result = (await preparedCheckpoint(work, {
      stage: 'complete',
      run: prepared.runId,
    })) as DelegationResult;
    // Undelivered batch after a failed session: name the provider failure; the batch stays retryable.
    if (
      result.code === 'CURATOR_WORKER_OUTPUT_INCOMPLETE' &&
      session.exitCode !== 0
    )
      return {
        ...result,
        code: 'CHECKPOINT_PROVIDER_FAILED',
        cause: session.error ?? 'exit ' + session.exitCode,
      };
    return result;
  } finally {
    await release();
  }
}
