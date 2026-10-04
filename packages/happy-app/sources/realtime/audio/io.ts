import { AudioBuffer, AudioBufferSourceNode, AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';
import { File, Paths } from 'expo-file-system';
import { createVadState, pushVadFrame } from '../vad';
import { encodeWav } from './wav';
import type { AudioCapture, AudioIO, AudioPlayback, CapturedUtterance } from './types';

const SAMPLE_RATE = 16000;
const BUFFER_LENGTH_IN_SAMPLES = 1600;
const FRAME_MS = (BUFFER_LENGTH_IN_SAMPLES / SAMPLE_RATE) * 1000;

/**
 * 16 kHz mono is what transcription models resample to anyway, so recording
 * at a higher rate would only make the upload bigger.
 */

let audioSessionConfigured = false;

function configureAudioSession(): void {
    if (audioSessionConfigured) {
        return;
    }
    AudioManager.setAudioSessionOptions({
        iosCategory: 'playAndRecord',
        iosMode: 'voiceChat',
        iosOptions: ['defaultToSpeaker', 'allowBluetooth'],
    });
    AudioManager.setAudioSessionActivity(true);
    audioSessionConfigured = true;
}

class NativeAudioCapture implements AudioCapture {
    private recorder: AudioRecorder | null = null;
    private stopRequested = false;

    async record(options: { signal: AbortSignal; onSpeakingChange?: (speaking: boolean) => void }): Promise<CapturedUtterance | null> {
        this.stopRequested = false;
        configureAudioSession();

        const granted = await AudioManager.requestRecordingPermissions();
        if (granted !== 'Granted') {
            throw new Error('Microphone permission denied');
        }

        const recorder = new AudioRecorder({
            sampleRate: SAMPLE_RATE,
            bufferLengthInSamples: BUFFER_LENGTH_IN_SAMPLES,
        });
        this.recorder = recorder;

        const frames: Float32Array[] = [];
        const vad = createVadState();
        let lastSpeaking = false;

        const startedAt = Date.now();

        try {
            await new Promise<void>((resolve) => {
                let settled = false;
                const finish = () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    options.signal.removeEventListener('abort', finish);
                    resolve();
                };

                recorder.onAudioReady((event) => {
                    if (settled) {
                        return;
                    }
                    if (this.stopRequested || options.signal.aborted) {
                        finish();
                        return;
                    }

                    // getChannelData hands back the recorder's own storage,
                    // which is reused for the next callback, so the samples
                    // have to be copied before they are kept.
                    const channel = event.buffer.getChannelData(0);
                    const copy = new Float32Array(event.numFrames);
                    copy.set(channel.subarray(0, event.numFrames));
                    frames.push(copy);

                    pushVadFrame(vad, copy, FRAME_MS);

                    if (vad.speaking !== lastSpeaking) {
                        lastSpeaking = vad.speaking;
                        options.onSpeakingChange?.(vad.speaking);
                    }

                    if (vad.ended) {
                        finish();
                    }
                });

                options.signal.addEventListener('abort', finish);
                recorder.start();
            });
        } finally {
            recorder.stop();
            this.recorder = null;
        }

        if (options.signal.aborted || !vad.started || frames.length === 0) {
            return null;
        }

        const wav = encodeWav(frames, SAMPLE_RATE);
        const file = new File(Paths.cache, `happy-utterance-${Date.now().toString(36)}.wav`);
        file.create({ overwrite: true });
        file.write(wav);

        return {
            part: {
                kind: 'file',
                uri: file.uri,
                filename: 'utterance.wav',
                mimeType: 'audio/wav',
            },
            durationMs: Date.now() - startedAt,
        };
    }

    stop(): void {
        this.stopRequested = true;
    }

    dispose(): void {
        this.stopRequested = true;
        this.recorder?.stop();
        this.recorder = null;
    }
}

class NativeAudioPlayback implements AudioPlayback {
    readonly format = 'mp3';

    private context: AudioContext | null = null;
    private source: AudioBufferSourceNode | null = null;

    async play(audio: ArrayBuffer, options: { signal: AbortSignal }): Promise<void> {
        if (options.signal.aborted) {
            return;
        }

        configureAudioSession();

        const context = this.context ?? new AudioContext();
        this.context = context;

        const buffer: AudioBuffer = await context.decodeAudioData(audio);
        if (options.signal.aborted) {
            return;
        }

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        this.source = source;

        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                options.signal.removeEventListener('abort', onAbort);
                resolve();
            };
            const onAbort = () => {
                try {
                    source.stop();
                } catch {
                    // Already stopped; nothing to undo.
                }
                finish();
            };

            source.onEnded = finish;
            options.signal.addEventListener('abort', onAbort);
            source.start();
        });

        this.source = null;
    }

    stop(): void {
        try {
            this.source?.stop();
        } catch {
            // Stopping a source that never started throws.
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
    createCapture: () => new NativeAudioCapture(),
    createPlayback: () => new NativeAudioPlayback(),
};
