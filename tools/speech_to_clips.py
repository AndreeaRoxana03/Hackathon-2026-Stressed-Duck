#!/usr/bin/env python3
"""Render src/speech.txt into spoken clips embedded in the firmware.

speech.txt has three sections: [touch] (default; random line on each screen touch), [stressed] (random line when
the duck gets stressed) and [happy] (random line every so often while the duck is happy). Each non-empty line that does not start with # becomes one clip, spoken
with a neural voice from Microsoft Edge's online TTS (internet needed only while running this tool).

Usage:
    python tools/speech_to_clips.py [speech.txt] [output.bin] [--voice en-GB-RyanNeural] [--rate +0%] [--pitch +0Hz]

Output format (little endian): uint32 sample_rate, uint32 group_count, then per group (touch, stressed, happy)
uint32 clip_count followed by clips of uint32 sample_count + int16 samples.
Sample counts are padded to even so every record stays 4-byte aligned.
"""
import argparse
import asyncio
import struct
from pathlib import Path

import edge_tts
import miniaudio

SAMPLE_RATE = 16000  # 6.5 MB of app flash must hold the firmware plus every clip
SILENCE_THRESHOLD = 400
SILENCE_PAD_SECONDS = 0.1
GROUPS = ("touch", "stressed", "happy")


def trim_silence(samples):
    pad = int(SAMPLE_RATE * SILENCE_PAD_SECONDS)
    loud = [i for i, sample in enumerate(samples) if abs(sample) > SILENCE_THRESHOLD]
    if not loud:
        return samples
    return samples[max(loud[0] - pad, 0) : min(loud[-1] + pad + 1, len(samples))]


def read_groups(path: Path) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {name: [] for name in GROUPS}
    current = GROUPS[0]
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1].strip().lower()
            if current not in groups:
                raise SystemExit(f"Unknown section {line}; use one of {', '.join(f'[{g}]' for g in GROUPS)}")
            continue
        groups[current].append(line)
    return groups


async def synthesize(text: str, voice: str, rate: str, pitch: str) -> bytes:
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    mp3 = bytearray()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            mp3.extend(chunk["data"])
    if not mp3:
        raise SystemExit(f"No audio returned for: {text!r}")
    decoded = miniaudio.decode(
        bytes(mp3),
        output_format=miniaudio.SampleFormat.SIGNED16,
        nchannels=1,
        sample_rate=SAMPLE_RATE,
    )
    samples = bytes(trim_silence(decoded.samples))
    if (len(samples) // 2) % 2:
        samples += b"\x00\x00"
    return samples


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("speech", nargs="?", default="src/speech.txt")
    parser.add_argument("output", nargs="?", default="src/generated/speech_clips.bin")
    parser.add_argument("--voice", default="en-GB-RyanNeural")
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    args = parser.parse_args()

    groups = read_groups(Path(args.speech))
    if not any(groups.values()):
        raise SystemExit(f"No lines to speak in {args.speech}")

    blob = bytearray(struct.pack("<II", SAMPLE_RATE, len(GROUPS)))
    total = 0
    for name in GROUPS:
        lines = groups[name]
        blob += struct.pack("<I", len(lines))
        for line in lines:
            pcm = await synthesize(line, args.voice, args.rate, args.pitch)
            count = len(pcm) // 2
            blob += struct.pack("<I", count) + pcm
            print(f"{name:8} {count / SAMPLE_RATE:5.1f} s  {line}")
            total += 1

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(blob)
    print(f"Wrote {total} clips ({len(blob) / 1024:.0f} KiB) to {output}")


if __name__ == "__main__":
    asyncio.run(main())
