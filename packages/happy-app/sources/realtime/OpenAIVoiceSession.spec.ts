import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsDefaults, type Settings } from '@/sync/settings';
import type { AudioCapture, AudioIO, AudioPlayback, CapturedUtterance } from './audio/types';
import type { ChatCompletionResult, ChatMessage, ChatToolCall } from './openaiVoiceClient';

const settings: Settings = {
    ...settingsDefaults,
    voiceBackend: 'openai-compatible',
    voiceApiBaseUrl: 'https://voice.example.com',
    voiceApiKey: 'sk-test',
    voiceSttModel: 'stt-1',
    voiceLlmModel: 'llm-1',
    voiceTtsModel: 'tts-1',
    voiceTtsVoice: 'voice-1',
};

const storageState = {
    settings,
    setRealtimeStatus: vi.fn(),
    setRealtimeMode: vi.fn(),
    clearRealtimeModeDebounce: vi.fn(),
};

vi.mock('@/sync/storage', () => ({
    storage: { getState: () => storageState },
}));

const sendMessageToSession = vi.fn(async () => 'sent');
const processPermissionRequest = vi.fn(async () => 'allowed');

vi.mock('./realtimeClientTools', () => ({
    realtimeClientTools: {
        get sendMessageToSession() { return sendMessageToSession; },
        get processPermissionRequest() { return processPermissionRequest; },
    },
}));

const transcribe = vi.fn();
const synthesize = vi.fn();
const streamChatCompletion = vi.fn();

/**
 * The session owns one message array and keeps appending to it, so a recorded
 * mock argument would reflect the end of the conversation rather than the
 * request. Each prompt is snapshotted at call time instead.
 */
const prompts: ChatMessage[][] = [];

vi.mock('./openaiVoiceClient', () => ({
    transcribe: (...args: unknown[]) => transcribe(...args),
    synthesize: (...args: unknown[]) => synthesize(...args),
    streamChatCompletion: (...args: unknown[]) => {
        prompts.push((args[1] as ChatMessage[]).map((message) => ({ ...message })));
        return streamChatCompletion(...args) as Promise<ChatCompletionResult>;
    },
}));

const { OpenAIVoiceSession } = await import('./OpenAIVoiceSession');

