#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = path.join(rootDir, "frontend");
const requireFromFrontend = createRequire(path.join(frontendDir, "package.json"));
const { Chess } = requireFromFrontend("chess.js");

const OUTPUT_PATH = path.join(frontendDir, "public", "public-games.json");
const OPENINGS_PATH = path.join(frontendDir, "public", "openings.json");
const MAX_GAMES = 260;

const PGN_MENTOR_BASE = "https://www.pgnmentor.com/events/";
const SOURCES = [
  { name: "World Championship 2024", url: `${PGN_MENTOR_BASE}WorldChamp2024.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2023", url: `${PGN_MENTOR_BASE}WorldChamp2023.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2021", url: `${PGN_MENTOR_BASE}WorldChamp2021.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2018", url: `${PGN_MENTOR_BASE}WorldChamp2018.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2016", url: `${PGN_MENTOR_BASE}WorldChamp2016.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2014", url: `${PGN_MENTOR_BASE}WorldChamp2014.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2013", url: `${PGN_MENTOR_BASE}WorldChamp2013.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2012", url: `${PGN_MENTOR_BASE}WorldChamp2012.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2010", url: `${PGN_MENTOR_BASE}WorldChamp2010.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2008", url: `${PGN_MENTOR_BASE}WorldChamp2008.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2007", url: `${PGN_MENTOR_BASE}WorldChamp2007.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2006", url: `${PGN_MENTOR_BASE}WorldChamp2006.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2004", url: `${PGN_MENTOR_BASE}WorldChamp2004.pgn`, source: "PGN Mentor" },
  { name: "World Championship 2000", url: `${PGN_MENTOR_BASE}WorldChamp2000.pgn`, source: "PGN Mentor" },
  { name: "World Championship 1990", url: `${PGN_MENTOR_BASE}WorldChamp1990.pgn`, source: "PGN Mentor" },
  { name: "World Championship 1987", url: `${PGN_MENTOR_BASE}WorldChamp1987.pgn`, source: "PGN Mentor" },
  { name: "World Championship 1986", url: `${PGN_MENTOR_BASE}WorldChamp1986.pgn`, source: "PGN Mentor" },
  { name: "World Championship 1985", url: `${PGN_MENTOR_BASE}WorldChamp1985.pgn`, source: "PGN Mentor" },
  { name: "World Championship 1984", url: `${PGN_MENTOR_BASE}WorldChamp1984.pgn`, source: "PGN Mentor" },
  { name: "Candidates 2024", url: `${PGN_MENTOR_BASE}Candidates2024.pgn`, source: "PGN Mentor" },
  { name: "Candidates 2018", url: `${PGN_MENTOR_BASE}Candidates2018.pgn`, source: "PGN Mentor" },
  { name: "Candidates 2013", url: `${PGN_MENTOR_BASE}Candidates2013.pgn`, source: "PGN Mentor" },
  { name: "Candidates 1959", url: `${PGN_MENTOR_BASE}Candidates1959.pgn`, source: "PGN Mentor" },
  { name: "Linares 1999", url: `${PGN_MENTOR_BASE}Linares1999.pgn`, source: "PGN Mentor" },
  { name: "Linares 1994", url: `${PGN_MENTOR_BASE}Linares1994.pgn`, source: "PGN Mentor" },
  { name: "London 1851", url: `${PGN_MENTOR_BASE}London1851.pgn`, source: "PGN Mentor" },
  {
    name: "My 60 Memorable Games",
    url: "https://raw.githubusercontent.com/brianerdelyi/ChessPGN/main/My%20Memorable%2060.pgn",
    source: "brianerdelyi/ChessPGN",
  },
  {
    name: "Life and Games of Mikhail Tal",
    url: "https://raw.githubusercontent.com/brianerdelyi/ChessPGN/main/Life%20and%20Games%20of%20Mikhail%20Tal.pgn",
    source: "brianerdelyi/ChessPGN",
  },
];

const PRIORITY_PLAYERS = [
  "Carlsen",
  "Kasparov",
  "Karpov",
  "Fischer",
  "Tal",
  "Anand",
  "Kramnik",
  "Ding",
  "Gukesh",
  "Caruana",
  "Nepomniachtchi",
  "Topalov",
  "Gelfand",
  "Karjakin",
  "Aronian",
  "Nakamura",
  "Keres",
  "Petrosian",
  "Smyslov",
  "Anderssen",
  "Kieseritzky",
  "Morphy",
  "Steinitz",
  "Lasker",
];

