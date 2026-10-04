import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { resolveOpenAIVoiceConfig, type OpenAIVoiceConfig } from './openaiVoiceConfig';
import {
    streamChatCompletion,
    synthesize,
    transcribe,
    type ChatMessage,
    type ChatTool,
    type ChatToolCall,
} from './openaiVoiceClient';
import type { AudioCapture, AudioIO, AudioPlayback } from './audio/types';
import type { VoiceSession, VoiceSessionConfig } from './types';

/**
 * The agent loop ElevenLabs runs on their servers, running in the app instead.
 *
 * One turn is: listen, transcribe, complete, speak, dispatch tool calls. The
 * turn is abortable at every await, which is what makes barge-in and
 * endSession immediate rather than "after the current request finishes".
 */

const SKIP_TURN_TOOL = 'skip_turn';

/**
 * Tools declared to the model.
 *
 * The two client tools mirror `realtimeClientTools`, under the same names, so
 * the existing dispatch table and session routing work unchanged.
 *
 * `skip_turn` is here because VOICE_SYSTEM_PROMPT_BASE instructs the model to
 * call it when the user is talking to someone else in the room. On the
 * ElevenLabs platform that tool is supplied by them. Nothing supplies it here,
 * so without this declaration the system prompt would be describing a tool
 * that does not exist.
 */