function toolCall(name: string, args: Record<string, unknown>, id = `call_${name}`): ChatToolCall {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/**
 * Capture that yields one scripted utterance per turn and then blocks until
 * the session aborts, which is how a real microphone behaves when nobody is
 * talking.
 */
class ScriptedCapture implements AudioCapture {
    readonly calls: number[] = [];

    constructor(private readonly utterances: (CapturedUtterance | null)[]) { }

    record(options: { signal: AbortSignal }): Promise<CapturedUtterance | null> {
        this.calls.push(Date.now());
        const next = this.utterances.shift();
        if (next !== undefined) {
            return Promise.resolve(next);
        }
        return new Promise((resolve) => {
            if (options.signal.aborted) {
                resolve(null);
                return;
            }
            options.signal.addEventListener('abort', () => resolve(null));
        });
    }

    stop(): void { }
    dispose(): void { }
}

class RecordingPlayback implements AudioPlayback {
    readonly format = 'mp3';
    readonly played: ArrayBuffer[] = [];

    async play(audio: ArrayBuffer): Promise<void> {
        this.played.push(audio);
    }

    stop(): void { }
    dispose(): void { }
}

function utterance(): CapturedUtterance {
    return {
        part: { kind: 'blob', blob: new Blob(['x']), filename: 'utterance.webm' },
        durationMs: 1000,
    };
}

function audioIO(capture: AudioCapture, playback: AudioPlayback): AudioIO {
    return { createCapture: () => capture, createPlayback: () => playback };
}

/** Lets the session's microtask-driven turn loop advance before asserting. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    vi.clearAllMocks();
    prompts.length = 0;
    synthesize.mockResolvedValue(new ArrayBuffer(8));
    streamChatCompletion.mockResolvedValue({ content: '', toolCalls: [] });
});

describe('OpenAIVoiceSession', () => {
    it('refuses to start when the backend is not configured', async () => {
        storageState.settings = settingsDefaults;
        const session = new OpenAIVoiceSession(audioIO(new ScriptedCapture([]), new RecordingPlayback()));

        await expect(session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'p' })).rejects.toThrow();

        storageState.settings = settings;
    });

    it('speaks the first message before listening', async () => {
        const capture = new ScriptedCapture([]);
        const playback = new RecordingPlayback();
        const session = new OpenAIVoiceSession(audioIO(capture, playback));

        await session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'p', firstMessage: 'Hi there' });
        await settle();

        expect(synthesize).toHaveBeenCalledWith(expect.anything(), 'Hi there', expect.objectContaining({ format: 'mp3' }));
        expect(playback.played).toHaveLength(1);

        await session.endSession();
    });

    it('transcribes an utterance, completes, and speaks the reply', async () => {
        transcribe.mockResolvedValueOnce({ text: 'what is the status' });
        streamChatCompletion.mockResolvedValueOnce({ content: 'All green.', toolCalls: [] });

        const capture = new ScriptedCapture([utterance()]);
        const playback = new RecordingPlayback();
        const session = new OpenAIVoiceSession(audioIO(capture, playback));

        await session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'system text' });
        await settle();

        const messages = prompts[0];
        expect(messages[0]).toEqual({ role: 'system', content: 'system text' });
        expect(messages[1]).toEqual({ role: 'user', content: 'what is the status' });
        expect(synthesize).toHaveBeenCalledWith(expect.anything(), 'All green.', expect.anything());

        await session.endSession();
    });

    it('drops an empty transcription without calling the model', async () => {
        transcribe.mockResolvedValueOnce({ text: '   ' });

        const session = new OpenAIVoiceSession(audioIO(new ScriptedCapture([utterance()]), new RecordingPlayback()));

        await session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'p' });
        await settle();

        expect(streamChatCompletion).not.toHaveBeenCalled();

        await session.endSession();
    });

    it('dispatches a tool call and feeds the result back to the model', async () => {
        transcribe.mockResolvedValueOnce({ text: 'tell session one to build' });
        streamChatCompletion
            .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('sendMessageToSession', { sessionId: 's1', message: 'build' })] })
            .mockResolvedValueOnce({ content: 'Sent.', toolCalls: [] });

        const session = new OpenAIVoiceSession(audioIO(new ScriptedCapture([utterance()]), new RecordingPlayback()));

        await session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'p' });
        await settle();

        expect(sendMessageToSession).toHaveBeenCalledWith({ sessionId: 's1', message: 'build' });

        const followUp = prompts[1];
        expect(followUp[followUp.length - 1]).toEqual({
            role: 'tool',
            tool_call_id: 'call_sendMessageToSession',
            content: 'sent',
        });

        await session.endSession();
    });

    it('reports malformed tool arguments to the model instead of throwing', async () => {
        transcribe.mockResolvedValueOnce({ text: 'do it' });
        streamChatCompletion
            .mockResolvedValueOnce({
                content: '',
                toolCalls: [{ id: 'c1', type: 'function', function: { name: 'sendMessageToSession', arguments: '{"sessionId":' } }],
            })
            .mockResolvedValueOnce({ content: 'Sorry.', toolCalls: [] });

        const session = new OpenAIVoiceSession(audioIO(new ScriptedCapture([utterance()]), new RecordingPlayback()));

        await session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'p' });
        await settle();

        expect(sendMessageToSession).not.toHaveBeenCalled();

        const followUp = prompts[1];
        expect(followUp[followUp.length - 1]).toMatchObject({ role: 'tool', content: 'error (invalid parameters)' });

        await session.endSession();
    });

    it('says nothing and does not continue when the model calls skip_turn', async () => {
        transcribe.mockResolvedValueOnce({ text: 'no I was talking to someone else' });
        streamChatCompletion.mockResolvedValueOnce({ content: 'Sure thing!', toolCalls: [toolCall('skip_turn', {})] });

        const playback = new RecordingPlayback();
        const session = new OpenAIVoiceSession(audioIO(new ScriptedCapture([utterance()]), playback));

        await session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'p' });
        await settle();

        expect(playback.played).toHaveLength(0);
        expect(streamChatCompletion).toHaveBeenCalledTimes(1);

        await session.endSession();
    });

    it('answers a text message without waiting for the microphone', async () => {
        streamChatCompletion.mockResolvedValue({ content: 'Acknowledged.', toolCalls: [] });

        const playback = new RecordingPlayback();
        const session = new OpenAIVoiceSession(audioIO(new ScriptedCapture([]), playback));

        await session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'p' });
        await settle();

        session.sendTextMessage('Permission requested');
        await settle();

        expect(transcribe).not.toHaveBeenCalled();
        const messages = prompts[0];
        expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'Permission requested' });

        await session.endSession();
    });

    it('does not interrupt the microphone for a contextual update', async () => {
        const session = new OpenAIVoiceSession(audioIO(new ScriptedCapture([]), new RecordingPlayback()));

        await session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'p' });
        await settle();

        session.sendContextualUpdate('a session went idle');
        await settle();

        expect(streamChatCompletion).not.toHaveBeenCalled();

        await session.endSession();
    });

    it('folds a pending contextual update into the next turn', async () => {
        transcribe.mockResolvedValueOnce({ text: 'what happened' });
        streamChatCompletion.mockResolvedValue({ content: 'Nothing.', toolCalls: [] });

        const session = new OpenAIVoiceSession(audioIO(new ScriptedCapture([utterance()]), new RecordingPlayback()));

        await session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'p' });
        session.sendContextualUpdate('a session went idle');
        await settle();

        const messages = prompts[0];
        expect(messages.map((message) => message.content)).toContain('a session went idle');

        await session.endSession();
    });

    it('clears realtime state on endSession', async () => {
        const session = new OpenAIVoiceSession(audioIO(new ScriptedCapture([]), new RecordingPlayback()));

        await session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'p' });
        await settle();
        await session.endSession();

        expect(storageState.setRealtimeStatus).toHaveBeenLastCalledWith('disconnected');
        expect(storageState.setRealtimeMode).toHaveBeenLastCalledWith('idle', true);
        expect(storageState.clearRealtimeModeDebounce).toHaveBeenCalled();
    });

    it('stops looping after endSession', async () => {
        const capture = new ScriptedCapture([]);
        const session = new OpenAIVoiceSession(audioIO(capture, new RecordingPlayback()));

        await session.startSession({ sessionId: 's', initialContext: '', systemPrompt: 'p' });
        await settle();
        await session.endSession();

        const callsAtEnd = capture.calls.length;
        await settle();

        expect(capture.calls.length).toBe(callsAtEnd);
    });
});
