import React from 'react';
import { registerVoiceSession } from './RealtimeSession';
import { OpenAIVoiceSession } from './OpenAIVoiceSession';
import { audioIO } from './audio/io';

/**
 * Registers the in-app cascade as the active VoiceSession.
 *
 * The ElevenLabs implementation needs a mounted component because it is built
 * on a hook. This one does not, but it is mounted the same way so that
 * RealtimeProvider can swap the two by rendering one or the other, and so the
 * session is torn down when the user switches backends.
 */
export const OpenAIVoiceSessionBridge: React.FC = () => {
    React.useEffect(() => {
        const session = new OpenAIVoiceSession(audioIO);
        registerVoiceSession(session);
        return () => {
            void session.endSession();
        };
    }, []);

    return null;
};