const CHAT_TOOLS: ChatTool[] = [
    {
        type: 'function',
        function: {
            name: 'sendMessageToSession',
            description: 'Send a message to a coding session. Use the session id from the session directory in the conversation context.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Id of the session to send to' },
                    message: { type: 'string', description: 'Message for the coding agent' },
                },
                required: ['sessionId', 'message'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'processPermissionRequest',
            description: 'Allow or deny a pending tool permission request from a coding session.',
            parameters: {
                type: 'object',
                properties: {
                    requestId: { type: 'string', description: 'Id of the permission request' },
                    decision: { type: 'string', enum: ['allow', 'deny'] },
                },
                required: ['requestId', 'decision'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: SKIP_TURN_TOOL,
            description: 'Say nothing this turn. Call this when the user was not addressing you.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

function isAbort(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.message === 'aborted');
}

export class OpenAIVoiceSession implements VoiceSession {
    private readonly audio: AudioIO;
    private capture: AudioCapture | null = null;
    private playback: AudioPlayback | null = null;

    private config: OpenAIVoiceConfig | null = null;
    private messages: ChatMessage[] = [];
    private loop: Promise<void> | null = null;
    private sessionAbort: AbortController | null = null;
    private turnAbort: AbortController | null = null;
    private conversationId: string | null = null;

    /**
     * Context that arrived while a turn was in flight. Appending to
     * `this.messages` mid-turn would mutate the array the completion request
     * was built from, so it is staged and folded in at the turn boundary.
     */
    private pendingContext: string[] = [];

    constructor(audio: AudioIO) {
        this.audio = audio;
    }

    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        const resolved = resolveOpenAIVoiceConfig(storage.getState().settings);
        if (!resolved) {
            throw new Error('OpenAI-compatible voice backend is not configured');
        }

        await this.endSession();

        this.config = resolved;
        this.conversationId = `local_${Date.now().toString(36)}`;
        this.messages = [{ role: 'system', content: config.systemPrompt ?? '' }];
        this.pendingContext = [];
        this.sessionAbort = new AbortController();
        this.capture = this.audio.createCapture();
        this.playback = this.audio.createPlayback();

        storage.getState().setRealtimeStatus('connected');
        storage.getState().setRealtimeMode('idle');

        this.loop = this.run(config.firstMessage).catch((error) => {
            if (!isAbort(error)) {
                console.error('[OpenAIVoice] Session loop failed:', error);
                storage.getState().setRealtimeStatus('error');
            }
        });

        return this.conversationId;
    }

    async endSession(): Promise<void> {
        this.turnAbort?.abort();
        this.sessionAbort?.abort();
        this.capture?.stop();
        this.playback?.stop();

        const loop = this.loop;
        this.loop = null;
        if (loop) {
            await loop.catch(() => {
                // The loop's own failures are reported where they happen.
            });
        }

        this.capture?.dispose();
        this.playback?.dispose();
        this.capture = null;
        this.playback = null;
        this.sessionAbort = null;
        this.turnAbort = null;
        this.conversationId = null;

        storage.getState().setRealtimeStatus('disconnected');
        storage.getState().setRealtimeMode('idle', true);
        storage.getState().clearRealtimeModeDebounce();
    }

    /**
     * Text that should produce a spoken reply. Interrupts whatever the turn is
     * doing, because the caller decided this is worth saying now.
     */
    sendTextMessage(message: string): void {
        if (!this.config) {
            return;
        }
        this.pendingContext.push(message);
        this.turnAbort?.abort();
    }

    /**
     * Silent context. Never interrupts: injecting background state is not a
     * reason to stop the user mid-sentence.
     */
    sendContextualUpdate(update: string): void {
        if (!this.config) {
            return;
        }
        this.pendingContext.push(update);
    }

    private drainPendingContext(): void {
        if (this.pendingContext.length === 0) {
            return;
        }
        const batched = this.pendingContext.join('\n\n');
        this.pendingContext = [];
        this.messages.push({ role: 'user', content: batched });
    }

    private async run(firstMessage?: string): Promise<void> {
        if (firstMessage) {
            await this.speak(firstMessage);
        }

        while (this.sessionAbort && !this.sessionAbort.signal.aborted) {
            this.turnAbort = new AbortController();
            const signal = this.turnAbort.signal;
            const onSessionAbort = () => this.turnAbort?.abort();
            this.sessionAbort.signal.addEventListener('abort', onSessionAbort);

            try {
                await this.runTurn(signal);
            } catch (error) {
                if (!isAbort(error)) {
                    throw error;
                }
            } finally {
                this.sessionAbort?.signal.removeEventListener('abort', onSessionAbort);
            }
        }
    }

    private async runTurn(signal: AbortSignal): Promise<void> {
        const config = this.config;
        const capture = this.capture;
        if (!config || !capture) {
            return;
        }

        this.drainPendingContext();

        // A queued message means the caller already decided there is something
        // to say; skip listening and answer it.
        const hasQueuedTurn = this.messages[this.messages.length - 1]?.role === 'user';

        if (!hasQueuedTurn) {
            storage.getState().setRealtimeMode('idle');
            const utterance = await capture.record({
                signal,
                onSpeakingChange: (speaking) => {
                    storage.getState().setRealtimeMode(speaking ? 'user-speaking' : 'idle', speaking);
                },
            });
            storage.getState().setRealtimeMode('idle', true);

            if (signal.aborted || !utterance) {
                return;
            }

            const transcription = await transcribe(config, utterance.part, {
                language: storage.getState().settings.voiceAssistantLanguage,
                signal,
            });

            const text = transcription.text.trim();
            if (!text) {
                return;
            }

            this.drainPendingContext();
            this.messages.push({ role: 'user', content: text });
        }

        await this.complete(signal);
    }

    private async complete(signal: AbortSignal): Promise<void> {
        const config = this.config;
        if (!config) {
            return;
        }

        const completion = await streamChatCompletion(config, this.messages, {
            tools: CHAT_TOOLS,
            signal,
        });

        this.messages.push({
            role: 'assistant',
            content: completion.content,
            ...(completion.toolCalls.length > 0 ? { tool_calls: completion.toolCalls } : {}),
        });

        const skipped = completion.toolCalls.some((call) => call.function.name === SKIP_TURN_TOOL);

        if (completion.content.trim() && !skipped) {
            await this.speak(completion.content);
        }

        if (completion.toolCalls.length === 0) {
            return;
        }

        for (const call of completion.toolCalls) {
            const result = await this.dispatchToolCall(call);
            this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }

        if (signal.aborted || skipped) {
            return;
        }

        // Tool results are only useful if the model gets to speak about them.
        await this.complete(signal);
    }

    private async dispatchToolCall(call: ChatToolCall): Promise<string> {
        if (call.function.name === SKIP_TURN_TOOL) {
            return 'skipped';
        }

        const tool = (realtimeClientTools as Record<string, undefined | ((args: unknown) => Promise<string>)>)[call.function.name];
        if (!tool) {
            return `error (unknown tool ${call.function.name})`;
        }

        let args: unknown;
        try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
            return 'error (invalid parameters)';
        }

        try {
            return await tool(args);
        } catch (error) {
            console.error('[OpenAIVoice] Tool call failed:', call.function.name, error);
            return 'error (tool failed)';
        }
    }

    private async speak(text: string): Promise<void> {
        const config = this.config;
        const playback = this.playback;
        const signal = this.turnAbort?.signal ?? this.sessionAbort?.signal;
        if (!config || !playback || !signal) {
            return;
        }

        storage.getState().setRealtimeMode('agent-speaking');
        try {
            const audio = await synthesize(config, text, { format: playback.format, signal });
            if (signal.aborted) {
                return;
            }
            await playback.play(audio, { signal });
        } finally {
            storage.getState().setRealtimeMode('idle');
        }
    }
}
