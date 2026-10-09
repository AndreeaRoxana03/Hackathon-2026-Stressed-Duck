#!/usr/bin/env python3
"""Synthesize one line of text with the same Edge TTS voice used for src/speech.txt clips.

Called by the duck-agent host (packages/host/src/speech.ts) so a live agent response sounds like
the same voice as the embedded touch/stressed/happy clips instead of a generic system voice.
Reads UTF-8 text from stdin and writes raw 16 kHz mono signed 16-bit PCM to stdout.

Usage:
    python tools/synthesize_speech.py [--voice en-GB-RyanNeural] [--rate +0%] [--pitch +0Hz] < text.txt > out.pcm
"""
import argparse
import asyncio
import sys

import edge_tts
import miniaudio

SAMPLE_RATE = 16000
SILENCE_THRESHOLD = 400
SILENCE_PAD_SECONDS = 0.1


def trim_silence(samples):
    pad = int(SAMPLE_RATE * SILENCE_PAD_SECONDS)
    loud = [i for i, sample in enumerate(samples) if abs(sample) > SILENCE_THRESHOLD]
    if not loud:
        return samples
    return samples[max(loud[0] - pad, 0) : min(loud[-1] + pad + 1, len(samples))]


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
    parser.add_argument("--voice", default="en-GB-RyanNeural")
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    args = parser.parse_args()

    text = sys.stdin.buffer.read().decode("utf-8").strip()
    if not text:
        raise SystemExit("No text provided on stdin.")

    pcm = await synthesize(text, args.voice, args.rate, args.pitch)
    sys.stdout.buffer.write(pcm)


if __name__ == "__main__":
    asyncio.run(main())
