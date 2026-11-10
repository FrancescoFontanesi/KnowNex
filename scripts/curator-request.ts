import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { writeExclusiveFiles, transportJson } = await import(
  new URL(
    import.meta.url.endsWith('.ts')
      ? '../src/artifact-io.ts'
      : './artifact-io.js',
    import.meta.url,
  ).href
);
export async function curatorRequest(run: string): Promise<{
  text: string;
  packetBytes: number;
  packetSha256: string;
  requestBytes: number;
  requestSha256: string;
}> {
  const module = await import(
    new URL(
      import.meta.url.endsWith('.ts')
        ? '../src/curator-request-data.ts'
        : './curator-request-data.js',
      import.meta.url,
    ).href
  );
  return module.curatorRequest(run);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: { run: { type: 'string' }, output: { type: 'string' } },
    });
    if (!values.run || !values.output)
      throw new Error('CURATOR_REQUEST_ARGUMENTS');
    const { text, ...metrics } = await curatorRequest(values.run);
    await writeExclusiveFiles([{ path: values.output, text }]);
    process.stdout.write(transportJson({ ...metrics, request: text }) + '\n');
  } catch {
    process.stderr.write(
      '{"status":"error","code":"CURATOR_REQUEST_FAILED"}\n',
    );
    process.exitCode = 1;
  }
}
