import { describe, expect, it } from 'vitest';
import { applyCompletionDelta, splitSSEEvents, stripReasoning, type CompletionAccumulator } from './openaiVoiceClient';

function emptyState(): CompletionAccumulator {
    return { content: '', toolCalls: new Map<number, { id: string; name: string; arguments: string }>() };
}

describe('applyCompletionDelta', () => {
    it('concatenates content fragments', () => {
        const state = emptyState();
        applyCompletionDelta(state, { content: 'Hel' });
        applyCompletionDelta(state, { content: 'lo' });

        expect(state.content).toBe('Hello');
    });

    it('excludes reasoning from the accumulated content', () => {
        const state = emptyState();
        applyCompletionDelta(state, { content: '<think>scratch' });
        applyCompletionDelta(state, { content: 'pad</think>Hello' });

        expect(state.content).toBe('Hello');
    });

    it('ignores a delta carrying neither content nor tool calls', () => {
        const state = emptyState();
        applyCompletionDelta(state, { role: 'assistant' });

        expect(state.content).toBe('');
        expect(state.toolCalls.size).toBe(0);
    });

    it('reassembles an argument string split across deltas', () => {
        const state = emptyState();
        applyCompletionDelta(state, { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'sendMessageToSession', arguments: '{"sessionId"' } }] });
        applyCompletionDelta(state, { tool_calls: [{ index: 0, function: { arguments: ':"s1","message"' } }] });
        applyCompletionDelta(state, { tool_calls: [{ index: 0, function: { arguments: ':"hi"}' } }] });

        const call = state.toolCalls.get(0)!;
        expect(call.id).toBe('call_a');
        expect(call.name).toBe('sendMessageToSession');
        expect(JSON.parse(call.arguments)).toEqual({ sessionId: 's1', message: 'hi' });
    });

    it('keeps the id from the one delta that carried it', () => {
        const state = emptyState();
        applyCompletionDelta(state, { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'skip_turn', arguments: '' } }] });
        applyCompletionDelta(state, { tool_calls: [{ index: 0, function: { arguments: '{}' } }] });

        expect(state.toolCalls.get(0)!.id).toBe('call_a');
    });

    it('keeps interleaved calls apart by index', () => {
        const state = emptyState();
        applyCompletionDelta(state, { tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{"x"' } }] });
        applyCompletionDelta(state, { tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{"y"' } }] });
        applyCompletionDelta(state, { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] });
        applyCompletionDelta(state, { tool_calls: [{ index: 1, function: { arguments: ':2}' } }] });

        expect(state.toolCalls.get(0)).toEqual({ id: 'a', name: 'first', arguments: '{"x":1}' });
        expect(state.toolCalls.get(1)).toEqual({ id: 'b', name: 'second', arguments: '{"y":2}' });
    });

    it('defaults a missing index to 0', () => {
        const state = emptyState();
        applyCompletionDelta(state, { tool_calls: [{ id: 'a', function: { name: 'only', arguments: '{}' } }] });

        expect(state.toolCalls.get(0)!.name).toBe('only');
    });
});

describe('stripReasoning', () => {
    it('passes plain text through unchanged', () => {
        const state = emptyState();

        expect(stripReasoning(state, 'All green.')).toBe('All green.');
    });

    it('drops a reasoning block that opens and closes in one chunk', () => {
        const state = emptyState();

        expect(stripReasoning(state, '<think>weighing options</think>All green.')).toBe('All green.');
    });

    it('stays inside a block until the closing tag arrives', () => {
        const state = emptyState();

        expect(stripReasoning(state, '<think>still')).toBe('');
        expect(stripReasoning(state, ' deciding')).toBe('');
        expect(stripReasoning(state, '</think>Done.')).toBe('Done.');
    });

    it('holds a tag split across chunks instead of emitting it', () => {
        const state = emptyState();

        expect(stripReasoning(state, 'ready <thi')).toBe('ready ');
        expect(stripReasoning(state, 'nk>hidden</think>visible')).toBe('visible');
    });

    it('does not hold text that only looks like the start of a tag', () => {
        const state = emptyState();

        expect(stripReasoning(state, 'a < b')).toBe('a < b');
    });

    it('keeps text after a block that reopens later', () => {
        const state = emptyState();

        expect(stripReasoning(state, '<think>one</think>mid<think>two</think>end')).toBe('midend');
    });
});

describe('splitSSEEvents', () => {
    it('returns the whole buffer as a remainder when no event is complete', () => {
        expect(splitSSEEvents('data: {"a"')).toEqual({ events: [], rest: 'data: {"a"' });
    });

    it('splits complete events and keeps the partial tail', () => {
        const { events, rest } = splitSSEEvents('data: one\n\ndata: two\n\ndata: thr');

        expect(events).toEqual(['data: one', 'data: two']);
        expect(rest).toBe('data: thr');
    });

    it('reassembles an event split across two chunks', () => {
        const first = splitSSEEvents('data: {"content":"he');
        const second = splitSSEEvents(first.rest + 'llo"}\n\n');

        expect(first.events).toEqual([]);
        expect(second.events).toEqual(['data: {"content":"hello"}']);
        expect(second.rest).toBe('');
    });
});
