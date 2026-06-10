#!/usr/bin/env python3
"""
Revanche audio pipeline — generates per-sentence audio for every card in
app/packs/*.json that doesn't have its mp3 yet.

For each card it produces:
  <id>.mp3      the French sentence (voice: fr_FR-siwis-medium)
  <id>.en.mp3   the English prompt   (voice: en_US-amy-medium)  [if card has "en"]

The English clips power the hands-free "Balade" mode (English → gap → French).

Runs in GitHub Actions (x86_64) with Piper TTS — NOT on-device TTS.
Usage:  python pipeline/generate_audio.py
Requires: pip install piper-tts ; ffmpeg on PATH.
"""
import json, glob, os, subprocess, sys, tempfile

APP = os.path.join(os.path.dirname(__file__), "..")
AUDIO_DIR = os.path.join(APP, "packs", "audio")
# Paths to the downloaded .onnx voices (newer piper-tts needs a file, not a name)
VOICE_FR = os.environ.get("PIPER_VOICE",
                          os.path.join(APP, "voices", "fr_FR-siwis-medium.onnx"))
VOICE_EN = os.environ.get("PIPER_VOICE_EN",
                          os.path.join(APP, "voices", "en_US-amy-medium.onnx"))
os.makedirs(AUDIO_DIR, exist_ok=True)

def synth(text, out_mp3, voice):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav = f.name
    try:
        subprocess.run(["piper", "--model", voice, "--output_file", wav],
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
            os.makedirs(os.path.join(APP, os.path.dirname(rel)), exist_ok=True)
            # French answer
            out = os.path.join(APP, rel)
            if os.path.exists(out):
                skipped += 1
            else:
                print("  ♪ FR", c["id"], "—", c["fr"][:50])
                synth(c["fr"], out, VOICE_FR)
                made += 1
            # English prompt (for Balade hands-free mode)
            en = c.get("en")
            if en:
                en_rel = rel[:-4] + ".en.mp3" if rel.endswith(".mp3") else rel + ".en.mp3"
                en_out = os.path.join(APP, en_rel)
                if os.path.exists(en_out):
                    skipped += 1
                else:
                    print("  ♪ EN", c["id"], "—", en[:50])
                    synth(en, en_out, VOICE_EN)
                    made += 1
    print(f"Done: {made} generated, {skipped} already existed.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
