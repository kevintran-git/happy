# Pluggable voice backend — OpenAI-compatible cascade

## Problem

Voice is the one Happy feature that cannot run without a specific third-party
vendor. Everything else in the app works against a self-hosted server, and
`happy server` exists precisely so a user can own the whole stack. Voice does
not participate in that: it requires ElevenLabs, and the only user-owned
configuration is which ElevenLabs agent to connect to.

That blocks three groups of users:

- Users who will not send microphone audio to a third party. `PRIVACY.md` is
  explicit that voice is the exception to the end-to-end encryption model, and
  there is currently no way to opt into voice while keeping that boundary.
- Users who already run inference infrastructure and want voice to use it
  rather than paying a second vendor for the same capability.
- Users in regions or organizations where the vendor is not an option at all.

It also means Happy's voice feature has a per-minute floor cost that no user
can remove, for themselves or for the project.

## Scope

This document proposes a second `VoiceSession` implementation that speaks to
any server implementing three OpenAI API endpoints, and a setting that chooses
between it and the existing ElevenLabs implementation. It does not propose
removing, replacing, or changing the default behavior of the ElevenLabs path.

The membership test for a compatible backend is exactly: it serves
`POST /v1/audio/transcriptions`, `POST /v1/audio/speech`, and
`POST /v1/chat/completions` with streaming and tool calling, at a single base
URL, authenticated by a bearer token. Nothing is required beyond that. Any
server meeting the test works, including servers that do not exist yet.

Choosing the OpenAI shape rather than inventing one is deliberate: it is the
interface the largest number of self-hosted and hosted inference servers
already expose, so the feature ships with a working ecosystem on day one
instead of requiring anyone to write an adapter.

## Current repo state

The abstraction this needs is already in the codebase.

`packages/happy-app/sources/realtime/types.ts:11` defines the whole contract
between the app and its voice provider:

```ts
export interface VoiceSession {
    startSession(config: VoiceSessionConfig): Promise<string | null>;
    endSession(): Promise<void>;
    sendTextMessage(message: string): void;
    sendContextualUpdate(update: string): void;
}
```

`packages/happy-app/sources/realtime/RealtimeSession.ts:176` registers one
implementation at runtime via `registerVoiceSession`. Everything downstream —
session routing, context batching, tool dispatch, UI state — talks to the
interface, not to ElevenLabs.

The ElevenLabs coupling is confined to four files:

- `RealtimeVoiceSession.tsx` — native bridge, `@elevenlabs/react-native`
- `RealtimeVoiceSession.web.tsx` — web bridge, `@elevenlabs/react`
- `RealtimeProvider.tsx` / `.web.tsx` — mount `ElevenLabsProvider`
- `RealtimeSession.ts` — token fetch, usage gate, paywall

Four more files are provider-agnostic already and need no changes:
`realtimeClientTools.ts`, `hooks/voiceHooks.ts`, `hooks/contextFormatters.ts`,
`voiceSystemPrompt.ts`.

There is also precedent for a user-owned, server-bypassing voice path.
`RealtimeSession.ts:51` already branches on `voiceBypassToken` plus
`voiceCustomAgentId` and skips Happy's server, usage gate, and paywall
entirely. This proposal extends an accepted idea rather than introducing one.

## What the backend must implement

**Transcription.** `POST /v1/audio/transcriptions`, multipart, fields `file`
and `model`, optional `language`. Returns JSON with a `text` field.

**Speech.** `POST /v1/audio/speech`, JSON body with `model`, `input`, `voice`,
`response_format`. Returns an audio byte stream.

**Chat.** `POST /v1/chat/completions` with `stream: true`, `tools`, and
`tool_choice`. Returns SSE deltas carrying `content` and `tool_calls`.

Authentication is `Authorization: Bearer <token>` against a single configured
base URL for all three.

Nothing above is optional, and nothing above is beyond the baseline that
OpenAI-compatible servers already implement. Streaming transcription over
WebSocket and incremental text-to-speech both reduce latency substantially,
but neither is standardized across servers, so neither is in v1. The
`VoiceSession` interface does not change if they are added later behind
capability detection.

## Where the turn loop moves

