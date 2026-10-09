param(
    [string]$UploadPort = ""
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

python -m pip install -r requirements.txt

python tools/slice_sprite_sheet.py src/frames/happyDuckDance.jpg src/frames/happyDuck
python tools/slice_sprite_sheet.py src/frames/angryDuck.jpg src/frames/angryDuck
python tools/slice_sprite_sheet.py src/frames/duckssmart.jpg src/frames/smartDuck
python tools/slice_sprite_sheet.py src/frames/monitor.jpg src/frames/monitor
python tools/slice_sprite_sheet.py src/frames/walk3.jpg src/frames/walkDuck
python tools/slice_sprite_sheet.py src/frames/reverse3.jpg src/frames/reverseWalk 8

python tools/png_to_header.py src/frames/happyDuck src/generated/duck_happy_frames.h duck_happy 220 164
python tools/png_to_header.py src/frames/angryDuck src/generated/duck_stressed_frames.h duck_stressed 220 164
python tools/png_to_header.py src/frames/smartDuck src/generated/duck_smart_frames.h duck_smart 220 164
python tools/png_to_header.py src/frames/monitor src/generated/duck_monitor_frames.h duck_monitor 175 130
python tools/png_to_header.py src/frames/walkDuck src/generated/duck_walk_frames.h duck_walk 220 164 src/frames/angryDuck/frame_01.png
python tools/png_to_header.py src/frames/reverseWalk src/generated/duck_reverse_walk_frames.h duck_reverse_walk 220 164 src/frames/angryDuck/frame_01.png

python tools/speech_to_clips.py
python -m platformio run

if ($UploadPort) {
    python -m platformio run -t erase --upload-port $UploadPort
    python -m platformio run -t upload --upload-port $UploadPort
}

Write-Host "Setup complete."