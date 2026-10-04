import type { OpenAIVoiceConfig } from './openaiVoiceConfig';
import type { AudioPart } from './audio/types';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ChatToolCall[];
    tool_call_id?: string;
}

export interface ChatToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ChatTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface ChatCompletionResult {
    content: string;
    toolCalls: ChatToolCall[];
}

export interface TranscriptionResult {
    text: string;
}

interface ToolCallAccumulator {
    id: string;
    name: string;
    arguments: string;
}

function authHeaders(config: OpenAIVoiceConfig): Record<string, string> {
    return { Authorization: `Bearer ${config.apiKey}` };
}

async function failure(response: Response, what: string): Promise<Error> {
    let detail = '';
    try {
        detail = (await response.text()).slice(0, 200);
    } catch {
        // The body is a nicety; the status is what matters.
    }
    return new Error(`${what} failed: ${response.status}${detail ? ` ${detail}` : ''}`);
}

/**
 * POST /v1/audio/transcriptions — multipart, as OpenAI defines it.
 *
 * The part carries its own filename because servers dispatch on the extension
 * as often as on the MIME type.
 */
export async function transcribe(
    config: OpenAIVoiceConfig,
    audio: AudioPart,
    options: { language?: string | null; signal?: AbortSignal },
): Promise<TranscriptionResult> {
    const form = new FormData();
    if (audio.kind === 'blob') {
        form.append('file', audio.blob as any, audio.filename);
    } else {
        form.append('file', {
            uri: audio.uri,
            name: audio.filename,
            type: audio.mimeType,
        } as any);
    }
    form.append('model', config.sttModel);
    if (options.language) {
        form.append('language', options.language);
    }

    const response = await fetch(`${config.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: authHeaders(config),
        body: form,
        signal: options.signal,
    });

    if (!response.ok) {
        throw await failure(response, 'Transcription');
    }

    const data = await response.json() as { text?: unknown };
    return { text: typeof data.text === 'string' ? data.text : '' };
}

/**
 * POST /v1/audio/speech — returns the whole clip. Servers that support
 * incremental synthesis do so over transports that are not standardized, so
 * this waits for the full body and plays it in one piece.
 */
export async function synthesize(
    config: OpenAIVoiceConfig,
    text: string,
    options: { format: string; signal?: AbortSignal },
): Promise<ArrayBuffer> {
    const response = await fetch(`${config.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: config.ttsModel,
            input: text,
            voice: config.ttsVoice,
            response_format: options.format,
        }),
        signal: options.signal,
    });

    if (!response.ok) {
        throw await failure(response, 'Speech synthesis');
    }

    return response.arrayBuffer();
}

/**
 * Folds one SSE delta into the accumulating completion.
 *
 * Tool calls arrive split across deltas and are addressed by `index`, not by
 * id — the id itself shows up in one delta and is absent from the rest, and
 * the arguments string is streamed a fragment at a time. Exported for tests,
 * which is the only way to exercise fragment reassembly without a server.
 */
export function applyCompletionDelta(
    state: { content: string; toolCalls: Map<number, ToolCallAccumulator> },
    delta: any,
): void {
    if (typeof delta?.content === 'string') {
        state.content += delta.content;
    }

    if (!Array.isArray(delta?.tool_calls)) {
        return;
    }

    for (const call of delta.tool_calls) {
        const index = typeof call?.index === 'number' ? call.index : 0;
        const existing = state.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof call?.id === 'string' && call.id) {
            existing.id = call.id;
        }
        if (typeof call?.function?.name === 'string' && call.function.name) {
            existing.name = call.function.name;
        }
        if (typeof call?.function?.arguments === 'string') {
            existing.arguments += call.function.arguments;
        }
        state.toolCalls.set(index, existing);
    }
}

/**
 * Splits a growing SSE buffer into complete events, returning the unconsumed
 * tail. Chunk boundaries fall anywhere, including mid-event, so a partial
 * trailing event must survive to the next read.
 */
export function splitSSEEvents(buffer: string): { events: string[]; rest: string } {
    const parts = buffer.split('\n\n');
    const rest = parts.pop() ?? '';
    return { events: parts, rest };
}

function parseSSEEvent(event: string): any | null {
    for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) {
            continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
            return null;
        }
        try {
            return JSON.parse(payload);
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * POST /v1/chat/completions with `stream: true`.
 *
 * `onContentDelta` fires as text arrives so a caller can start speaking before
 * the completion finishes.
 */
export async function streamChatCompletion(
    config: OpenAIVoiceConfig,
    messages: ChatMessage[],
    options: {
        tools: ChatTool[];
        signal?: AbortSignal;
        onContentDelta?: (delta: string) => void;
    },
): Promise<ChatCompletionResult> {
    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: config.llmModel,
            messages,
            tools: options.tools,
            tool_choice: 'auto',
            stream: true,
        }),
        signal: options.signal,
    });

    if (!response.ok) {
        throw await failure(response, 'Chat completion');
    }

    const state = { content: '', toolCalls: new Map<number, ToolCallAccumulator>() };
    const body = response.body;

    if (!body) {
        // No streaming body available: fall back to the whole payload. Some
        // runtimes expose only text().
        const text = await response.text();
        let buffer = text;
        const { events } = splitSSEEvents(buffer + '\n\n');
        for (const event of events) {
            const parsed = parseSSEEvent(event);
            if (parsed?.choices?.[0]?.delta) {
                const before = state.content.length;
                applyCompletionDelta(state, parsed.choices[0].delta);
                if (state.content.length > before) {
                    options.onContentDelta?.(state.content.slice(before));
                }
            }
        }
    } else {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const { events, rest } = splitSSEEvents(buffer);
            buffer = rest;
            for (const event of events) {
                const parsed = parseSSEEvent(event);
                if (!parsed?.choices?.[0]?.delta) {
                    continue;
                }
                const before = state.content.length;
                applyCompletionDelta(state, parsed.choices[0].delta);
                if (state.content.length > before) {
                    options.onContentDelta?.(state.content.slice(before));
                }
            }
        }
    }

    const toolCalls: ChatToolCall[] = [...state.toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, call]) => ({
            id: call.id || `call_${index}`,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
        }))
        .filter((call) => call.function.name);

    return { content: state.content, toolCalls };
}
