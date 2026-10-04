import { describe, expect, it } from 'vitest';
import { settingsDefaults, type Settings } from '@/sync/settings';
import { resolveOpenAIVoiceConfig } from './openaiVoiceConfig';

const COMPLETE: Settings = {
    ...settingsDefaults,
    voiceBackend: 'openai-compatible',
    voiceApiBaseUrl: 'https://voice.example.com',
    voiceApiKey: 'sk-test',
    voiceSttModel: 'stt-1',
    voiceLlmModel: 'llm-1',
    voiceTtsModel: 'tts-1',
    voiceTtsVoice: 'voice-1',
};

describe('resolveOpenAIVoiceConfig', () => {
    it('is null on defaults', () => {
        expect(resolveOpenAIVoiceConfig(settingsDefaults)).toBeNull();
    });

    it('resolves a complete configuration', () => {
        expect(resolveOpenAIVoiceConfig(COMPLETE)).toEqual({
            baseUrl: 'https://voice.example.com',
            apiKey: 'sk-test',
            sttModel: 'stt-1',
            llmModel: 'llm-1',
            ttsModel: 'tts-1',
            ttsVoice: 'voice-1',
        });
    });

    it('strips trailing slashes from the base URL', () => {
        const config = resolveOpenAIVoiceConfig({ ...COMPLETE, voiceApiBaseUrl: 'https://voice.example.com//' });

        expect(config?.baseUrl).toBe('https://voice.example.com');
    });

    it('trims surrounding whitespace', () => {
        const config = resolveOpenAIVoiceConfig({ ...COMPLETE, voiceApiKey: '  sk-test  ' });

        expect(config?.apiKey).toBe('sk-test');
    });

    it('is null when any single field is missing', () => {
        const fields = [
            'voiceApiBaseUrl',
            'voiceApiKey',
            'voiceSttModel',
            'voiceLlmModel',
            'voiceTtsModel',
            'voiceTtsVoice',
        ] as const;

        for (const field of fields) {
            expect(resolveOpenAIVoiceConfig({ ...COMPLETE, [field]: null })).toBeNull();
        }
    });

    it('treats a whitespace-only field as missing', () => {
        expect(resolveOpenAIVoiceConfig({ ...COMPLETE, voiceTtsVoice: '   ' })).toBeNull();
    });
});
