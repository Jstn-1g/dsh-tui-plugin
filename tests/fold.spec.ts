/**
 * Session-event fold: user/assistant messages, streaming chunks, tool calls
 * and results, todos, commands, plan mode, titles, and turn errors.
 */

import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldTranscript, TranscriptFold, type TranscriptBlock } from '../src/tui/fold.ts'

function user(text: string): SessionEvent<'user/message'> {
  return {
    type: 'user/message', seq: 0, time: 1,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }
}function assistant(text: string): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message', seq: 0, time: 1,
    data: {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'p', model: 'm' },
      }),
    },
    surfaceOp: 'append',
  }
}

function chunk(text: string): SessionEvent<'assistant/chunk'> {
  return {
    type: 'assistant/chunk', seq: 0, time: 1,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
  }
}

function toolCall(
  callId: string,
  name: string,
  args: string,
  turn = 1,
  step = 1,
): SessionEvent<'tool/call'> {
  return {
    type: 'tool/call', seq: 0, time: 1,
    data: { turn, step, callId: callId as never, name, arguments: args },
  }
}

function toolResult(callId: string, text: string, turn = 1, step = 1): SessionEvent<'tool/result'> {
  return {
    type: 'tool/result', seq: 0, time: 1,
    data: {
      turn, step,
      message: createToolResultMessage({
        callId: callId as never,
        content: [{ type: 'text', text }],
        isError: false,
      }),
    },
    surfaceOp: 'append',
  }
}

describe('TranscriptFold', () => {
  /** Apply every event in order and return the resulting blocks. */
  function foldAll(events: readonly SessionEvent[]): TranscriptBlock[] {
    const fold = new TranscriptFold()
    for (const event of events) fold.apply(event)
    return fold.blocks
  }

  it('matches foldTranscript on a mixed log', () => {
    const callId = 'call-1' as never
    const events = [
      { type: 'user/message', seq: 0, time: 1, data: {
        content: [
          { type: 'text', text: 'fix it' },
          { type: 'text', text: '<system-reminder> read the workspace</system-reminder>' },
        ],
      }, surfaceOp: 'append' },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      chunk('Hel'),
      chunk('lo'),
      toolCall(callId, 'bash', '{}'),
      toolResult(callId, 'ok'),
      todoEvent(),
      commandRunEvent(),
      commandDoneEvent('done'),
      planEvent(true),
      { type: 'turn/end', seq: 10, time: 11, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    expect(foldAll(events)).toEqual(foldTranscript(events))
  })

  it('matches foldTranscript on every remaining branch arm', () => {
    const callId = 'call-2' as never
    const events = [
      contextOnlyUser(),
      user('plain'),
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
      reasoningChunk(),
      toolCall(callId, 'bash', '{}'),
      toolResult('unknown-call', 'x'),
      { type: 'tool/result', seq: 6, time: 7, data: {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
        }),
        error: { name: 'x', code: 'E1' },
      }, surfaceOp: 'append' },
      commandRunWithArgs(),
      commandDoneEvent(''),
      planEvent(false),
      { type: 'turn/end', seq: 12, time: 13, data: {
        turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'E1' } },
      } },
    ] as unknown as SessionEvent[]
    expect(foldAll(events)).toEqual(foldTranscript(events))
  })

  it('keeps repeated provider call ids isolated across steps', () => {
    const events = [
      toolCall('bash:0', 'bash', '{"cmd":"first"}', 1, 1),
      toolCall('bash:0', 'bash', '{"cmd":"second"}', 1, 2),
      toolResult('bash:0', 'first result', 1, 1),
      toolResult('bash:0', 'second result', 1, 2),
    ]
    const expected = [
      {
        kind: 'tool', callId: 'bash:0', name: 'bash', args: '{"cmd":"first"}',
        status: 'done', result: 'first result',
      },
      {
        kind: 'tool', callId: 'bash:0', name: 'bash', args: '{"cmd":"second"}',
        status: 'done', result: 'second result',
      },
    ]
    expect(foldTranscript(events)).toEqual(expected)
    expect(foldAll(events)).toEqual(expected)
  })

  it('grows an open assistant block in place', () => {
    const fold = new TranscriptFold()
    fold.apply({
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1 },
    })
    fold.apply(chunk('a'))
    fold.apply(chunk('b'))
    expect(fold.blocks).toHaveLength(1)
    const block = fold.blocks[0]
    expect(block).toMatchObject({ kind: 'assistant', text: 'ab', streaming: true })
    fold.apply({
      type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(block).toMatchObject({ streaming: false })
  })

  it('closes an open assistant when a user message follows', () => {
    const fold = new TranscriptFold()
    fold.apply(chunk('partial'))
    fold.apply(user('then this'))
    expect(fold.blocks).toEqual([
      { kind: 'assistant', text: 'partial', streaming: false },
      { kind: 'user', text: 'then this' },
    ])
  })

  it('creates an assistant block from a full assistant message', () => {
    const fold = new TranscriptFold()
    fold.apply(assistant('complete answer'))
    expect(fold.blocks).toEqual([
      { kind: 'assistant', text: 'complete answer', streaming: false },
    ])
  })

  it('replaces a streamed assistant block when the settled message arrives', () => {
    const fold = new TranscriptFold()
    fold.apply(chunk('par'))
    fold.apply(assistant('full answer'))
    expect(fold.blocks).toEqual([
      { kind: 'assistant', text: 'full answer', streaming: false },
    ])
  })
})

