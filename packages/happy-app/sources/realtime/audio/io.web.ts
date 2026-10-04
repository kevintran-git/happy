import { createVadState, pushVadFrame } from '../vad';
import type { AudioCapture, AudioIO, AudioPlayback, CapturedUtterance } from './types';

const ANALYSER_FFT_SIZE = 1024;
const VAD_POLL_MS = 50;

function pickMimeType(): { mimeType: string | undefined; extension: string } {
    const candidates = [
        { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
        { mimeType: 'audio/webm', extension: 'webm' },
        { mimeType: 'audio/mp4', extension: 'mp4' },
        { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
    ];
    for (const candidate of candidates) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate.mimeType)) {
            return candidate;
        }
    }
    return { mimeType: undefined, extension: 'webm' };
}

class WebAudioCapture implements AudioCapture {
    private stream: MediaStream | null = null;
    private context: AudioContext | null = null;
    private recorder: MediaRecorder | null = null;
    private stopRequested = false;

    async record(options: { signal: AbortSignal; onSpeakingChange?: (speaking: boolean) => void }): Promise<CapturedUtterance | null> {
        this.stopRequested = false;

        const stream = this.stream ?? await navigator.mediaDevices.getUserMedia({ audio: true });
        this.stream = stream;

        const context = this.context ?? new AudioContext();
        this.context = context;
        if (context.state === 'suspended') {
            await context.resume();
        }

        // An AnalyserNode gives time-domain frames without an AudioWorklet
        // module to host and load, and the energy gate does not need
        // sample-accurate framing.
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = ANALYSER_FFT_SIZE;
        source.connect(analyser);

        const { mimeType, extension } = pickMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        this.recorder = recorder;

        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                chunks.push(event.data);
            }
        };

        const startedAt = Date.now();
        recorder.start();

        const frame = new Float32Array(analyser.fftSize);
        const vad = createVadState();
        let lastSpeaking = false;

        try {
            await new Promise<void>((resolve) => {
                const finish = () => {
                    clearInterval(timer);
                    options.signal.removeEventListener('abort', finish);
                    resolve();
                };

                const timer = setInterval(() => {
                    if (this.stopRequested || options.signal.aborted) {
                        finish();
                        return;
                    }

                    analyser.getFloatTimeDomainData(frame);
                    pushVadFrame(vad, frame, VAD_POLL_MS);

                    if (vad.speaking !== lastSpeaking) {
                        lastSpeaking = vad.speaking;
                        options.onSpeakingChange?.(vad.speaking);
                    }

                    if (vad.ended) {
                        finish();
                    }
                }, VAD_POLL_MS);

                options.signal.addEventListener('abort', finish);
            });
        } finally {
            source.disconnect();
            analyser.disconnect();
        }

        const stopped = new Promise<void>((resolve) => {
            recorder.onstop = () => resolve();
        });
        if (recorder.state !== 'inactive') {
            recorder.stop();
        }
        await stopped;
        this.recorder = null;

        if (options.signal.aborted || !vad.started || chunks.length === 0) {
            return null;
        }

        return {
            part: {
                kind: 'blob',
                blob: new Blob(chunks, mimeType ? { type: mimeType } : undefined),
                filename: `utterance.${extension}`,
            },
            durationMs: Date.now() - startedAt,
        };
    }

    stop(): void {
        this.stopRequested = true;
    }

    dispose(): void {
        this.stopRequested = true;
        if (this.recorder && this.recorder.state !== 'inactive') {
            this.recorder.stop();
        }
        this.recorder = null;
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
        void this.context?.close();
        this.context = null;
    }
}

class WebAudioPlayback implements AudioPlayback {
    readonly format = 'mp3';

    private context: AudioContext | null = null;
    private source: AudioBufferSourceNode | null = null;

    async play(audio: ArrayBuffer, options: { signal: AbortSignal }): Promise<void> {
        if (options.signal.aborted) {
            return;
        }

        const context = this.context ?? new AudioContext();
        this.context = context;
        if (context.state === 'suspended') {
            await context.resume();
        }

        const buffer = await context.decodeAudioData(audio.slice(0));
        if (options.signal.aborted) {
            return;
        }

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        this.source = source;

        await new Promise<void>((resolve) => {
            const finish = () => {
                options.signal.removeEventListener('abort', onAbort);
                source.onended = null;
                resolve();
            };
            const onAbort = () => {
                try {
                    source.stop();
                } catch {
                    // Already stopped; the ended handler still resolves.
                }
                finish();
            };

            source.onended = finish;
            options.signal.addEventListener('abort', onAbort);
            source.start();
        });

        this.source = null;
    }

    stop(): void {
        try {
            this.source?.stop();
        } catch {
            // Stopping a source that never started throws; nothing to undo.
        }
        this.source = null;
    }

    dispose(): void {
        this.stop();
        void this.context?.close();
        this.context = null;
    }
}

export const audioIO: AudioIO = {
    createCapture: () => new WebAudioCapture(),
    createPlayback: () => new WebAudioPlayback(),
};
