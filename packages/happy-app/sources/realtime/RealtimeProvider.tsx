import React from 'react';
import { ElevenLabsProvider } from '@elevenlabs/react-native';
import { RealtimeVoiceSession } from './RealtimeVoiceSession';
import { OpenAIVoiceSessionBridge } from './OpenAIVoiceSessionBridge';
import { useSetting, useVoiceSessionGeneration } from '@/sync/storage';

export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    // Force ElevenLabsProvider to remount between sessions. The native SDK uses
    // LiveKit, whose Room instance can't be reused after disconnect — second
    // startSession silently fails. Children sit OUTSIDE the provider so the app
    // tree isn't torn down on remount.
    const generation = useVoiceSessionGeneration();
    const backend = useSetting('voiceBackend');

    // Only one of the two ever mounts: registerVoiceSession keeps a single
    // implementation, so mounting both would leave the winner up to render
    // order.
    return (
        <>
            {backend === 'openai-compatible' ? (
                <OpenAIVoiceSessionBridge key={generation} />
            ) : (
                <ElevenLabsProvider key={generation}>
                    <RealtimeVoiceSession />
                </ElevenLabsProvider>
            )}
            {children}
        </>
    );
};