With ElevenLabs, the agent loop runs on the vendor's servers: they own
voice activity detection, turn taking, the LLM, and tool dispatch. The app
receives events. With an OpenAI-compatible backend there is no such service,
so the loop runs in the app. This is the substantive engineering in the
proposal; the rest is wiring.

The loop, per turn: capture microphone audio, detect end of utterance,
transcribe, append to conversation history, stream a chat completion,
synthesize and play the spoken portion, dispatch any tool calls locally, and
return to listening. A turn is cancellable at any await point, which is what
makes barge-in work.

Three behaviors the ElevenLabs integration currently gets for free have to be
reimplemented, and each has a defined local equivalent:

**Voice activity detection.** `RealtimeVoiceSession.tsx:160` consumes an
`onVadScore` callback and debounces it into the `user-speaking` UI state. The
local implementation derives the same signal from frame energy over the
captured PCM, and drives the identical `storage.setRealtimeMode` calls. The
debounce constants already in that file carry over unchanged.

**Turn skipping.** `voiceSystemPrompt.ts:7` instructs the agent to call a
`skip_turn` tool when the user is talking to someone else in the room. That
tool is provided by the vendor's platform, not by Happy. The local backend
must declare an equivalent no-op tool in its `tools` array so the system
prompt remains true. Without it, the prompt instructs the model to call
something that does not exist.

**Message versus context.** `voiceHooks.ts:19` distinguishes
`sendContextualUpdate`, which injects silently, from `sendTextMessage`, which
triggers a response. Locally these are the same operation on the conversation
history, differing only in whether a completion is requested afterward.

The two client tools are declared to the model with the names the existing
dispatch table already uses: `sendMessageToSession` with `sessionId` and
`message`, and `processPermissionRequest` with `requestId` and `decision`
(`realtimeClientTools.ts:20`, `:49`). Tool calls arriving in the completion
stream are routed to the same table the ElevenLabs path routes to, so session
routing through `currentSessionId` behaves identically.

## Audio capture and playback

**Native.** `react-native-audio-api` is already a dependency
(`packages/happy-app/package.json:170`) and its Expo plugin is already
registered (`packages/happy-app/app.config.js:152`), though no app code
imports it yet. Its `AudioRecorder` exposes `onAudioReady` with a configurable
sample rate, buffer length, and channel count, delivering float PCM frames —
which is the capture side of this feature, already installed. Playback uses
`AudioBufferSourceNode` from the same library. Microphone permission is
already handled for every platform by
`sources/utils/microphonePermissions.ts`, including the web branch.

**Web.** Capture via `getUserMedia` and an `AudioWorklet`, playback via
`AudioContext`. No new dependency.

If the native backend ships without `@livekit/*`, `@config-plugins/react-native-webrtc`,
and `@elevenlabs/*` on the code path, those remain required only by the
ElevenLabs implementation. Removing them is out of scope here and only becomes
possible if the project ever makes this the default, which this document does
not propose.

## Settings

Added to `SettingsSchema` in `sources/sync/settings.ts`:

```ts
voiceBackend: z.enum(['elevenlabs', 'openai-compatible'])
    .describe('Which voice backend to use'),
voiceApiBaseUrl: z.string().nullable()
    .describe('Base URL of an OpenAI-compatible voice backend'),
voiceApiKey: z.string().nullable()
    .describe('Bearer token for the OpenAI-compatible voice backend'),
voiceSttModel: z.string().nullable()
    .describe('Transcription model id on the configured backend'),
voiceTtsModel: z.string().nullable()
    .describe('Speech model id on the configured backend'),
voiceTtsVoice: z.string().nullable()
    .describe('Speech voice id on the configured backend'),
voiceLlmModel: z.string().nullable()
    .describe('Chat model id on the configured backend'),
```

`voiceBackend` defaults to `'elevenlabs'` and every other field defaults to
`null`, so existing users see no change. These settings sync between devices
field by field like the rest of the schema.

No model id, voice id, or hostname is hardcoded anywhere. The user supplies
all of them, because the set of valid values is a property of their server,
not of Happy.

One open question for review: `voiceApiKey` is a credential, and the existing
`inferenceOpenAIKey` field (`settings.ts:23`) sets the precedent of keeping one
in synced settings. If that precedent is considered a mistake rather than a
pattern, this field should go to `expo-secure-store` instead and not sync. The
decision affects roughly ten lines.

