# Phone-direct conversational assistant

Current revision: 2026-10-02. The user approved one-time, per-device API key entry stored in iOS Keychain. Provider credentials are not embedded in distributable builds.

## Runtime

Settings → Assistant → Conversational assistant still defaults off. Off retains the original Apple speech / local interpretation experience. On selects `DirectConversationService`; it no longer calls the Mac gateway or reads an assistant IP/access code.

The phone records audio, sends multipart audio directly to Groq Whisper, searches the locally cached transit catalogue, sends the text plus structured context directly to DeepSeek, validates its patch, updates local conversation state, and renders native choices. Session history, revision checking, replay handling and confirmations live in the phone process. The chat presents retained left/right message bubbles, a fixed text/voice composer, and at most two initial stop suggestions. Other stops are explicitly expandable. Model extraction and deterministic validation jointly decide when stop, serving route and assistance needs are complete; wheelchair/mobility requests also require a ramp answer. A complete draft is resolved against real arrival data and automatically submitted through the existing booking service. No extra review screen is required.

An explicit pause or unfinished request (`hold`) persists across follow-up turns until the passenger says to send. Unclear interpretation, ambiguous stops, missing fields, invalid routes and failed resolution prevent automatic submission. Reply replay and the view's submitted-request guard prevent duplicate submissions. Acknowledgement and live status remain inside the chat, using the existing booking service as their authority; requested preparations are labelled as requests, not proof of physical execution. Backend/Dashboard code is unchanged.

`DirectConversationProviders` uses fixed HTTPS endpoints and Apple's URLSession. `ConversationModelProviding` permits injected providers for tests. API errors map to actionable messages without exposing provider response bodies. Network and JSON work run in actors. Cancellation does not commit a partially completed turn.

Provider references: [Groq speech transcription](https://console.groq.com/docs/speech-to-text), [DeepSeek chat completions](https://api-docs.deepseek.com/api/create-chat-completion/), [DeepSeek JSON mode](https://api-docs.deepseek.com/guides/json_mode/).

## Configuration boundary

Settings → Assistant → **Add API keys** accepts the Groq and DeepSeek keys once. **Save keys** stores both atomically as one versioned generic-password item. The item uses `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, is not synchronizable, and is isolated by the app's Keychain access group. Empty fields on the update screen preserve the corresponding existing key. Keys are not loaded back into text fields, written to UserDefaults/files, printed, or bundled. **Check assistant connection** authenticates directly with both providers.

`AssistantProviderConfiguration.current()` reads `AssistantCredentialStore` asynchronously. Each inference loads the latest saved credentials, so updating keys does not erase the current conversation. Missing credentials show an actionable setup message; Keychain errors do not claim success. User-entered keys remain after process termination. The installation itself does not provision real credentials.

The previous Python gateway and HTTP client remain historical development/test utilities. They are not selected by the app factory. Settings no longer offers an assistant IP address or access-code field. Existing legacy preference data does not select a gateway.

## Verification

Unit coverage includes model patch validation, independent session reset, revision/idempotency handling, explicit versus negated send, stop lookup confirmation, ambiguous yes, no matches, invalid routes, combined needs and corrections. Provider transport tests intercept URLSession using synthetic keys and responses, verify HTTPS requests only target Groq/DeepSeek, reject silence, and check provider-error handling.

UI tests use `-ui-testing -direct-assistant-fixture`, an explicit Debug-only in-process provider fixture. They exercise the same on-phone state machine as the normal app. No fixture server, local listening port, or real API keys are required. Fixture results are not evidence of real model accuracy or real phone speech quality.

Real-provider calls and physical-phone audio cannot be validated until credentials are configured. Prior live DeepSeek results in [the stop evaluation report](stop-dialogue-evaluation.md) came from the earlier gateway implementation and must not be represented as live verification of this Swift transport.

Final verification: Release simulator build succeeded. Final unit run reported 64 tests with 1 live-hub test skipped (63 passed). Five UI tests passed: on-phone multi-turn text using injected fixtures, settings without credentials, missing-key manual recovery, flag round-trip/persistence, and maximum Dynamic Type. Release Info.plist contains no assistant gateway URL/access code or Groq/DeepSeek key fields. Screenshots were exported and reviewed. That earlier code-only revision did not update the physical phone or call live providers.

## Keychain verification

Keychain tests must use a signed simulator build (`CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`); unsigned simulator builds cannot access the application's Keychain. Synthetic credentials verify save/read across independent store instances, atomic rejection of invalid edits, replacement, and deletion. UI cold-launch testing uses a separate test-only Keychain service, never the user's real credentials.

Keychain follow-up: 63 unit tests passed and 1 live-hub test skipped with a signed simulator build. Three relevant UI cases passed (cold restart retaining synthetic keys, empty-configuration settings, manual recovery). Cold-restart evidence verified both the saved state and an Update API keys entry. Fixed duplicate accessibility identifiers on the saved-status icon/text so VoiceOver treats it as a single status. The final signed app was installed on the physical iPhone. Real provider keys must be entered once on that phone; no live provider authentication was claimed from the synthetic-key tests.

## Chat interface verification (2026-10-02)

The chat redesign passed 65 unit tests; the live-hub test remains skipped (66 reported cases). Seven relevant UI cases passed across focused runs: chat entry with text/voice switching, automatic submission with inline feedback, feature-flag persistence and legacy return, missing-credential recovery, multi-turn hold/correction and missing-arrival recovery, maximum Dynamic Type, and failed delivery with retry and editing that preserves the journey. Screenshots were exported and visually inspected. Tests use explicit model and vehicle fixtures; they do not establish real provider accuracy, microphone quality, or physical bus execution.

The stop badge now scales its custom font once rather than twice at large accessibility sizes. An existing stream ownership unit test uses an exact-second timestamp to avoid nondeterministic epoch-millisecond rounding at the receipt boundary; runtime trigger rules are unchanged.

The signed Debug chat build was installed successfully on the connected iPhone (bundle `sg.buspulse.connexis`, installation database sequence 3648). Remote launch was attempted but iOS rejected it because the device was locked; unlock and open the app manually. Provider keys and existing preferences are preserved by the update.
