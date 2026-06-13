// Morning build step: mine the latest "Real Life French" podcast episode into a pack.
// Fetches the RSS feed, asks Gemini to split the dialogue into a transcript + a handful
// of study cards, and writes an episode pack — but only if that episode isn't already mined.
//
// Env: GEMINI_API_KEY (required). Optional: GEMINI_MODEL, PODCAST_FEED.
// Exits 0 (no-op) on any problem or when there's no new episode, so it never breaks the deploy.

import fs from "node:fs";
import path from "node:path";

const { GEMINI_API_KEY } = process.env;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const FEED = process.env.PODCAST_FEED || "https://feeds.acast.com/public/shows/real-life-french";
const SOURCE = "Real Life French — Choses à Savoir";
const PACKS = path.resolve("packs");

if (!GEMINI_API_KEY) { console.log("No GEMINI_API_KEY — skipping episode."); process.exit(0); }

const stripCdata = (s = "") => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
const decodeHtml = (s = "") =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
   .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const stripHtml = (s = "") => decodeHtml(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();

// --- fetch RSS, take the latest <item> ---
let xml;
try {
  const r = await fetch(FEED);
  if (!r.ok) throw new Error(`feed ${r.status}`);
  xml = await r.text();
} catch (e) { console.log("Could not fetch feed:", e.message, "— skipping."); process.exit(0); }

const item = (xml.match(/<item>([\s\S]*?)<\/item>/) || [])[1];
if (!item) { console.log("No items in feed — skipping."); process.exit(0); }
const pick = (re) => { const m = item.match(re); return m ? m[1].trim() : ""; };

const title = stripCdata(pick(/<title>([\s\S]*?)<\/title>/)) || "Épisode";
const mp3 = pick(/<enclosure[^>]*\burl="([^"]+)"/);
const link = stripCdata(pick(/<link>([\s\S]*?)<\/link>/)) || stripCdata(pick(/<guid[^>]*>([\s\S]*?)<\/guid>/));
const pubDate = pick(/<pubDate>([\s\S]*?)<\/pubDate>/);
let dialogue = stripHtml(stripCdata(pick(/<description>([\s\S]*?)<\/description>/)));

if (!mp3) { console.log("No audio URL in latest item — skipping."); process.exit(0); }

const d = pubDate ? new Date(pubDate) : new Date();
const date = isNaN(d) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
const slug = (link || "").replace(/[?#].*$/, "").replace(/\/$/, "").split("/").pop() || "episode";
const id = `ep-${date}-${slug}`.slice(0, 80);
const file = `${id}.json`;

if (fs.existsSync(path.join(PACKS, file))) { console.log("Episode already mined:", file); process.exit(0); }

// dialogue fallback: episode page og:description
if (!/[A-Za-zÀ-ÿ]+\s*:/.test(dialogue) && link) {
  try {
    const html = await (await fetch(link)).text();
    const og = (html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/) ||
                html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/) || [])[1];
    if (og) dialogue = decodeHtml(og).trim();
  } catch (e) {}
}
if (!dialogue || dialogue.length < 20) { console.log("No usable dialogue — skipping."); process.exit(0); }

// --- Gemini: transcript + cards ---
const prompt =
  `You are a French tutor building a study pack from a short French podcast dialogue.\n` +
  `Episode title: "${title}".\nDialogue:\n${dialogue}\n\n` +
  `Return ONLY JSON: {"transcript":[{"speaker","fr","en"}],"cards":[{"fr","en","note"}]}.\n` +
  `transcript = the dialogue split into speaker turns, each with a short English gloss "en".\n` +
  `cards = 5 to 7 of the most useful, idiomatic sentences/expressions a learner should own, ` +
  `each a clean natural standalone French sentence with a short English gloss and a brief ` +
  `usage/grammar note.`;

let out;
try {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, responseMimeType: "application/json" } }) }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let txt = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  out = JSON.parse(txt);
} catch (e) { console.log("Gemini failed:", e.message, "— skipping episode."); process.exit(0); }

const mmdd = date.slice(5).replace("-", "");
const cards = (out.cards || []).filter((c) => c && c.fr).map((c, i) => {
  const cid = `ep${mmdd}-${String(i + 1).padStart(2, "0")}`;
  return { id: cid, fr: c.fr, en: c.en || "", note: c.note || "", scene: title,
           audio: `packs/audio/${cid}.mp3` };
});
if (!cards.length) { console.log("No cards from episode — skipping."); process.exit(0); }

const transcript = (out.transcript || []).filter((t) => t && t.fr)
  .map((t) => ({ speaker: t.speaker || "", fr: t.fr, en: t.en || "" }));

const pack = {
  id, title, type: "episode", date,
  episode: { title: `${title} 🎧`, mp3, source: SOURCE, transcript },
  cards,
};
fs.writeFileSync(path.join(PACKS, file), JSON.stringify(pack));

const idxPath = path.join(PACKS, "index.json");
const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
if (!idx.includes(file)) { idx.push(file); fs.writeFileSync(idxPath, JSON.stringify(idx)); }

console.log(`Mined episode "${title}" → ${file} (${cards.length} cards, ${transcript.length} lines).`);
