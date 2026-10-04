# Voice Architecture

How the voice assistant integrates with the Happy app, routes messages to sessions, and manages context delivery.

Two implementations of the same `VoiceSession` interface exist. The hosted ElevenLabs agent is the default and everything below describes it unless stated otherwise; the alternative runs the turn loop in the app against a server the user supplies, and is covered in [Backends](#backends).

## Components

```text
SessionView.tsx            UI — mic button, triggers voice start/stop
RealtimeSession.ts         Lifecycle — start/stop, token fetch, session routing state
RealtimeProvider.tsx       Mounts whichever backend the voiceBackend setting selects
RealtimeVoiceSession.tsx   Native ElevenLabs bridge (useConversation hook)
RealtimeVoiceSession.web.tsx  Web ElevenLabs bridge (same interface)
OpenAIVoiceSession.ts      In-app turn loop against an OpenAI-compatible server
openaiVoiceClient.ts       HTTP for the three OpenAI endpoints
openaiVoiceConfig.ts       All-or-nothing config resolution from settings
vad.ts                     Energy-gate voice activity detection
audio/io.ts, audio/io.web.ts  Microphone capture and speaker playback per platform
voiceHooks.ts              Context delivery — formats and routes app events to voice agent
contextFormatters.ts       Text formatters for session context, messages, permissions
realtimeClientTools.ts     Tool implementations the voice agent can invoke
voiceConfig.ts             Feature flags and constants
storage.ts                 Global state (realtimeStatus, realtimeMode)
types.ts                   Shared type definitions
```

## Session Routing

A single module-level variable `currentSessionId` in `RealtimeSession.ts` controls which session the voice agent's tool calls route to. It is the single source of truth for both:

- **Routing**: `messageClaudeCode` and `processPermissionRequest` in `realtimeClientTools.ts` read it via `getCurrentRealtimeSessionId()`.
- **Focus dedup**: `voiceHooks.onSessionFocus()` compares against it to avoid re-injecting context for the already-focused session.

When the user navigates to a different session while voice is active, `onSessionFocus` updates `currentSessionId` so subsequent voice commands route to the newly viewed session.

```text
User taps mic on Session A
  │
  v
startRealtimeSession("A")
  └──> currentSessionId = "A"

User navigates to Session B
  │
  v
sync.onSessionVisible("B")
  └──> voiceHooks.onSessionFocus("B")
         └──> setCurrentRealtimeSessionId("B")

Voice agent calls messageClaudeCode
  └──> getCurrentRealtimeSessionId() → "B"
```

## Voice Start

When the voice session starts, `onVoiceStarted(sessionId)` builds an initial prompt containing:

1. **Session directory** — one-liner per active session (id + summary), so the agent knows all available targets.
2. **Current session context** — full dump via `injectSessionContext(sessionId)`: session metadata, path, summary, and message history.

```text
onVoiceStarted("A")
  │
  ├──> formatSessionDirectory()
  │      → "Available sessions:\n- abc: "Refactor auth"\n- def: "Fix dark mode""
  │
  └──> injectSessionContext("A")
         → "# Session ID: abc\n# Project path: ...\n## History\n..."
```

## Context Delivery

App events are delivered to the voice agent through two channels with different semantics:

### sendContext() — silent background injection

Calls `voice.sendContextualUpdate()`. The agent receives the information but does **not** respond. Always sent immediately, never queued.

Used for: new messages, session focus changes, session online/offline, full session dumps.

### sendPrompt() — triggers agent response

Calls `voice.sendTextMessage()`. Acts as a user turn — the agent will respond. **Queued while anyone is speaking**, flushed as a single batch when mode transitions to `idle`.

Used for: permission requests, ready events (agent finished working).

### Batching

When the user or agent is speaking, prompts queue up in `pendingPrompts[]`. A zustand subscription on `realtimeMode` triggers `flushPendingPrompts()` when mode returns to `idle`, joining all queued prompts into a single `sendTextMessage` call.

```text
realtimeMode = 'agent-speaking'
  │
  ├── onReady("abc")        → sendPrompt() → queued
  ├── onPermission("abc")   → sendPrompt() → queued
  ├── onMessages("abc")     → sendContext() → sent immediately
  │
  v
realtimeMode → 'idle'
  │
  v
flushPendingPrompts()
  └──> voice.sendTextMessage(joined prompts)
```

### Session Context Injection

`injectSessionContext(sessionId)` is the shared code path for injecting full session context. It is used by both `onVoiceStarted` (to build the initial prompt string) and `onSessionFocus` (to send a contextual update). It tracks which sessions have already been shown via `shownSessions` to avoid redundant dumps.

## Realtime Mode

`realtimeMode` in storage tracks who is currently speaking:

| Mode | Meaning | Source |
|------|---------|--------|
| `idle` | Nobody is talking | Default / after speech ends |
| `agent-speaking` | ElevenLabs agent is producing audio | `onModeChange({ mode: 'speaking' })` |
| `user-speaking` | User mic VAD is above threshold | `onVadScore({ vadScore })` |

Priority: `agent-speaking` > `user-speaking` > `idle`. If both fire simultaneously, agent wins (user speech during agent output is likely crosstalk).

### VAD Detection

ElevenLabs provides `onVadScore({ vadScore: number })` — a continuous 0-1 signal for user microphone activity. We derive a binary state with debounce:

- `vadScore > VAD_THRESHOLD` (0.5) → `user-speaking`, reset silence timer
- `vadScore <= VAD_THRESHOLD` → start silence timer (`VAD_SILENCE_MS` = 300ms), transition to `idle` on timeout

Agent mode changes (`onModeChange`) take priority over VAD. When `onModeChange` reports `'speaking'`, we set `agent-speaking` regardless of VAD. When it reports `'listening'`, we defer to VAD state.

```text
ElevenLabs SDK
  │
  ├── onModeChange({ mode: 'speaking' })
  │     └──> realtimeMode = 'agent-speaking'
  │
  ├── onModeChange({ mode: 'listening' })
  │     └──> realtimeMode = (VAD active ? 'user-speaking' : 'idle')
  │
  └── onVadScore({ vadScore })
        └──> if agent not speaking:
               vadScore > 0.5 → 'user-speaking'
               vadScore ≤ 0.5 → debounce → 'idle'
```

## Voice Agent Tools

The voice agent can invoke these client tools (defined in `realtimeClientTools.ts`):

- **messageClaudeCode** — sends a text message to the currently focused session via `sync.sendMessage(sessionId, message)`.
- **processPermissionRequest** — allows or denies a pending permission request on the current session.

Both read the target session from `getCurrentRealtimeSessionId()`.

## Lifecycle

```text
App mounts RealtimeVoiceSession component
  └──> useConversation() hook initializes
  └──> registerVoiceSession(impl) — makes the instance available globally

User taps mic
  └──> voiceHooks.onVoiceStarted(sessionId) — builds initial prompt
  └──> startRealtimeSession(sessionId, prompt)
         ├──> fetchVoiceToken() — server-side gating (see plans/elevenlabs-voice-usage-gating.md)
         ├──> currentSessionId = sessionId
         └──> voiceSession.startSession({ token, initialContext, ... })

User taps mic again (or navigates away)
  └──> stopRealtimeSession()
         ├──> voiceSession.endSession()
         ├──> currentSessionId = null
         └──> voiceHooks.onVoiceStopped() — clears state
```

## Backends

`settings.voiceBackend` selects which implementation of `VoiceSession` is registered. It defaults to `'elevenlabs'`; the only other value is `'openai-compatible'`. `RealtimeProvider` mounts exactly one of the two, because `registerVoiceSession` holds a single instance and mounting both would make the winner depend on render order.

### openai-compatible

The agent loop ElevenLabs runs on their servers runs in the app instead, against any server exposing three endpoints at one base URL with bearer auth:

| Endpoint | Used for |
|----------|----------|
| `POST /v1/audio/transcriptions` | multipart upload of one captured utterance |
| `POST /v1/chat/completions` | SSE-streamed completion with tool calls |
| `POST /v1/audio/speech` | the whole reply clip, in the platform's playback format |

No vendor, hostname, model id or voice id is built in. All six fields — base URL, API key, and the four model/voice ids — are configured in Settings → Voice → Server Settings, and the backend is unusable until every one of them is set: there is no sensible default for a model id, because it is named by whichever server the user runs.

One turn is: listen, transcribe, complete, speak, dispatch tool calls, then complete again so the model can speak about the tool results. Every step is abortable, which is what makes barge-in and `endSession` immediate rather than "after the current request finishes".

Billing is the user's, directly with their server, so none of Happy's token minting, usage gating or paywall applies to this path. The system prompt is still Happy's — only the transport is theirs.

Three things ElevenLabs supplies for free are rebuilt locally:

- **VAD** — `vad.ts` runs an energy gate over frame RMS. An utterance starts after `minSpeechMs` of speech and ends after `silenceMs` of continuous silence, so the pause between two words does not end the sentence. There is no continuous `vadScore`, so `realtimeMode` is driven by the start/end transitions instead of a debounced threshold.
- **`skip_turn`** — `VOICE_SYSTEM_PROMPT_BASE` instructs the model to call it when the user was addressing someone else. ElevenLabs' platform provides that tool; nothing provides it here, so `OpenAIVoiceSession` declares it alongside the two client tools and handles it by suppressing both speech and the follow-up completion.
- **The context/prompt distinction** — `sendTextMessage` aborts the current turn and queues a user message; `sendContextualUpdate` only queues. Updates that arrive mid-turn are staged in `pendingContext` and folded in at the turn boundary, because appending to the message array the in-flight completion was built from would mutate it under the request.

Capture and playback are platform files resolved by the bundler. Web records with `MediaRecorder` and reads VAD frames from an `AnalyserNode`, producing a `Blob`. Native records PCM with `react-native-audio-api`, encodes 16 kHz mono WAV, writes it to the cache directory, and hands back a file URI so a whole recording never has to sit in JS memory as a `Blob`.

## Related

- `docs/plans/elevenlabs-voice-usage-gating.md` — usage gating and paywall flow for voice sessions.
- `docs/plans/openai-compatible-voice-backend.md` — design of the second backend.
