# Stressed Duck Agent

This is an independent TypeScript host and VS Code extension for the Stressed Ducks project.

## Current status

The host implements Studio JSON/SSE calls, OAuth/static authentication, bounded multi-leg local-tool continuation, authenticated named-pipe IPC, focused-window heartbeats, fresh editor context requests for hardware knocks, structured results, cancellation, and cooldown. The extension captures selections, diagnostics, document versions and symbols, shows full results, and automatically applies snapshot-checked fixes in VS Code without saving. Edits are undoable and require no acceptance.

The optional HTTPS CoreS3 audio channel implements expiring one-use clarification sessions, playback-complete gating, WAV validation and OpenAI-compatible transcription. A valid transcript requests fresh context from the same originating window/file/version after cooldown; context drift discards it. No typed clarification prompt or computer-microphone fallback is provided.

The firmware receiver/backend mode is implemented but not yet hardware-verified; TTS/microphone/network implementation, certificate pairing, USB-loss reconnection, and an actual voice-to-new-run session also remain to be tested. Live Studio tool continuation and the Extension Development Host UI require a smoke test. The current tool host reads disk files; unsaved editor excerpts are supplied separately, so checks do not verify unsaved proposed edits. Diagnosis conservatively aborts on any editor text change in its workspace; precise read-document tracking, owner-only pipe ACLs, and user model switching remain follow-up work.

The host sends only a validated mood and short comment to the duck. `FIX` and `EXPLAIN` remain empty for wire compatibility.

## Requirements

- Node.js 22 or newer
- npm
- A trusted local VS Code workspace on Windows

## Local checks

From this directory:

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run simulator
npm run studio-check
npm run mock-run
npm run broker
npm run package:extension
```

`npm run simulator` is fully offline and exercises two SSE legs, a bounded local read, structured results and mood transitions. Set `DUCK_WORKSPACE_ROOT` for its read-only fixture root, otherwise it uses the current directory. `npm run studio-check` validates the configured agent and models. `npm run mock-run` performs a real Studio connection test while replacing the duck with an in-process mock serial device.

## Configuration

Copy `config.example.json` to `config.json` if you want file-based settings. `config.json` is ignored by Git. Environment variables override its values.

### Studio setup

1. Create or open the agent in [Trimble AI Studio](https://studio.dev.trimble-ai.com/agents), add at least one model, and save the configuration.
2. Record the agent ID from Studio. Use `latest` for the configuration unless you need a specific configuration ID.
3. Choose one authentication method:

For the agent configuration itself:

- **Name:** `Stressed Duck`.
- **Instructions:** paste the contents of [agent/instructions.md](agent/instructions.md). The output contract is intentionally different from a generic `duck_reaction` schema: this host reads `status`, `roast`, string `diagnosis`, string `explanation`, `verification`, and optional `clarificationQuestion`.
- **Models:** select one supported model and use its exact ID for `DUCK_STUDIO_MODEL_ID`. Prefer a low temperature or deterministic setting when Studio exposes one, because the final response must be JSON.
- **Reasoning effort:** set this to `none` or disabled when function tools are enabled. The current Studio chat-completions adapter rejects function tools for `gpt-6.1-sol-dzs` when a non-`none` `reasoning_effort` is configured. Keep the host tools enabled; do not remove them to work around this setting.
- **Knowledge Libraries:** leave empty for the first test. The host supplies the active editor and workspace evidence and can search the trusted workspace itself. If stable documentation is added later, do not add secrets or the whole source tree.
- **Tools:** do not add separate filesystem, shell, or tools. The host sends these bounded tools at runtime: `read_file`, `search_files`, `git_diff`, `run_tests`, and `propose_edit`. Enable the agent's generic tool-calling capability if Studio presents it as a separate option.
- **Skills and Sub-agents:** leave empty for the first test. Tool continuation is bounded by the host.
- **Image generation:** Off.
- **Citations:** Off unless required by the selected Studio model; citations or extra wrappers can break the JSON-only response contract.
- **Sharing:** keep the agent private while testing.

If Studio offers a structured response or JSON-object setting, enable it. The prompt still requires JSON because the host also validates the response itself.

Static access token:

```powershell
$env:DUCK_STUDIO_ACCESS_TOKEN="<access token>"
```

Interactive dev OAuth:

```powershell
$env:DUCK_OAUTH_CLIENT_ID="<OAuth client ID>"
$env:DUCK_OAUTH_CLIENT_SECRET="<OAuth client secret>"
```

The OAuth application must allow this exact loopback callback:
`http://127.0.0.1:53682/callback`. You may register/manage the application through the dev Trimble Cloud Console at `https://console.dev.api.trimblecloud.com/guest/home`, if your account exposes OAuth application registration there. That console is not the OAuth issuer and must not be used as `DUCK_OAUTH_BASE_URL`. The dev Studio API is `https://agents.dev.trimble-ai.com`; this client uses the separate OAuth authority `https://stage.id.trimblecloud.com` by default. If the application registration shows a different issuer, set `DUCK_OAUTH_BASE_URL` to that issuer.

