# Stressed Ducks

CoreS3 firmware for an animated duck that reacts to table vibrations.

## Requirements

- Windows PowerShell
- Python 3.10 or newer
- A USB-connected M5Stack CoreS3

## First-time setup

Open PowerShell in this directory and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\tools\setup.ps1
```

The script installs Pillow and PlatformIO, slices the three source sprite sheets, generates the embedded PNG headers, and builds the firmware.

To also erase and flash a connected board:

```powershell
.\tools\setup.ps1 -UploadPort COM4
```

Replace `COM4` with the port shown by `python -m platformio device list`.

## Firmware behavior

- The duck starts in the happy state.
- A table punch above the tuned vibration threshold switches to the stressed animation.
- After 5 seconds, it switches to the smart duck state for 5 seconds, then returns to happy.
- Buttons A, B, and C select happy, stressed, and smart states for testing.

The independent TypeScript host and VS Code client are in [duck-agent/README.md](duck-agent/README.md). The current firmware is still an offline demo: it emits `EVENT:FIST_SLAM` but does not yet parse host responses.

The host now supports focused-editor context, bounded Studio tool investigation, snapshot-checked edits, cancellation/cooldown and an optional authenticated CoreS3 audio/transcription channel. Firmware receiver/backend mode, TTS, microphone capture and Wi-Fi pairing remain teammate-owned integration work. The shared contract and hardware verification gates are in [duck-agent/docs/firmware-integration.md](duck-agent/docs/firmware-integration.md).

## Source assets and generated files

Keep the original `.jpg` sprite sheets, Python tools, C++ source, and `platformio.ini` in Git.

The following are intentionally ignored because the setup script recreates them:

- `.pio/` PlatformIO build and dependency cache
- `src/frames/*/frame_*.png` sliced animation frames
- `src/generated/*.h` embedded PNG headers

Do not commit those generated outputs unless the team specifically decides to vendor build artifacts.