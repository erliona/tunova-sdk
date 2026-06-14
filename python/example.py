"""Minimal example. Run from this directory so `tunova` resolves:

    TUNOVA_API_KEY=sk_live_… python example.py

tunova.py is stdlib-only — nothing to pip install.
"""
import os

from tunova import Tunova

t = Tunova(os.environ["TUNOVA_API_KEY"])

# Submit + poll until the track is delivered (billed only on success).
job = t.generate("calm rainy-night lofi", model="v5.5")

if job["status"] == "complete":
    print(job["clips"][0]["audio_url"])
else:
    print("failed (auto-refunded):", job["error"])
