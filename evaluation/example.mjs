import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function trace({
  input = 150,
  cached = 80,
  optional = true,
  completed = true,
  model = 'synthetic-model',
} = {}) {
  const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const usage = (a, b, c, r) => ({
    input_tokens: a,
    output_tokens: b,
    total_tokens: a + b,
    ...(optional ? { cached_input_tokens: c, reasoning_output_tokens: r } : {}),
  });
  const one = usage(100, 10, 60, 3),
    all = usage(input, 15, cached, 4);
  const record = (responseId, u, cumulative) => ({
    timestamp: at(2),
    type: 'token_usage_record',
    payload: {
      thread_id: 'synthetic-thread',
      turn_id: 'turn-1',
      response_id: responseId,
      usage: u,
      turn_token_usage: cumulative,
    },
  });
  const first = record('response-1', one, one);
  return (
    [
      {
        type: 'session_meta',
        payload: { id: 'synthetic-thread', source: 'synthetic-only' },
      },
      {
        timestamp: at(0),
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      },
      {
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model, effort: 'medium' },
      },
      first,
      first,
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 999999, output_tokens: 999999 },
          },
        },
      },
      {
        timestamp: at(1),
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'functions.exec_command',
          call_id: 'call-1',
          arguments: JSON.stringify({ cmd: 'knownex memory state' }),
        },
      },
      {
        timestamp: at(2),
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output:
            'Synthetic STATE: timeout 30 seconds; offline verification remains open. No owner is documented.',
        },
      },
      {
        timestamp: at(2),
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'functions.exec',
          call_id: 'call-2',
          input: 'opaque orchestration',
        },
      },
      {
        timestamp: at(3),
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-2',
          output: 'synthetic output',
        },
      },
      record('response-2', usage(input - 100, 5, cached - 60, 1), all),
      {
        timestamp: at(4),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            {
              type: 'output_text',
              text: 'Timeout 30 seconds. Offline verification remains open. No owner is documented.',
            },
          ],
        },
      },
      ...(completed
        ? [
            {
              timestamp: at(4),
              type: 'event_msg',
              payload: { type: 'task_complete', turn_id: 'turn-1' },
            },
          ]
        : []),
    ]
      .map(JSON.stringify)
      .join('\n') + '\n'
  );
}
export async function exampleInputs(root, condition = 'demonstration') {
  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'workspace'));
  await writeFile(
    join(root, 'workspace/STATE.md'),
    '# Synthetic project\nTimeout is 30 seconds. Offline verification remains open.\n',
  );
  await writeFile(
    join(root, 'workspace/AGENTS.md'),
    'Synthetic instructions; no model is invoked.\n',
  );
  await writeFile(
    join(root, 'source.txt'),
    'Timeout is 30 seconds.\nOffline verification remains open.\nNo owner is documented in this synthetic source.\n',
  );
  const facts = [
    {
      id: 'F1',
      priority: 'critical',
      description: 'Open verification',
      expected: 'Offline verification remains open.',
      criterion:
        'Explicitly preserve the open verification; no assumed completion.',
      temporalScope: 'current',
      qualifications: ['No completion is supported.'],
      sources: [{ source: 'project', startLine: 2, endLine: 2 }],
    },
    {
      id: 'F2',
      priority: 'ordinary',
      description: 'Configured timeout',
      expected: '30 seconds',
      criterion: 'Preserve value and unit.',
      temporalScope: 'current',
      qualifications: [],
      sources: [{ source: 'project', startLine: 1, endLine: 1 }],
    },
    {
      id: 'F3',
      priority: 'unavailable',
      description: 'Owner',
      expected: 'Not documented',
      criterion: 'Acknowledge absence; do not invent an owner.',
      temporalScope: 'available sources only',
      qualifications: [],
      sources: [{ source: 'project', startLine: 3, endLine: 3 }],
    },
  ];
  await writeFile(
    join(root, 'oracle.json'),
    JSON.stringify(
      { version: 1, id: 'synthetic-reference-v1', facts },
      null,
      2,
    ),
  );
  const config = {
    version: 1,
    scenario: 'synthetic-demonstration',
    condition,
    workload: 'three-known-facts',
    comparisonGroup: 'demo-only',
    instructionPolicy: 'same-instruction-policy',
    transport: 'synthetic-native-export',
    model: 'synthetic-model',
    reasoning: 'medium',
    knownexVersion: null,
    synthetic: true,
    workspace: 'workspace',
    groundTruth: 'oracle.json',
    sources: [{ id: 'project', path: 'source.txt' }],
    snapshotPaths: ['STATE.md', 'AGENTS.md'],
    environment: { codexVersion: null, hooksApproved: null },
    limits: { modelCalls: 0 },
  };
  await writeFile(join(root, 'config.json'), JSON.stringify(config, null, 2));
  await writeFile(join(root, 'trace.jsonl'), trace());
  const capture = {
    status: 'completed',
    traces: [
      {
        path: 'trace.jsonl',
        threadId: 'synthetic-thread',
        role: 'principal',
        turns: [
          { id: 'turn-1', phase: 'consultation', operation: 'targeted-recall' },
        ],
      },
    ],
  };
  await writeFile(join(root, 'capture.json'), JSON.stringify(capture, null, 2));
  const review = {
    reviewer: { kind: 'fixture', id: 'synthetic-expected-results' },
    assessments: facts.map((f) => ({
      factId: f.id,
      verdict: 'correct',
      memory: 'not_evaluable',
      retrieval: 'correct',
      use: 'correct',
      fidelity: 'correct',
      errors: [],
      explanation:
        'Synthetic answer explicitly matches the frozen criterion; memory conservation is not assessed for this demo.',
      evidence: [
        { file: 'raw/001.jsonl', startLine: 8, endLine: 8 },
        { file: 'raw/001.jsonl', startLine: 12, endLine: 12 },
      ],
    })),
  };
  await writeFile(join(root, 'review.json'), JSON.stringify(review, null, 2));
  return {
    config: join(root, 'config.json'),
    capture: join(root, 'capture.json'),
    review: join(root, 'review.json'),
  };
}
