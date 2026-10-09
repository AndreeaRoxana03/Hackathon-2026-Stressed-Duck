# Firmware Integration Handoff

Current firmware emits `EVENT:FIST_SLAM` and runs the offline five-second stressed plus five-second smart demonstration. It does not yet parse host responses or enter a backend-controlled state.

The target host workflow preserves the existing 115200-baud line format. The host sends only `MOOD` and a short `COMMENT`; `FIX` and `EXPLAIN` remain empty. Full diagnosis, diffs, explanations, and verification stay in VS Code.

A complete hardware gate requires a firmware receiver, backend-mode state handling, host-driven stressed timing, smart hold timing, and an explicit post-run cooldown. This document is a handoff specification, not a claim that those receiver changes already exist.

## Mood Timing

- HAPPY: idle, aborted, failed, awaiting speech, or post-run cooldown.
- STRESSED: real investigation duration, not the offline five-second timer.
- COOL: successful short result, held for 5000 ms by the host, then HAPPY.
- After returning HAPPY, the host rejects knocks for 3000 ms. The sensor's existing 2000 ms debounce is independent.
- Parse only ordered `RESP|MOOD=<HAPPY|STRESSED|COOL>|COMMENT=<text>|FIX=|EXPLAIN=` lines. Bound the complete line to 1024 bytes and comment to 160 printable ASCII characters. Never interpret FIX/EXPLAIN as code.
- In backend mode, disable the offline stressed/smart timeouts and follow host moods. Define an offline fallback with the hardware owner before testing disconnection.

## Authenticated Voice Channel

Host endpoints use HTTPS on an explicitly configured private-network interface (default configured port: 53683). Pair a single device with a random bearer credential of at least 32 characters and pin/validate the host TLS certificate. Tokens and certificate private keys stay outside the repository and must not appear in serial logs. Firmware owns Wi-Fi, certificate validation, TTS playback, playback-complete indication, recording UI, microphone capture and upload. The host owns session validation and transcription.

1. Poll `GET /session` with `Authorization: Bearer <device-token>`.
2. A session contains `id`, `comment`, `expiresAt` and `state`. Play the matching clarification comment once when state is `awaiting_playback`. Associate it with the serial comment, do not play it twice.
3. After speaker playback finishes, post `POST /playback-complete?id=<id>` with the same authorization header. Only a valid session transitions to `listening`.
4. Record only for this session, with a visible listening indicator, then upload once to `POST /audio?id=<id>`, `Content-Type: audio/wav`. Format: mono 16 kHz, 16-bit PCM WAV, <=20 seconds, <=1 MiB.
5. Stop recording/uploading if polling reports cancellation or expiry. Never record while the speaker is playing. There is no always-on microphone or desktop-microphone fallback.

Sessions expire after 60 seconds; the host rejects incorrect IDs, duplicate uploads, uploads before playback completion and late transcription. STT has a 30-second deadline. Silence/error/cancel leaves HAPPY. Transcript continuation requests fresh context from the same window/root/file/version after cooldown, not a continuation of the original LLM run. Normal roast TTS playback remains firmware-owned and is not implemented by the host's audio upload endpoint.

## Hardware Gate

Confirm receiver/backend mode, actual stressed duration, smart/happy timing, typing cancellation, double-knock rejection, speaker-before-microphone ordering, paired TLS/audio upload, speech-to-fresh-context retry, and cancellation on context drift. Detailed code/diffs must appear only in VS Code. These gates require teammate firmware and provider credentials; automated host tests are not hardware confirmation.
