# Firmware Integration Handoff

The firmware emits `EVENT:FIST_SLAM`, parses bounded host responses, and enters host-controlled mode after the first valid response. Until that handshake, it retains the offline stressed, walking, smart, and happy demonstration. If valid host responses stop for 10 seconds, it returns to happy and resumes the offline path.

The target host workflow preserves the existing 115200-baud line format. The host sends only `MOOD` and a short `COMMENT`; `FIX` and `EXPLAIN` remain empty. Full diagnosis, diffs, explanations, and verification stay in VS Code.

A complete hardware gate still requires physical testing of the receiver, host-driven stressed timing, smart hold timing, the explicit post-run cooldown, and USB-loss recovery. The receiver and backend-mode state handling are implemented in `src/main.cpp`.

## Mood Timing

- HAPPY: idle, aborted, failed, awaiting speech, or post-run cooldown.
- STRESSED: displayed for the first 3000 ms of a physical run. The firmware then quacks once and loops the walking animation while the host continues reporting STRESSED. Heartbeats must not restart the three-second timer or walking animation.
- COOL: successful short result with sunglasses. The host synthesizes the actual short response on Windows and sends PCM to the device speaker. No broker response text is drawn on the screen. COOL lasts through transfer and playback, then a 5000 ms hold, followed by HAPPY.
- After returning HAPPY, the host rejects knocks for 3000 ms. The sensor's existing 2000 ms debounce is independent.
- Parse only ordered `RESP|MOOD=<HAPPY|STRESSED|COOL>|COMMENT=<text>|FIX=|EXPLAIN=` lines. Bound the complete line to 1024 bytes and comment to 160 printable ASCII characters. Never interpret FIX/EXPLAIN as code.
- In backend mode, disable the offline stressed/smart timeouts and follow host moods. Send `ACK|MOOD=<HAPPY|STRESSED|COOL>` after each accepted response. If the host heartbeat expires, send `EVENT:HOST_TIMEOUT`, return to happy, and resume the offline fallback.
- The host sends the current mood once per second while the broker is running, including during long Studio investigations.

## USB Response Speech

Physical broker mode uses Windows `System.Speech` to synthesize the bounded response locally. Audio is raw mono 16 kHz signed 16-bit little-endian PCM, at most 529200 bytes. The computer speaker is not used, and no new cloud speech credentials are required.

- `AUDIO|BEGIN=<byte-count>` reserves the firmware buffer only in COOL. The device replies `ACK|AUDIO=0`.
- `AUDIO|DATA=<lowercase-hex>` transfers 64 PCM bytes per host line to fit the serial receive buffer during animation decoding; the firmware accepts at most 256 bytes. The host waits for `ACK|AUDIO=<cumulative-byte-count>` before sending the next chunk.
- `AUDIO|END` starts playback only after all declared bytes arrive. `ACK|AUDIO=DONE` signals actual speaker completion.
- `AUDIO|CANCEL`, a HAPPY transition, or heartbeat expiry cancels transfer/playback. Invalid transfer messages return `ACK|AUDIO=ERROR`.

Speech is sent once per completed successful run, never on repeated mood heartbeats. Synthesis, transfer, and playback have deadlines and support investigation cancellation. Speech errors are logged as `Duck speaker: ...`; an unrelated prerecorded line is not substituted. USB audio preparation/transfer adds latency before playback.

## Authenticated Voice Channel

Host endpoints use HTTPS on an explicitly configured private-network interface (default configured port: 53683). Pair a single device with a random bearer credential of at least 32 characters and pin/validate the host TLS certificate. Tokens and certificate private keys stay outside the repository and must not appear in serial logs. Firmware owns Wi-Fi, certificate validation, TTS playback, playback-complete indication, recording UI, microphone capture and upload. The host owns session validation and transcription.

1. Poll `GET /session` with `Authorization: Bearer <device-token>`.
2. A session contains `id`, `comment`, `expiresAt` and `state`. Play the matching clarification comment once when state is `awaiting_playback`. Associate it with the serial comment, do not play it twice.
3. After speaker playback finishes, post `POST /playback-complete?id=<id>` with the same authorization header. Only a valid session transitions to `listening`.
4. Record only for this session, with a visible listening indicator, then upload once to `POST /audio?id=<id>`, `Content-Type: audio/wav`. Format: mono 16 kHz, 16-bit PCM WAV, <=20 seconds, <=1 MiB.
5. Stop recording/uploading if polling reports cancellation or expiry. Never record while the speaker is playing. There is no always-on microphone or desktop-microphone fallback.

Sessions expire after 60 seconds; the host rejects incorrect IDs, duplicate uploads, uploads before playback completion and late transcription. STT has a 30-second deadline. Silence/error/cancel leaves HAPPY. Transcript continuation requests fresh context from the same window/root/file/version after cooldown, not a continuation of the original LLM run. Normal successful response speech uses the separate USB protocol above; the HTTPS audio upload endpoint is for clarification only.

## Hardware Gate

Confirm receiver/backend mode, actual stressed duration, smart/happy timing, typing cancellation, double-knock rejection, speaker-before-microphone ordering, paired TLS/audio upload, speech-to-fresh-context retry, and cancellation on context drift. Detailed code/diffs must appear only in VS Code. These gates require teammate firmware and provider credentials; automated host tests are not hardware confirmation.