For Windows onboarding, set the documented `DUCK_*` values once as User environment variables. The host automatically fills missing values from the current user's Windows environment (`HKCU\Environment`) before every CLI command, while explicit process variables remain higher priority. This means existing terminals can run the host without repeating `$env:` assignments. On non-Windows systems, use the normal process environment or a launcher script.

The core Studio values are:

```powershell
$env:DUCK_STUDIO_BASE_URL="https://agents.dev.trimble-ai.com"
$env:DUCK_STUDIO_AGENT_ID="<agent ID>"
$env:DUCK_STUDIO_CONFIG_ID="latest"
$env:DUCK_STUDIO_MODEL_ID="<model ID>"
```

Then, from the `duck-agent` directory, test the real Studio connection with:

```powershell
npm run studio-check
npm run mock-run
```

The first command performs the metadata request. The second sends a mocked `EVENT:FIST_SLAM`, runs the configured agent through SSE, and prints the mock duck's `STRESSED`, `COOL`, and `HAPPY` responses. Credentials are never stored in the repository.

### VS Code broker

#### One-time Windows setup

Each developer needs one local broker token shared only between their host and VS Code extension. Run this once in PowerShell; it stores the token as a Windows User environment variable and enables mock hardware plus verbose broker events:

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()

$env:DUCK_BROKER_TOKEN = [Convert]::ToBase64String($bytes)
[Environment]::SetEnvironmentVariable("DUCK_BROKER_TOKEN", $env:DUCK_BROKER_TOKEN, "User")