function contextOnlyUser(): SessionEvent {
  return {
    type: 'user/message', seq: 0, time: 1,
    data: { content: [{ type: 'text', text: '<system-reminder> context only</system-reminder>' }] },
    surfaceOp: 'append',
  } as SessionEvent
}

function reasoningChunk(): SessionEvent {
  return {
    type: 'assistant/chunk', seq: 0, time: 1,
    data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } },
  }
}

function commandRunWithArgs(): SessionEvent {
  return {
    type: 'command/run', seq: 0, time: 1,
    data: { commandId: 'c2', name: 'plan', args: 'off', source: { kind: 'user' } },
  } as SessionEvent
}

function todoEvent(): SessionEvent {
  return {
    type: 'todo/write', seq: 0, time: 1,
    data: { todos: [{ content: 'a', status: 'pending' }] },
  }
}

function commandRunEvent(): SessionEvent {
  return {
    type: 'command/run', seq: 0, time: 1,
    data: { commandId: 'c1', name: 'compact', args: '', source: { kind: 'user' } },
  } as SessionEvent
}

function commandDoneEvent(text: string): SessionEvent {
  return {
    type: 'command/done', seq: 0, time: 1,
    data: { commandId: 'c1', kind: 'success', text },
  } as SessionEvent
}

function planEvent(active: boolean): SessionEvent {
  return { type: 'plan/mode', seq: 0, time: 1, data: { active } }
}

