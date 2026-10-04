import { describe, expect, it } from 'vitest';
import { applyCompletionDelta, splitSSEEvents } from './openaiVoiceClient';

function emptyState() {
    return { content: '', toolCalls: new Map<number, { id: string; name: string; arguments: string }>() };
}

describe('applyCompletionDelta', () => {
    it('concatenates content fragments', () => {
        const state = emptyState();
        applyCompletionDelta(state, { content: 'Hel' });
        applyCompletionDelta(state, { content: 'lo' });

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