$env:DUCK_MOCK_DUCK = "1"
$env:DUCK_VERBOSE = "1"
[Environment]::SetEnvironmentVariable("DUCK_MOCK_DUCK", "1", "User")
[Environment]::SetEnvironmentVariable("DUCK_VERBOSE", "1", "User")
```

Do not rerun this block unless you intend to rotate the local token. The host reads these values from the Windows user environment automatically. Restart VS Code after adding or changing `DUCK_BROKER_TOKEN` so the extension host inherits the same token. This token is only for the local named pipe; it is separate from the Trimble OAuth client secret.

Start the broker from the `duck-agent` directory and leave its terminal open:

```powershell
npm run broker
```

The broker defaults to the Windows named pipe `\\.\pipe\stressed-duck`. Install the extension in regular VS Code with:

```powershell
npm run package:extension
code --install-extension "$PWD\packages\vscode-extension\stressed-duck-0.1.0.vsix" --force
```

You can also use **Extensions: Install from VSIX** and select `packages/vscode-extension/stressed-duck-0.1.0.vsix`. Reload VS Code after installation. Alternatively, launch the Extension Development Host for a temporary development window. Physical events request fresh context from a focused registered window; no focused trusted editor means no investigation. Heartbeats expire after six seconds and cancel an orphaned run without stopping the daemon. **Stressed Duck: Broker Status** and **Stressed Duck: Stop Run** are also available.

Open windows are detected automatically by the installed extension. Each active extension host sends an authenticated heartbeat every second with its window focus and workspace-trust state. A real fist event is routed to the latest focused, trusted window, which captures its active editor. The extension reads `DUCK_BROKER_TOKEN` from its process environment first and falls back to the current Windows user's `HKCU\\Environment` value when needed, so an older VS Code process can still discover the token. Reload VS Code after installing the extension. If an old process-level token is still set after rotating the user-level token, restart VS Code or clear the process-level variable so the new token can be used.

Authenticated IPC requires protocol version 1; incompatible clients are rejected before their command executes. Update the host and extension together.

With `DUCK_MOCK_DUCK=1`, the Command Palette command **Stressed Duck: Trigger** is the no-hardware punch simulation. The terminal prints events such as:

```text
FIST_SLAM simulated by the VS Code command; fresh context received.
MOCK_DUCK_RECEIVED RESP|MOOD=STRESSED|COMMENT=I am inspecting the evidence.|FIX=|EXPLAIN=
MOCK_DUCK_RECEIVED RESP|MOOD=COOL|COMMENT=<short roast>|FIX=|EXPLAIN=
MOCK_DUCK_RECEIVED RESP|MOOD=HAPPY|COMMENT=Ready.|FIX=|EXPLAIN=
```

With a physical duck, the first line instead reads `FIST_SLAM detected; requesting fresh context from the focused VS Code window.` `npm run mock-run` is a separate Studio connectivity check; it does not capture an active VS Code editor. The offline `npm run simulator` does not contact Studio.

Launch the host independently with `scripts/start-broker.ps1`; extensions never spawn or own it. Stop the host using Ctrl+C in its terminal. Stopping an investigation does not stop the host or unsubscribe serial. Run duration defaults to two minutes, with at most 16 Studio legs and 32 local calls. Physical runs start with three seconds of stressed animation, then walking with a quack. Success shows sunglasses, speaks the short response through the CoreS3 speaker using Windows-generated PCM over USB, holds smart for five seconds after playback, then returns happy with a three-second cooldown. Failure/abort/clarification enter happy cooldown immediately. Knocks during work, smart hold, speech, or cooldown are discarded, not queued.

The broker cancels work/speech on serial disconnection and reconnects to the selected device with backoff capped at 30 seconds. New connections flush buffered data and start HAPPY; stale knocks are not replayed. An explicit port setting remains pinned to that port, so update it if Windows assigns a different port. Close any serial monitor if the device is busy.

Tools support bounded reads, literal searches, Git status/diffs, user-allowlisted checks, and cumulative staged fixes. LF and CRLF are normalized for exact matching; empty replacement text supports deletion. After an edit, file reads return staged content. Secret paths and outside-root symlink/junction targets are rejected. Regex searches are intentionally disabled. Commands are disabled by default; configure exact trusted commands in the host environment:

```powershell
$env:DUCK_ALLOWED_COMMANDS='["npm test","npm run typecheck","npm run build"]'
```

Commands use `shell:false`, a 60-second timeout and capped output; Windows cancellation uses `taskkill /T` to terminate child process trees. This is not an OS sandbox: trusted build/test scripts can run arbitrary workspace code. Use an OS sandbox for hostile projects. Editor excerpts, symbols, diagnostics, selected text and requested tool output are transmitted to the configured Studio service. Credential filename exclusions do not detect every secret embedded in source files. Review the workspace before enabling remote diagnosis. Automatic application checks full content immediately before VS Code's version-checked `TextEditor.edit`; concurrent changes or editor closure block the edit. Checks run before application and therefore do not prove a staged fix works.

The duck receives only the short mood comment. The **Stressed Duck Result** panel opens as soon as a run starts and updates live with the current phase, animated progress, chronological tool activity, diagnosis, explanation, verification, fixes, and actual edit outcomes. Fixes are automatically applied to unchanged trusted editor documents after the run, without saving. Completed fixes survive investigation failures; cancellation and clarification discard fixes. The output channel remains available for live milestones. Tests run on disk, not staged or unsaved fixes, so successful checks do not prove those fixes work. Save the target before triggering if its unsaved content differs from disk; the extension refuses mismatched snapshots.

From the `duck-agent` directory, an easy development launch is:

```powershell
code --extensionDevelopmentPath="$PWD\packages\vscode-extension" "$PWD"
```

Set `DUCK_MOCK_DUCK=0` for the physical CoreS3 path; the broker will select the CoreS3 serial device instead of the mock transport. The firmware enters host-controlled mode after the first valid mood response and returns an `ACK|MOOD=...` line. The broker refreshes the current mood every second so long Studio runs do not trigger the firmware fallback timeout.

### CoreS3 Voice Clarification

The audio server is disabled unless `DUCK_AUDIO_HOST` is set. Configure an explicit LAN interface, TLS certificate/private-key files outside the repository, and a random per-device bearer token of at least 32 characters. The device must validate/pin the host certificate; never disable TLS validation or expose this listener publicly. No firewall rule is installed automatically.

Set `DUCK_AUDIO_PORT` (default 53683), `DUCK_AUDIO_CERT_FILE`, `DUCK_AUDIO_KEY_FILE`, `DUCK_AUDIO_DEVICE_TOKEN`, `DUCK_STT_ENDPOINT` (HTTPS audio-transcriptions endpoint), `DUCK_STT_MODEL`, and `DUCK_STT_API_KEY` in the broker environment. A provider is required; Studio itself is not assumed to offer transcription. Environment examples are documentation, not automatically loaded dotenv files.

The paired device polls `GET /session`, plays the matching short comment exactly once, posts `POST /playback-complete?id=<session-id>`, then records and posts `POST /audio?id=<session-id>` with `Content-Type: audio/wav`. Every request requires `Authorization: Bearer <device-token>`. Session IDs are one-use, expire after 60 seconds, and reject wrong/out-of-order/replayed uploads. Clips must be mono 16 kHz, 16-bit PCM WAV, at most 20 seconds and 1 MiB. Transcription times out after 30 seconds. See [docs/firmware-integration.md](docs/firmware-integration.md).

Clarification audio is bounded in memory, not persisted by this host, and discarded after the request/transcription. Provider retention follows the provider's policy. Successful response playback is separate: the physical Windows broker synthesizes the actual short message locally and transfers bounded mono PCM over USB to the device speaker. It never plays the response on the computer speaker or prints it on the device screen. This does not implement device microphone capture or the HTTPS clarification pairing flow.

`npm run live` opens the real serial port when a CoreS3 is available. The broker command is the full VS Code-connected path; `live` remains a direct hardware smoke test without focused-editor context.