## Dispatch

`RealtimeSession.ts:51` currently branches once, for the ElevenLabs bypass. It
gains one branch above that, which returns before any token fetch, usage
query, or paywall presentation — none of which apply when Happy is not the one
being billed.

`RealtimeProvider.tsx` and `.web.tsx` mount `ElevenLabsProvider` with the
ElevenLabs bridge inside it. They become conditional on `voiceBackend`,
mounting the local bridge instead when selected. The remount-on-generation
behavior documented in `RealtimeProvider.tsx:8` exists because LiveKit `Room`
instances cannot be reused; the local backend has no such constraint but
inherits the mechanism harmlessly.

## Diff surface

New files, which cannot produce merge conflicts:

- `sources/realtime/OpenAIVoiceSession.ts` — the turn loop
- `sources/realtime/openaiVoiceClient.ts` — the three HTTP calls
- `sources/realtime/audio/capture.ts` + `capture.web.ts` — microphone to PCM
- `sources/realtime/audio/playback.ts` + `playback.web.ts` — PCM to speaker
- `sources/realtime/vad.ts` — frame energy to speaking state
- `sources/app/(app)/settings/voice/backend.tsx` — configuration screen

Edited files, one small hunk each:

- `sources/sync/settings.ts` — schema fields and defaults
- `sources/realtime/RealtimeSession.ts` — one branch
- `sources/realtime/RealtimeProvider.tsx` and `.web.tsx` — conditional mount
- `sources/app/(app)/settings/voice.tsx` — entry point to the new screen
- `sources/text/translations/en.ts` — strings
- `docs/voice-architecture.md` — document the second implementation

Unchanged: `realtimeClientTools.ts`, `hooks/voiceHooks.ts`,
`hooks/contextFormatters.ts`, `voiceSystemPrompt.ts`, `voiceConfig.ts`,
`storage.ts`, every UI component, and the entire server package.

While reviewing `voiceSystemPrompt.ts` for the `skip_turn` dependency, note
that the in-app help string at `translations/en.ts:758` documents a tool named
`messageClaudeCode`, while the code registers `sendMessageToSession`. The
architecture doc repeats the stale name. That is a pre-existing bug affecting
anyone configuring a custom ElevenLabs agent today, and should be fixed in its
own PR rather than folded into this one.

## Effect on paid voice

`docs/paid-voice.md` describes voice as a monetization surface: a free tier
measured in minutes, a hard cap, and a RevenueCat paywall. A user-owned
backend is outside that system by construction, in the same way the existing
`voiceCustomAgentId` bypass already is.

The honest framing is that this converts a subset of would-be subscribers into
non-subscribers. The counter-argument is that the subset is small and largely
disjoint from the paying one: a user who configures a base URL, an API key,
and four model ids to avoid a subscription was not a likely subscriber, and
the users this unblocks for policy or privacy reasons could not subscribe at
any price. Shipping it also removes "voice requires a third-party vendor" as a
reason not to adopt Happy at all.

This is a product call, not a technical one, and it should be settled before
implementation starts rather than at review time. If the answer is that it
must stay behind the `experiments` flag or a Pro entitlement, that is a
one-line change to the dispatch branch and worth knowing now.

## Verification

Unit tests cover the turn loop with the three HTTP calls stubbed: tool call
dispatch, cancellation mid-turn, and the contextual-update versus
trigger-response distinction. These run in the existing vitest setup.

`CONTRIBUTING.md:33` requires proof in a real running app, so the PR carries
screen recordings of a real session against a real backend, on web and on a
physical device: sending a message to a session by voice, approving a
permission request by voice, barge-in interrupting playback mid-sentence, and
switching back to ElevenLabs to show the default path is untouched.

## Staging

The work splits into reviewable pieces that are independently useful:

1. Settings schema, configuration screen, and dispatch branch, with the new
   backend stubbed. Proves the default path is unaffected.
2. The client and the turn loop, exercised by tests without audio.
3. Web capture and playback. Shippable and demonstrable on its own.
4. Native capture and playback.

If review stalls at any point, the preceding stages still stand on their own.
