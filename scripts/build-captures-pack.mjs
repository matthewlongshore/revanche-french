// Morning build step (runs in GitHub Actions on a schedule).
// 1) fetch pending captures from Convex (typed text and/or voice recordings)
// 2) turn each into a natural French card using Groq:
//    - voice captures -> Groq Whisper (STT) then Groq Llama (compose)
//    - text captures  -> Groq Llama (compose)
// 3) write a pack JSON + update packs/index.json
// 4) mark the captures it used as processed in Convex
//
// Env (GitHub Actions secrets):
//   CONVEX_URL          https://your-deployment.convex.site  (HTTP actions URL)
//   CAPTURE_SECRET      shared secret, matches the Convex env var
//   GROQ_API_KEY        free Groq key (console.groq.com/keys)
// Optional: GROQ_MODEL (default "llama-3.3-70b-versatile"), GROQ_STT_MODEL (default "whisper-large-v3")
//
// Exits 0 (no-op) when anything is missing or there are no new captures.

import fs from "node:fs";
import path from "node:path";

const { CONVEX_URL, CAPTURE_SECRET, GROQ_API_KEY } = process.env;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3";
const PACKS = path.resolve("packs");

if (!CONVEX_URL || !CAPTURE_SECRET || !GROQ_API_KEY) {
  console.log("Missing CONVEX_URL / CAPTURE_SECRET / GROQ_API_KEY — skipping.");
  process.exit(0);
}

const q = (p) => `${CONVEX_URL.replace(/\/$/, "")}${p}?secret=${encodeURIComponent(CAPTURE_SECRET)}`;

// --- 1) pending captures ---
let pending = [];
try {
  const r = await fetch(q("/pending"));
  if (!r.ok) throw new Error(`pending ${r.status}`);
  pending = await r.json();
} catch (e) {
  console.log("Could not reach Convex:", e.message, "— skipping.");
  process.exit(0);
}
if (!Array.isArray(pending) || pending.length === 0) {
  console.log("No new captures this morning.");
  process.exit(0);
}

// --- Groq helpers ---
async function groqJson(instruction, userText) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: userText },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices?.[0]?.message?.content || "{}");
}

async function groqTranscribe(blob) {
  const form = new FormData();
  form.append("model", GROQ_STT_MODEL);
  form.append("file", blob, "capture.m4a");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq STT ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.text || "").trim();
}

const INSTR =
  `You are a French tutor. The user gives a rough note (or a transcribed voice note) about ` +
  `something they couldn't say in French, or an expression they want to drill (e.g. "mine de rien"). ` +
  `The input may be unclear or mix English and French — infer their intent, don't translate literally. ` +
  `Produce the natural, idiomatic French they're reaching for. ` +
  `Respond with ONLY a JSON object {"fr","en","note"}: fr = natural colloquial French; ` +
  `en = short English gloss; note = brief usage/grammar tip.`;

const built = []; // { card, id }
for (const c of pending) {
  try {
    let source;
    if (c.audioUrl) {
      const ab = await (await fetch(c.audioUrl)).arrayBuffer();
      const blob = new Blob([ab], { type: c.mime || "audio/mp4" });
      source = await groqTranscribe(blob);
      if (!source) { console.error("Empty transcription, skipping a capture."); continue; }
    } else if (c.text && c.text.trim()) {
      source = c.text.trim();
    } else {
      continue;
    }
    const card = await groqJson(INSTR, source);
    if (card && card.fr) built.push({ card, id: c._id });
  } catch (e) {
    console.error("Skipping a capture:", e.message);
  }
}
if (built.length === 0) {
  console.log("No cards built this morning.");
  process.exit(0);
}

// --- 3) write pack + index ---
const today = new Date().toISOString().slice(0, 10);
const mmdd = today.slice(5).replace("-", "");
let id = `cap-${today}`, file = `${id}.json`, n = 2;
while (fs.existsSync(path.join(PACKS, file))) { id = `cap-${today}-${n}`; file = `${id}.json`; n++; }

const cards = built.map((b, i) => {
  const cid = `cap${mmdd}-${String(i + 1).padStart(2, "0")}`;
  return {
    id: cid, fr: b.card.fr, en: b.card.en || "", note: b.card.note || "",
    scene: "Mes captures", isPersonal: true, audio: `packs/audio/${cid}.mp3`,
  };
});
const pack = { id, title: `Mes captures — ${today}`, type: "personal", date: today, cards };
fs.writeFileSync(path.join(PACKS, file), JSON.stringify(pack));

const idxPath = path.join(PACKS, "index.json");
const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
if (!idx.includes(file)) { idx.push(file); fs.writeFileSync(idxPath, JSON.stringify(idx)); }

// --- 4) mark only the captures we used ---
try {
  await fetch(q("/mark"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: built.map((b) => b.id) }),
  });
} catch (e) {
  console.log("Warning: could not mark captures processed:", e.message);
}

console.log(`Built ${cards.length} card(s) into ${file}.`);
