# Current implementation

The assistant now runs its orchestration on the phone and calls providers directly. Provider keys are entered once per phone and saved in iOS Keychain; the installation package contains no provider keys. See [current architecture and verification](direct-assistant.md). The sections below record the earlier Mac-gateway implementation and are not current setup instructions.

---

# Conversational assistant (version 1)

## Switching versions

Settings → Assistant → **Conversational assistant**. Default: **off**.

Off keeps the existing Apple Speech / Foundation Models screen and manual flow. On replaces both voice entry points (Assistant tab and a selected bus's Speak to Assistant) with the cloud conversation. Turning it off abandons the conversation draft, without sending a booking. Existing bookings continue through the existing booking service.

The new screen accepts speech, typed text and buttons. It retains an editable help card, asks one question at a time and keeps Send request at the bottom. There is no separate review screen, language selector or feedback-mode question. No recording starts automatically. Tap Speak, then Done speaking; recordings stop after 60 seconds. A pause in speech does not submit the request. Say “send my request” or tap Send request to submit.

## Configure keys locally

From the repository root:

```sh
python3 scripts/conversation_gateway.py --configure
```

Paste `GROQ_API_KEY` and `DEEPSEEK_API_KEY` at the hidden prompts. They are written atomically to `.local/assistant-secrets.json` (0600), excluded by Git. No provider API keys go in the app, chat or xcconfig. Blank input preserves an existing key. The script prints a separate **App access code**. Keep it locally.

Start the service:

```sh
python3 scripts/conversation_gateway.py --lan
```

Default port: **8788**, independent of the BusTech booking hub on 8787. Without `--lan`, it listens only on localhost. Keep the terminal running. Restart the service after changing keys or model configuration.

On the same network, enable the flag. Distribution builds can include the service address and App access code using the bundled-connection setup below; they reload automatically on every launch. Unconfigured developer builds still offer manual entry. The address override and flag persist; manually entered codes are session-only. “Check assistant connection” checks connectivity and presence of keys, not validity of provider accounts or quota.

The existing **BusTech signal hub** address and bridge token still configure actual booking delivery. Assistant access code and bridge token are separate. A connected assistant does not imply a connected booking hub.

Defaults: Groq `whisper-large-v3`, DeepSeek `deepseek-flash`, non-thinking JSON mode. The environment variables `GROQ_MODEL` and `DEEPSEEK_MODEL` override these. Providers are isolated behind `Providers`; the iOS app uses `ConversationServing`.

## Interaction and data boundaries

- Groq receives the audio and a short stop-name vocabulary. DeepSeek receives the transcription, selected journey, stop candidates, current structured draft, last question and up to six recent turns. Exact GPS coordinates are not sent; the app obtains nearby candidates from its transit data.
- GPS proximity never selects a boarding stop. A user selection or explicit matching stop reference is needed. Unknown stop references become search terms, followed by candidate buttons. Route/stop matching is checked again against local transit data and live arrivals before submitting.
- A selected route/stop is reused. Missing fields in a model patch preserve existing values; explicit corrections update only the relevant fields. Wheelchair use does not automatically request a ramp. Vision support is independent of mobility need.
- Model output cannot acknowledge a booking, invent an ETA or execute a bus action. The server produces fixed question types and factual summary templates; SwiftUI renders fixed components. Only the existing booking service can advance delivery status.
- Spoken feedback is automatic when the passenger states a vision need; VoiceOver uses accessibility announcements without duplicate app speech. Sighted wheelchair users get the same visual card and large controls. System reading, audio interruptions and real-device VoiceOver still need hands-on checks.
- The gateway keeps conversation state and recent transcripts in memory, expiring after 30 minutes. It does not write recordings/transcripts to disk or log provider responses. Local recording files are deleted after encoding or when the screen exits. Provider retention is governed separately by the provider account settings.
- Session IDs isolate drafts, revision checks reject stale turns, and turn IDs make retries idempotent. Ambiguous network failures retain the exact pending turn for retry. Explicit server rejections permit a new input. Leaving the screen cancels local work/recording; a completed server turn can still be recovered by retrying its ID.

## Testing

Backend state tests, no API calls:

```sh
python3 -m unittest discover -s scripts/conversation -p 'test_*.py' -v
```

For simulator UI tests, start the explicit test fixture in a second terminal:

```sh
python3 scripts/conversation/ui_fixture.py
```

`testConversation*` UI tests connect to that localhost fixture. It has fixed interpretation responses, uses no provider keys and never sends bookings itself. Existing mock booking tests remain separate from real-hub tests. Run the normal Xcode test scheme, or select the conversational tests and the unit-test target. Do not expose the fixture on a LAN.

Live acceptance checks after keys are available:

1. Select a bus; say “I use a wheelchair and need more time.” Verify the selected journey is reused, More time appears, and the assistant asks about a ramp.
2. Answer “yes”, then “no ramp, keep the extra time.” Verify only Ramp disappears.
3. Say “I cannot see well; help me identify the bus.” Verify vision support enables spoken feedback without erasing the mobility need.
4. Try global Assistant with a stop code and route. Confirm a correct stop candidate; verify a wrong route cannot be sent.
5. Tap Send request; verify actual hub receipt, then the existing persistent trigger card and one haptic.
6. Disconnect the network mid-turn. Reconnect and retry; verify one state update. Turn the flag off and exercise the original voice and manual paths.

## Version 1 limits

This is a local development gateway using Python's standard-library HTTP server and a shared local access code. Public deployment requires HTTPS, per-user authentication, quota/rate limiting and a managed service. Cloud conversations require internet. Multiple phones have independent conversational drafts, but the existing BusTech hub still supports a single active booking: this change does not add multi-passenger vehicle matching.

This version uses English UI and spoken prompts; transcription accepts multiple languages without a language selector. Do not infer measured recognition accuracy, real-world usability or noisy-station robustness from deterministic tests. Those require real recordings and users. Drafts are not restored after app/service restart.

## Verification record (2026-10-02)

- Gateway: 17 state and localhost HTTP tests passed, including authentication, idempotent retries, session separation, corrections, ramp consent, and rejecting a negated send even when the model misclassifies it.
- iOS: 51 unit tests passed; the real-hub integration test was skipped because its environment was not supplied.
- Seven related UI flows passed across the verification runs: original global voice, original selected-bus voice, original manual request, flag persistence and restoration, new card correction and submission, global text follow-up at maximum accessibility text size, and unconfigured-service recovery to Map.
- Simulator screenshots were reviewed. Fixed an accessibility identifier propagation issue, grouped the error icon and text, shortened visual ready-state copy, and fixed icon overlap at maximum Dynamic Type.
- No provider credentials were present during verification. Real Groq audio transcription, DeepSeek interpretation, noisy-environment accuracy, physical-device recording/VoiceOver and multi-phone live hub operation remain unverified. The UI fixture never calls either provider.

## Live provider verification (2026-10-02, after key setup)

Both configured API keys authenticated successfully. Groq rejected Python's default User-Agent with HTTP 403 / error 1010; provider requests now use `BusPulseAssistant/1.0`, with a regression test for that header. All 18 gateway state/HTTP/provider-header tests pass.

A synthetic English recording was transcribed correctly by Groq Whisper and interpreted by DeepSeek. Six live turns verified wheelchair + more time, yes to the ramp question, declining the ramp while retaining more time, adding vision support while retaining wheelchair need, refusing to send, and explicitly requesting send. No test submitted a booking to the hub. The combined synthetic-audio first turn took 1.22 seconds in this run; this is not a measured phone or noisy-station latency benchmark.

The running gateway's authenticated `/health` responded ready via both localhost and the Mac's current LAN address. A real DeepSeek turn through `/v1/turn` over LAN returned the expected help card state. Service binds port 8788; LAN addresses can change when switching networks. Runtime PID/log are under `.local/` and remain excluded from Git.

Physical-phone recording, VoiceOver listening, noisy-environment accuracy and actual hub delivery through the new UI still require device testing. This verification did not install or launch a new phone build.

## Stop retrieval correction (2026-10-02)

Named locations now produce a search query against the app's complete cached transit catalogue. The new assistant uses separate conversational retrieval (normal map search is unchanged): common LTA abbreviations, B4/Before, road suffixes and bounded spelling edits. Before/After/Opposite are not interchangeable. Numeric stop codes require exact matches. Search runs in the existing search actor.

After local retrieval, the app automatically completes a `stops` event without another model inference. One match asks a specific confirmation with name, road and code; multiple matches require a choice; zero matches explain recovery instead of repeating the generic boarding question. Candidates come only from transit records. A yes confirms only one offered result; ambiguous yes cannot select even if the model proposes a stop. Existing selected journey and help fields survive unrelated corrections. The UI uses the same path for typed text and Groq transcripts, behind the existing feature flag.

See [text evaluation](stop-dialogue-evaluation.md) for measured results, the discovered companion-needs failure, corrections and limits. The reproducible real-provider test is `python3 scripts/conversation/evaluate_live.py`; it uses synthetic inputs and never submits bookings.

## Bundled distribution connection

Generate local build defaults with:

```sh
python3 scripts/configure_assistant_build.py --address http://YOUR_MAC_IP:8788
```

This reads the existing gateway access code (and local booking hub token when present), writes ignored `Config/Assistant.local.xcconfig` with owner-only permissions, and embeds those credentials and the service address into subsequent Debug and Release builds. It does not embed Groq or DeepSeek API keys. Rebuild after changing defaults. The app loads them on every normal launch; a saved address override takes precedence. UI fixtures deliberately ignore bundled settings so missing-configuration tests remain valid.

The current LAN address requires a reachable Mac running the gateway. Installation of the same build on another phone does not make that private address reachable over the Internet. Distribution outside the LAN requires hosting the gateway at a stable HTTPS address and generating a new build with that address. A shared bundled code can be extracted from a distributed app; it is a distribution access credential, not a private provider API key.

Verification of bundled access: 53 unit tests passed with 1 live-hub test skipped; two UI tests passed, including a cold relaunch without any token environment variable followed by a successful authenticated health check. Packaged URL and gateway code matched the running service. Installed and launched the signed build on the physical iPhone without injecting credentials.
