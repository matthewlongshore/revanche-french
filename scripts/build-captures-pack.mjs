// Morning build step (runs in GitHub Actions on a schedule).
// 1) fetch pending captures from Convex (typed text and/or voice recordings)
// 2) ask Gemini to turn each into a natural French card
//    - text captures  -> text prompt
//    - voice captures -> Gemini multimodal (it transcribes AND composes in one call)
// 3) write a pack JSON + update packs/index.json
// 4) mark the captures it successfully used as processed in Convex
//
// Env (GitHub Actions secrets):
//   CONVEX_URL          https://your-deployment.convex.site  (HTTP actions URL)
//   CAPTURE_SECRET      shared secret, matches the Convex env var
//   GEMINI_API_KEY      free Google Gemini key (aistudio.google.com)
// Optional: GEMINI_MODEL (default "gemini-2.0-flash")
//
// Exits 0 (no-op) when anything is missing or there are no new captures.

import fs from "node:fs";
import path from "node:path";

const { CONVEX_URL, CAPTURE_SECRET, GEMINI_API_KEY } = process.env;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const PACKS = path.resolve("packs");

if (!CONVEX_URL || !CAPTURE_SECRET || !GEMINI_API_KEY) {
  console.log("Missing CONVEX_URL / CAPTURE_SECRET / GEMINI_API_KEY — skipping.");
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

// --- 2) Gemini → cards ---
const TEXT_INSTR =
  `You are a French tutor. The following is a note from a learner about something they ` +
  `couldn't say in French, or an expression they want to drill. Infer the natural, idiomatic ` +
  `French they're reaching for. Return ONLY JSON {"fr","en","note"}: fr = natural colloquial ` +
  `French a native would say; en = short English gloss; note = brief usage/grammar tip.`;
const AUDIO_INSTR =
  `You are a French tutor. This is a ROUGH voice note from a learner describing a moment they ` +
  `couldn't express in French, or naming an expression they want to use (e.g. "mine de rien"). ` +
  `The audio may be unclear or mix English and French — infer their intent, don't transcribe ` +
  `literally. Produce the natural, idiomatic French they're reaching for. ` +
  `Return ONLY JSON {"fr","en","note"}.`;

async function geminiCard(parts) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let txt = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  return JSON.parse(txt); // { fr, en, note }
}

const built = []; // { card, id }
for (const c of pending) {
  try {
    let card;
    if (c.audioUrl) {
      const ab = await (await fetch(c.audioUrl)).arrayBuffer();
      const b64 = Buffer.from(ab).toString("base64");
      card = await geminiCard([
        { text: AUDIO_INSTR },
        { inlineData: { mimeType: c.mime || "audio/mp4", data: b64 } },
      ]);
    } else if (c.text && c.text.trim()) {
      card = await geminiCard([{ text: `${TEXT_INSTR}\n\nNote: ${c.text}` }]);
    } else {
      continue;
    }
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
    id: cid,
    fr: b.card.fr,
    en: b.card.en || "",
    note: b.card.note || "",
    scene: "Mes captures",
    isPersonal: true,
    audio: `packs/audio/${cid}.mp3`,
  };
});
const pack = { id, title: `Mes captures — ${today}`, type: "personal", date: today, cards };
fs.writeFileSync(path.join(PACKS, file), JSON.stringify(pack));

const idxPath = path.join(PACKS, "index.json");
const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
if (!idx.includes(file)) { idx.push(file); fs.writeFileSync(idxPath, JSON.stringify(idx)); }

// --- 4) mark only the captures we actually used ---
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
