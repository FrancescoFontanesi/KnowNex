const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const runtime = resolve(__dirname, '../..');
const entry = existsSync(join(runtime, 'dist/session-hook.js'))
  ? join(runtime, 'dist/session-hook.js')
  : join(runtime, 'src/session-hook.ts');
const result = spawnSync(process.execPath, [entry], {
  stdio: ['inherit', 'pipe', 'pipe'],
  encoding: 'utf8',
  timeout: 7500,
  windowsHide: true,
  maxBuffer: 64 * 1024,
});
process.stdout.write(
  result.status === 0 && result.stdout
    ? result.stdout
    : JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            'KnowNex: avvio contesto non riuscito; memoria e pending non verificati. Non assumere conferme.',
        },
      }) + '\n',
);
