#!/usr/bin/env python3
"""
Revanche audio pipeline — generates per-sentence French audio for every card
in app/packs/*.json that doesn't have its mp3 yet.

Runs in GitHub Actions (x86_64) with Piper TTS — NOT on-device TTS.
Voice: fr_FR-siwis-medium (neural, trained on the SIWIS corpus).

Usage:  python pipeline/generate_audio.py
Requires: pip install piper-tts ; ffmpeg on PATH.
"""
import json, glob, os, subprocess, sys, tempfile

APP = os.path.join(os.path.dirname(__file__), "..")
AUDIO_DIR = os.path.join(APP, "packs", "audio")
# Path to the downloaded .onnx voice (newer piper-tts needs a file, not a name)
VOICE = os.environ.get("PIPER_VOICE",
                       os.path.join(APP, "voices", "fr_FR-siwis-medium.onnx"))
os.makedirs(AUDIO_DIR, exist_ok=True)

def synth(text, out_mp3):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav = f.name
    try:
        subprocess.run(["piper", "--model", VOICE, "--output_file", wav],
                       input=text.encode("utf-8"), check=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav,
                        "-codec:a", "libmp3lame", "-qscale:a", "5", "-ar", "22050", out_mp3],
                       check=True)
    finally:
        if os.path.exists(wav): os.remove(wav)

def main():
    made, skipped = 0, 0
    for packfile in glob.glob(os.path.join(APP, "packs", "*.json")):
        if packfile.endswith("index.json"): continue
        pack = json.load(open(packfile, encoding="utf-8"))
        for c in pack.get("cards", []):
            rel = c.get("audio")
            if not rel: continue
            out = os.path.join(APP, rel)
            if os.path.exists(out): skipped += 1; continue
            os.makedirs(os.path.dirname(out), exist_ok=True)
            print("  ♪", c["id"], "—", c["fr"][:50])
            synth(c["fr"], out)
            made += 1
    print(f"Done: {made} generated, {skipped} already existed.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
