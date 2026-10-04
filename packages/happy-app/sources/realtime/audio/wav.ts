/**
 * Minimal 16-bit PCM WAV writer.
 *
 * The native recorder hands back float frames, and /v1/audio/transcriptions
 * takes a container, not raw samples. WAV is the one container that can be
 * produced from PCM without an encoder, and every transcription server
 * accepts it.
 */

export function encodeWav(frames: Float32Array[], sampleRate: number, channels = 1): Uint8Array {
    let sampleCount = 0;
    for (const frame of frames) {
        sampleCount += frame.length;
    }

    const dataBytes = sampleCount * 2;
    const out = new Uint8Array(44 + dataBytes);
    const view = new DataView(out.buffer);

    const ascii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    };

    ascii(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);            // PCM header size
    view.setUint16(20, 1, true);             // format: PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);  // byte rate
    view.setUint16(32, channels * 2, true);  // block align
    view.setUint16(34, 16, true);            // bits per sample
    ascii(36, 'data');
    view.setUint32(40, dataBytes, true);

    let offset = 44;
    for (const frame of frames) {
        for (let i = 0; i < frame.length; i++) {
            // Clamp before scaling: a float sample outside [-1, 1] would wrap
            // to the opposite sign as an int16 and read as a loud click.
            const clamped = Math.max(-1, Math.min(1, frame[i]));
            view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
            offset += 2;
        }
    }

    return out;
}
