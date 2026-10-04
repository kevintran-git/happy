import type { Settings } from '@/sync/settings';

export interface OpenAIVoiceConfig {
    baseUrl: string;
    apiKey: string;
    sttModel: string;
    llmModel: string;
    ttsModel: string;
    ttsVoice: string;
}

function clean(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

/**
 * Reads the OpenAI-compatible backend configuration out of settings, or null
 * when any field is missing. Every field is required: there is no sensible
 * default for a model id or a voice id, because both are named by whichever
 * server the user happens to be running.
 */
export function resolveOpenAIVoiceConfig(settings: Settings): OpenAIVoiceConfig | null {
    const baseUrl = clean(settings.voiceApiBaseUrl);
    const apiKey = clean(settings.voiceApiKey);
    const sttModel = clean(settings.voiceSttModel);
    const llmModel = clean(settings.voiceLlmModel);
    const ttsModel = clean(settings.voiceTtsModel);
    const ttsVoice = clean(settings.voiceTtsVoice);

    if (!baseUrl || !apiKey || !sttModel || !llmModel || !ttsModel || !ttsVoice) {
        return null;
    }

    return {
        baseUrl: baseUrl.replace(/\/+$/, ''),
        apiKey,
        sttModel,
        llmModel,
        ttsModel,
        ttsVoice,
    };
}