function compactWhitespace(value) {
  return value.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parsePgnGames(content) {
  const normalized = compactWhitespace(content);
  const starts = [...normalized.matchAll(/(?=^\[Event\s+")/gm)].map((match) => match.index ?? 0);
  if (!starts.length) return [];

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? normalized.length;
    return normalized.slice(start, end).trim();
  }).filter(Boolean);
}

function parseHeaders(pgn) {
  const headers = {};
  for (const match of pgn.matchAll(/^\[([A-Za-z0-9_]+)\s+"(.*)"\]$/gm)) {
    headers[match[1]] = match[2].replace(/\\"/g, "\"").trim();
  }
  return headers;
}

function normalizeDate(value) {
  const date = (value || "").replace(/\?/g, "").replace(/\.$/, "");
  if (!date) return "";
  return date.split(".").filter(Boolean).join(".");
}

function yearFromDate(value) {
  const match = value?.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

function winnerLabel(result, white, black) {
  if (result === "1-0") return white || "White";
  if (result === "0-1") return black || "Black";
  if (result === "1/2-1/2") return "Draw";
  return "Unknown";
}

function cleanOpeningName(value) {
  const opening = (value || "").trim();
  if (!opening || opening === "?" || /^[A-E][0-9]{2}$/i.test(opening)) return "";
  const cleaned = opening.replace(/\s*[·-]\s*[A-E][0-9]{2}$/i, "").trim();
  const aliases = new Map([
    ["QGD", "Queen's Gambit Declined"],
    ["QGA", "Queen's Gambit Accepted"],
    ["Sicilian", "Sicilian Defense"],
    ["Petrov", "Petrov's Defense"],
    ["English", "English Opening"],
    ["Catalan", "Catalan Opening"],
    ["Nimzo-Indian", "Nimzo-Indian Defense"],
    ["Reti", "Reti Opening"],
    ["Four knights", "Four Knights Game"],
  ]);
  return aliases.get(cleaned) || cleaned;
}

async function loadEcoNames() {
  const openings = JSON.parse(await fs.readFile(OPENINGS_PATH, "utf8"));
  const byEco = new Map();
  for (const opening of openings) {
    if (!opening.eco || byEco.has(opening.eco)) continue;
    byEco.set(opening.eco, opening.name);
  }
  return byEco;
}

function moveCountFromPgn(pgn, headers) {
  const explicit = Number.parseInt(headers.PlyCount || "", 10);
  if (Number.isFinite(explicit)) return Math.ceil(explicit / 2);

  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
    return Math.ceil(chess.history().length / 2);
  } catch {
    return 0;
  }
}

function finalFenFromPgn(pgn) {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
    return chess.fen();
  } catch {
    return "";
  }
}

function priorityScore(game) {
  const playerText = `${game.white} ${game.black}`;
  const playerScore = PRIORITY_PLAYERS.reduce((score, player) => score + (playerText.includes(player) ? 4 : 0), 0);
  const eventScore = /World Championship/i.test(game.event) ? 7 : /Candidates/i.test(game.event) ? 5 : /Linares|London/i.test(game.event) ? 3 : 0;
  const decisiveScore = game.result === "1-0" || game.result === "0-1" ? 2 : 0;
  const recentScore = game.year ? Math.min(4, Math.max(0, Math.floor((game.year - 1980) / 12))) : 0;
  return playerScore + eventScore + decisiveScore + recentScore;
}

async function fetchSource(source) {
  const response = await fetch(source.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${source.url}: ${response.status}`);
  }
  return response.text();
}

async function main() {
  const ecoNames = await loadEcoNames();
  const seen = new Set();
  const games = [];

  for (const source of SOURCES) {
    const content = await fetchSource(source);
    for (const pgn of parsePgnGames(content)) {
      const headers = parseHeaders(pgn);
      const white = headers.White || "White";
      const black = headers.Black || "Black";
      const result = headers.Result || "*";
      const pgnHash = crypto.createHash("sha1").update(pgn).digest("hex").slice(0, 12);
      const dedupeKey = `${white}|${black}|${headers.Date}|${result}|${pgnHash}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const date = normalizeDate(headers.Date || headers.UTCDate || headers.EventDate || "");
      const year = yearFromDate(date);
      const opening = cleanOpeningName(headers.Opening) || ecoNames.get(headers.ECO) || "Unknown Opening";
      const event = headers.Event && headers.Event !== "?" ? headers.Event : source.name;
      const moveCount = moveCountFromPgn(pgn, headers);
      if (!moveCount || moveCount < 7) continue;

      const game = {
        id: `public-${pgnHash}`,
        white,
        black,
        title: `${white} vs ${black}`,
        result,
        winner: winnerLabel(result, white, black),
        date,
        year,
        event,
        opening,
        eco: headers.ECO || "",
        moveCount,
        pgn,
        source: source.source,
        sourceUrl: source.url,
        finalFen: finalFenFromPgn(pgn),
      };

      games.push(game);
    }
  }

  const ranked = games
    .map((game) => ({ ...game, score: priorityScore(game) }))
    .sort((a, b) => b.score - a.score || (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));

  const selectedById = new Map();
  for (const source of SOURCES) {
    for (const game of ranked.filter((candidate) => candidate.sourceUrl === source.url).slice(0, 8)) {
      selectedById.set(game.id, game);
    }
  }

  for (const game of ranked) {
    if (selectedById.size >= MAX_GAMES) break;
    selectedById.set(game.id, game);
  }

  const selected = [...selectedById.values()]
    .slice(0, MAX_GAMES)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.event.localeCompare(b.event) || a.title.localeCompare(b.title))
    .map(({ score, ...game }) => game);

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: SOURCES.map(({ name, url, source }) => ({ name, url, source })),
    games: selected,
  };

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${selected.length} public games to ${path.relative(rootDir, OUTPUT_PATH)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
