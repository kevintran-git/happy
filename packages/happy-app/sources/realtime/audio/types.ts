/**
 * Platform-independent audio surface the OpenAI-compatible voice session
 * builds on. Native and web implement these separately; nothing above this
 * file knows which one is loaded.
 */

/**
 * A multipart file part. Web produces a Blob; React Native's FormData takes
 * a file descriptor and reads the file itself, which keeps a whole recording
 * out of JS memory.
 */
export type AudioPart =
    | { kind: 'blob'; blob: Blob; filename: string }
    | { kind: 'file'; uri: string; filename: string; mimeType: string };

export interface CapturedUtterance {
    part: AudioPart;
    /** Duration in milliseconds, for callers that drop fragments too short to be speech. */
    durationMs: number;
}

export interface AudioCapture {
    /**
     * Records until the utterance ends, `stop()` is called, or `signal`
     * aborts. Resolves with null when nothing usable was captured.
     */
    record(options: { signal: AbortSignal; onSpeakingChange?: (speaking: boolean) => void }): Promise<CapturedUtterance | null>;
    stop(): void;
    dispose(): void;
}

export interface AudioPlayback {
    /** Plays one encoded clip to completion, or until `signal` aborts. */
    play(audio: ArrayBuffer, options: { signal: AbortSignal }): Promise<void>;
    stop(): void;
    dispose(): void;
    /** Container the backend should synthesize into for this platform. */
    readonly format: string;
}

export interface AudioIO {
    createCapture(): AudioCapture;
    createPlayback(): AudioPlayback;
}
