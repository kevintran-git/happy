/**
 * Energy-gate voice activity detection.
 *
 * The ElevenLabs SDK hands the app a continuous `vadScore` and
 * RealtimeVoiceSession debounces it into the speaking state. Nothing supplies
 * that score when the cascade runs locally, so it is derived here from frame
 * energy: speech is louder than room tone by a wide margin, and the only job
 * is deciding when an utterance ended.
 *
 * Silence has to persist before the turn is committed, otherwise the pause
 * between two words ends the sentence.
 */

export interface VadOptions {
    /** RMS above which a frame counts as speech. 0-1, against normalized samples. */
    threshold: number;
    /** Continuous silence that ends an utterance. */
    silenceMs: number;
    /** Speech required before an utterance is considered started at all. */
    minSpeechMs: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
    threshold: 0.015,
    silenceMs: 800,
    minSpeechMs: 250,
};

export function frameRms(samples: Float32Array): number {
    if (samples.length === 0) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
}

export interface VadState {
    speaking: boolean;
    speechMs: number;
    silenceMs: number;
    /** True once enough speech accumulated for this to be a real utterance. */
    started: boolean;
    /** True once a started utterance has been followed by enough silence. */
    ended: boolean;
}

export function createVadState(): VadState {
    return { speaking: false, speechMs: 0, silenceMs: 0, started: false, ended: false };
}

/**
 * Advances the state by one frame. Returns the same object, mutated: this runs
 * per audio frame and allocating here would be the dominant cost.
 */
export function pushVadFrame(
    state: VadState,
    samples: Float32Array,
    frameMs: number,
    options: VadOptions = DEFAULT_VAD_OPTIONS,
): VadState {
    const loud = frameRms(samples) >= options.threshold;

    if (loud) {
        state.speechMs += frameMs;
        state.silenceMs = 0;
        if (state.speechMs >= options.minSpeechMs) {
            state.started = true;
        }
    } else {
        state.silenceMs += frameMs;
        if (state.started && state.silenceMs >= options.silenceMs) {
            state.ended = true;
        }
    }

    // Speaking stays true across the gaps between words: a per-frame loudness
    // reading would flip it several times a sentence, and the UI treats it as
    // "the user has the floor", not "sound is arriving right now".
    state.speaking = state.started && !state.ended;
    return state;
}
