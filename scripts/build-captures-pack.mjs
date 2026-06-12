// Morning build step (runs in GitHub Actions on a schedule).
// 1) fetch pending captures from Convex
// 2) ask the LLM to turn them into natural French cards
// 3) write a pack JSON + update packs/index.json
// 4) mark those captures processed in Convex
//
// Env required (set as GitHub Actions secrets):
//   CONVEX_URL          e.g. https://your-deployment.convex.site   (the HTTP actions URL)
//   CAPTURE_SECRET      shared secret, must match the Convex env var
//   GEMINI_API_KEY      free Google Gemini API key (aistudio.google.com → Get API key)
// Optional:
//   GEMINI_MODEL        defaults to "gemini-2.0-flash"
//
// Exits 0 (no-op) when anything is missing or there are no new captures,
// so a quiet morning never fails the workflow.

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

// 1) pending captures
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

// 2) LLM → cards
const list = pending.map((c, i) => `${i + 1}. ${c.text}`).join("\n");
const prompt =
  `You are a French tutor. A learner logged moments when they couldn't say something in French ` +
  `(in English or broken French). For EACH numbered item, write the natural, idiomatic French they ` +
  `were reaching for. Return ONLY a JSON array (no prose, no code fence) of objects ` +
  `{"fr","en","note"} in the same order: "fr" = natural colloquial French a native would say; ` +
  `"en" = short English gloss; "note" = brief grammar/usage tip (the key structure or idiom).\n\nItems:\n${list}`;

const resp = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
    }),
  }
);
if (!resp.ok) {
  console.error("Gemini error:", resp.status, await resp.text());
  process.exit(1);
}
const data = await resp.json();
let txt = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
let cards0;
try {
  cards0 = JSON.parse(txt);
} catch (e) {
  console.error("Could not parse LLM JSON:\n", txt);
  process.exit(1);
}
if (!Array.isArray(cards0) || cards0.length === 0) {
  console.log("LLM returned no cards — skipping.");
  process.exit(0);
}

// 3) write pack + index
const today = new Date().toISOString().slice(0, 10);
const mmdd = today.slice(5).replace("-", "");
let id = `cap-${today}`, file = `${id}.json`, n = 2;
while (fs.existsSync(path.join(PACKS, file))) { id = `cap-${today}-${n}`; file = `${id}.json`; n++; }

const cards = cards0.map((c, i) => {
  const cid = `cap${mmdd}-${String(i + 1).padStart(2, "0")}`;
  return {
    id: cid,
    fr: c.fr,
    en: c.en,
    note: c.note || "",
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

// 4) mark processed
try {
  await fetch(q("/mark"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: pending.map((c) => c._id) }),
  });
} catch (e) {
  console.log("Warning: could not mark captures processed:", e.message);
}

console.log(`Built ${cards.length} card(s) into ${file}.`);
