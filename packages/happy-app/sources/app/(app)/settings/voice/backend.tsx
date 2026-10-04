import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';

type TextSetting =
    | 'voiceApiBaseUrl'
    | 'voiceApiKey'
    | 'voiceSttModel'
    | 'voiceTtsModel'
    | 'voiceTtsVoice'
    | 'voiceLlmModel';

function useTextSettingPrompt(
    setting: TextSetting,
    title: string,
    description: string,
    placeholder: string,
    secure?: boolean,
) {
    const [value, setValue] = useSettingMutable(setting);
    const prompt = React.useCallback(async () => {
        const next = await Modal.prompt(title, description, {
            defaultValue: value ?? '',
            placeholder,
            ...(secure ? { inputType: 'secure-text' as const } : {}),
        });
        if (next !== null) {
            setValue(next.trim() || null);
        }
    }, [value, setValue, title, description, placeholder, secure]);
    return [value, prompt] as const;
}

export default React.memo(function VoiceBackendSettingsScreen() {
    const [baseUrl, promptBaseUrl] = useTextSettingPrompt(
        'voiceApiBaseUrl',
        t('settingsVoice.openaiBackend.baseUrl'),
        t('settingsVoice.openaiBackend.baseUrlDescription'),
        t('settingsVoice.openaiBackend.baseUrlPlaceholder'),
    );
    const [apiKey, promptApiKey] = useTextSettingPrompt(
        'voiceApiKey',
        t('settingsVoice.openaiBackend.apiKey'),
        t('settingsVoice.openaiBackend.apiKeyDescription'),
        t('settingsVoice.openaiBackend.apiKeyPlaceholder'),
        true,
    );
    const [sttModel, promptSttModel] = useTextSettingPrompt(
        'voiceSttModel',
        t('settingsVoice.openaiBackend.sttModel'),
        t('settingsVoice.openaiBackend.modelsDescription'),
        t('settingsVoice.openaiBackend.sttModelPlaceholder'),
    );
    const [llmModel, promptLlmModel] = useTextSettingPrompt(
        'voiceLlmModel',
        t('settingsVoice.openaiBackend.llmModel'),
        t('settingsVoice.openaiBackend.modelsDescription'),
        t('settingsVoice.openaiBackend.llmModelPlaceholder'),
    );
    const [ttsModel, promptTtsModel] = useTextSettingPrompt(
        'voiceTtsModel',
        t('settingsVoice.openaiBackend.ttsModel'),
        t('settingsVoice.openaiBackend.modelsDescription'),
        t('settingsVoice.openaiBackend.ttsModelPlaceholder'),
    );
    const [ttsVoice, promptTtsVoice] = useTextSettingPrompt(
        'voiceTtsVoice',
        t('settingsVoice.openaiBackend.ttsVoice'),
        t('settingsVoice.openaiBackend.modelsDescription'),
        t('settingsVoice.openaiBackend.ttsVoicePlaceholder'),
    );

    const notSet = t('settingsVoice.openaiBackend.notSet');

    return (
        <ItemList>
            <ItemGroup
                title={t('settingsVoice.openaiBackend.serverTitle')}
                footer={t('settingsVoice.openaiBackend.description')}
            >
                <Item
                    title={t('settingsVoice.openaiBackend.baseUrl')}
                    subtitle={baseUrl ?? notSet}
                    icon={<Ionicons name="globe-outline" size={29} color="#007AFF" />}
                    onPress={promptBaseUrl}
                />
                <Item
                    title={t('settingsVoice.openaiBackend.apiKey')}
                    subtitle={apiKey ? t('settingsVoice.openaiBackend.apiKeySet') : notSet}
                    icon={<Ionicons name="key-outline" size={29} color="#FF9500" />}
                    onPress={promptApiKey}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsVoice.openaiBackend.modelsTitle')}
                footer={t('settingsVoice.openaiBackend.modelsDescription')}
            >
                <Item
                    title={t('settingsVoice.openaiBackend.sttModel')}
                    subtitle={sttModel ?? notSet}
                    icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                    onPress={promptSttModel}
                />
                <Item
                    title={t('settingsVoice.openaiBackend.llmModel')}
                    subtitle={llmModel ?? notSet}
                    icon={<Ionicons name="chatbubbles-outline" size={29} color="#5856D6" />}
                    onPress={promptLlmModel}
                />
                <Item
                    title={t('settingsVoice.openaiBackend.ttsModel')}
                    subtitle={ttsModel ?? notSet}
                    icon={<Ionicons name="volume-high-outline" size={29} color="#FF2D55" />}
                    onPress={promptTtsModel}
                />
                <Item
                    title={t('settingsVoice.openaiBackend.ttsVoice')}
                    subtitle={ttsVoice ?? notSet}
                    icon={<Ionicons name="person-outline" size={29} color="#AF52DE" />}
                    onPress={promptTtsVoice}
                />
            </ItemGroup>
        </ItemList>
    );
});