describe('foldTranscript', () => {
  it('folds an empty log to an empty transcript', () => {
    expect(foldTranscript([])).toEqual([])
  })

  it('folds user and assistant messages in order', () => {
    const blocks = foldTranscript([user('hello'), assistant('hi there')])
    expect(blocks).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'hi there', streaming: false },
    ])
  })

  it('accumulates streaming chunks into the open assistant block', () => {
    const blocks = foldTranscript([
      user('q'),
      chunk('Hel'),
      chunk('lo'),
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      assistant('Hello'),
    ])
    expect(blocks).toEqual([
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: 'Hello', streaming: false },
    ])
  })

  it('marks the assistant block streaming while a turn is open', () => {
    const blocks = foldTranscript([
      user('q'),
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      chunk('par'),
    ])
    expect(blocks).toEqual([
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: 'par', streaming: true },
    ])
  })

  it('folds tool calls and pairs results to their call', () => {
    const callId = 'call-1' as never
    const blocks = foldTranscript([
      toolCall(callId, 'bash', '{"cmd":"ls"}'),
      toolResult(callId, 'file.txt'),
    ])
    expect(blocks[0]).toMatchObject({ kind: 'tool', name: 'bash', args: '{"cmd":"ls"}', status: 'done' })
    expect(blocks[0]).toMatchObject({ result: 'file.txt' })
  })

  it('keeps a tool call running when no result arrives', () => {
    const blocks = foldTranscript([toolCall('call-2', 'fs', '{}')])
    expect(blocks[0]).toMatchObject({ kind: 'tool', status: 'running' })
    expect((blocks[0] as { result?: unknown }).result).toBeUndefined()
  })

  it('folds todo writes', () => {
    const blocks = foldTranscript([{
      type: 'todo/write', seq: 0, time: 1,
      data: { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }] },
    }])
    expect(blocks[0]).toEqual({
      kind: 'todo',
      items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }],
    })
  })

  it('folds command run and done events', () => {
    const blocks = foldTranscript([
      { type: 'command/run', seq: 0, time: 1, data: { commandId: 'c1', name: 'compact', args: '', source: { kind: 'user' } } } as SessionEvent,
      { type: 'command/done', seq: 1, time: 2, data: { commandId: 'c1', kind: 'success', text: 'done' } } as SessionEvent,
    ])
    expect(blocks).toEqual([
      { kind: 'system', text: '/ compact' },
      { kind: 'system', text: 'done' },
    ])
  })

  it('folds command run with arguments', () => {
    const blocks = foldTranscript([
      { type: 'command/run', seq: 0, time: 1, data: { commandId: 'c2', name: 'plan', args: 'off', source: { kind: 'user' } } } as SessionEvent,
    ])
    expect(blocks).toEqual([{ kind: 'system', text: '/ plan off' }])
  })

  it('folds plan mode changes', () => {
    const blocks = foldTranscript([
      { type: 'plan/mode', seq: 0, time: 1, data: { active: true } },
      { type: 'plan/mode', seq: 1, time: 2, data: { active: false } },
    ])
    expect(blocks).toEqual([
      { kind: 'system', text: 'plan mode: on' },
      { kind: 'system', text: 'plan mode: off' },
    ])
  })

  it('keeps session titles out of the conversation', () => {
    // Titles are a sidebar concern; the fold must not surface them as rows.
    const blocks = foldTranscript([
      { type: 'session/title', seq: 0, time: 1, data: { title: 'My session', messageSeqs: [], source: { kind: 'user' } } },
    ])
    expect(blocks).toEqual([])
  })

  it('folds turn-end errors', () => {
    const blocks = foldTranscript([
      { type: 'turn/end', seq: 0, time: 1, data: { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'E1' } } } },
    ])
    expect(blocks).toEqual([{ kind: 'system', text: 'error: E1: boom' }])
  })

  it('ignores unknown event types', () => {
    const blocks = foldTranscript([
      { type: 'session/end-seed', seq: 0, time: 1, data: {} },
    ])
    expect(blocks).toEqual([])
  })

  it('tolerates non-array message content', () => {
    const blocks = foldTranscript([
      { type: 'user/message', seq: 0, time: 1, data: { content: 'plain string' } as unknown, surfaceOp: 'append' } as SessionEvent,
    ])
    expect(blocks).toEqual([]) // no readable text, no user block
  })

  it('skips content blocks that are neither text nor tool-result', () => {
    const blocks = foldTranscript([
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'tool_use', id: 'x' }] } as unknown, surfaceOp: 'append' } as SessionEvent,
    ])
    expect(blocks).toEqual([])
  })

  it('separates injected instruction context from the user message', () => {
    const blocks = foldTranscript([
      { type: 'user/message', seq: 0, time: 1, data: {
        content: [
          { type: 'text', text: 'fix the build' },
          { type: 'text', text: '<system-reminder> Follow the workspace instructions.</system-reminder>' },
        ],
      }, surfaceOp: 'append' } as unknown as SessionEvent,
    ])
    expect(blocks).toEqual([
      { kind: 'user', text: 'fix the build' },
      { kind: 'context', text: '<system-reminder> Follow the workspace instructions.</system-reminder>' },
    ])
  })

  it('classifies plugin-sourced messages as context regardless of framing', () => {
    const event: SessionEvent<'user/message'> = {
      type: 'user/message', seq: 0, time: 1,
      data: createUserMessage({
        content: [{ type: 'text', text: 'Current runtime context. Some snapshot.' }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
      }),
      surfaceOp: 'append',
    }
    expect(foldTranscript([event])).toEqual([
      { kind: 'context', text: 'Current runtime context. Some snapshot.' },
    ])
    const fold = new TranscriptFold()
    fold.apply(event)
    expect(fold.blocks).toEqual([
      { kind: 'context', text: 'Current runtime context. Some snapshot.' },
    ])
  })

  it('splits context nested inside a tool-result block', () => {
    const blocks = foldTranscript([
      { type: 'user/message', seq: 0, time: 1, data: {
        content: [
          { type: 'tool-result', content: [
            { type: 'text', text: 'nested text' },
            { type: 'text', text: '<system-reminder> nested reminder</system-reminder>' },
          ] },
        ],
      }, surfaceOp: 'append' } as unknown as SessionEvent,
    ])
    expect(blocks).toEqual([
      { kind: 'user', text: 'nested text' },
      { kind: 'context', text: '<system-reminder> nested reminder</system-reminder>' },
    ])
  })

  it('tolerates non-array assistant message content', () => {
    const blocks = foldTranscript([
      { type: 'assistant/message', seq: 0, time: 1, data: {
        turn: 1, step: 1,
        message: { content: 'plain string' },
      }, surfaceOp: 'append' } as unknown as SessionEvent,
    ])
    expect(blocks).toEqual([{ kind: 'assistant', text: '', streaming: false }])
  })

  it('skips non-text blocks inside a tool result', () => {
    const callId = 'call-odd' as never
    const blocks = foldTranscript([
      toolCall(callId, 'bash', '{}'),
      { type: 'tool/result', seq: 1, time: 2, data: {
        turn: 1, step: 1,
        message: { source: { callId }, content: [{ type: 'tool_use', id: 'x' }] },
      }, surfaceOp: 'append' } as unknown as SessionEvent,
    ])
    expect(blocks[0]).toMatchObject({ status: 'done', result: '' })
  })

  it('closes an open assistant block when a user message follows', () => {
    const blocks = foldTranscript([chunk('hi'), user('q')])
    expect(blocks).toEqual([
      { kind: 'assistant', text: 'hi', streaming: false },
      { kind: 'user', text: 'q' },
    ])
  })

  it('tracks open turns by sequence past the log tail', () => {
    // The assistant/message declares seq 3 while the array only holds three
    // events, so the streaming scan walks past the tail (undefined events)
    // and still resolves the turn/start + turn/end pair to a closed block.
    const blocks = foldTranscript([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'a' }], source: { provider: 'p', model: 'm' } }) }, surfaceOp: 'append' },
    ])
    expect(blocks).toEqual([{ kind: 'assistant', text: 'a', streaming: false }])
  })

  it('ignores non-text chunk deltas', () => {
    const blocks = foldTranscript([
      { type: 'assistant/chunk', seq: 0, time: 1, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } as unknown } } as SessionEvent,
    ])
    expect(blocks).toEqual([])
  })

  it('ignores a tool result for an unknown call', () => {
    const blocks = foldTranscript([toolResult('ghost-call', 'x')])
    expect(blocks).toEqual([])
  })

  it('records an error on a tool result', () => {
    const callId = 'call-err' as never
    const blocks = foldTranscript([
      toolCall(callId, 'bash', '{}'),
      { type: 'tool/result', seq: 1, time: 2, data: { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'boom' }], isError: true }), error: { name: 'x', code: 'y' } }, surfaceOp: 'append' },
    ])
    expect(blocks[0]).toMatchObject({ status: 'done', result: 'boom', error: { name: 'x', code: 'y' } })
  })

  it('skips command done rows with empty text', () => {
    const blocks = foldTranscript([
      { type: 'command/run', seq: 0, time: 1, data: { commandId: 'c1', name: 'compact', args: '', source: { kind: 'user' } } } as SessionEvent,
      { type: 'command/done', seq: 1, time: 2, data: { commandId: 'c1', kind: 'success', text: '' } } as SessionEvent,
    ])
    expect(blocks).toEqual([{ kind: 'system', text: '/ compact' }])
  })
})
