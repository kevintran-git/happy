import { describe, expect, it } from 'vitest';
import { createVadState, frameRms, pushVadFrame, type VadOptions } from './vad';

const OPTIONS: VadOptions = { threshold: 0.015, silenceMs: 800, minSpeechMs: 250 };
const FRAME_MS = 100;

function frame(amplitude: number, length = 256): Float32Array {
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        samples[i] = i % 2 === 0 ? amplitude : -amplitude;
    }
    return samples;
}

const LOUD = frame(0.3);
const QUIET = frame(0.001);

function push(state: ReturnType<typeof createVadState>, samples: Float32Array, count: number) {
    for (let i = 0; i < count; i++) {
        pushVadFrame(state, samples, FRAME_MS, OPTIONS);
    }
}

describe('frameRms', () => {
    it('is zero for an empty frame', () => {
        expect(frameRms(new Float32Array(0))).toBe(0);
    });

    it('equals the amplitude of a square wave', () => {
        expect(frameRms(frame(0.5))).toBeCloseTo(0.5, 6);
    });
});

describe('pushVadFrame', () => {
    it('does not start on speech shorter than minSpeechMs', () => {
        const state = createVadState();
        push(state, LOUD, 2);

        expect(state.started).toBe(false);
        expect(state.speaking).toBe(false);
    });

    it('starts once minSpeechMs of speech accumulates', () => {
        const state = createVadState();
        push(state, LOUD, 3);

        expect(state.started).toBe(true);
        expect(state.speaking).toBe(true);
        expect(state.ended).toBe(false);
    });

    it('stays speaking through a pause shorter than silenceMs', () => {
        const state = createVadState();
        push(state, LOUD, 3);
        push(state, QUIET, 5);

        expect(state.speaking).toBe(true);
        expect(state.ended).toBe(false);
    });

    it('ends after silenceMs of continuous silence', () => {
        const state = createVadState();
        push(state, LOUD, 3);
        push(state, QUIET, 8);

        expect(state.ended).toBe(true);
        expect(state.speaking).toBe(false);
    });

    it('resets the silence run when speech resumes', () => {
        const state = createVadState();
        push(state, LOUD, 3);
        push(state, QUIET, 7);
        push(state, LOUD, 1);
        push(state, QUIET, 7);

        expect(state.ended).toBe(false);
    });

    it('never ends on silence alone', () => {
        const state = createVadState();
        push(state, QUIET, 50);

        expect(state.started).toBe(false);
        expect(state.ended).toBe(false);
    });
});
