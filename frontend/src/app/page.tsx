"use client";

import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Chess, type Square } from "chess.js";
import ChessgroundBoard, { BoardSquareOverlay, BoardBadgeOverlay, squareToPos } from "./ChessgroundBoard";

import {
  AlertCircle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDot,
  ClipboardPaste,
  Copy,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  History,
  House,
  Layers,
  Library,
  List,
  Loader2,
  LogOut,
  Maximize2,
  Menu,
  Minimize2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  Share2,
  Sparkles,
  Star,
  Trash2,
  Undo2,
  Upload,
  User,
  X,
} from "lucide-react";
import type { SupabaseClient, User as SupabaseUser } from "@supabase/supabase-js";
import { createSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";
import {
  deleteCloudGame,
  loadCloudGames,
  loadCloudProfile,
  saveCloudGame,
  saveCloudGames,
  saveCloudProfile,
  type CloudSavedGame,
} from "@/lib/account-storage";
import type { AnalysisMove, AnalysisResult, Classification, EngineLine, EvalScore, LivePositionEval } from "@/lib/types";

// Chessground-based board (no dynamic import needed)

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const RECENT_GAMES_KEY = "chess-review:recent-games";
const USER_NAME_KEY = "chess-review:user-name";

function accountStorageKey(baseKey: string, userId?: string | null) {
  return userId ? `${baseKey}:${userId}` : baseKey;
}

// Board colors (used by ChessgroundBoard defaults and arrow overlay)

// Convert centipawns to winning probability (sigmoid function)
function centipawnsToWinningProbability(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
}

function moverWinningProbability(cp: number, color: "white" | "black") {
  const whiteProbability = centipawnsToWinningProbability(cp);
  return color === "white" ? whiteProbability : 100 - whiteProbability;
}

function classifyFromExpectedPointLoss({
  afterExpected,
  bestExpected,
  playedBest,
}: {
  afterExpected: number;
  bestExpected: number;
  playedBest: boolean;
}): Classification {
  const expectedLoss = Math.max(0, bestExpected - afterExpected);

  if (bestExpected >= 70 && afterExpected >= 35 && afterExpected <= 58 && expectedLoss >= 10) return "miss";
  if (playedBest && expectedLoss <= 0.3) return "best";
  if (expectedLoss <= 2) return "excellent";
  if (expectedLoss <= 5) return "good";
  if (bestExpected <= 45 && expectedLoss <= 12) return "inaccuracy";
  if (expectedLoss <= 9.5) return "inaccuracy";
  if (expectedLoss <= 20) return "mistake";
  return "blunder";
}
const REVIEW_ARROW_COLOR = "rgba(170, 210, 96, 0.9)";

// Piece glyph map for captured piece display (chessground handles board pieces via CSS)
const PIECE_GLYPHS: Record<string, string> = {
  wP: "♙", wN: "♘", wB: "♗", wR: "♖", wQ: "♕", wK: "♔",
  bP: "♟", bN: "♞", bB: "♝", bR: "♜", bQ: "♛", bK: "♚",
};

// Compute legal move destinations from a chess.js instance
function getLegalDests(game: Chess): Map<string, string[]> {
  const dests = new Map<string, string[]>();
  const moves = game.moves({ verbose: true });
  for (const move of moves) {
    const existing = dests.get(move.from) || [];
    existing.push(move.to);
    dests.set(move.from, existing);
  }
  return dests;
}

type CapturedPiece = NonNullable<AnalysisMove["captured_piece"]>;
type CaptureSummary = {
  white: CapturedPiece[];
  black: CapturedPiece[];
};

const PIECE_VALUE_BY_TYPE: Record<CapturedPiece["type"], number> = {
  pawn: 100,
  knight: 300,
  bishop: 300,
  rook: 500,
  queen: 900,
};

function emptyCaptureSummary(): CaptureSummary {
  return { white: [], black: [] };
}

const SAMPLE_PGN = `[Event "Casual Game"]
[Site "Local"]
[Date "2024.01.01"]
[Round "-"]
[White "Ada"]
[Black "Turing"]
[Result "0-1"]
[Opening "Italian Game"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. e5 d5
7. exf6 dxc4 8. O-O O-O 9. cxd4 Nxd4 10. fxg7 Re8 11. Be3 Bg4
12. Nbd2 b5 13. Re1 Qf6 14. Bxd4 Bxd4 15. Rxe8+ Rxe8 16. Nxc4 Bxf3
17. Qxf3 Qxf3 18. gxf3 bxc4 19. Rd1 Bxb2 20. Rd7 c3 21. Rxc7 Kxg7
22. Kg2 Re2 23. Rxa7 c2 24. Rc7 c1=Q 25. Rxc1 Bxc1 26. a4 Ra2
27. Kg3 Rxa4 28. h4 h5 29. Kg2 Rxh4 30. Kg3 Ra4 31. f4 Bxf4+
32. Kg2 h4 33. Kh3 Bg5 34. f3 Kg6 35. Kg2 Kf5 36. Kh3 Ra3
37. Kg2 Kf4 38. Kh3 Rxf3+ 39. Kh2 Kg4 40. Kg2 h3+ 41. Kh1 Kg3
42. Kg1 Be3+ 43. Kh1 Rf1# 0-1`;

function evalToWhitePercent(evalScore?: EvalScore | null) {
  if (!evalScore) return 50;
  if (evalScore.mate !== null) {
    return evalScore.cp > 0 ? 100 : 0;
  }
  const clamped = Math.max(-900, Math.min(900, evalScore.cp));
  return 50 + (clamped / 900) * 42;
}

function squareNameFromUci(uci?: string | null) {
  if (!uci || uci.length < 4) return null;
  return [uci.slice(0, 2), uci.slice(2, 4)] as const;
}

function currentEval(result: AnalysisResult | null, ply: number) {
  if (!result || result.moves.length === 0) return null;
  if (ply === 0) return result.moves[0].eval_before;
  return result.moves[ply - 1]?.eval_after ?? null;
}

function evalToGraphUnit(evalScore?: EvalScore | null) {
  if (!evalScore) return 0;
  if (evalScore.mate !== null) {
    if (evalScore.cp > 0) return 1;
    if (evalScore.cp < 0) return -1;
    return evalScore.display.startsWith("-") ? -1 : 1;
  }
  const clamped = Math.max(-700, Math.min(700, evalScore.cp));
  return clamped / 700;
}

function evalToGraphY(evalScore: EvalScore, midY: number, usableHeight: number, graphHeight: number) {
  if (evalScore.mate !== null) {
    return evalToGraphUnit(evalScore) > 0 ? 0 : graphHeight;
  }
  return midY - evalToGraphUnit(evalScore) * usableHeight;
}

function pieceGlyphFromSan(san: string, color: "white" | "black") {
  const lead = san.replace(/^[0-9]+\.{1,3}\s*/, "").charAt(0);
  if (lead === "N") return capturedPieceGlyph("knight", color);
  if (lead === "B") return capturedPieceGlyph("bishop", color);
  if (lead === "R") return capturedPieceGlyph("rook", color);
  if (lead === "Q") return capturedPieceGlyph("queen", color);
  if (lead === "K") return color === "white" ? "♔" : "♚";
  return null;
}

function legalMoveTargets(game: Chess, square: string | null) {
  if (!square) return [];
  try {
    return game.moves({ square: square as Square, verbose: true }) as Array<{ to: string; captured?: string }>;
  } catch {
    return [];
  }
}

function classifyMoveGroups(moves: AnalysisMove[]) {
  const rows: { moveNumber: number; white?: AnalysisMove; black?: AnalysisMove }[] = [];
  for (const move of moves) {
    if (move.color === "white") {
      rows.push({ moveNumber: move.move_number, white: move });
    } else {
      const current = rows[rows.length - 1];
      if (current && current.moveNumber === move.move_number) {
        current.black = move;
      } else {
        rows.push({ moveNumber: move.move_number, black: move });
      }
    }
  }
  return rows;
}

function classifyVariationGroups(moves: VariationMove[]) {
  const rows: VariationRow[] = [];
  for (const move of moves) {
    if (move.color === "white") {
      rows.push({ moveNumber: move.moveNumber, white: move });
    } else {
      const current = rows[rows.length - 1];
      if (current && current.moveNumber === move.moveNumber) {
        current.black = move;
      } else {
        rows.push({ moveNumber: move.moveNumber, black: move });
      }
    }
  }
  return rows;
}

function normalizePgn(value: string) {
  return value.trim();
}

function pgnTagValue(pgn: string, tag: string) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pgn.match(new RegExp(`\\[${escapedTag}\\s+"([^"]*)"\\]`, "i"));
  return match?.[1]?.trim() || "";
}

function resultFromPgn(pgn: string, fallback = "*") {
  const taggedResult = pgnTagValue(pgn, "Result");
  if (taggedResult === "1-0" || taggedResult === "0-1" || taggedResult === "1/2-1/2" || taggedResult === "*") {
    return taggedResult;
  }
  const movetextResult = pgn.match(/\s(1-0|0-1|1\/2-1\/2|\*)\s*$/)?.[1];
  return movetextResult ?? fallback;
}

function cleanOpeningLabel(value?: string | null) {
  const label = (value ?? "").trim();
  if (!label || label === "Unknown") return "PGN review";
  const withoutEcoSuffix = label.replace(/\s*[·-]\s*[A-E][0-9]{2}\s*$/i, "").trim();
  if (/^[A-E][0-9]{2}$/i.test(withoutEcoSuffix)) {
    return openingNameFromEco(withoutEcoSuffix) ?? "PGN review";
  }
  if (/^ECO\s+[A-E][0-9]{2}$/i.test(withoutEcoSuffix)) {
    return openingNameFromEco(withoutEcoSuffix.replace(/^ECO\s+/i, "")) ?? "PGN review";
  }
  return withoutEcoSuffix;
}

function openingNameFromEco(eco: string) {
  const code = eco.toUpperCase();
  const match = OPENINGS.filter((opening) => opening.eco === code).sort((a, b) => b.moves.length - a.moves.length)[0];
  if (match) return match.name;

  const common: Record<string, string> = {
    A00: "Irregular Opening",
    A40: "Queen's Pawn Game",
    B00: "King's Pawn Opening",
    B20: "Sicilian Defense",
    C00: "French Defense",
    D00: "Queen's Pawn Game",
    D06: "Queen's Gambit",
    D30: "Queen's Gambit Declined",
    E00: "Catalan Opening",
  };
  return common[code] ?? null;
}

type PanelTab = "home" | "analysis" | "graph" | "history" | "upload" | "playtest" | "mygames" | "publicgames";
type ReviewPanelTab = "review" | "graph" | "list";
type GameSource = "mygames" | "publicgames";
type PendingGameReview = {
  game: SavedGame;
  source: GameSource;
  rows: { moveNumber: number; white?: string; black?: string }[];
};
type VariationMove = {
  ply: number;
  moveNumber: number;
  color: "white" | "black";
  san: string;
};
type VariationRow = {
  moveNumber: number;
  white?: VariationMove;
  black?: VariationMove;
};
type MoveListVariation = {
  activePly: number;
  insertBeforeMoveNumber: number;
  rows: VariationRow[];
};

type SavedGame = {
  id: string;
  title: string;
  subtitle: string;
  pgn: string;
  updatedAt: number;
  uploadedAt: number;
  gameDate: string;
  result: string;
  termination?: string;
  moveCount: number;
  finalFen: string;
  whiteAccuracy?: number;
  blackAccuracy?: number;
};

function savedGameFromPgn(
  pgn: string,
  overrides: { title?: string; subtitle?: string } = {}
): SavedGame {
  const game = new Chess();
  game.loadPgn(pgn, { strict: false });
  const history = game.history();
  if (!history.length) {
    throw new Error("The PGN does not contain any moves.");
  }

  const white = pgnTagValue(pgn, "White") || "White";
  const black = pgnTagValue(pgn, "Black") || "Black";
  const taggedOpening = pgnTagValue(pgn, "Opening");
  const ecoOpening = openingNameFromEco(pgnTagValue(pgn, "ECO"));
  const detectedOpening = detectOpening(history);
  const uploadedAt = Date.now();

  return {
    id: `pgn-${uploadedAt}-${Math.random().toString(36).slice(2, 8)}`,
    title: overrides.title || `${white} vs ${black}`,
    subtitle: overrides.subtitle || taggedOpening || ecoOpening || detectedOpening || "PGN review",
    pgn,
    updatedAt: uploadedAt,
    uploadedAt,
    gameDate: pgnTagValue(pgn, "Date"),
    result: resultFromPgn(pgn),
    termination: pgnTagValue(pgn, "Termination"),
    moveCount: history.length,
    finalFen: game.fen(),
  };
}

type LiveSnapshot = {
  pgn: string;
  fen: string;
  lastMoveUci?: string;
};

type PlaytestAnalysisBase = {
  history: LiveSnapshot[];
  cursor: number;
};

function loadRecentGames(userId?: string | null) {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(accountStorageKey(RECENT_GAMES_KEY, userId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];

    // Migrate old saved games to new format
    return (parsed as any[]).map((game) => {
      const subtitle = cleanOpeningLabel(game.subtitle);

      if (game.result && typeof game.moveCount === 'number' && game.finalFen) {
        return {
          ...game,
          subtitle,
          uploadedAt: game.uploadedAt || game.updatedAt || Date.now(),
          gameDate: game.gameDate || "",
          termination: game.termination || pgnTagValue(game.pgn ?? "", "Termination"),
        } as SavedGame;
      }
      // Migrate old format or fix invalid data
      const tempGame = new Chess();
      tempGame.loadPgn(game.pgn);
      const finalFen = tempGame.fen();
      const moveCount = tempGame.history().length;
      const gameResult = resultFromPgn(game.pgn);
      return {
        id: game.id,
        title: game.title,
        subtitle,
        pgn: game.pgn,
        updatedAt: game.updatedAt,
        uploadedAt: game.uploadedAt || game.updatedAt || Date.now(),
        gameDate: (game as any).gameDate || "",
        result: gameResult,
        termination: pgnTagValue(game.pgn, "Termination"),
        moveCount,
        finalFen,
        whiteAccuracy: undefined,
        blackAccuracy: undefined,
      } as SavedGame;
    });
  } catch {
    return [];
  }
}

function sortSavedGames(games: SavedGame[]) {
  return [...games].sort((a, b) => {
    const dateA = a.gameDate || new Date(a.updatedAt).toISOString().split("T")[0];
    const dateB = b.gameDate || new Date(b.updatedAt).toISOString().split("T")[0];
    return dateB.localeCompare(dateA);
  });
}

function persistLocalGames(games: SavedGame[], userId?: string | null) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(accountStorageKey(RECENT_GAMES_KEY, userId), JSON.stringify(games));
}

function recentGameFromAnalysis(pgn: string, result: AnalysisResult): SavedGame {
  const white = result.metadata.white || "White";
  const black = result.metadata.black || "Black";
  const opening = cleanOpeningLabel(result.metadata.opening);
  const game = new Chess();
  game.loadPgn(pgn);
  const finalFen = game.fen();
  const moveCount = game.history().length;

  const gameResult = result.metadata.result || resultFromPgn(pgn);

  const whiteAccuracy = result.summary.white.accuracy;
  const blackAccuracy = result.summary.black.accuracy;
  const uploadedAt = Date.now();

  return {
    id: `${uploadedAt}`,
    title: `${white} vs ${black}`,
    subtitle: opening,
    pgn,
    updatedAt: uploadedAt,
    uploadedAt,
    gameDate: result.metadata.date || "",
    result: gameResult,
    termination: result.metadata.termination || pgnTagValue(pgn, "Termination"),
    moveCount,
    finalFen,
    whiteAccuracy,
    blackAccuracy,
  };
}

function classificationAccuracyScore(classification: Classification): number {
  const scores: Record<Classification, number> = {
    brilliant: 100,
    great: 95,
    best: 90,
    excellent: 85,
    good: 75,
    book: 100,
    inaccuracy: 50,
    mistake: 25,
    blunder: 0,
    miss: 50,
  };
  return scores[classification] ?? 50;
}

const OPENINGS = [
  { moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"], name: "Ruy Lopez", eco: "C78" },
  { moves: ["e4", "e5", "Nf3", "Nc6", "Bc4"], name: "Italian Game", eco: "C50" },
  { moves: ["e4", "e5", "Nf3", "Nf6"], name: "Petrov Defense", eco: "C42" },
  { moves: ["e4", "c5"], name: "Sicilian Defense", eco: "B20" },
  { moves: ["e4", "e6"], name: "French Defense", eco: "C10" },
  { moves: ["e4", "c6"], name: "Caro-Kann Defense", eco: "B10" },
  { moves: ["e4", "d5"], name: "Scandinavian Defense", eco: "B01" },
  { moves: ["d4", "d5", "c4"], name: "Queen's Gambit", eco: "D06" },
  { moves: ["d4", "Nf6", "c4", "g6"], name: "King's Indian Defense", eco: "E60" },
  { moves: ["d4", "Nf6", "c4", "e6"], name: "Queen's Indian Defense", eco: "D12" },
  { moves: ["d4", "Nf6", "c4", "e6", "g3"], name: "Catalan Opening", eco: "E01" },
  { moves: ["d4", "d5", "Bf4"], name: "London System", eco: "D02" },
  { moves: ["d4", "Nf6", "Bf4"], name: "London System", eco: "D02" },
  { moves: ["d4", "Nf6", "Nf3", "Bf4"], name: "London System", eco: "D02" },
  { moves: ["d4", "Nf6", "Nf3", "g6", "Bf4"], name: "London System", eco: "D02" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "Bf4"], name: "London System", eco: "D02" },
  { moves: ["d4", "d5", "Nf3", "e3"], name: "Colle System", eco: "D05" },
  { moves: ["d4", "Nf6", "Bg5"], name: "Trompowsky Attack", eco: "D00" },
  { moves: ["d4", "d5", "c4", "c6"], name: "Slav Defense", eco: "D10" },
  { moves: ["d4", "d5", "c4", "e6"], name: "Queen's Gambit Declined", eco: "D30" },
  { moves: ["d4", "d5", "c4", "dxc4"], name: "Queen's Gambit Accepted", eco: "D20" },
  { moves: ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4"], name: "Nimzo-Indian Defense", eco: "E20" },
  { moves: ["d4", "Nf6", "c4", "e6", "Nf3", "b6"], name: "Queen's Indian Defense", eco: "D15" },
  { moves: ["d4", "Nf6", "c4", "e6", "Nf3", "Bb4+"], name: "Bogo-Indian Defense", eco: "E11" },
  { moves: ["d4", "Nf6", "c4", "c5", "d5", "b5"], name: "Benko Gambit", eco: "A57" },
  { moves: ["d4", "f5"], name: "Dutch Defense", eco: "A80" },
  { moves: ["d4", "Nf6", "c4", "c5"], name: "Benoni Defense", eco: "A43" },
  { moves: ["e4", "e5", "Nf3", "Nc6", "d4"], name: "Scotch Game", eco: "C45" },
  { moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"], name: "Ruy Lopez", eco: "C84" },
  { moves: ["e4", "e5", "Nf3", "Nc6", "Bc5"], name: "Italian Game", eco: "C53" },
  { moves: ["e4", "e5", "Nc3"], name: "Vienna Game", eco: "C26" },
  { moves: ["e4", "e5", "Nf3", "d6"], name: "Philidor Defense", eco: "C41" },
  { moves: ["e4", "c5", "Nf3", "d4"], name: "Sicilian Defense: Open", eco: "B20" },
  { moves: ["e4", "c5", "Nc3"], name: "Sicilian Defense: Closed", eco: "B23" },
  { moves: ["e4", "c5", "c3"], name: "Sicilian Defense: Alapin", eco: "B22" },
  { moves: ["e4", "c5", "d4", "cxd4", "c3"], name: "Sicilian Defense: Smith-Morra", eco: "B21" },
  { moves: ["e4", "e6", "d4", "d5", "e5"], name: "French Defense: Advance", eco: "C02" },
  { moves: ["e4", "e6", "d4", "d5", "exd5"], name: "French Defense: Exchange", eco: "C01" },
  { moves: ["e4", "e6", "d4", "d5", "Nc3"], name: "French Defense: Tarrasch", eco: "C09" },
  { moves: ["e4", "c6", "d4", "d5", "e5"], name: "Caro-Kann: Advance", eco: "B12" },
  { moves: ["e4", "c6", "d4", "d5", "Nc3"], name: "Caro-Kann: Classical", eco: "B18" },
  { moves: ["e4", "d6"], name: "Pirc Defense", eco: "B07" },
  { moves: ["e4", "Nf6"], name: "Alekhine's Defense", eco: "B02" },
  { moves: ["e4", "Nc6"], name: "Nimzowitsch Defense", eco: "B00" },
  { moves: ["e4", "g6"], name: "Modern Defense", eco: "B06" },
  { moves: ["c4"], name: "English Opening", eco: "A10" },
  { moves: ["Nf3"], name: "Reti Opening", eco: "A09" },
  { moves: ["f4"], name: "Bird's Opening", eco: "A03" },
  { moves: ["b3"], name: "Larsen's Opening", eco: "A01" },
  { moves: ["d4"], name: "Queen's Pawn Game", eco: "A40" },
  { moves: ["d4", "d5"], name: "Queen's Pawn Game", eco: "A40" },
  { moves: ["d4", "Nf6"], name: "Queen's Pawn Game", eco: "A45" },
  { moves: ["d4", "Nf6", "Nf3"], name: "Queen's Pawn Game", eco: "A46" },
  { moves: ["d4", "Nf6", "Nf3", "e6"], name: "Queen's Pawn Game", eco: "A40" },
  { moves: ["d4", "Nf6", "Nf3", "g6"], name: "King's Indian Defense", eco: "A41" },
  { moves: ["d4", "Nf6", "Nf3", "c5"], name: "Benoni Defense", eco: "A43" },
  { moves: ["d4", "Nf6", "Nf3", "d5"], name: "Queen's Pawn Game", eco: "A46" },
  { moves: ["d4", "Nf6", "Nf3", "d6"], name: "King's Indian Defense", eco: "A41" },
  { moves: ["d4", "Nf6", "Nf3", "b6"], name: "Queen's Indian Defense", eco: "A40" },
  { moves: ["d4", "Nf6", "Nf3", "Bf4"], name: "London System", eco: "A45" },
  { moves: ["d4", "Nf6", "Nf3", "Bg5"], name: "Trompowsky Attack", eco: "A45" },
  { moves: ["d4", "Nf6", "Nf3", "c6"], name: "Slav Defense", eco: "A40" },
  { moves: ["d4", "Nf6", "Nf3", "e5"], name: "King's Indian Defense", eco: "A41" },
  { moves: ["d4", "Nf6", "Nf3", "f5"], name: "Dutch Defense", eco: "A80" },
  { moves: ["d4", "d5", "Nf3"], name: "Queen's Gambit", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6"], name: "Queen's Gambit Declined", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Bf4"], name: "London System", eco: "A45" },
  { moves: ["d4", "d5", "Nf3", "Bg5"], name: "Trompowsky Attack", eco: "A45" },
  { moves: ["d4", "d5", "Nf3", "c5"], name: "Benoni Defense", eco: "A43" },
  { moves: ["d4", "d5", "Nf3", "e6"], name: "Queen's Gambit Declined", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "f5"], name: "Dutch Defense", eco: "A80" },
  { moves: ["d4", "d5", "c4"], name: "Queen's Gambit", eco: "A40" },
  { moves: ["d4", "d5", "c4", "c6"], name: "Slav Defense", eco: "A40" },
  { moves: ["d4", "d5", "c4", "e6"], name: "Queen's Gambit Declined", eco: "A40" },
  { moves: ["d4", "d5", "c4", "dxc4"], name: "Queen's Gambit Accepted", eco: "A40" },
  { moves: ["d4", "d5", "Bf4"], name: "London System", eco: "A45" },
  { moves: ["d4", "d5", "Bg5"], name: "Trompowsky Attack", eco: "A45" },
  { moves: ["d4", "d5", "e3"], name: "Queen's Pawn Game", eco: "A40" },
  { moves: ["d4", "d5", "e4"], name: "Blackmar-Diemer Gambit", eco: "A40" },
  { moves: ["d4", "d5", "Nc3"], name: "Veresov Attack", eco: "A45" },
  { moves: ["d4", "d5", "Bb5"], name: "Portuguese Gambit", eco: "A40" },
  { moves: ["d4", "d5", "c4", "Bf4"], name: "London System", eco: "A45" },
  { moves: ["d4", "d5", "c4", "Bg5"], name: "Trompowsky Attack", eco: "A45" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "c4"], name: "Queen's Gambit Declined", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "Bf4"], name: "London System", eco: "A45" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "Bg5"], name: "Trompowsky Attack", eco: "A45" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "e3"], name: "Queen's Gambit Declined", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "g3"], name: "Catalan Opening", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "c4", "c6"], name: "Slav Defense", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "c4", "e6"], name: "Queen's Gambit Declined", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "c4", "dxc4"], name: "Queen's Gambit Accepted", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "Bf4"], name: "London System", eco: "A45" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "Bg5"], name: "Trompowsky Attack", eco: "A45" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "e3"], name: "Queen's Gambit Declined", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "g3"], name: "Catalan Opening", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "Bf4", "e6"], name: "London System", eco: "A45" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "Bg5", "e6"], name: "Trompowsky Attack", eco: "A45" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "e3", "e6"], name: "Queen's Gambit Declined", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "g3", "e6"], name: "Catalan Opening", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "c4", "c6"], name: "Slav Defense", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "c4", "e6"], name: "Queen's Gambit Declined", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "c4", "dxc4"], name: "Queen's Gambit Accepted", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "Bf4", "e6"], name: "London System", eco: "A45" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "Bg5", "e6"], name: "Trompowsky Attack", eco: "A45" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "e3", "e6"], name: "Queen's Gambit Declined", eco: "A40" },
  { moves: ["d4", "d5", "Nf3", "Nf6", "g3", "e6"], name: "Catalan Opening", eco: "A40" },
  { moves: ["b4"], name: "Sokolsky Opening" },
];

function detectOpening(sans: string[]) {
  if (sans.length === 0) return "";
  let match = "";
  let maxMatchLength = 0;
  for (const opening of OPENINGS) {
    let matchLength = 0;
    for (let i = 0; i < opening.moves.length && i < sans.length; i++) {
      if (sans[i] === opening.moves[i]) {
        matchLength++;
      } else {
        break;
      }
    }
    if (matchLength > maxMatchLength && matchLength > 0) {
      maxMatchLength = matchLength;
      match = opening.name;
    }
  }
  return match;
}

function openingLabelForMove(move?: AnalysisMove | null) {
  const opening = move?.opening?.trim();
  if (!opening || opening === "Unknown" || opening === "Starting position") return "";
  return opening;
}

function openingLabelForPosition(result: AnalysisResult | null, ply: number, fallbackSans: string[]) {
  if (!result) return detectOpening(fallbackSans);
  for (let index = Math.min(ply, result.moves.length) - 1; index >= 0; index--) {
    const label = openingLabelForMove(result.moves[index]);
    if (label) return label;
  }
  const metadataOpening = result.metadata.opening?.trim();
  if (metadataOpening && metadataOpening !== "Unknown") return cleanOpeningLabel(metadataOpening);
  return detectOpening(fallbackSans);
}

function gameStatus(game: Chess) {
  if (game.isCheckmate()) {
    return game.turn() === "w" ? "Black wins by checkmate" : "White wins by checkmate";
  }
  if (game.isDraw()) return "Draw";
  const turn = game.turn() === "w" ? "White" : "Black";
  return game.isCheck() ? `${turn} to move, in check` : `${turn} to move`;
}

function groupSans(sans: string[]) {
  const rows: { moveNumber: number; white?: string; black?: string }[] = [];
  for (let index = 0; index < sans.length; index += 2) {
    rows.push({
      moveNumber: index / 2 + 1,
      white: sans[index],
      black: sans[index + 1],
    });
  }
  return rows;
}

function moveRowsFromPgn(pgn: string) {
  try {
    const game = new Chess();
    game.loadPgn(pgn, { strict: false });
    return groupSans(game.history());
  } catch {
    return [];
  }
}

function groupLiveAnalysisMoves(sans: string[], analysis: AnalysisResult | null) {
  const rows: { moveNumber: number; white?: AnalysisMove | string; black?: AnalysisMove | string }[] = [];
  for (let index = 0; index < sans.length; index += 2) {
    rows.push({
      moveNumber: index / 2 + 1,
      white: analysis?.moves[index] ?? sans[index],
      black: analysis?.moves[index + 1] ?? sans[index + 1],
    });
  }
  return rows;
}

function cleanPgnFromGameHistory(game: Chess, startFen: string) {
  const moves = game.history({ verbose: true }) as Array<{ from: string; to: string; promotion?: string }>;
  if (moves.length === 0) return "";

  const replay = new Chess(startFen);
  if (startFen !== INITIAL_FEN) {
    replay.setHeader("SetUp", "1");
    replay.setHeader("FEN", startFen);
  }

  for (const move of moves) {
    replay.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion || "q",
    });
  }

  const sans = replay.history();
  const rows: string[] = [];
  for (let index = 0; index < sans.length; index += 2) {
    const whiteMove = sans[index];
    const blackMove = sans[index + 1];
    rows.push(`${index / 2 + 1}. ${whiteMove}${blackMove ? ` ${blackMove}` : ""}`);
  }
  const movetext = `${rows.join(" ")} *`;

  if (startFen === INITIAL_FEN) return movetext;

  return [
    `[Event "?"]`,
    `[Site "?"]`,
    `[Date "????.??.??"]`,
    `[Round "?"]`,
    `[White "?"]`,
    `[Black "?"]`,
    `[Result "*"]`,
    `[SetUp "1"]`,
    `[FEN "${startFen}"]`,
    "",
    movetext,
  ].join("\n");
}

function liveSnapshotsFromAnalysis(analysis: AnalysisResult): LiveSnapshot[] {
  const startFen = analysis.metadata.initial_fen || INITIAL_FEN;
  const replay = new Chess(startFen);
  const snapshots: LiveSnapshot[] = [{ pgn: "", fen: replay.fen() }];

  for (const move of analysis.moves) {
    try {
      replay.move({
        from: move.uci.slice(0, 2),
        to: move.uci.slice(2, 4),
        promotion: move.uci.slice(4) || "q",
      });
    } catch {
      break;
    }

    snapshots.push({
      pgn: replay.pgn({ newline: " ", maxWidth: 0 }),
      fen: replay.fen(),
      lastMoveUci: move.uci,
    });
  }

  return snapshots;
}

function classificationMapFromAnalysis(analysis: AnalysisResult | null) {
  if (!analysis) return {};
  return Object.fromEntries(
    analysis.moves.map((move, index) => [index, move.classification ?? fallbackMoveClassification(move)])
  ) as Record<number, Classification | null>;
}

function analysisWithFallbackClassifications(analysis: AnalysisResult): AnalysisResult {
  return {
    ...analysis,
    moves: analysis.moves.map((move) => ({
      ...move,
      classification: move.classification ?? fallbackMoveClassification(move) ?? "good",
    })),
  };
}

function fallbackMoveClassification(move: AnalysisMove): Classification | null {
  const bestLine = move.engine_lines?.[0];
  if (!bestLine) return null;

  const afterExpected = moverWinningProbability(move.eval_after.cp ?? 0, move.color);
  const bestExpected = moverWinningProbability(bestLine.eval.cp ?? 0, move.color);
  return classifyFromExpectedPointLoss({
    afterExpected,
    bestExpected,
    playedBest: !!move.best_move && move.uci === move.best_move,
  });
}

function classificationIndicator(classification: Classification) {
  if (classification === "brilliant") return "!!";
  if (classification === "great") return "!";
  if (classification === "best") return "★";
  if (classification === "excellent") return "!";
  if (classification === "good") return "✓";
  if (classification === "book") return "♜";
  if (classification === "miss") return "⊗";
  if (classification === "inaccuracy") return "?!";
  if (classification === "mistake") return "?";
  return "??";
}

function classificationTone(classification: Classification) {
  if (classification === "book") return "text-stone-950 bg-[var(--move-book)] border-white/35";
  if (classification === "brilliant") return "text-white bg-[var(--move-brilliant)] border-white/40";
  if (classification === "great") return "text-white bg-[var(--move-great)] border-white/35";
  if (classification === "best") return "text-white bg-[var(--move-best)] border-white/35";
  if (classification === "excellent" || classification === "good") return "text-stone-950 bg-[var(--move-good)] border-white/30";
  if (classification === "miss") return "text-white bg-[var(--move-missed)] border-white/40";
  if (classification === "inaccuracy") return "text-stone-950 bg-[var(--move-inaccuracy)] border-white/35";
  if (classification === "mistake") return "text-white bg-[var(--move-mistake)] border-white/30";
  return "text-white bg-[var(--move-blunder)] border-white/35";
}

function classificationOverlayTone(classification?: Classification | null) {
  if (!classification) return "text-white bg-black/55";
  return `${classificationTone(classification)} shadow-[0_1px_4px_rgba(0,0,0,0.35)]`;
}

function classificationHighlightColor(classification?: Classification | null) {
  if (!classification) return "rgba(125, 211, 252, 0.55)";
  if (classification === "book") return "rgba(181, 164, 134, 0.55)";
  if (classification === "brilliant") return "rgba(79, 161, 199, 0.55)";
  if (classification === "great") return "rgba(122, 122, 151, 0.55)";
  if (classification === "best") return "rgba(105, 146, 62, 0.55)";
  if (classification === "excellent" || classification === "good") return "rgba(138, 163, 111, 0.55)";
  if (classification === "miss") return "rgba(143, 95, 184, 0.55)";
  if (classification === "inaccuracy") return "rgba(229, 178, 68, 0.55)";
  if (classification === "mistake") return "rgba(209, 120, 56, 0.55)";
  return "rgba(176, 73, 56, 0.55)";
}

function classificationTextColor(classification: Classification) {
  if (classification === "book") return "text-[#e4aa74]";
  if (classification === "brilliant") return "text-[#35d1b3]";
  if (classification === "great") return "text-[#8fb5d4]";
  if (classification === "best") return "text-[#94c957]";
  if (classification === "excellent" || classification === "good") return "text-[#9bc66a]";
  if (classification === "miss") return "text-[#ff7f6f]";
  if (classification === "inaccuracy") return "text-[#f2c33d]";
  if (classification === "mistake") return "text-[#ff9d55]";
  return "text-[#ff4e3d]";
}

function classificationLabel(classification: Classification) {
  if (classification === "best") return "best";
  if (classification === "great") return "great";
  if (classification === "excellent") return "excellent";
  if (classification === "good") return "good";
  if (classification === "miss") return "missed win";
  if (classification === "inaccuracy") return "inaccuracy";
  if (classification === "mistake") return "mistake";
  if (classification === "blunder") return "blunder";
  if (classification === "brilliant") return "brilliant";
  return "book";
}

const CLASSIFICATION_BADGE_FILES: Record<Classification, string> = {
  book: "book.png",
  brilliant: "brilliant.png",
  best: "best.png",
  great: "great.png",
  excellent: "excellent.png",
  good: "good.png",
  miss: "miss.png",
  inaccuracy: "inaccuracy.png",
  mistake: "mistake.png",
  blunder: "blunder.png",
};

type EndGameBadgeKind = "winner" | "loss" | "draw" | "resign" | "timeout" | "checkmate";

const END_GAME_BADGE_ICONS: Record<EndGameBadgeKind, string> = {
  winner: "/move-badges/winner.png",
  loss: "/move-badges/loss.png",
  draw: "/move-badges/draw.svg",
  resign: "/move-badges/resign.png",
  timeout: "/move-badges/timeout.png",
  checkmate: "/move-badges/loss.png",
};

const MOVE_BADGE_ASSET_VERSION = "clean-1";

function classificationBadgeIcon(classification: Classification) {
  return `/move-badges/${CLASSIFICATION_BADGE_FILES[classification]}?v=${MOVE_BADGE_ASSET_VERSION}`;
}

function endGameBadgeIcon(kind: EndGameBadgeKind) {
  return `${END_GAME_BADGE_ICONS[kind]}?v=${MOVE_BADGE_ASSET_VERSION}`;
}

function boardSquareHighlights(
  move?: { uci?: string | null; classification?: Classification | null } | null,
  kind: "best" | "played" = "played"
): Record<string, CSSProperties> {
  if (!move) return {};
  const squares = squareNameFromUci(move.uci ?? undefined);
  if (!squares) return {};
  const [fromSquare, toSquare] = squares;

  const color = kind === "best" ? "rgba(34, 197, 94, 0.55)" : classificationHighlightColor(move.classification);

  return {
    [fromSquare]: {
      backgroundColor: color,
    },
    [toSquare]: {
      backgroundColor: color,
    },
  };
}

function selectedSquareStyles(game: Chess, selectedSquare: string | null): Record<string, CSSProperties> {
  if (!selectedSquare) return {};

  const nextStyles: Record<string, CSSProperties> = {
    [selectedSquare]: {
      backgroundColor: "rgba(125, 211, 252, 0.55)",
    },
  };

  return nextStyles;
}

function materialCaptureLabel(captured: AnalysisMove["captured_piece"] | null) {
  if (!captured) return null;
  const sign = captured.color === "white" ? "+" : "-";
  return `${sign}${captured.value / 100}`;
}

function captureTypeFromSymbol(symbol?: string | null): CapturedPiece["type"] | null {
  if (symbol === "p") return "pawn";
  if (symbol === "n") return "knight";
  if (symbol === "b") return "bishop";
  if (symbol === "r") return "rook";
  if (symbol === "q") return "queen";
  return null;
}

function captureMaterialTotal(pieces: CapturedPiece[]) {
  return pieces.reduce((total, piece) => total + PIECE_VALUE_BY_TYPE[piece.type], 0) / 100;
}

function capturedPiecesFromMoves(
  moves: Array<Pick<AnalysisMove, "color" | "captured_piece">>
): CaptureSummary {
  const captures: CaptureSummary = { white: [], black: [] };

  for (const move of moves) {
    if (!move.captured_piece) continue;
    captures[move.color].push(move.captured_piece);
  }

  return captures;
}

function capturedPiecesFromLiveGame(game: Chess): CaptureSummary {
  const captures: CaptureSummary = { white: [], black: [] };
  const history = game.history({ verbose: true }) as Array<{ color: "w" | "b"; captured?: string }>;

  for (const move of history) {
    const type = captureTypeFromSymbol(move.captured);
    if (!type) continue;

    captures[move.color === "w" ? "white" : "black"].push({
      type,
      color: move.color === "w" ? "black" : "white",
      value: PIECE_VALUE_BY_TYPE[type],
    });
  }

  return captures;
}

type SquareAnnotation = {
  label: string;
  tone: string;
  iconSrc?: string;
};

function kingSquaresFromFen(fen: string) {
  const board = fen.split(" ")[0] ?? "";
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  let rank = 8;
  let fileIndex = 0;
  const kings: { white?: string; black?: string } = {};

  for (const char of board) {
    if (char === "/") {
      rank -= 1;
      fileIndex = 0;
      continue;
    }

    const emptySquares = Number.parseInt(char, 10);
    if (Number.isFinite(emptySquares)) {
      fileIndex += emptySquares;
      continue;
    }

    const square = `${files[fileIndex]}${rank}`;
    if (char === "K") kings.white = square;
    if (char === "k") kings.black = square;
    fileIndex += 1;
  }

  return kings;
}

function endGameBoardAnnotations({
  fen,
  isFinalPly,
  pgn,
  result,
  termination,
}: {
  fen: string;
  isFinalPly: boolean;
  pgn?: string;
  result?: string;
  termination?: string;
}): Record<string, SquareAnnotation> {
  if (!isFinalPly) return {};

  const winner = winnerFromResult(result);
  if (!winner) return {};

  const kings = kingSquaresFromFen(fen);
  const annotations: Record<string, SquareAnnotation> = {};

  if (winner === "draw") {
    for (const square of [kings.white, kings.black]) {
      if (!square) continue;
      annotations[square] = {
        label: "Draw",
        tone: "text-white bg-stone-500 border-white/35",
        iconSrc: endGameBadgeIcon("draw"),
      };
    }
    return annotations;
  }

  const loser = winner === "white" ? "black" : "white";
  const winnerSquare = kings[winner];
  const loserSquare = kings[loser];
  const endReason = endReasonFromGame(termination, pgn);
  const loserKind = endReason === "resign" || endReason === "timeout" ? endReason : "loss";

  if (winnerSquare) {
    annotations[winnerSquare] = {
      label: "Win",
      tone: "text-white bg-emerald-500 border-white/35",
      iconSrc: endGameBadgeIcon("winner"),
    };
  }

  if (loserSquare) {
    annotations[loserSquare] = {
      label: loserKind === "resign" ? "Resign" : loserKind === "timeout" ? "Timeout" : "Loss",
      tone: "text-white bg-rose-500 border-white/35",
      iconSrc: endGameBadgeIcon(loserKind),
    };
  }

  return annotations;
}

// boardSquareRenderer removed — overlays now handled by BoardSquareOverlay component

function getLegalMoves(game: Chess, square: string | null): { legalMoves: Set<string>; captureMoves: Set<string> } {
  if (!square) return { legalMoves: new Set(), captureMoves: new Set() };

  // Only show legal moves if the piece on the selected square belongs to the current turn
  const piece = game.get(square as Square);
  if (!piece || piece.color !== game.turn()) {
    return { legalMoves: new Set(), captureMoves: new Set() };
  }

  const legalMoves = new Set<string>();
  const captureMoves = new Set<string>();

  const moves = game.moves({ square: square as Square, verbose: true });
  for (const move of moves) {
    legalMoves.add(move.to);
    if (move.captured) {
      captureMoves.add(move.to);
    }
  }

  return { legalMoves, captureMoves };
}

function capturedPieceGlyph(type: "pawn" | "knight" | "bishop" | "rook" | "queen", color: "white" | "black") {
  const white = color === "white";
  if (type === "pawn") return white ? "♙" : "♟";
  if (type === "knight") return white ? "♘" : "♞";
  if (type === "bishop") return white ? "♗" : "♝";
  if (type === "rook") return white ? "♖" : "♜";
  return white ? "♕" : "♛";
}

function capturedPieceAsset(piece: CapturedPiece) {
  return `/captured-pieces/${piece.color}_${piece.type}.svg`;
}

const CAPTURED_PIECE_DISPLAY_ORDER: Record<CapturedPiece["type"], number> = {
  pawn: 0,
  knight: 1,
  bishop: 2,
  rook: 3,
  queen: 4,
};

function groupedCapturedPieces(pieces: CapturedPiece[]) {
  const groups = new Map<string, CapturedPiece[]>();

  for (const piece of pieces) {
    const key = `${piece.color}-${piece.type}`;
    const group = groups.get(key);
    if (group) {
      group.push(piece);
    } else {
      groups.set(key, [piece]);
    }
  }

  return Array.from(groups.values()).sort((a, b) => {
    const first = a[0];
    const second = b[0];
    if (!first || !second) return 0;
    return CAPTURED_PIECE_DISPLAY_ORDER[first.type] - CAPTURED_PIECE_DISPLAY_ORDER[second.type];
  });
}

function squareBadgeText(classification?: Classification | null, kind: "played" | "best" = "played") {
  if (kind === "best") return "★";
  if (!classification) return ".";
  return classificationIndicator(classification);
}

function squareBadgeTone(classification?: Classification | null, kind: "played" | "best" = "played") {
  if (kind === "best") return "text-white bg-[var(--move-best)] border-white/35";
  return classificationOverlayTone(classification);
}

function squareBadgeIcon(classification?: Classification | null, kind: "played" | "best" = "played") {
  if (kind === "best") return "/move-badges/best.png";
  if (!classification) return null;
  return classificationBadgeIcon(classification);
}

function ClassificationBadge({
  classification,
  className = "",
}: {
  classification: Classification;
  className?: string;
}) {
  return (
    <img
      src={classificationBadgeIcon(classification)}
      alt={classificationLabel(classification)}
      title={classificationLabel(classification)}
      className={`inline-block h-7 w-7 shrink-0 object-contain ${className}`}
    />
  );
}

function EndGameBadge({
  className = "",
  kind,
  label,
}: {
  className?: string;
  kind: EndGameBadgeKind;
  label?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-black/20 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-stone-100 ${className}`}
      title={label ?? kind}
    >
      <img src={endGameBadgeIcon(kind)} alt={label ?? kind} className="h-5 w-5 object-contain" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

function squareCenterPoint(square: string) {
  const fileChar = square[0];
  const rankChar = square[1];
  const fileIndex = fileChar.charCodeAt(0) - "a".charCodeAt(0);
  const rank = Number.parseInt(rankChar ?? "", 10);
  if (fileIndex < 0 || fileIndex > 7 || !Number.isFinite(rank) || rank < 1 || rank > 8) return null;
  return { x: fileIndex + 0.5, y: 8 - rank + 0.5 };
}

function isKnightMove(startSquare: string, endSquare: string) {
  const start = squareCenterPoint(startSquare);
  const end = squareCenterPoint(endSquare);
  if (!start || !end) return false;
  const fileDelta = Math.abs(end.x - start.x);
  const rankDelta = Math.abs(end.y - start.y);
  return (fileDelta === 1 && rankDelta === 2) || (fileDelta === 2 && rankDelta === 1);
}

function insetArrowPoints(startSquare: string, endSquare: string, inset = 0.34) {
  const start = squareCenterPoint(startSquare);
  const end = squareCenterPoint(endSquare);
  if (!start || !end) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.001) return { start, end };
  const unitX = dx / distance;
  const unitY = dy / distance;
  const clampedInset = Math.min(inset, Math.max(0, distance / 2 - 0.05));
  return {
    start: { x: start.x + unitX * clampedInset, y: start.y + unitY * clampedInset },
    end,
  };
}

function BoardArrowOverlay({
  arrow,
  color,
  boardOrientation = "white",
}: {
  arrow: readonly [string, string] | null;
  color: string;
  boardOrientation?: "white" | "black";
}) {
  const points = arrow ? insetArrowPoints(arrow[0], arrow[1]) : null;
  if (!points) return null;

  if (arrow && isKnightMove(arrow[0], arrow[1])) {
    const startCenter = squareCenterPoint(arrow[0]);
    const end = squareCenterPoint(arrow[1]);
    if (!startCenter || !end) return null;

    const deltaX = end.x - startCenter.x;
    const deltaY = end.y - startCenter.y;
    const bend = Math.abs(deltaX) === 2 ? { x: end.x, y: startCenter.y } : { x: startCenter.x, y: end.y };

    const firstDx = bend.x - startCenter.x;
    const firstDy = bend.y - startCenter.y;
    const firstLength = Math.hypot(firstDx, firstDy);
    const firstUnitX = firstLength > 0.001 ? firstDx / firstLength : 0;
    const firstUnitY = firstLength > 0.001 ? firstDy / firstLength : 0;
    const startInset = 0.34;
    const start = {
      x: startCenter.x + firstUnitX * startInset,
      y: startCenter.y + firstUnitY * startInset,
    };

    const secondDx = end.x - bend.x;
    const secondDy = end.y - bend.y;
    const secondLength = Math.hypot(secondDx, secondDy);
    if (secondLength < 0.001) return null;
    const secondUnitX = secondDx / secondLength;
    const secondUnitY = secondDy / secondLength;
    const arrowHeadLength = 0.32;
    const arrowHeadHalfWidth = 0.24;
    const headBase = {
      x: end.x - secondUnitX * arrowHeadLength,
      y: end.y - secondUnitY * arrowHeadLength,
    };
    const perpX = -secondUnitY;
    const perpY = secondUnitX;
    const headLeft = {
      x: headBase.x + perpX * arrowHeadHalfWidth,
      y: headBase.y + perpY * arrowHeadHalfWidth,
    };
    const headRight = {
      x: headBase.x - perpX * arrowHeadHalfWidth,
      y: headBase.y - perpY * arrowHeadHalfWidth,
    };

    return (
      <svg 
        className={`pointer-events-none absolute inset-0 z-30 h-full w-full ${boardOrientation === "black" ? "rotate-180" : ""}`} 
        viewBox="0 0 8 8" 
        preserveAspectRatio="none"
      >
        <polyline
          points={`${start.x},${start.y} ${bend.x},${bend.y} ${headBase.x},${headBase.y}`}
          fill="none"
          stroke={color}
          strokeWidth="0.23"
          strokeLinecap="butt"
          strokeLinejoin="miter"
        />
        <path d={`M ${end.x} ${end.y} L ${headLeft.x} ${headLeft.y} L ${headRight.x} ${headRight.y} Z`} fill={color} />
      </svg>
    );
  }

  const dx = points.end.x - points.start.x;
  const dy = points.end.y - points.start.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return null;
  const unitX = dx / length;
  const unitY = dy / length;
  const perpX = -unitY;
  const perpY = unitX;
  const headLength = 0.32;
  const shaftHalfWidth = 0.12;
  const headHalfWidth = 0.24;
  const effectiveHeadLength = Math.min(headLength, Math.max(0.18, length * 0.46));
  const headBase = {
    x: points.end.x - unitX * effectiveHeadLength,
    y: points.end.y - unitY * effectiveHeadLength,
  };
  const path = [
    `M ${points.start.x + perpX * shaftHalfWidth} ${points.start.y + perpY * shaftHalfWidth}`,
    `L ${headBase.x + perpX * shaftHalfWidth} ${headBase.y + perpY * shaftHalfWidth}`,
    `L ${headBase.x + perpX * headHalfWidth} ${headBase.y + perpY * headHalfWidth}`,
    `L ${points.end.x} ${points.end.y}`,
    `L ${headBase.x - perpX * headHalfWidth} ${headBase.y - perpY * headHalfWidth}`,
    `L ${headBase.x - perpX * shaftHalfWidth} ${headBase.y - perpY * shaftHalfWidth}`,
    `L ${points.start.x - perpX * shaftHalfWidth} ${points.start.y - perpY * shaftHalfWidth}`,
    "Z",
  ].join(" ");

  return (
    <svg 
      className={`pointer-events-none absolute inset-0 z-30 h-full w-full ${boardOrientation === "black" ? "rotate-180" : ""}`} 
      viewBox="0 0 8 8" 
      preserveAspectRatio="none"
    >
      <path d={path} fill={color} />
    </svg>
  );
}

export default function Home() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const authConfigured = isSupabaseConfigured();
  const [pgn, setPgn] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [playtestAnalysisResult, setPlaytestAnalysisResult] = useState<AnalysisResult | null>(null);
  const [playtestAnalysisEnabled, setPlaytestAnalysisEnabled] = useState(false);
  const [isPlaytestReview, setIsPlaytestReview] = useState(false);
  const [liveMode, setLiveMode] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>("home");
  const [reviewTab, setReviewTab] = useState<ReviewPanelTab>("review");
  const [activeGameSource, setActiveGameSource] = useState<GameSource | null>(null);
  const [activeSavedGameId, setActiveSavedGameId] = useState<string | null>(null);
  const [loadingGameId, setLoadingGameId] = useState<string | null>(null);
  const [pendingGameReview, setPendingGameReview] = useState<PendingGameReview | null>(null);
  const [reviewEvalVisible, setReviewEvalVisible] = useState(false);
  const [showUploadInHistory, setShowUploadInHistory] = useState(false);
  const [historyView, setHistoryView] = useState<"list" | "analysis">("list");
  const [savedGames, setSavedGames] = useState<SavedGame[]>(() => {
    const games = loadRecentGames();
    return sortSavedGames(games);
  });
  const [liveStartFen, setLiveStartFen] = useState(INITIAL_FEN);
  const [livePgn, setLivePgn] = useState("");
  const [liveFen, setLiveFen] = useState(INITIAL_FEN);
  const [userName, setUserName] = useState("");
  const [authUser, setAuthUser] = useState<SupabaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(authConfigured);
  const [syncedAccountId, setSyncedAccountId] = useState<string | null>(null);
  const [accountSyncError, setAccountSyncError] = useState<string | null>(null);
  const accountName =
    typeof authUser?.user_metadata?.full_name === "string"
      ? authUser.user_metadata.full_name
      : typeof authUser?.user_metadata?.name === "string"
        ? authUser.user_metadata.name
        : null;
  const accountAvatarUrl =
    typeof authUser?.user_metadata?.avatar_url === "string"
      ? authUser.user_metadata.avatar_url
      : typeof authUser?.user_metadata?.picture === "string"
        ? authUser.user_metadata.picture
        : null;
  const [boardOrientation, setBoardOrientation] = useState<"white" | "black">("white");
  const [mounted, setMounted] = useState(false);

  // Mark as mounted after hydration to avoid SSR mismatches
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }

    let active = true;

    function applySessionUser(user: SupabaseUser | null) {
      setSyncedAccountId(null);
      setAuthUser(user);
      setSavedGames(sortSavedGames(loadRecentGames(user?.id)));
      setUserName(localStorage.getItem(accountStorageKey(USER_NAME_KEY, user?.id)) ?? "");
      setAuthLoading(false);
    }

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      applySessionUser(data.session?.user ?? null);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      applySessionUser(session?.user ?? null);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [supabase]);

  // Load guest data before auth resolves to avoid a hydration mismatch.
  useEffect(() => {
    const storedName = localStorage.getItem(accountStorageKey(USER_NAME_KEY)) ?? "";
    setUserName(storedName);
  }, []);

  useEffect(() => {
    if (!supabase || !authUser) return;

    let cancelled = false;
    const accountClient = supabase as SupabaseClient;
    const accountUser = authUser;

    async function syncAccount() {
      try {
        setAccountSyncError(null);
        const [cloudName, cloudGames] = await Promise.all([
          loadCloudProfile(accountClient, accountUser),
          loadCloudGames(accountClient, accountUser),
        ]);

        if (cancelled) return;

        const accountLocalGames = loadRecentGames(accountUser.id);
        const guestGames = loadRecentGames();
        const mergedByPgn = new Map<string, SavedGame>();
        for (const game of cloudGames as SavedGame[]) mergedByPgn.set(game.pgn, game);
        for (const game of [...accountLocalGames, ...guestGames]) {
          const existing = mergedByPgn.get(game.pgn);
          if (!existing || game.updatedAt > existing.updatedAt) {
            mergedByPgn.set(game.pgn, game);
          }
        }

        const merged = sortSavedGames(Array.from(mergedByPgn.values()));
        setSavedGames(merged);
        persistLocalGames(merged, accountUser.id);

        if (accountLocalGames.length || guestGames.length) {
          await saveCloudGames(accountClient, accountUser, merged as CloudSavedGame[]);
        }
        if (guestGames.length) {
          localStorage.removeItem(accountStorageKey(RECENT_GAMES_KEY));
        }

        if (cloudName) {
          setUserName(cloudName);
          localStorage.setItem(accountStorageKey(USER_NAME_KEY, accountUser.id), cloudName);
        } else {
          const accountLocalName =
            localStorage.getItem(accountStorageKey(USER_NAME_KEY, accountUser.id)) ??
            localStorage.getItem(accountStorageKey(USER_NAME_KEY)) ??
            "";
          setUserName(accountLocalName);
          await saveCloudProfile(accountClient, accountUser, accountLocalName);
        }
        if (guestGames.length) {
          localStorage.removeItem(accountStorageKey(USER_NAME_KEY));
        }
        setSyncedAccountId(accountUser.id);
        setAccountSyncError(null);
      } catch (error) {
        if (!cancelled) setAccountSyncError("Could not sync account data yet.");
      }
    }

    void syncAccount();

    return () => {
      cancelled = true;
    };
  }, [supabase, authUser]);

  // Save user name to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(accountStorageKey(USER_NAME_KEY, authUser?.id), userName);
    }
  }, [authUser?.id, userName]);

  useEffect(() => {
    if (!supabase || !authUser || !mounted || syncedAccountId !== authUser.id) return;
    const trimmedName = userName.trim();
    const accountClient = supabase as SupabaseClient;
    const accountUser = authUser;
    const timeoutId = window.setTimeout(() => {
      saveCloudProfile(accountClient, accountUser, trimmedName)
        .then(() => setAccountSyncError(null))
        .catch(() => {
          setAccountSyncError(trimmedName ? "Could not save account name yet." : null);
        });
    }, 500);

    return () => window.clearTimeout(timeoutId);
  }, [supabase, authUser, userName, mounted, syncedAccountId]);

  // Auto-flip board when user name matches black player
  useEffect(() => {
    if (analysis && userName) {
      const blackPlayer = analysis.metadata.black;
      if (blackPlayer && blackPlayer.toLowerCase() === userName.toLowerCase()) {
        setBoardOrientation("black");
      } else {
        setBoardOrientation("white");
      }
    }
  }, [analysis, userName]);
  const [liveHistory, setLiveHistory] = useState<LiveSnapshot[]>([{ pgn: "", fen: INITIAL_FEN }]);
  const [liveCursor, setLiveCursor] = useState(0);
  const [playtestAnalysisBase, setPlaytestAnalysisBase] = useState<PlaytestAnalysisBase | null>(null);
  const [playtestBranchOriginCursor, setPlaytestBranchOriginCursor] = useState<number | null>(null);
  const [liveSeedCaptures, setLiveSeedCaptures] = useState<CaptureSummary>(() => emptyCaptureSummary());
  const [liveEval, setLiveEval] = useState<LivePositionEval | null>(null);
  const [liveEvalFen, setLiveEvalFen] = useState<string | null>(null);
  const [liveLoading, setLiveLoading] = useState(true);
  const [playtestMoveClassifications, setPlaytestMoveClassifications] = useState<Record<number, Classification | null>>({});
  const [liveError, setLiveError] = useState<string | null>(null);
  const [activePly, setActivePly] = useState(0);
  const [branchOriginPly, setBranchOriginPly] = useState<number | null>(null);
  const [branchMoveUci, setBranchMoveUci] = useState<string | null>(null);
  const [branchMoveClassification, setBranchMoveClassification] = useState<Classification | null>(null);
  const [branchMoveEvalBefore, setBranchMoveEvalBefore] = useState<EvalScore | null>(null);
  const [branchAnalysisResult, setBranchAnalysisResult] = useState<AnalysisResult | null>(null);
  const [branchAnalysisLoading, setBranchAnalysisLoading] = useState(false);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [dragHoverSquare, setDragHoverSquare] = useState<string | null>(null);
  const [suppressBoardArrow, setSuppressBoardArrow] = useState(false);
  const [boardTransitioning, setBoardTransitioning] = useState(false);
  const [reviewSurfaceVisible, setReviewSurfaceVisible] = useState(true);
  const pieceClickRef = useRef<string | null>(null);
  const isNavigatingRef = useRef(false);
  const boardArrowTimeoutRef = useRef<number | null>(null);
  const boardTransitionTimeoutRef = useRef<number | null>(null);
  const reviewSurfaceTimeoutRef = useRef<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (liveMode || !analysis) {
      setReviewEvalVisible(false);
      return;
    }

    const timer = window.setTimeout(() => setReviewEvalVisible(true), boardTransitioning ? 260 : 80);
    return () => window.clearTimeout(timer);
  }, [liveMode, analysis, boardTransitioning]);

  useEffect(() => {
    return () => {
      if (boardArrowTimeoutRef.current !== null) {
        window.clearTimeout(boardArrowTimeoutRef.current);
      }
      if (boardTransitionTimeoutRef.current !== null) {
        window.clearTimeout(boardTransitionTimeoutRef.current);
      }
      if (reviewSurfaceTimeoutRef.current !== null) {
        window.clearTimeout(reviewSurfaceTimeoutRef.current);
      }
    };
  }, []);

  function transitionBoardShell(duration = 420) {
    if (boardTransitionTimeoutRef.current !== null) {
      window.clearTimeout(boardTransitionTimeoutRef.current);
    }
    setBoardTransitioning(true);
    boardTransitionTimeoutRef.current = window.setTimeout(() => {
      setBoardTransitioning(false);
      boardTransitionTimeoutRef.current = null;
    }, duration);
  }

  function revealReviewSurface(delay = 90) {
    if (reviewSurfaceTimeoutRef.current !== null) {
      window.clearTimeout(reviewSurfaceTimeoutRef.current);
    }
    reviewSurfaceTimeoutRef.current = window.setTimeout(() => {
      setReviewSurfaceVisible(true);
      reviewSurfaceTimeoutRef.current = null;
    }, delay);
  }

  function suppressBoardArrowDuringAnimation() {
    setSuppressBoardArrow(true);
    if (boardArrowTimeoutRef.current !== null) {
      window.clearTimeout(boardArrowTimeoutRef.current);
    }
    boardArrowTimeoutRef.current = window.setTimeout(() => {
      setSuppressBoardArrow(false);
      boardArrowTimeoutRef.current = null;
    }, 220);
  }

  // Remove drag hover borders from chessboard library
  useEffect(() => {
    const removeDragBorders = () => {
      const squares = document.querySelectorAll('[class*="square"]');
      squares.forEach((square) => {
        (square as HTMLElement).style.removeProperty('border');
        (square as HTMLElement).style.removeProperty('box-shadow');
      });
    };

    // Run initially and on drag hover changes
    removeDragBorders();
    const interval = setInterval(removeDragBorders, 100);

    return () => clearInterval(interval);
  }, [dragHoverSquare]);

  const boardFen = activePly === 0 ? analysis?.metadata.initial_fen ?? INITIAL_FEN : analysis?.moves[activePly - 1]?.fen_after ?? INITIAL_FEN;
  const reviewBoard = useMemo(() => new Chess(boardFen), [boardFen]);
  // Compute classifications for moves if missing (API might not always return them)
  const computedAnalysis = useMemo(() => {
    if (!analysis) return null;
    const moves = analysis.moves.map((move) => {
      if (move.classification) return move; // Already has classification

      const classification = fallbackMoveClassification(move);
      if (classification) return { ...move, classification };
      return move;
    });
    return { ...analysis, moves };
  }, [analysis]);
  
  const selectedMove = activePly > 0 ? computedAnalysis?.moves[activePly - 1] ?? null : null;
  const evalScore = currentEval(computedAnalysis, activePly);
  const whitePercent = evalToWhitePercent(evalScore);
  
  const moveRows = useMemo(() => classifyMoveGroups(computedAnalysis?.moves ?? []), [computedAnalysis]);
  const reviewSans = useMemo(() => reviewBoard.history({ verbose: true }).map(m => m.san), [boardFen]);
  const currentOpening = useMemo(
    () => openingLabelForPosition(computedAnalysis, activePly, reviewSans),
    [activePly, computedAnalysis, reviewSans]
  );
  const reviewPositionStatus = gameStatus(reviewBoard);
  const reviewEngineLines = useMemo(() => {
    if (!analysis) return [];
    if (activePly === 0) return analysis.moves[0]?.engine_lines ?? [];
    // "Should have played" for the selected move (position before that move).
    return analysis.moves[activePly - 1]?.engine_lines ?? [];
  }, [analysis, activePly]);
  const reviewArrowSquares = squareNameFromUci(reviewEngineLines[0]?.move);
  const canStepBack = activePly > 0;
  const canStepForward = !!analysis && activePly < analysis.moves.length;
  const liveGame = useMemo(() => {
    const game = new Chess(liveStartFen);
    if (livePgn) {
      game.loadPgn(livePgn, { strict: false });
    }
    return game;
  }, [livePgn, liveStartFen]);
  const liveSans = useMemo(() => liveGame.history(), [liveGame]);
  const branchVariation = useMemo<MoveListVariation | null>(() => {
    if (!analysis || branchOriginPly === null || liveHistory.length < 2) return null;

    const lastSnapshot = liveHistory[liveHistory.length - 1];
    const branchGame = new Chess(liveStartFen);
    if (lastSnapshot?.pgn) {
      branchGame.loadPgn(lastSnapshot.pgn, { strict: false });
    }

    const fenParts = liveStartFen.split(" ");
    const startSide = fenParts[1] === "b" ? "b" : "w";
    const startMoveNumber = Number.parseInt(fenParts[5] ?? "1", 10) || 1;
    const verboseMoves = branchGame.history({ verbose: true }) as Array<{
      color: "w" | "b";
      san: string;
    }>;
    const branchMoves: VariationMove[] = verboseMoves.map((move, index) => ({
      ply: index + 1,
      moveNumber: startMoveNumber + Math.floor((index + (startSide === "b" ? 1 : 0)) / 2),
      color: move.color === "w" ? "white" : "black",
      san: move.san,
    }));
    const rows = classifyVariationGroups(branchMoves);
    const firstRow = rows[0];
    if (!firstRow) return null;

    return {
      activePly: liveCursor,
      insertBeforeMoveNumber: firstRow.white ? firstRow.moveNumber : firstRow.moveNumber + 1,
      rows,
    };
  }, [analysis, branchOriginPly, liveCursor, liveHistory, liveStartFen]);
  const liveOpening = useMemo(() => detectOpening(liveSans), [liveSans]);
  const currentLiveEval = liveEvalFen === liveFen ? liveEval : null;
  const branchMoveAnalysis = branchOriginPly !== null ? branchAnalysisResult?.moves[liveCursor - 1] ?? null : null;
  const liveCapturedPieces = useMemo(() => {
    const sessionCaptures = capturedPiecesFromLiveGame(liveGame);
    return {
      white: [...liveSeedCaptures.white, ...sessionCaptures.white],
      black: [...liveSeedCaptures.black, ...sessionCaptures.black],
    };
  }, [liveGame, liveSeedCaptures]);
  const canRedoLiveMove = liveCursor < liveHistory.length - 1;
  const reviewPlayedSquares = selectedMove ? boardSquareHighlights({ uci: selectedMove.uci, classification: selectedMove.classification }, "played") : {};
  // Branch played squares: tint the last branch move
  const branchPlayedSquares = branchMoveUci
    ? boardSquareHighlights({ uci: branchMoveUci, classification: branchMoveAnalysis?.classification ?? branchMoveClassification ?? undefined }, "played")
    : {};
  const reviewMoveSquares = squareNameFromUci(selectedMove?.uci);
  const reviewSquareAnnotations = reviewMoveSquares
    ? {
        [reviewMoveSquares[1]]: {
          label: squareBadgeText(selectedMove?.classification, "played"),
          tone: squareBadgeTone(selectedMove?.classification, "played"),
          iconSrc: squareBadgeIcon(selectedMove?.classification, "played") ?? undefined,
        },
      }
    : {};
  const reviewEndGameAnnotations = useMemo(
    () =>
      endGameBoardAnnotations({
        fen: boardFen,
        isFinalPly: !!analysis && activePly === analysis.moves.length,
        pgn,
        result: analysis?.metadata.result,
        termination: analysis?.metadata.termination,
      }),
    [activePly, analysis, boardFen, pgn]
  );
  const combinedReviewSquareAnnotations = useMemo(
    () => ({ ...reviewSquareAnnotations, ...reviewEndGameAnnotations }),
    [reviewSquareAnnotations, reviewEndGameAnnotations]
  );
  const reviewCapturedPieces = useMemo(
    () => capturedPiecesFromMoves((analysis?.moves ?? []).slice(0, activePly)),
    [analysis, activePly]
  );
  const activeBoardGame = (liveMode || branchOriginPly !== null) ? liveGame : reviewBoard;
  const interactionSquareStyles = useMemo(
    () => selectedSquareStyles(activeBoardGame, selectedSquare),
    [activeBoardGame, selectedSquare]
  );
  const reviewSquareStyles = { ...reviewPlayedSquares, ...interactionSquareStyles };
  // Use branch played squares when in branch mode, otherwise review played squares
  const reviewSquareOverlays = {
    ...interactionSquareStyles,
    ...(branchOriginPly !== null ? branchPlayedSquares : reviewPlayedSquares),
  };
  // Use liveGame for legal moves when in branch mode
  const { legalMoves: reviewLegalMoves, captureMoves: reviewCaptureMoves } = getLegalMoves(
    branchOriginPly !== null ? liveGame : reviewBoard, 
    selectedSquare
  );
  // Branch arrow: show best move from engine
  const branchArrowSquares = branchOriginPly !== null && currentLiveEval?.engine_lines[0]?.move
    ? squareNameFromUci(currentLiveEval.engine_lines[0].move)
    : null;
  // Branch annotations: badge for the last branch move
  const branchSquareAnnotations = useMemo(() => {
    if (!branchOriginPly || !branchMoveUci) return {};
    const annotations: Record<string, SquareAnnotation> = {};
    const squares = squareNameFromUci(branchMoveUci);
    const classification = branchMoveAnalysis?.classification ?? branchMoveClassification;
    if (squares && classification) {
      const [, toSquare] = squares;
      annotations[toSquare] = {
        label: squareBadgeText(classification, "played"),
        tone: squareBadgeTone(classification, "played"),
        iconSrc: squareBadgeIcon(classification, "played") ?? undefined,
      };
    }
    return annotations;
  }, [branchOriginPly, branchMoveUci, branchMoveAnalysis, branchMoveClassification]);

  useEffect(() => {
    // Run engine analysis in live mode OR when in branch mode (branchOriginPly !== null)
    if (!liveMode && branchOriginPly === null) return;

    const controller = new AbortController();
    const requestedFen = liveFen;
    setLiveLoading(true);

    fetch(`${API_URL}/api/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen: liveFen }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.detail ?? "Evaluation failed.");
        }
        if (!controller.signal.aborted) {
          setLiveEval(payload);
          setLiveEvalFen(requestedFen);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          const message = err instanceof Error ? err.message : "Evaluation failed.";
          setLiveError(message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLiveLoading(false);
        }
      });

    return () => controller.abort();
  }, [liveFen, liveMode, branchOriginPly]);

  useEffect(() => {
    if (branchOriginPly === null) {
      setBranchAnalysisResult(null);
      setBranchAnalysisLoading(false);
    }
  }, [branchOriginPly]);

  useEffect(() => {
    if (branchOriginPly === null || !livePgn || !branchMoveUci) return;

    const cleanPgn = cleanPgnFromGameHistory(liveGame, liveStartFen);
    if (!cleanPgn) return;

    const controller = new AbortController();
    setBranchAnalysisLoading(true);

    fetch(`${API_URL}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pgn: cleanPgn }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload: AnalysisResult = await response.json();
        if (!response.ok) {
          throw new Error((payload as unknown as { detail?: string }).detail ?? "Branch analysis failed.");
        }
        if (controller.signal.aborted) return;

        const classifiedPayload = analysisWithFallbackClassifications(payload);
        const latestMove = classifiedPayload.moves[classifiedPayload.moves.length - 1];
        setBranchAnalysisResult(classifiedPayload);
        setBranchMoveClassification(latestMove?.classification ?? null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : "Branch analysis failed.";
        setLiveError(message);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setBranchAnalysisLoading(false);
        }
      });

    return () => controller.abort();
  }, [branchOriginPly, branchMoveUci, liveGame, livePgn, liveStartFen]);

  const [capturedPieceAnim, setCapturedPieceAnim] = useState<{ square: string; piece: CapturedPiece } | null>(null);
  const [previousPly, setPreviousPly] = useState(0);

  useEffect(() => {
    if (!analysis || liveMode) return;

    const currentMove = activePly > 0 ? analysis.moves[activePly - 1] : null;
    const previousMove = previousPly > 0 ? analysis.moves[previousPly - 1] : null;
    const isSteppingForward = activePly > previousPly;

    // Clear any existing animation before starting a new one
    setCapturedPieceAnim(null);

    // Check if current move is a capture (forward)
    if (isSteppingForward && currentMove?.captured_piece) {
      const squares = squareNameFromUci(currentMove.uci);
      const capturedPiece = currentMove.captured_piece;
      if (squares && capturedPiece) {
        // Small delay to allow board to start animating
        setTimeout(() => {
          setCapturedPieceAnim({
            square: squares[1],
            piece: capturedPiece,
          });
          setTimeout(() => setCapturedPieceAnim(null), 250);
        }, 20);
      }
    }

    setPreviousPly(activePly);
  }, [activePly, analysis, liveMode, previousPly]);

  useEffect(() => {
    if (!analysis || liveMode) return;
    const moveCount = analysis.moves.length;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (tagName === "INPUT" || tagName === "TEXTAREA" || target?.isContentEditable) return;

      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (activePly >= moveCount) return;
        suppressBoardArrowDuringAnimation();
        setActivePly(activePly + 1);
        setSelectedSquare(null);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (activePly <= 0) return;
        suppressBoardArrowDuringAnimation();
        setActivePly(activePly - 1);
        setSelectedSquare(null);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePly, analysis, liveMode]);

  useEffect(() => {
    if (!liveMode && branchOriginPly === null) return;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (tagName === "INPUT" || tagName === "TEXTAREA" || target?.isContentEditable) return;

      if (event.key === "ArrowLeft") {
        if (liveCursor > 0) {
          const prevCursor = liveCursor - 1;
          const snapshot = liveHistory[prevCursor];
          event.preventDefault();
          isNavigatingRef.current = true;
          suppressBoardArrowDuringAnimation();
          setLiveCursor(prevCursor);
          setLivePgn(snapshot.pgn);
          setLiveFen(snapshot.fen);
          setLiveLoading(true);
          setLiveError(null);
          setBranchMoveUci(snapshot.lastMoveUci ?? null);
          setBranchMoveClassification(playtestMoveClassifications[prevCursor - 1] ?? null);
          setTimeout(() => { isNavigatingRef.current = false; }, 0);
        } else if (branchOriginPly !== null) {
          event.preventDefault();
          returnToReview();
        }
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (liveCursor >= liveHistory.length - 1) return;
        const nextCursor = liveCursor + 1;
        const snapshot = liveHistory[nextCursor];
        isNavigatingRef.current = true;
        suppressBoardArrowDuringAnimation();
        setLiveCursor(nextCursor);
        setLivePgn(snapshot.pgn);
        setLiveFen(snapshot.fen);
        setLiveLoading(true);
        setLiveError(null);
        setBranchMoveUci(snapshot.lastMoveUci ?? null);
        setBranchMoveClassification(playtestMoveClassifications[nextCursor - 1] ?? null);
        setTimeout(() => { isNavigatingRef.current = false; }, 0);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [branchOriginPly, liveCursor, liveHistory, liveMode, playtestMoveClassifications]);

  async function submitAnalysis(sourcePgn?: string) {
    const cleanPgn = normalizePgn(sourcePgn ?? pgn);
    if (!cleanPgn) {
      setError("Paste a PGN first.");
      return;
    }

    transitionBoardShell();
    const preserveCurrentShell = liveMode || !!analysis;
    setIsLoading(true);
    setError(null);
    setActivePly(0);
    setBranchOriginPly(null);
    setBranchMoveUci(null);
    setBranchMoveClassification(null);
    setBranchMoveEvalBefore(null);
    setSelectedSquare(null);
    setPlaytestAnalysisEnabled(false);
    setPlaytestAnalysisResult(null);
    setPlaytestAnalysisBase(null);
    setPlaytestBranchOriginCursor(null);
    setIsPlaytestReview(false);
    setPgn(cleanPgn);
    setActiveGameSource(null);
    setActiveSavedGameId(null);

    if (!preserveCurrentShell) {
      setAnalysis(null);
      setLiveMode(false);
    }

    try {
      const response = await fetch(`${API_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn: cleanPgn }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.detail ?? "Analysis failed.");
      }
      transitionBoardShell();
      setAnalysis(payload);
      setPanelTab("analysis");
      setLiveMode(false);
      setReviewTab("review");
      setActivePly(payload.moves.length);
      const savedGame = saveRecentGame(cleanPgn, payload);
      setActiveGameSource("mygames");
      setActiveSavedGameId(savedGame.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Analysis failed.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  function resetLiveBoard() {
    transitionBoardShell();
    setReviewSurfaceVisible(true);
    const initialSnapshot = { pgn: "", fen: INITIAL_FEN };
    setBranchOriginPly(null);
    setBranchMoveUci(null);
    setBranchMoveClassification(null);
    setBranchMoveEvalBefore(null);
    setSelectedSquare(null);
    setLiveStartFen(INITIAL_FEN);
    setLiveHistory([initialSnapshot]);
    setLiveCursor(0);
    setLiveSeedCaptures(emptyCaptureSummary());
    setLivePgn(initialSnapshot.pgn);
    setLiveFen(initialSnapshot.fen);
    setLiveEval(null);
    setLiveLoading(true);
    setLiveError(null);
    setPlaytestAnalysisResult(null);
    setPlaytestAnalysisEnabled(false);
    setPlaytestAnalysisBase(null);
    setPlaytestBranchOriginCursor(null);
    setIsPlaytestReview(false);
    setPlaytestMoveClassifications({});
    setActiveGameSource(null);
    setActiveSavedGameId(null);
  }

  function startLiveBoard() {
    setReviewSurfaceVisible(true);
    setAnalysis(null);
    setActiveGameSource(null);
    setActiveSavedGameId(null);
    setPlaytestAnalysisResult(null);
    setPlaytestAnalysisEnabled(false);
    setPlaytestAnalysisBase(null);
    setPlaytestBranchOriginCursor(null);
    setIsPlaytestReview(false);
    setBranchOriginPly(null);
    setBranchMoveUci(null);
    setBranchMoveClassification(null);
    setBranchMoveEvalBefore(null);
    setSelectedSquare(null);
    setError(null);
    resetLiveBoard();
    setLiveMode(true);
    setPanelTab("analysis");
  }

  async function analyzePlaytestAsReview() {
    const cleanPgn = normalizePgn(cleanPgnFromGameHistory(liveGame, liveStartFen));
    if (!cleanPgn) {
      setLiveError("Make some moves first.");
      return;
    }
    const analysisBase = {
      history: [...liveHistory],
      cursor: liveCursor,
    };

    setIsLoading(true);
    setLiveError(null);
    setError(null);
    setSelectedSquare(null);
    setBranchOriginPly(null);
    setBranchMoveUci(null);
    setBranchMoveClassification(null);
    setBranchMoveEvalBefore(null);
    setPlaytestAnalysisEnabled(true);
    setPlaytestAnalysisBase(analysisBase);
    setPlaytestBranchOriginCursor(null);
    setPlaytestAnalysisResult(null);
    setPlaytestMoveClassifications({});
    setPgn(cleanPgn);

    try {
      const response = await fetch(`${API_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn: cleanPgn }),
      });
      const payload: AnalysisResult = await response.json();
      if (!response.ok) {
        throw new Error((payload as unknown as { detail?: string }).detail ?? "Analysis failed.");
      }

      const classifiedPayload = analysisWithFallbackClassifications(payload);
      if (classifiedPayload.moves.length === 0) {
        throw new Error("No moves were found to review. Make a move first, then click Analysis.");
      }
      setAnalysis(classifiedPayload);
      setPlaytestAnalysisResult(classifiedPayload);
      setPlaytestMoveClassifications(classificationMapFromAnalysis(classifiedPayload));
      setIsPlaytestReview(true);
      setPanelTab("analysis");
      setActivePly(classifiedPayload.moves.length);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Analysis failed.";
      setLiveError(message);
      setPlaytestAnalysisEnabled(false);
      setPlaytestAnalysisBase(null);
      setPlaytestBranchOriginCursor(null);
    } finally {
      setIsLoading(false);
    }
  }

  async function analyzePlaytestBoard(sourcePgn = livePgn, sourceCursor = liveCursor, signal?: AbortSignal) {
    if (!sourcePgn) return;
    setIsLoading(true);
    setLiveError(null);
    try {
      const response = await fetch(`${API_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn: sourcePgn }),
        signal,
      });
      const payload: AnalysisResult = await response.json();
      if (!response.ok) {
        throw new Error((payload as unknown as { detail?: string }).detail ?? "Analysis failed.");
      }

      if (signal?.aborted) return;

      const classifiedPayload = analysisWithFallbackClassifications(payload);
      const classifications = classificationMapFromAnalysis(classifiedPayload);

      setPlaytestAnalysisResult(classifiedPayload);
      setPlaytestMoveClassifications((current) => ({ ...current, ...classifications }));
      setBranchMoveClassification(classifications[sourceCursor - 1] ?? null);
    } catch (err) {
      if (signal?.aborted) return;
      const message = err instanceof Error ? err.message : "Analysis failed.";
      setLiveError(message);
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!liveMode || !playtestAnalysisEnabled || !livePgn) return;

    const cleanPgn = normalizePgn(cleanPgnFromGameHistory(liveGame, liveStartFen));
    if (!cleanPgn) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void analyzePlaytestBoard(cleanPgn, liveCursor, controller.signal);
    }, 0);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
    // analyzePlaytestBoard intentionally reads the snapshot passed above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMode, playtestAnalysisEnabled, livePgn, liveCursor, liveStartFen]);

  function snapshotAfterMove(startFen: string, currentPgn: string, sourceSquare: string, targetSquare: string | null) {
    if (!targetSquare) return null;

    const nextGame = new Chess(startFen);
    if (currentPgn) {
      nextGame.loadPgn(currentPgn, { strict: false });
    }

    try {
      nextGame.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
    } catch {
      return null;
    }

    return {
      pgn: nextGame.pgn({ newline: " ", maxWidth: 0 }),
      fen: nextGame.fen(),
      lastMoveUci: `${sourceSquare}${targetSquare}`,
    };
  }

  function handleLiveDrop(sourceSquare: string, targetSquare: string | null) {
    const uci = targetSquare ? `${sourceSquare}${targetSquare}` : null;
    const nextMainlineSnapshot = liveHistory[liveCursor + 1];

    if (playtestAnalysisEnabled && uci && nextMainlineSnapshot?.lastMoveUci === uci) {
      const nextCursor = liveCursor + 1;
      isNavigatingRef.current = true;
      suppressBoardArrowDuringAnimation();
      setLiveLoading(true);
      setLiveError(null);
      if (targetSquare) setSelectedSquare(targetSquare);
      setLiveCursor(nextCursor);
      setLivePgn(nextMainlineSnapshot.pgn);
      setLiveFen(nextMainlineSnapshot.fen);
      setBranchMoveUci(nextMainlineSnapshot.lastMoveUci ?? null);
      setBranchMoveClassification(playtestMoveClassifications[nextCursor - 1] ?? null);
      setTimeout(() => { isNavigatingRef.current = false; }, 0);
      return true;
    }

    const nextSnapshot = snapshotAfterMove(liveStartFen, livePgn, sourceSquare, targetSquare);
    if (!nextSnapshot) return false;
    const nextCursor = liveCursor + 1;
    const isTemporaryAnalysisBranch = playtestAnalysisEnabled && liveCursor < liveHistory.length - 1;
    const isExtendingPlaytestMainline = playtestAnalysisEnabled && playtestBranchOriginCursor === null && !isTemporaryAnalysisBranch;
    const nextHistory = [...liveHistory.slice(0, liveCursor + 1), nextSnapshot];

    setLiveLoading(true);
    setLiveError(null);
    if (targetSquare) setSelectedSquare(targetSquare);
    if (isTemporaryAnalysisBranch) {
      setPlaytestAnalysisBase((current) => current ?? { history: liveHistory, cursor: liveHistory.length - 1 });
      setPlaytestBranchOriginCursor(liveCursor);
    }
    setLiveHistory(nextHistory);
    setPlaytestMoveClassifications((current) => {
      const next: Record<number, Classification | null> = {};
      for (const [index, classification] of Object.entries(current)) {
        if (Number(index) < liveCursor) next[Number(index)] = classification;
      }
      return next;
    });
    if (isExtendingPlaytestMainline) {
      setPlaytestAnalysisBase({ history: nextHistory, cursor: nextHistory.length - 1 });
    }
    setLiveCursor(nextCursor);
    setLivePgn(nextSnapshot.pgn);
    setLiveFen(nextSnapshot.fen);
    // Set branch move UCI from snapshot (includes the move that was just made)
    setBranchMoveUci(nextSnapshot.lastMoveUci ?? null);
    setBranchMoveClassification(null);
    setBranchAnalysisResult(null);
    if (branchOriginPly !== null) {
      setBranchAnalysisLoading(true);
    }
    // Capture eval BEFORE this move, but only if it belongs to the current board position.
    setBranchMoveEvalBefore(currentLiveEval?.eval ?? { cp: 0, mate: null, display: "0.0" });
    return true;
  }

  function handleReviewBranchDrop(sourceSquare: string, targetSquare: string | null) {
    const uci = targetSquare ? `${sourceSquare}${targetSquare}` : null;

    // Check if this move matches the next move in the analysis - if so, advance instead of branching
    if (uci && analysis && activePly < analysis.moves.length) {
      const nextMove = analysis.moves[activePly];
      if (nextMove.uci === uci) {
        // Advance to next move instead of creating a branch
        setActivePly(activePly + 1);
        if (targetSquare) setSelectedSquare(targetSquare);
        return true;
      }
    }

    const nextSnapshot = snapshotAfterMove(boardFen, "", sourceSquare, targetSquare);
    if (!nextSnapshot) return false;

    const initialSnapshot = { pgn: "", fen: boardFen };
    setLiveStartFen(boardFen);
    setLiveHistory([initialSnapshot, nextSnapshot]);
    setLiveCursor(1);
    setLiveSeedCaptures({
      white: [...reviewCapturedPieces.white],
      black: [...reviewCapturedPieces.black],
    });
    setLiveFen(nextSnapshot.fen);
    setLivePgn(nextSnapshot.pgn);
    setLiveEval(null);
    setLiveLoading(true);
    setLiveError(null);
    setBranchOriginPly(activePly);
    setBranchMoveUci(uci);
    setBranchMoveClassification(null);
    setBranchAnalysisResult(null);
    setBranchAnalysisLoading(true);
    // Store the eval before the branch move (from current review position)
    setBranchMoveEvalBefore(selectedMove?.eval_after ?? evalScore);
    if (targetSquare) setSelectedSquare(targetSquare);
    // Stay in review layout, just swap the right panel to branch mode
    setPanelTab("analysis");
    return true;
  }

  function handleBoardDrop(sourceSquare: string, targetSquare: string | null) {
    setDragHoverSquare(null);
    // Use handleLiveDrop if in live mode OR if already in branch mode (branchOriginPly !== null)
    return (liveMode || branchOriginPly !== null) 
      ? handleLiveDrop(sourceSquare, targetSquare) 
      : handleReviewBranchDrop(sourceSquare, targetSquare);
  }

  function handleBoardSquareClick(square: string | null) {
    if (!square) {
      setSelectedSquare(null);
      return;
    }
    const currentGame = (liveMode || branchOriginPly !== null) ? liveGame : reviewBoard;
    const piece = currentGame.get(square as Square);

    // If a piece is selected and clicking on a different square, try to move
    if (selectedSquare && selectedSquare !== square) {
      if (handleBoardDrop(selectedSquare, square)) {
        // Keep the piece selected after moving
        setSelectedSquare(square);
        return;
      }
    }

    // If clicking on the same square, deselect
    if (selectedSquare === square) {
      setSelectedSquare(null);
      return;
    }

    // If clicking on a piece of the current turn's color, select it
    if (piece && piece.color === currentGame.turn()) {
      setSelectedSquare(square);
      return;
    }

    // Otherwise deselect
    setSelectedSquare(null);
  }

  function handleBoardPieceClick(square: string | null) {
    if (!square) {
      setSelectedSquare(null);
      return;
    }
    const currentGame = liveMode ? liveGame : reviewBoard;
    const piece = currentGame.get(square as Square);

    // If clicking on a piece, select it (any piece in analysis mode, only current turn in live mode)
    if (piece) {
      if (liveMode && piece.color !== currentGame.turn()) {
        setSelectedSquare(null);
        return;
      }
      setSelectedSquare(square);
      return;
    }

    // Otherwise deselect
    setSelectedSquare(null);
  }

  function undoLiveMove() {
    if (liveCursor <= 0) {
      returnToReview();
      return;
    }
    const prevCursor = liveCursor - 1;
    const snapshot = liveHistory[prevCursor];
    isNavigatingRef.current = true;
    suppressBoardArrowDuringAnimation();
    setLiveLoading(true);
    setLiveError(null);
    setLiveCursor(prevCursor);
    setLivePgn(snapshot.pgn);
    setLiveFen(snapshot.fen);
    setBranchMoveUci(snapshot.lastMoveUci ?? null);
    // Restore stored classification for this position (move that landed here)
    setBranchMoveClassification(playtestMoveClassifications[prevCursor - 1] ?? null);
    setTimeout(() => { isNavigatingRef.current = false; }, 0);
  }

  function redoLiveMove() {
    if (!canRedoLiveMove) return;
    const nextCursor = liveCursor + 1;
    const snapshot = liveHistory[nextCursor];
    isNavigatingRef.current = true;
    suppressBoardArrowDuringAnimation();
    setLiveLoading(true);
    setLiveError(null);
    setLiveCursor(nextCursor);
    setLivePgn(snapshot.pgn);
    setLiveFen(snapshot.fen);
    setBranchMoveUci(snapshot.lastMoveUci ?? null);
    // Restore stored classification for this position
    setBranchMoveClassification(playtestMoveClassifications[nextCursor - 1] ?? null);
    setTimeout(() => { isNavigatingRef.current = false; }, 0);
  }

  function saveRecentGame(cleanPgn: string, result: AnalysisResult) {
    const savedGame = recentGameFromAnalysis(cleanPgn, result);
    setSavedGames((current) => {
      const next = [savedGame, ...current.filter((game) => game.pgn !== cleanPgn)];
      const sorted = sortSavedGames(next);
      persistLocalGames(sorted, authUser?.id);
      return sorted;
    });
    if (supabase && authUser) {
      saveCloudGame(supabase as SupabaseClient, authUser, savedGame as CloudSavedGame).catch(() => {
        setAccountSyncError("Could not save this game to your account yet.");
      });
    }
    return savedGame;
  }

  function saveDraftGame(cleanPgn: string, title?: string, subtitle?: string) {
    const existingGame = savedGames.find((game) => game.pgn === cleanPgn);
    if (existingGame) return existingGame;

    const savedGame = savedGameFromPgn(cleanPgn, { title, subtitle });
    setSavedGames((current) => {
      const next = [savedGame, ...current.filter((game) => game.pgn !== cleanPgn)];
      const sorted = sortSavedGames(next);
      persistLocalGames(sorted, authUser?.id);
      return sorted;
    });
    if (supabase && authUser) {
      saveCloudGame(supabase as SupabaseClient, authUser, savedGame as CloudSavedGame).catch(() => {
        setAccountSyncError("Could not save this game to your account yet.");
      });
    }
    return savedGame;
  }

  function saveCurrentGame() {
    const cleanPgn = normalizePgn(liveMode ? livePgn : pgn);
    if (!cleanPgn) return;

    if (!liveMode && analysis) {
      const savedGame = saveRecentGame(cleanPgn, analysis);
      setActiveGameSource("mygames");
      setActiveSavedGameId(savedGame.id);
      return;
    }

    saveDraftGame(cleanPgn, branchOriginPly !== null ? "Branch line" : "Live board", `${openingLabelForDraft()} · draft`);
  }

  async function addUploadedGame(openAfterAdding: boolean) {
    const cleanPgn = normalizePgn(pgn);
    if (!cleanPgn) {
      setError("Paste a PGN first.");
      return;
    }

    try {
      const savedGame = saveDraftGame(cleanPgn);
      setPgn(cleanPgn);
      setError(null);
      setShowUploadInHistory(false);
      setActiveGameSource("mygames");

      if (openAfterAdding) {
        await loadSavedGame(savedGame, "mygames");
      } else {
        setPanelTab("mygames");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this PGN.");
    }
  }

  function deleteSavedGame(gameId: string) {
    setSavedGames((current) => {
      const next = current.filter((game) => game.id !== gameId);
      persistLocalGames(next, authUser?.id);
      return next;
    });
    if (supabase && authUser) {
      deleteCloudGame(supabase as SupabaseClient, authUser, gameId).catch(() => {
        setAccountSyncError("Could not delete this game from your account yet.");
      });
    }
    setLoadingGameId((current) => (current === gameId ? null : current));
    if (activeSavedGameId === gameId) {
      setAnalysis(null);
      setActivePly(0);
      setLiveMode(true);
      resetLiveBoard();
      setPanelTab("mygames");
      setReviewTab("review");
    }
  }

  function openingLabelForDraft() {
    if (analysis && branchOriginPly !== null) return analysis.metadata.opening || "Analysis branch";
    return liveOpening;
  }

  async function signInWithGoogle() {
    if (!supabase) {
      setAccountSyncError("Supabase is not configured yet.");
      return;
    }

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: {
          access_type: "offline",
          prompt: "consent",
        },
      },
    });

    if (error) {
      setAccountSyncError("Google sign-in could not start.");
    }
  }

  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) {
      setAccountSyncError("Could not sign out.");
      return;
    }
    setAuthUser(null);
    setSyncedAccountId(null);
    setSavedGames(sortSavedGames(loadRecentGames()));
    setUserName(localStorage.getItem(accountStorageKey(USER_NAME_KEY)) ?? "");
  }

  async function loadSavedGame(game: SavedGame, source: GameSource = "mygames") {
    const cleanPgn = normalizePgn(game.pgn);
    if (!cleanPgn) return;

    transitionBoardShell();
    setReviewSurfaceVisible(false);
    setReviewEvalVisible(false);
    setPgn(cleanPgn);
    setActiveGameSource(source);
    setActiveSavedGameId(null);
    setLoadingGameId(game.id);
    setPendingGameReview({ game, source, rows: moveRowsFromPgn(cleanPgn) });
    setPanelTab("analysis");
    setReviewTab("review");
    setPlaytestAnalysisEnabled(false);
    setPlaytestAnalysisResult(null);
    setPlaytestAnalysisBase(null);
    setPlaytestBranchOriginCursor(null);
    setPlaytestMoveClassifications({});
    setIsPlaytestReview(false);
    setIsLoading(true);
    setError(null);
    setLiveError(null);
    setSelectedSquare(null);
    setBranchOriginPly(null);
    setBranchMoveUci(null);
    setBranchMoveClassification(null);
    setBranchMoveEvalBefore(null);

    try {
      const response = await fetch(`${API_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn: cleanPgn }),
      });
      const payload: AnalysisResult = await response.json();
      if (!response.ok) {
        throw new Error((payload as unknown as { detail?: string }).detail ?? "Analysis failed.");
      }

      const classifiedPayload = analysisWithFallbackClassifications(payload);
      const snapshots = liveSnapshotsFromAnalysis(classifiedPayload);
      const finalSnapshot = snapshots[snapshots.length - 1] ?? { pgn: cleanPgn, fen: classifiedPayload.metadata.initial_fen ?? INITIAL_FEN };
      const analyzedSavedGame =
        source === "mygames"
          ? {
              ...recentGameFromAnalysis(cleanPgn, classifiedPayload),
              id: game.id,
              uploadedAt: game.uploadedAt || game.updatedAt,
            }
          : null;

      if (analyzedSavedGame) {
        setSavedGames((current) => {
          const next = [analyzedSavedGame, ...current.filter((savedGame) => savedGame.pgn !== cleanPgn)];
          const sorted = sortSavedGames(next);
          persistLocalGames(sorted, authUser?.id);
          return sorted;
        });
        if (supabase && authUser) {
          saveCloudGame(supabase as SupabaseClient, authUser, analyzedSavedGame as CloudSavedGame).catch(() => {
            setAccountSyncError("Could not save this game to your account yet.");
          });
        }
      }

      transitionBoardShell();
      setAnalysis(classifiedPayload);
      setPendingGameReview(null);
      setPlaytestAnalysisResult(classifiedPayload);
      setPlaytestMoveClassifications(classificationMapFromAnalysis(classifiedPayload));
      setLiveStartFen(classifiedPayload.metadata.initial_fen ?? INITIAL_FEN);
      setLiveHistory(snapshots);
      setLiveCursor(Math.max(0, snapshots.length - 1));
      setLivePgn(cleanPgn);
      setLiveFen(finalSnapshot.fen);
      setActivePly(classifiedPayload.moves.length);
      setPlaytestAnalysisBase(null);
      setPlaytestBranchOriginCursor(null);
      setLiveMode(false);
      setPanelTab("analysis");
      setReviewTab("review");
      setActiveSavedGameId(source === "mygames" ? game.id : null);
      revealReviewSurface();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Analysis failed.";
      setLiveError(message);
      setPlaytestAnalysisEnabled(false);
      setPlaytestAnalysisBase(null);
      setPlaytestBranchOriginCursor(null);
      revealReviewSurface(0);
    } finally {
      setIsLoading(false);
      setLoadingGameId(null);
    }
  }

  // Legacy helper kept safe: saved games should open in the normal review layout.
  async function loadGameToSandbox(game: SavedGame) {
    setIsLoading(true);
    setLiveError(null);
    try {
      const response = await fetch(`${API_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn: game.pgn }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.detail ?? "Analysis failed.");
      }
      setAnalysis(payload);
      // Stay in liveMode - just update the live board with the game
      setLivePgn(game.pgn);
      setLiveFen(payload.final_fen ?? INITIAL_FEN);
      // Parse the game to set up the live history
      const tempGame = new Chess();
      const moves = payload.moves as Array<{ uci: string; san: string }>;
      const history: Array<{ pgn: string; fen: string }> = [];
      for (const move of moves) {
        tempGame.move(move.uci);
        history.push({ pgn: tempGame.pgn(), fen: tempGame.fen() });
      }
      setLiveHistory(history.length > 0 ? history : [{ pgn: "", fen: INITIAL_FEN }]);
      setLiveCursor(history.length > 0 ? history.length - 1 : 0);
      setActivePly(moves.length); // Set activePly to show the last move with classification
      setBranchOriginPly(null); // Clear branch mode - this is a reviewed game
      setLiveMode(false); // Exit live mode to show full review UI with badges
      setPanelTab("analysis"); // Switch to the normal review panel.
    } catch (err) {
      const message = err instanceof Error ? err.message : "Analysis failed.";
      setLiveError(message);
    } finally {
      setIsLoading(false);
    }
  }

  function showUpload() {
    setPanelTab("upload");
  }

  function playFromReviewPosition() {
    setReviewSurfaceVisible(true);
    setSelectedSquare(null);
    const initialSnapshot = { pgn: "", fen: boardFen };
    setLiveStartFen(boardFen);
    setLiveHistory([initialSnapshot]);
    setLiveCursor(0);
    setLiveSeedCaptures({
      white: [...reviewCapturedPieces.white],
      black: [...reviewCapturedPieces.black],
    });
    setLiveFen(initialSnapshot.fen);
    setLivePgn(initialSnapshot.pgn);
    setLiveEval(null);
    setLiveLoading(true);
    setLiveError(null);
    setBranchOriginPly(activePly);
    setSelectedSquare(null);
    setLiveMode(true);
    setPanelTab("analysis");
  }

  function returnToReview() {
    if (!analysis) return;
    setReviewSurfaceVisible(true);
    setLiveMode(false);
    setSelectedSquare(null);
    setBranchOriginPly(null);
    setBranchMoveUci(null);
    setBranchMoveClassification(null);
    setBranchMoveEvalBefore(null);
    setPanelTab("analysis");
  }

  function returnToPlaytestGame() {
    setReviewSurfaceVisible(true);
    const base = playtestAnalysisBase;
    const targetHistory = base?.history ?? liveHistory;
    const targetCursor = Math.max(0, targetHistory.length - 1);
    const targetSnapshot = targetHistory[targetCursor] ?? { pgn: "", fen: liveStartFen };

    setLiveMode(true);
    setPanelTab("analysis");
    setSelectedSquare(null);
    setLiveError(null);
    setBranchOriginPly(null);
    setLiveHistory(targetHistory);
    setLiveCursor(targetCursor);
    setLivePgn(targetSnapshot.pgn);
    setLiveFen(targetSnapshot.fen);
    setBranchMoveUci(targetSnapshot.lastMoveUci ?? null);
    setBranchMoveClassification(null);
    setBranchMoveEvalBefore(null);
    setPlaytestAnalysisEnabled(false);
    setPlaytestAnalysisBase(null);
    setPlaytestBranchOriginCursor(null);
    setIsPlaytestReview(false);
    setPlaytestMoveClassifications({});
  }

  function jumpToMainlineReview(ply: number) {
    if (ply === activePly) return;
    suppressBoardArrowDuringAnimation();
    setActivePly(ply);
    setSelectedSquare(null);
    returnToReview();
  }

  function goToFirstMove() {
    if (!canStepBack) return;
    suppressBoardArrowDuringAnimation();
    setActivePly(0);
    setSelectedSquare(null);
  }

  function goToPreviousMove() {
    if (!canStepBack) return;
    suppressBoardArrowDuringAnimation();
    setActivePly((value) => Math.max(0, value - 1));
    setSelectedSquare(null);
  }

  function goToNextMove() {
    if (!canStepForward) return;
    suppressBoardArrowDuringAnimation();
    setActivePly((value) => Math.min(analysis.moves.length, value + 1));
    setSelectedSquare(null);
  }

  function goToLastMove() {
    if (!canStepForward) return;
    suppressBoardArrowDuringAnimation();
    setActivePly(analysis.moves.length);
    setSelectedSquare(null);
  }

  return (
    <main className="min-h-screen px-4 py-3 text-stone-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-[1620px] flex-col gap-3">
        {panelTab === "home" ? (
          <HomeIntroLayout
            onFreshBoard={startLiveBoard}
            onMyGames={() => {
              setActiveGameSource(null);
              setPanelTab("mygames");
            }}
            onPublicGames={() => {
              setActiveGameSource(null);
              setPanelTab("publicgames");
            }}
            onSave={saveCurrentGame}
            saveDisabled={reviewSans.length === 0 && liveSans.length === 0}
            userName={userName}
            onUserNameChange={setUserName}
            accountEmail={authUser?.email ?? null}
            accountName={accountName}
            accountAvatarUrl={accountAvatarUrl}
            authConfigured={authConfigured}
            authLoading={authLoading}
            accountSyncError={accountSyncError}
            onSignIn={signInWithGoogle}
            onSignOut={signOut}
          />
        ) : liveMode || !analysis ? (
          <LiveBoard
            analysis={playtestAnalysisResult}
            boardOrientation={boardOrientation}
            branchVariation={branchVariation}
            branchOriginPly={branchOriginPly}
            playtestBranchOriginCursor={playtestBranchOriginCursor}
            branchMoveUci={branchMoveUci}
            branchMoveClassification={branchMoveClassification}
            branchMoveAnalysis={branchMoveAnalysis}
            captures={liveCapturedPieces}
            evalData={currentLiveEval}
            game={liveGame}
            isLoading={playtestAnalysisEnabled ? isLoading || liveLoading : liveLoading}
            liveCursor={liveCursor}
            liveError={liveError}
            liveHistory={liveHistory}
            playtestAnalysis={playtestAnalysisEnabled}
            suppressBoardArrow={suppressBoardArrow}
            canRedo={canRedoLiveMove}
            onAnalyzePgn={() => addUploadedGame(true)}
            onAddPgn={() => addUploadedGame(false)}
            onTogglePlaytestAnalysis={analyzePlaytestAsReview}
            onExitPlaytestAnalysis={returnToPlaytestGame}
            onBackToList={() => {
                          setPanelTab("mygames");
                          setAnalysis(null);
                          setActivePly(0);
                          setBranchOriginPly(null);
                          setLiveMode(true);
                          resetLiveBoard();
                        }}
            onDrop={handleBoardDrop}
            onFlipBoard={() => setBoardOrientation(boardOrientation === "white" ? "black" : "white")}
            onFreshBoard={startLiveBoard}
            onLoadSaved={loadSavedGame}
            onDeleteSaved={deleteSavedGame}
            onMainlineSelect={jumpToMainlineReview}
            onClearPendingGameReview={() => {
              setPendingGameReview(null);
              setLoadingGameId(null);
              setIsLoading(false);
              setLiveError(null);
              setReviewSurfaceVisible(true);
            }}
            showUploadInHistory={showUploadInHistory}
            setShowUploadInHistory={setShowUploadInHistory}
            historyView={historyView}
            setHistoryView={setHistoryView}
            mounted={mounted}
            loadingGameId={loadingGameId}
            onPieceClick={handleBoardPieceClick}
            onPieceDrag={(square) => setDragHoverSquare(square)}
            onReset={resetLiveBoard}
            onRedo={redoLiveMove}
            onReturnToReview={returnToReview}
            onSample={() => setPgn(SAMPLE_PGN)}
            onSaveCurrentPgn={saveCurrentGame}
            onHome={() => setPanelTab("home")}
            onSetPanelTab={setPanelTab}
            onSetPgn={setPgn}
            dragHoverSquare={dragHoverSquare}
            onSquareClick={handleBoardSquareClick}
            onUndo={undoLiveMove}
            panelTab={panelTab}
            reviewRows={moveRows}
            savedGames={savedGames}
            selectedSquare={selectedSquare}
            sans={liveSans}
            playtestMoveClassifications={playtestMoveClassifications}
            uploadError={error}
            uploadIsLoading={isLoading}
            uploadPgn={pgn}
            boardTransitioning={boardTransitioning}
            pendingGameReview={pendingGameReview}
            reviewSurfaceVisible={reviewSurfaceVisible}
            userName={userName}
            onUserNameChange={setUserName}
            accountEmail={authUser?.email ?? null}
            accountName={accountName}
            accountAvatarUrl={accountAvatarUrl}
            authConfigured={authConfigured}
            authLoading={authLoading}
            accountSyncError={accountSyncError}
            onSignIn={signInWithGoogle}
            onSignOut={signOut}
          />
        ) : (
          <section className="game-review-shell grid items-stretch xl:grid-cols-[208px_minmax(620px,960px)_minmax(360px,1fr)]">
            <AppRail
              active={
                activeGameSource === "mygames"
                  ? "mygames"
                  : activeGameSource === "publicgames"
                    ? "publicgames"
                    : panelTab === "mygames"
                  ? "mygames"
                  : panelTab === "publicgames"
                    ? "publicgames"
                    : isPlaytestReview
                      ? "playtest"
                      : "analysis"
              }
              onFreshBoard={startLiveBoard}
              onHome={() => {
                setActiveGameSource(null);
                setPanelTab("home");
              }}
              onMyGames={() => {
                setActiveGameSource(null);
                setPanelTab("mygames");
              }}
              onPublicGames={() => {
                setActiveGameSource(null);
                setPanelTab("publicgames");
              }}
              onSave={saveCurrentGame}
              saveDisabled={reviewSans.length === 0}
              userName={userName}
              onUserNameChange={setUserName}
              accountEmail={authUser?.email ?? null}
              accountName={accountName}
              accountAvatarUrl={accountAvatarUrl}
              authConfigured={authConfigured}
              authLoading={authLoading}
              accountSyncError={accountSyncError}
              onSignIn={signInWithGoogle}
              onSignOut={signOut}
            />
            <div className={`board-column-shell review-surface-fade flex min-h-0 flex-col justify-center ${reviewSurfaceVisible ? "review-surface-fade-visible" : ""}`}>
              <div
                className="board-eval-layout min-h-0 flex-1"
                data-eval-visible={reviewEvalVisible}
                data-transitioning={boardTransitioning}
                style={{
                  "--eval-column": "48px",
                  "--eval-gap": "0.75rem",
                  "--eval-row": "32px",
                } as CSSProperties}
              >
                <div
                  className={`board-eval-slot min-w-0 overflow-hidden transition-[opacity,transform] duration-300 ease-out ${
                    reviewEvalVisible ? "translate-x-0 opacity-100" : "-translate-x-2 opacity-0"
                  }`}
                  style={{ visibility: reviewEvalVisible ? "visible" : "hidden" }}
                />
                <div className="board-eval-stage min-h-0">
                  <BoardStage
                    topPlayer={{
                      active: reviewBoard.turn() === "b",
                      color: "black",
                      captures: reviewCapturedPieces.black,
                      name: analysis.metadata.black || "Black",
                      rating: analysis.metadata.black_elo,
                    }}
                    bottomPlayer={{
                      active: reviewBoard.turn() === "w",
                      color: "white",
                      captures: reviewCapturedPieces.white,
                      name: analysis.metadata.white || "White",
                      rating: analysis.metadata.white_elo,
                    }}
                    horizontalEvalBar={
                      <div className={`eval-bar-fade ${reviewEvalVisible ? "eval-bar-fade-visible" : ""}`}>
                        <EvalBar
                          key={`horizontal-${boardOrientation}`}
                          score={evalScore}
                          whitePercent={whitePercent}
                          boardOrientation={boardOrientation}
                        />
                      </div>
                    }
                    onFlipBoard={() => setBoardOrientation(boardOrientation === "white" ? "black" : "white")}
                    boardOrientation={boardOrientation}
                    edgeToEdge
                  >
                    <div className="board-stage-transition" data-transitioning={boardTransitioning}>
                      <ChessgroundBoard
                        key={boardOrientation}
                        fen={branchOriginPly !== null ? liveFen : boardFen}
                        orientation={boardOrientation}
                        turnColor={(branchOriginPly !== null ? liveGame : reviewBoard).turn() === "w" ? "white" : "black"}
                        dests={getLegalDests(branchOriginPly !== null ? liveGame : reviewBoard)}
                        animationDuration={180}
                        onMove={(orig, dest) => {
                          handleBoardDrop(orig, dest);
                        }}
                        onSelect={(key) => {
                          setSelectedSquare(key);
                        }}
                      >
                      <BoardSquareOverlay
                        squareOverlays={reviewSquareOverlays}
                        legalMoves={reviewLegalMoves}
                        captureMoves={reviewCaptureMoves}
                        orientation={boardOrientation}
                      />
                      <BoardBadgeOverlay
                        annotations={branchOriginPly !== null ? branchSquareAnnotations : combinedReviewSquareAnnotations}
                        orientation={boardOrientation}
                      />
                      <BoardArrowOverlay
                        arrow={
                          suppressBoardArrow
                            ? null
                            : branchOriginPly !== null
                              ? (branchArrowSquares ? [branchArrowSquares[0], branchArrowSquares[1]] : null)
                              : (reviewArrowSquares ? [reviewArrowSquares[0], reviewArrowSquares[1]] : null)
                        }
                        color={REVIEW_ARROW_COLOR}
                        boardOrientation={boardOrientation}
                      />
                      <CaptureAnimationOverlay capture={capturedPieceAnim} boardOrientation={boardOrientation} />
                    </ChessgroundBoard>
                  </div>
                  </BoardStage>
                </div>
              </div>
            </div>

            <aside className="review-panel-shell flex min-h-0 flex-col overflow-hidden rounded-md border border-white/10 bg-[#203746]/82 p-4 shadow-2xl shadow-black/20">
              {panelTab === "analysis" ? (
                branchOriginPly !== null ? (
                  <LiveAnalysisPanel
                    analysis={analysis}
                    branchOriginPly={branchOriginPly}
                    playtestBranchOriginCursor={null}
                    branchMoveClassification={branchMoveClassification}
                    branchMoveAnalysis={branchMoveAnalysis}
                    branchVariation={branchVariation}
                    evalData={currentLiveEval}
                    game={liveGame}
                    isLoading={liveLoading || branchAnalysisLoading}
                    lastMove={branchMoveUci ? { san: liveGame.history({ verbose: true }).slice(-1)[0]?.san ?? "" } : null}
                    liveCursor={liveCursor}
                    liveError={liveError}
                    liveHistory={liveHistory}
                    reviewRows={moveRows}
                    rows={moveRows}
                    hasMoves={true}
                    onMainlineSelect={jumpToMainlineReview}
                    onUndo={undoLiveMove}
                    onRedo={redoLiveMove}
                    onReturnToReview={returnToReview}
                    savedGames={savedGames}
                    onLoadSaved={loadGameToSandbox}
                    onSetPanelTab={setPanelTab}
                    onBackToList={() => {
                          setPanelTab("mygames");
                          setAnalysis(null);
                          setActivePly(0);
                          setBranchOriginPly(null);
                          setLiveMode(false);
                        }}
                    playtestAnalysis={false}
                    onTogglePlaytestAnalysis={() => {}}
                    onExitPlaytestAnalysis={() => {}}
                    playtestMoveClassifications={{}}
                    currentOpening={currentOpening}
                  />
                ) : pendingGameReview ? (
                  <PendingGameReviewPanel
                    pendingGameReview={pendingGameReview}
                    isLoading={isLoading || loadingGameId === pendingGameReview.game.id}
                    error={liveError}
                    onBackToList={() => {
                      setPanelTab(pendingGameReview.source);
                      setPendingGameReview(null);
                      setLoadingGameId(null);
                      setIsLoading(false);
                      setLiveError(null);
                      setReviewSurfaceVisible(true);
                    }}
                  />
                ) : (
                  <ReviewPanel
                    activePly={activePly}
                    analysis={analysis}
                    branchVariation={branchVariation}
                    canStepBack={canStepBack}
                    canStepForward={canStepForward}
                    loadingGameId={loadingGameId}
                    engineLines={reviewEngineLines}
                    evalScore={evalScore}
                    onFirst={goToFirstMove}
                    onLast={goToLastMove}
                    onNext={goToNextMove}
                    onPlayFromPosition={playFromReviewPosition}
                    onReturnToPlaytest={isPlaytestReview ? returnToPlaytestGame : undefined}
                    onPrev={goToPreviousMove}
                    positionStatus={reviewPositionStatus}
                    onSelectPly={(ply) => {
                      if (ply === activePly) return;
                      suppressBoardArrowDuringAnimation();
                      setActivePly(ply);
                      setSelectedSquare(null);
                    }}
                    rows={moveRows}
                    selectedMove={selectedMove}
                    currentOpening={currentOpening}
                    gameSource={activeGameSource}
                    reviewTab={reviewTab}
                    onReviewTabChange={setReviewTab}
                    showUploadInHistory={showUploadInHistory}
                    setShowUploadInHistory={setShowUploadInHistory}
                    uploadPgn={pgn}
                    onSetPgn={setPgn}
                    onAnalyzePgn={() => addUploadedGame(true)}
                    onAddPgn={() => addUploadedGame(false)}
                    uploadError={error}
                    uploadIsLoading={isLoading}
                    savedGames={savedGames}
                    onLoadSavedGame={(game) => loadSavedGame(game, activeGameSource ?? "mygames")}
                    onDeleteSavedGame={deleteSavedGame}
                  />
                )
              ) : panelTab === "mygames" ? (
                <MyGamesListView
                  loadingGameId={loadingGameId}
                  onAnalyzePgn={() => addUploadedGame(true)}
                  onAddPgn={() => addUploadedGame(false)}
                  onLoadSavedGame={(game) => loadSavedGame(game, "mygames")}
                  onDeleteSavedGame={deleteSavedGame}
                  onSetPgn={setPgn}
                  savedGames={savedGames}
                  setShowUploadInHistory={setShowUploadInHistory}
                  showUploadInHistory={showUploadInHistory}
                  uploadError={error}
                  uploadIsLoading={isLoading}
                  uploadPgn={pgn}
                />
              ) : panelTab === "publicgames" ? (
                <PublicGamesPanel
                  loadingGameId={loadingGameId}
                  onLoadGame={(game) => loadSavedGame(game, "publicgames")}
                />
              ) : (
                <div className="move-scroll flex-1 space-y-4 overflow-y-auto pr-1">
                  {panelTab === "upload" ? (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="text-xl font-semibold text-white">Upload Game</h2>
                        <button
                          onClick={() => setPgn(SAMPLE_PGN)}
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-amber-300 px-3 text-sm font-bold text-stone-950 transition hover:bg-amber-200"
                        >
                          <ClipboardPaste size={15} />
                          Sample
                        </button>
                      </div>
                      <textarea
                        value={pgn}
                        onChange={(event) => setPgn(event.target.value)}
                        spellCheck={false}
                        placeholder='[Event "My Game"]&#10;1. e4 e5 2. Nf3 Nc6 ...'
                        className="move-scroll min-h-[360px] w-full resize-none rounded-md border border-white/10 bg-[#0f1921] p-4 font-mono text-sm leading-6 text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-sky-200/50"
                      />
                      {error ? (
                        <div className="flex items-start gap-2 rounded-md border border-red-300/20 bg-red-500/10 p-3 text-sm text-red-100">
                          <AlertCircle className="mt-0.5 shrink-0" size={16} />
                          <span>{error}</span>
                        </div>
                      ) : null}
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => addUploadedGame(false)}
                          disabled={isLoading}
                          className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-white/10 bg-[#101214] px-4 text-sm font-bold text-white transition hover:bg-white/10 disabled:opacity-60"
                        >
                          <Upload size={17} />
                          Add Only
                        </button>
                        <button
                          onClick={() => addUploadedGame(true)}
                          disabled={isLoading}
                          className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-emerald-300 px-4 text-sm font-bold text-stone-950 transition hover:bg-emerald-200 disabled:opacity-60"
                        >
                          {isLoading ? <Loader2 className="animate-spin" size={17} /> : <Sparkles size={17} />}
                          {isLoading ? "Opening..." : "Add & Open"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </aside>
          </section>
        )}
      </div>
    </main>
  );
}

function AppRail({
  active,
  accountAvatarUrl,
  accountEmail,
  accountName,
  accountSyncError,
  authConfigured,
  authLoading,
  onFreshBoard,
  onHome,
  onMyGames,
  onPublicGames,
  onSave,
  onSignIn,
  onSignOut,
  saveDisabled,
  userName,
  onUserNameChange,
}: {
  active: "home" | "playtest" | "mygames" | "publicgames" | "analysis";
  accountAvatarUrl?: string | null;
  accountEmail?: string | null;
  accountName?: string | null;
  accountSyncError?: string | null;
  authConfigured: boolean;
  authLoading: boolean;
  onFreshBoard: () => void;
  onHome: () => void;
  onMyGames: () => void;
  onPublicGames: () => void;
  onSave: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  saveDisabled?: boolean;
  userName: string;
  onUserNameChange: (value: string) => void;
}) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [tempName, setTempName] = useState(userName);

  useEffect(() => {
    setTempName(userName);
  }, [userName]);

  const handleSaveName = () => {
    onUserNameChange(tempName);
    setIsEditingName(false);
  };

  const handleCancelEdit = () => {
    setTempName(userName);
    setIsEditingName(false);
  };

  return (
    <nav className="sidebar-rail">
      <div className="mb-1 flex items-center gap-2 px-2 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-100/45">
        <span className="h-2 w-2 rounded-full bg-sky-100/50" />
        Account
      </div>
      <div className="grid min-w-0 gap-1.5">
        {isEditingName ? (
          <div className="flex min-h-[2.8rem] w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-[0.7rem] border border-white/10 bg-[#142531] px-2">
            <span className="sidebar-rail-button__icon shrink-0 text-stone-400">
              <User size={17} />
            </span>
            <input
              type="text"
              value={tempName}
              onChange={(e) => setTempName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveName();
                if (e.key === "Escape") handleCancelEdit();
              }}
              placeholder="Enter name"
              className="w-0 min-w-0 flex-1 rounded-sm bg-transparent px-1 text-sm text-stone-100 outline-none"
              autoFocus
            />
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={handleSaveName}
                className="inline-flex items-center justify-center rounded-md p-1 text-sky-300 transition hover:bg-white/10"
                title="Save"
              >
                <Save size={14} />
              </button>
              <button
                onClick={handleCancelEdit}
                className="inline-flex items-center justify-center rounded-md p-1 text-stone-400 transition hover:bg-white/10"
                title="Cancel"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setIsEditingName(true)}
            className="sidebar-rail-button w-full"
          >
            <span className="sidebar-rail-button__icon shrink-0">
              {userName ? <User size={17} /> : <User size={17} className="text-stone-400" />}
            </span>
            <span className="sidebar-rail-button__label">{userName || "Set your name"}</span>
          </button>
        )}
        <div>
          {!authConfigured ? (
            <div className="px-2 text-xs leading-5 text-amber-200/85">Add Supabase env vars to enable Google sign-in.</div>
          ) : accountEmail ? (
            <div className="flex min-h-[2.8rem] w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-[0.7rem] border border-transparent px-2.5 text-stone-100 transition hover:border-white/10 hover:bg-white/[0.06]">
              <div className="relative flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[#243746] text-xs font-black text-white">
                {(accountName || accountEmail).charAt(0).toUpperCase()}
                {accountAvatarUrl ? (
                  <img
                    src={accountAvatarUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-white" title={accountEmail}>
                  {accountName || accountEmail.split("@")[0]}
                </div>
              </div>
              <button
                onClick={onSignOut}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/10 hover:text-white"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut size={14} />
              </button>
            </div>
          ) : (
            <button
              onClick={onSignIn}
              disabled={authLoading}
              className="sidebar-rail-button disabled:cursor-wait disabled:opacity-60"
            >
              <span className="sidebar-rail-button__icon shrink-0">
                {authLoading ? (
                  <Loader2 className="animate-spin text-stone-300" size={15} />
                ) : (
                  <img src="/google-g.svg" alt="" className="h-4 w-4" />
                )}
              </span>
              <span className="sidebar-rail-button__label">Sign in</span>
            </button>
          )}
          {accountSyncError ? <div className="mt-1.5 px-2 text-[11px] leading-4 text-amber-200/80">{accountSyncError}</div> : null}
        </div>
      </div>
      <div className="mb-1 mt-3 flex items-center gap-2 border-t border-white/10 px-2 pt-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-100/45">
        <span className="h-2 w-2 rounded-full bg-sky-100/50" />
        Menu
      </div>
      <div className="grid gap-1.5">
        <RailButton active={active === "home"} icon={<House size={17} />} label="Home" onClick={onHome} />
        <RailButton active={active === "playtest"} icon={<Play size={17} />} label="Playtest" onClick={onFreshBoard} />
        <RailButton active={active === "mygames"} icon={<History size={17} />} label="My Games" onClick={onMyGames} />
        <RailButton active={active === "publicgames"} icon={<Library size={17} />} label="Public Games" onClick={onPublicGames} />
      </div>
      <div className="mt-3 border-t border-white/10 px-1 pt-3">
        <RailButton active={false} disabled={saveDisabled} icon={<Save size={17} />} label="Save PGN" onClick={onSave} />
      </div>
    </nav>
  );
}

function HomeIntroLayout({
  accountAvatarUrl,
  accountEmail,
  accountName,
  accountSyncError,
  authConfigured,
  authLoading,
  onFreshBoard,
  onMyGames,
  onPublicGames,
  onSave,
  onSignIn,
  onSignOut,
  saveDisabled,
  userName,
  onUserNameChange,
}: {
  accountAvatarUrl?: string | null;
  accountEmail?: string | null;
  accountName?: string | null;
  accountSyncError?: string | null;
  authConfigured: boolean;
  authLoading: boolean;
  onFreshBoard: () => void;
  onMyGames: () => void;
  onPublicGames: () => void;
  onSave: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  saveDisabled?: boolean;
  userName: string;
  onUserNameChange: (value: string) => void;
}) {
  return (
    <section className="grid items-start gap-5 xl:grid-cols-[208px_minmax(0,1fr)]">
      <AppRail
        active="home"
        accountAvatarUrl={accountAvatarUrl}
        accountEmail={accountEmail}
        accountName={accountName}
        accountSyncError={accountSyncError}
        authConfigured={authConfigured}
        authLoading={authLoading}
        onFreshBoard={onFreshBoard}
        onHome={() => {}}
        onMyGames={onMyGames}
        onPublicGames={onPublicGames}
        onSave={onSave}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
        saveDisabled={saveDisabled}
        userName={userName}
        onUserNameChange={onUserNameChange}
      />
      <HomeIntro onMyGames={onMyGames} onPublicGames={onPublicGames} />
    </section>
  );
}

function HomeIntro({
  onMyGames,
  onPublicGames,
}: {
  onMyGames: () => void;
  onPublicGames: () => void;
}) {
  const heroStats = [
    ["No daily cap", "review your PGNs"],
    ["Saved games", "come back later"],
    ["Full review", "badges, eval, stats"],
  ];

  const problemRows = [
    {
      icon: <AlertCircle size={16} />,
      title: "Daily review limits",
      body: "Some chess sites give you one full review, then push the rest behind a paid plan.",
    },
    {
      icon: <History size={16} />,
      title: "Games get scattered",
      body: "You play in one place, copy a PGN somewhere else, and lose track of what you wanted to study.",
    },
    {
      icon: <BarChart3 size={16} />,
      title: "Hard to spot the lesson",
      body: "A raw eval number is not enough. You need the move, board, badges, and swing all together.",
    },
  ];

  const featureRows = [
    { icon: <Star size={16} />, title: "Move badges", body: "See best moves, mistakes, blunders, book moves, and the moments that changed the game." },
    { icon: <BarChart3 size={16} />, title: "Synced review", body: "The board, eval graph, move list, captured pieces, and summary stay tied to the same position." },
    { icon: <Library size={16} />, title: "Your game library", body: "Keep uploaded games in My Games and use Public Games when you want extra review examples." },
  ];

  const stepCards = [
    {
      title: "Copy your PGN",
      body: "Find the finished game on Chess.com, Lichess, or wherever you played. Open Share or the three-dot menu and copy the PGN.",
      detail: "You are looking for the PGN text from the finished game, not a screenshot or a link.",
      src: "/how-it-works-copy-pgn.png",
    },
    {
      title: "Upload it here",
      body: "Go to My Games, click the upload button, paste the PGN, and add it to your saved games.",
      detail: "Once it is added, the game stays in your list so you can open the review again later.",
      src: "/how-it-works-upload-pgn.png",
    },
    {
      title: "Understand your game",
      body: "Review every move with ratings, badges, eval swings, captured pieces, and stats that show where the game turned.",
      detail: "The board, review panel, and game summary stay synced so each moment is easier to read.",
      src: "/how-it-works-play-position.png",
    },
  ];

  return (
    <div className="home-shell move-scroll min-h-[calc(100vh-1.5rem)] overflow-y-auto rounded-md border border-white/10 shadow-2xl shadow-black/20">
      <section className="home-hero home-gradient-band grid min-h-[min(680px,calc(100vh-6rem))] gap-8 px-5 py-5 md:px-8 lg:grid-cols-[minmax(0,0.82fr)_minmax(460px,1.18fr)] lg:items-center lg:py-6">
        <div className="home-reveal max-w-3xl">
          <h1 className="max-w-3xl text-4xl font-black leading-[1.02] text-white sm:text-5xl lg:text-6xl">
            Analyze more than one game a day.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-slate-200/88 sm:text-lg">
            Bring in your Chess.com or Lichess PGNs and review them with move badges, eval swings, accuracy, captured pieces, and saved game history.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <button
              onClick={onMyGames}
              className="home-primary-action inline-flex h-11 items-center justify-center gap-2 rounded-md bg-white px-4 text-sm font-black text-[#10222e] transition hover:bg-sky-50"
            >
              <Upload size={16} />
              Upload PGN
            </button>
            <button
              onClick={onPublicGames}
              className="home-secondary-action inline-flex h-11 items-center justify-center gap-2 rounded-md border border-white/15 bg-[#101214]/80 px-4 text-sm font-bold text-white transition hover:bg-white/10"
            >
              <Library size={16} />
              Browse Public Games
            </button>
          </div>
          <div className="home-proof-strip mt-8 grid max-w-2xl gap-2 sm:grid-cols-3">
            {heroStats.map(([value, label]) => (
              <div key={value} className="home-glass-tile rounded-md border border-white/10 px-3 py-2">
                <div className="text-base font-black text-white">{value}</div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300/70">{label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="home-reveal home-product-showcase" style={{ animationDelay: "100ms" }}>
          <div className="home-product-frame rounded-md border border-white/10">
            <img src="/how-it-works-play-position.png" alt="" className="home-hero-shot h-full w-full object-contain" />
          </div>
        </div>
      </section>

      <section className="home-problem-band px-5 py-10 md:px-8 lg:py-14">
        <div className="home-reveal grid gap-7 lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1fr)] lg:items-center">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-rose-200/20 bg-rose-400/10 px-3 py-1 text-[11px] font-black uppercase tracking-[0.16em] text-rose-100">
              <Sparkles size={13} />
              The problem
            </div>
            <h2 className="text-3xl font-black leading-tight text-white">Game review should not stop after one game.</h2>
            <p className="mt-3 max-w-2xl text-base leading-7 text-slate-200">
              On sites like Chess.com, full analysis can run into daily limits or paid plans. That is frustrating when you are playing multiple games and actually trying to learn from them.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {problemRows.map((row) => (
              <div key={row.title} className="home-problem-item rounded-md border border-white/10 p-4">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-white/10 text-rose-100">
                  {row.icon}
                </span>
                <h3 className="mt-3 font-black text-white">{row.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-300">{row.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="home-gradient-band home-gradient-band-alt px-5 py-8 md:px-8 lg:py-10">
        <div className="home-reveal grid gap-6 lg:grid-cols-[minmax(240px,0.48fr)_minmax(0,1fr)]">
          <div>
            <h2 className="text-2xl font-black text-white">Built for reviewing your own games.</h2>
            <p className="mt-2 text-sm leading-6 text-slate-300">The app keeps the full review readable instead of turning your game into disconnected numbers.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {featureRows.map((feature, index) => (
              <div key={feature.title} className="home-feature-card rounded-md border border-white/10 bg-white/[0.055] p-4" style={{ animationDelay: `${150 + index * 70}ms` }}>
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-white/10 text-sky-100">
                  {feature.icon}
                </span>
                <h3 className="mt-3 font-black text-white">{feature.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-300">{feature.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="home-gradient-band home-gradient-band-warm px-5 py-10 md:px-8 lg:py-14">
        <div className="home-reveal mb-8 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-3xl font-black text-white">From online game to full review.</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
              Copy the PGN, add it to My Games, then study the full review with the board and stats moving together.
            </p>
          </div>
        </div>
        <div className="home-walkthrough grid gap-10">
          {stepCards.map((step, index) => (
            <div
              key={step.title}
              className={`home-walkthrough-item home-reveal grid items-center gap-6 md:grid-cols-[minmax(230px,0.72fr)_minmax(360px,1.28fr)] ${index % 2 === 1 ? "md:[&_.home-step-copy]:order-2 md:[&_.home-step-media]:order-1" : ""}`}
              style={{ animationDelay: `${220 + index * 80}ms` }}
            >
              <div className="home-step-copy">
                <div className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-md bg-white text-sm font-black text-[#142531] shadow-lg shadow-black/20">
                  {index + 1}
                </div>
                <h3 className="text-2xl font-black text-white">{step.title}</h3>
                <p className="mt-3 text-base leading-7 text-slate-200">{step.body}</p>
                <p className="mt-3 text-sm leading-6 text-slate-400">{step.detail}</p>
              </div>
              <div className="home-step-media">
                <div className="home-step-image-wrap">
                  <img src={step.src} alt="" className="home-step-image h-full w-full object-contain" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="home-reveal flex flex-col gap-2 px-5 py-5 text-sm text-slate-300 md:flex-row md:items-center md:justify-between md:px-8" style={{ animationDelay: "560ms" }}>
        <span>Made by Daniel for reviewing games without running into daily limits.</span>
        <a
          href="https://venmo.com/u/Daniel-Lezhanskiy"
          target="_blank"
          rel="noreferrer"
          className="home-venmo-link inline-flex w-fit items-center gap-2 rounded-md border border-white/10 bg-white/[0.07] px-3 py-1.5 font-semibold text-slate-100 transition hover:bg-white/10"
          aria-label="Support Daniel on Venmo"
        >
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-sm bg-[#3d95ce] text-[13px] font-black leading-none text-white">V</span>
          <span>Venmo: @Daniel-Lezhanskiy</span>
          <ExternalLink size={13} className="text-slate-400" />
        </a>
      </footer>
    </div>
  );
}

function HomePreviewBoard() {
  return (
    <div className="home-board-shot aspect-square overflow-hidden rounded-md border border-white/10">
      <img
        src="/home-review-board.png"
        alt=""
        className="h-full w-full object-contain"
        style={{ transform: "none" }}
        loading="eager"
        decoding="async"
      />
    </div>
  );
}

function RailButton({
  active,
  disabled,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-active={active ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
      className="sidebar-rail-button"
    >
      <span className="sidebar-rail-button__icon shrink-0">{icon}</span>
      <span className="sidebar-rail-button__label">{label}</span>
    </button>
  );
}

function gamePlayersFromTitle(title: string) {
  const [white, black] = title.split(/\s+vs\s+/i);
  return {
    white: white?.trim() || "White",
    black: black?.trim() || "Black",
  };
}

function displayPlayerName(value: string | undefined | null, fallback: "White" | "Black") {
  const name = value?.trim();
  if (!name || name === "?") return fallback;
  return name;
}

function pgnPlayerRating(pgn: string | undefined, color: "white" | "black") {
  if (!pgn) return "";
  return pgnTagValue(pgn, color === "white" ? "WhiteElo" : "BlackElo");
}

function winnerFromResult(result?: string) {
  if (result === "1-0") return "white";
  if (result === "0-1") return "black";
  if (result === "1/2-1/2") return "draw";
  return null;
}

function endReasonFromGame(termination?: string, pgn?: string): EndGameBadgeKind | null {
  const value = `${termination || ""} ${pgn ? pgnTagValue(pgn, "Termination") : ""}`.toLowerCase();
  if (/(time|timeout|forfeit|flag)/.test(value)) return "timeout";
  if (/resign/.test(value)) return "resign";
  if (/(checkmate|mate)/.test(value)) return "checkmate";
  if (/draw/.test(value)) return "draw";
  return null;
}

function resultBadgeKind(result?: string, termination?: string, pgn?: string): EndGameBadgeKind | null {
  const winner = winnerFromResult(result);
  if (winner === "draw") return "draw";
  return endReasonFromGame(termination, pgn);
}

function playerOutcomeBadgeKind(
  playerColor: "white" | "black",
  result?: string,
  termination?: string,
  pgn?: string
): { kind: EndGameBadgeKind; label: string } | null {
  const winner = winnerFromResult(result);
  if (!winner || winner === "draw") return null;
  if (winner === playerColor) return { kind: "winner", label: "Win" };

  const endReason = endReasonFromGame(termination, pgn);
  if (endReason === "resign") return { kind: "resign", label: "Resign" };
  if (endReason === "timeout") return { kind: "timeout", label: "Timeout" };
  return { kind: "loss", label: "Loss" };
}

function playerDotClass(color: "white" | "black") {
  return color === "white" ? "bg-white" : "bg-stone-950 ring-1 ring-white/20";
}

function GameListCard({
  blackAccuracy,
  dateLabel,
  playedDateLabel,
  uploadedDateLabel,
  moveCount,
  onClick,
  onDelete,
  opening,
  pgn,
  isLoading,
  result,
  termination,
  title,
  whiteAccuracy,
}: {
  blackAccuracy?: number;
  dateLabel?: string;
  playedDateLabel?: string;
  uploadedDateLabel?: string;
  isLoading?: boolean;
  moveCount?: number;
  onClick?: () => void;
  onDelete?: () => void;
  opening: string;
  pgn?: string;
  result?: string;
  termination?: string;
  title: string;
  whiteAccuracy?: number;
}) {
  const players = gamePlayersFromTitle(title);
  const resultLabel = result === "1/2-1/2" ? "Draw" : result;
  const winner = winnerFromResult(result);
  const whiteRating = pgnPlayerRating(pgn, "white");
  const blackRating = pgnPlayerRating(pgn, "black");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function handleDelete(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    onDelete?.();
  }

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${playerDotClass("white")}`} />
              <span className="truncate text-sm font-semibold text-white">{players.white}</span>
              {whiteRating ? <span className="shrink-0 text-[11px] font-semibold text-stone-400">{whiteRating}</span> : null}
              {winner === "white" ? <WonBubble /> : null}
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${playerDotClass("black")}`} />
              <span className="truncate text-sm font-semibold text-white">{players.black}</span>
              {blackRating ? <span className="shrink-0 text-[11px] font-semibold text-stone-400">{blackRating}</span> : null}
              {winner === "black" ? <WonBubble /> : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isLoading ? (
            <span className="inline-flex items-center gap-1.5 rounded-sm bg-sky-300/10 px-2 py-1 text-xs font-bold text-sky-100">
              <Loader2 className="animate-spin" size={12} />
              Loading
            </span>
          ) : resultLabel && resultLabel !== "*" ? (
            <span className="inline-flex items-center gap-1.5 rounded-sm bg-[#101214] px-2 py-1 text-xs font-bold text-white">
              {resultLabel}
            </span>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={handleDelete}
              onBlur={() => setConfirmingDelete(false)}
              title={confirmingDelete ? "Confirm delete" : "Remove game"}
              aria-label={confirmingDelete ? "Confirm remove game" : "Remove game"}
              className={`inline-flex h-7 items-center justify-center gap-1 rounded-md border px-2 text-xs font-bold transition ${
                confirmingDelete
                  ? "border-red-200/30 bg-red-400/20 text-red-100 hover:bg-red-400/30"
                  : "w-7 border-white/10 bg-[#101214] text-white hover:border-red-300/35 hover:bg-red-400/10 hover:text-red-300"
              }`}
            >
              <Trash2 size={13} />
              {confirmingDelete ? <span>Delete</span> : null}
            </button>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-stone-400">{cleanOpeningLabel(opening)}</span>
        {typeof moveCount === "number" ? <span className="shrink-0 text-stone-400">{moveCount} moves</span> : null}
      </div>
      {whiteAccuracy !== undefined || blackAccuracy !== undefined ? (
        <div className="mt-2 grid grid-cols-2 gap-2 rounded-sm bg-black/12 px-2 py-1.5 text-[11px] font-semibold text-stone-300">
          <span className="truncate">White accuracy {whiteAccuracy !== undefined ? `${whiteAccuracy}%` : "-"}</span>
          <span className="truncate text-right">Black accuracy {blackAccuracy !== undefined ? `${blackAccuracy}%` : "-"}</span>
        </div>
      ) : null}
      {playedDateLabel || uploadedDateLabel ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[0.06] pt-2 text-[11px] text-stone-500">
          {playedDateLabel ? <span>Played: {playedDateLabel}</span> : null}
          {uploadedDateLabel ? <span>Uploaded: {uploadedDateLabel}</span> : null}
        </div>
      ) : dateLabel ? (
        <div className="mt-1 text-[11px] text-stone-500">{dateLabel}</div>
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <div
        role="button"
        tabIndex={isLoading ? -1 : 0}
        aria-disabled={isLoading}
        onClick={() => {
          if (!isLoading) onClick();
        }}
        onKeyDown={(event) => {
          if (isLoading) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
          }
        }}
        className={`w-full rounded-md border border-white/10 bg-white/[0.04] p-3 text-left transition hover:bg-white/10 ${
          isLoading ? "cursor-wait border-sky-200/20 bg-sky-300/[0.06]" : "cursor-pointer"
        }`}
      >
        {content}
      </div>
    );
  }

  return <div className="rounded-md border border-white/10 bg-white/[0.04] p-3">{content}</div>;
}

function WonBubble() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-emerald-200/20 bg-emerald-400/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-emerald-100">
      Won
    </span>
  );
}

function OpeningNameRow({ opening }: { opening: string }) {
  return (
    <div
      className="mt-2 flex min-w-0 items-center justify-between gap-3 rounded-sm bg-white/[0.04] px-2 py-1 text-[11px]"
      title={opening}
    >
      <span className="shrink-0 font-bold uppercase tracking-[0.16em] text-stone-400">Opening</span>
      <span className="min-w-0 flex-1 truncate text-right font-semibold text-sky-100">{opening}</span>
    </div>
  );
}

type PublicGame = {
  id: string;
  title: string;
  white: string;
  black: string;
  opening: string;
  result: string;
  termination?: string;
  winner: string;
  date: string;
  year: number | null;
  event: string;
  eco: string;
  moveCount: number;
  pgn: string;
  source: string;
  sourceUrl: string;
  finalFen: string;
};

type PublicGamesCatalog = {
  generatedAt?: string;
  sources?: Array<{ name: string; source: string; url: string }>;
  games: PublicGame[];
};

const PUBLIC_GAMES_PAGE_SIZE = 80;

function publicGameToSavedGame(game: PublicGame): SavedGame {
  return {
    id: game.id,
    title: game.title,
    subtitle: game.opening,
    pgn: game.pgn,
    updatedAt: 0,
    uploadedAt: 0,
    gameDate: game.date || String(game.year ?? ""),
    result: game.result,
    termination: game.termination || pgnTagValue(game.pgn, "Termination"),
    moveCount: game.moveCount,
    finalFen: game.finalFen,
  };
}

function normalizeSearchValue(value: string) {
  return value.trim().toLowerCase();
}

type MyGamesSortField = "played" | "uploaded";
type MyGamesSortDirection = "newest" | "oldest";

function gameDateTimestamp(value: string) {
  const normalized = value.trim().replace(/\./g, "-");
  if (!normalized || normalized.includes("?")) return null;
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(normalized) ? `${normalized}T00:00:00` : normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatPlayedDate(value: string) {
  const timestamp = gameDateTimestamp(value);
  if (timestamp === null) return value.trim() || null;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(timestamp));
}

function formatUploadedDate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function savedGameSearchText(game: SavedGame) {
  return normalizeSearchValue([
    game.title,
    game.subtitle,
    game.result,
    game.gameDate,
    pgnTagValue(game.pgn, "White"),
    pgnTagValue(game.pgn, "Black"),
    pgnTagValue(game.pgn, "WhiteElo"),
    pgnTagValue(game.pgn, "BlackElo"),
    pgnTagValue(game.pgn, "Event"),
    pgnTagValue(game.pgn, "ECO"),
  ].join(" "));
}

function MyGamesCollection({
  isReady = true,
  loadingGameId,
  onDeleteSavedGame,
  onLoadSavedGame,
  savedGames,
}: {
  isReady?: boolean;
  loadingGameId?: string | null;
  onDeleteSavedGame: (gameId: string) => void;
  onLoadSavedGame: (game: SavedGame) => void;
  savedGames: SavedGame[];
}) {
  const [query, setQuery] = useState("");
  const [showOrganize, setShowOrganize] = useState(false);
  const [sortField, setSortField] = useState<MyGamesSortField>("played");
  const [sortDirection, setSortDirection] = useState<MyGamesSortDirection>("newest");
  const deferredQuery = useDeferredValue(query);

  const visibleGames = useMemo(() => {
    const search = normalizeSearchValue(deferredQuery);
    const direction = sortDirection === "newest" ? -1 : 1;

    return savedGames
      .filter((game) => !search || savedGameSearchText(game).includes(search))
      .sort((a, b) => {
        const uploadedA = a.uploadedAt || a.updatedAt || 0;
        const uploadedB = b.uploadedAt || b.updatedAt || 0;
        const primaryA = sortField === "played" ? gameDateTimestamp(a.gameDate) ?? uploadedA : uploadedA;
        const primaryB = sortField === "played" ? gameDateTimestamp(b.gameDate) ?? uploadedB : uploadedB;
        if (primaryA !== primaryB) return (primaryA - primaryB) * direction;
        if (uploadedA !== uploadedB) return (uploadedA - uploadedB) * direction;
        return a.id.localeCompare(b.id);
      });
  }, [deferredQuery, savedGames, sortDirection, sortField]);

  const sortSummary = `${sortField === "played" ? "Date played" : "Date uploaded"}, ${
    sortDirection === "newest" ? "newest first" : "oldest first"
  }`;

  return (
    <>
      <div className="space-y-3 rounded-md border border-white/10 bg-[#142531] p-3">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label className="text-[10px] font-bold uppercase tracking-[0.18em] text-stone-500" htmlFor="my-games-search">
              Search
            </label>
            <input
              id="my-games-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Player, opening, result, rating"
              className="mt-2 h-9 w-full rounded-md border border-white/10 bg-[#101214] px-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-sky-200/50"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowOrganize((value) => !value)}
            aria-expanded={showOrganize}
            className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-bold transition ${
              showOrganize
                ? "border-sky-200/30 bg-sky-300/10 text-sky-100"
                : "border-white/10 bg-[#101214] text-white hover:bg-white/10"
            }`}
          >
            <List size={14} />
            Organize
          </button>
        </div>
        {showOrganize ? (
          <div className="grid grid-cols-2 gap-2 border-t border-white/[0.06] pt-3">
            <label className="space-y-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-stone-500">
              Sort by
              <select
                value={sortField}
                onChange={(event) => setSortField(event.target.value as MyGamesSortField)}
                className="h-9 w-full rounded-md border border-white/10 bg-[#101214] px-2 text-sm font-semibold normal-case tracking-normal text-stone-100 outline-none focus:border-sky-200/50"
              >
                <option value="played">Date played</option>
                <option value="uploaded">Date uploaded</option>
              </select>
            </label>
            <label className="space-y-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-stone-500">
              Order
              <select
                value={sortDirection}
                onChange={(event) => setSortDirection(event.target.value as MyGamesSortDirection)}
                className="h-9 w-full rounded-md border border-white/10 bg-[#101214] px-2 text-sm font-semibold normal-case tracking-normal text-stone-100 outline-none focus:border-sky-200/50"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
          </div>
        ) : null}
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-stone-500">
          {visibleGames.length} of {savedGames.length} games · {sortSummary}
        </div>
      </div>

      {!isReady ? (
        <div className="rounded-md border border-white/10 bg-[#142531] p-4 text-sm leading-6 text-stone-400">
          Loading games...
        </div>
      ) : visibleGames.length ? (
        visibleGames.map((game) => (
          <GameListCard
            key={game.id}
            onClick={() => onLoadSavedGame(game)}
            onDelete={() => onDeleteSavedGame(game.id)}
            title={game.title}
            opening={game.subtitle}
            result={game.result}
            termination={game.termination}
            pgn={game.pgn}
            moveCount={game.moveCount}
            playedDateLabel={formatPlayedDate(game.gameDate) ?? undefined}
            uploadedDateLabel={formatUploadedDate(game.uploadedAt || game.updatedAt) ?? undefined}
            isLoading={loadingGameId === game.id}
            whiteAccuracy={game.whiteAccuracy}
            blackAccuracy={game.blackAccuracy}
          />
        ))
      ) : savedGames.length ? (
        <div className="rounded-md border border-white/10 bg-[#142531] p-4 text-sm leading-6 text-stone-400">
          No saved games match that search.
        </div>
      ) : (
        <div className="rounded-md border border-white/10 bg-[#142531] p-4 text-sm leading-6 text-stone-400">
          Games you upload or review from the board will show here.
        </div>
      )}
    </>
  );
}

function formatPublicGameDate(game: PublicGame) {
  return game.date || (game.year ? String(game.year) : "Date unavailable");
}

function publicGameDateLabel(game: PublicGame) {
  const date = formatPublicGameDate(game);
  return `${date} · ${game.event}`;
}

function PublicGamesPanel({
  loadingGameId,
  onLoadGame,
  onBackToReview,
}: {
  loadingGameId?: string | null;
  onLoadGame?: (game: SavedGame) => void;
  onBackToReview?: () => void;
}) {
  const [catalog, setCatalog] = useState<PublicGamesCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [resultFilter, setResultFilter] = useState("all");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(PUBLIC_GAMES_PAGE_SIZE);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogError(null);

    fetch("/public-games.json", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Public games catalog could not be loaded.");
        const payload = (await response.json()) as PublicGamesCatalog;
        if (!Array.isArray(payload.games)) throw new Error("Public games catalog is invalid.");
        setCatalog(payload);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setCatalogError(err instanceof Error ? err.message : "Public games catalog could not be loaded.");
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    setVisibleLimit(PUBLIC_GAMES_PAGE_SIZE);
  }, [deferredQuery, resultFilter, yearFrom, yearTo]);

  const games = catalog?.games ?? [];
  const filteredGames = useMemo(() => {
    const search = normalizeSearchValue(deferredQuery);
    const minYear = Number.parseInt(yearFrom, 10);
    const maxYear = Number.parseInt(yearTo, 10);
    const hasMinYear = Number.isFinite(minYear);
    const hasMaxYear = Number.isFinite(maxYear);

    return games.filter((game) => {
      if (resultFilter !== "all" && game.result !== resultFilter) return false;
      if (hasMinYear && (!game.year || game.year < minYear)) return false;
      if (hasMaxYear && (!game.year || game.year > maxYear)) return false;
      if (!search) return true;

      const haystack = [
        game.white,
        game.black,
        game.opening,
        game.event,
        game.result,
        game.winner,
        game.eco,
        String(game.year ?? ""),
      ].join(" ").toLowerCase();
      return haystack.includes(search);
    });
  }, [deferredQuery, games, resultFilter, yearFrom, yearTo]);

  const visibleGames = filteredGames.slice(0, visibleLimit);
  const hasMoreGames = visibleGames.length < filteredGames.length;
  const sourceSummary = catalog?.sources?.length ? `${catalog.sources.length} source files` : "local catalog";

  return (
    <div className="move-scroll flex-1 space-y-3 overflow-y-auto pr-1">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Public Games</h2>
          <p className="mt-1 text-xs text-stone-400">
            {games.length ? `${filteredGames.length} of ${games.length} games · ${sourceSummary}` : "Loading master-game catalog..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onBackToReview ? (
            <button
              onClick={onBackToReview}
              title="Back to current review"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-white/10 bg-[#101214] px-2.5 text-xs font-bold text-white transition hover:bg-white/10"
            >
              <Star size={14} />
              Review
            </button>
          ) : null}
          <Library size={22} className="shrink-0 text-sky-200" />
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-white/10 bg-[#142531] p-3">
        <div>
          <label className="text-[10px] font-bold uppercase tracking-[0.18em] text-stone-500" htmlFor="public-game-search">
            Search
          </label>
          <input
            id="public-game-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Player, opening, event, winner, ECO"
            className="mt-2 h-9 w-full rounded-md border border-white/10 bg-[#101214] px-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-sky-200/50"
          />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_76px_76px] gap-2">
          <select
            value={resultFilter}
            onChange={(event) => setResultFilter(event.target.value)}
            className="h-9 min-w-0 rounded-md border border-white/10 bg-[#101214] px-2 text-sm font-semibold text-stone-100 outline-none focus:border-sky-200/50"
            title="Result"
          >
            <option value="all">All results</option>
            <option value="1-0">1-0</option>
            <option value="0-1">0-1</option>
            <option value="1/2-1/2">Draw</option>
          </select>
          <input
            value={yearFrom}
            onChange={(event) => setYearFrom(event.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            placeholder="From"
            className="h-9 min-w-0 rounded-md border border-white/10 bg-[#101214] px-2 text-sm text-stone-100 outline-none placeholder:text-stone-600 focus:border-sky-200/50"
            title="From year"
          />
          <input
            value={yearTo}
            onChange={(event) => setYearTo(event.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            placeholder="To"
            className="h-9 min-w-0 rounded-md border border-white/10 bg-[#101214] px-2 text-sm text-stone-100 outline-none placeholder:text-stone-600 focus:border-sky-200/50"
            title="To year"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-stone-500">
            Catalog
            {filteredGames.length ? <span className="ml-2 text-stone-400">Showing {visibleGames.length} of {filteredGames.length}</span> : null}
          </div>
        </div>
        {catalogError ? (
          <div className="rounded-md border border-red-300/20 bg-red-500/10 p-3 text-sm leading-6 text-red-100">{catalogError}</div>
        ) : !catalog ? (
          <div className="rounded-md border border-white/10 bg-[#142531] p-4 text-sm leading-6 text-stone-400">Loading public games...</div>
        ) : visibleGames.length ? (
          <>
            {visibleGames.map((game) => {
              const savedGame = publicGameToSavedGame(game);
              return (
                <GameListCard
                  key={game.id}
                  title={game.title}
                  opening={game.opening}
                  result={game.result}
                  termination={savedGame.termination}
                  pgn={game.pgn}
                  moveCount={game.moveCount}
                  dateLabel={publicGameDateLabel(game)}
                  isLoading={loadingGameId === savedGame.id}
                  onClick={onLoadGame ? () => onLoadGame(savedGame) : undefined}
                />
              );
            })}
            {hasMoreGames ? (
              <button
                onClick={() => setVisibleLimit((value) => value + PUBLIC_GAMES_PAGE_SIZE)}
                className="inline-flex h-10 w-full items-center justify-center rounded-md border border-white/10 bg-[#101214] px-3 text-sm font-bold text-white transition hover:bg-white/10"
              >
                Load more games
              </button>
            ) : null}
          </>
        ) : (
          <div className="rounded-md border border-white/10 bg-[#142531] p-4 text-sm leading-6 text-stone-400">
            No public games match those filters.
          </div>
        )}
      </div>
    </div>
  );
}

function MyGamesListView({
  loadingGameId,
  onAddPgn,
  onAnalyzePgn,
  onDeleteSavedGame,
  onLoadSavedGame,
  onSetPgn,
  savedGames,
  setShowUploadInHistory,
  showUploadInHistory,
  uploadError,
  uploadIsLoading,
  uploadPgn,
}: {
  loadingGameId?: string | null;
  onAddPgn: () => void;
  onAnalyzePgn: () => void;
  onDeleteSavedGame: (gameId: string) => void;
  onLoadSavedGame: (game: SavedGame) => void;
  onSetPgn: (value: string) => void;
  savedGames: SavedGame[];
  setShowUploadInHistory: (value: boolean) => void;
  showUploadInHistory: boolean;
  uploadError?: string | null;
  uploadIsLoading: boolean;
  uploadPgn: string;
}) {
  return (
    <div className="move-scroll flex-1 space-y-3 overflow-y-auto pr-1">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-white">My Games</h2>
        <button
          onClick={() => setShowUploadInHistory(!showUploadInHistory)}
          title="Upload Game"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#101214] text-white transition hover:bg-white/10"
        >
          <Upload size={16} />
        </button>
      </div>
      {showUploadInHistory && (
        <div className="space-y-3 rounded-md border border-white/10 bg-[#142531] p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">Upload Game</h3>
            <button
              onClick={() => setShowUploadInHistory(false)}
              className="inline-flex items-center justify-center rounded-md border border-white/10 bg-white/10 p-1 transition hover:bg-white/20"
            >
              <X size={14} className="text-stone-300" />
            </button>
          </div>
          <textarea
            value={uploadPgn}
            onChange={(event) => onSetPgn(event.target.value)}
            placeholder="Paste your PGN here..."
            className="h-32 w-full resize-none rounded-md border border-white/10 bg-[#101214] p-2.5 text-sm text-stone-100 outline-none focus:border-sky-300/50"
          />
          {uploadError ? (
            <div className="flex items-start gap-2 rounded-md border border-red-300/20 bg-red-500/10 p-2.5 text-xs leading-5 text-red-100">
              <AlertCircle className="mt-0.5 shrink-0" size={14} />
              <span>{uploadError}</span>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onAddPgn}
              disabled={uploadIsLoading}
              className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-white/10 bg-[#101214] px-3 text-xs font-bold text-white transition hover:bg-white/10 disabled:opacity-60"
            >
              <Upload size={14} />
              Add Only
            </button>
            <button
              onClick={onAnalyzePgn}
              disabled={uploadIsLoading}
              className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-emerald-300 px-3 text-xs font-bold text-stone-950 transition hover:bg-emerald-200 disabled:opacity-60"
            >
              {uploadIsLoading ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
              {uploadIsLoading ? "Opening..." : "Add & Review"}
            </button>
          </div>
        </div>
      )}
      <MyGamesCollection
        loadingGameId={loadingGameId}
        onDeleteSavedGame={onDeleteSavedGame}
        onLoadSavedGame={onLoadSavedGame}
        savedGames={savedGames}
      />
    </div>
  );
}

function GameSourceListView({
  gameSource,
  loadingGameId,
  onAddPgn,
  onAnalyzePgn,
  onDeleteSavedGame,
  onLoadSavedGame,
  onSetPgn,
  savedGames,
  setShowUploadInHistory,
  showUploadInHistory,
  uploadError,
  uploadIsLoading,
  uploadPgn,
}: {
  gameSource: GameSource;
  loadingGameId?: string | null;
  onAddPgn: () => void;
  onAnalyzePgn: () => void;
  onDeleteSavedGame?: (gameId: string) => void;
  onLoadSavedGame: (game: SavedGame) => void;
  onSetPgn: (value: string) => void;
  savedGames: SavedGame[];
  setShowUploadInHistory: (value: boolean) => void;
  showUploadInHistory: boolean;
  uploadError?: string | null;
  uploadIsLoading: boolean;
  uploadPgn: string;
}) {
  if (gameSource === "publicgames") {
    return <PublicGamesPanel loadingGameId={loadingGameId} onLoadGame={onLoadSavedGame} />;
  }

  return (
    <MyGamesListView
      loadingGameId={loadingGameId}
      onAddPgn={onAddPgn}
      onAnalyzePgn={onAnalyzePgn}
      onDeleteSavedGame={onDeleteSavedGame ?? (() => {})}
      onLoadSavedGame={onLoadSavedGame}
      onSetPgn={onSetPgn}
      savedGames={savedGames}
      setShowUploadInHistory={setShowUploadInHistory}
      showUploadInHistory={showUploadInHistory}
      uploadError={uploadError}
      uploadIsLoading={uploadIsLoading}
      uploadPgn={uploadPgn}
    />
  );
}

function LiveBoard({
  accountAvatarUrl,
  accountEmail,
  accountName,
  accountSyncError,
  analysis,
  authConfigured,
  authLoading,
  boardOrientation,
  boardTransitioning,
  branchVariation,
  branchOriginPly,
  playtestBranchOriginCursor,
  branchMoveUci,
  branchMoveClassification,
  branchMoveAnalysis,
  canRedo,
  captures,
  evalData,
  game,
  isLoading,
  liveCursor,
  liveError,
  liveHistory,
  loadingGameId,
  onAddPgn,
  onAnalyzePgn,
  playtestAnalysis,
  pendingGameReview,
  suppressBoardArrow,
  onTogglePlaytestAnalysis,
  onExitPlaytestAnalysis,
  onDrop,
  onBackToList,
  onFlipBoard,
  onFreshBoard,
  onHome,
  onLoadSaved,
  onDeleteSaved,
  onMainlineSelect,
  onClearPendingGameReview,
  onPieceClick,
  onPieceDrag,
  onReset,
  onRedo,
  onReturnToReview,
  onSample,
  onSaveCurrentPgn,
  onSignIn,
  onSignOut,
  onSetPanelTab,
  onSetPgn,
  onSquareClick,
  onUndo,
  panelTab,
  reviewRows,
  reviewSurfaceVisible,
  savedGames,
  uploadError,
  uploadIsLoading,
  uploadPgn,
  dragHoverSquare,
  selectedSquare,
  sans,
  playtestMoveClassifications,
  showUploadInHistory,
  setShowUploadInHistory,
  historyView,
  setHistoryView,
  mounted,
  userName,
  onUserNameChange,
}: {
  accountAvatarUrl?: string | null;
  accountEmail?: string | null;
  accountName?: string | null;
  accountSyncError?: string | null;
  analysis: AnalysisResult | null;
  authConfigured: boolean;
  authLoading: boolean;
  boardOrientation: "white" | "black";
  boardTransitioning: boolean;
  branchVariation: MoveListVariation | null;
  branchOriginPly: number | null;
  playtestBranchOriginCursor: number | null;
  branchMoveUci: string | null;
  branchMoveClassification: Classification | null;
  branchMoveAnalysis: AnalysisMove | null;
  canRedo: boolean;
  captures: CaptureSummary;
  dragHoverSquare: string | null;
  evalData: LivePositionEval | null;
  game: Chess;
  isLoading: boolean;
  liveCursor: number;
  liveError: string | null;
  liveHistory: LiveSnapshot[];
  loadingGameId?: string | null;
  onAddPgn: () => void;
  onAnalyzePgn: () => void;
  playtestAnalysis: boolean;
  pendingGameReview: PendingGameReview | null;
  suppressBoardArrow: boolean;
  onTogglePlaytestAnalysis: () => void;
  onExitPlaytestAnalysis: () => void;
  onDrop: (sourceSquare: string, targetSquare: string | null) => boolean;
  onBackToList: () => void;
  onFlipBoard?: () => void;
  onFreshBoard: () => void;
  onHome: () => void;
  onLoadSaved: (game: SavedGame, source?: GameSource) => void;
  onDeleteSaved: (gameId: string) => void;
  onMainlineSelect: (ply: number) => void;
  onClearPendingGameReview: () => void;
  onPieceClick: (square: string | null) => void;
  onPieceDrag: (square: string | null) => void;
  onReset: () => void;
  onRedo: () => void;
  onReturnToReview: () => void;
  onSample: () => void;
  onSaveCurrentPgn: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onSetPanelTab: (tab: PanelTab) => void;
  onSetPgn: (pgn: string) => void;
  onSquareClick: (square: string | null) => void;
  onUndo: () => void;
  panelTab: PanelTab;
  reviewRows: { moveNumber: number; white?: AnalysisMove; black?: AnalysisMove }[];
  reviewSurfaceVisible?: boolean;
  savedGames: SavedGame[];
  uploadError: string | null;
  uploadIsLoading: boolean;
  uploadPgn: string;
  selectedSquare: string | null;
  sans: string[];
  playtestMoveClassifications: Record<number, Classification | null>;
  showUploadInHistory: boolean;
  setShowUploadInHistory: (value: boolean) => void;
  historyView: "list" | "analysis";
  setHistoryView: (view: "list" | "analysis") => void;
  mounted: boolean;
  userName: string;
  onUserNameChange: (value: string) => void;
}) {
  const whitePercent = evalToWhitePercent(evalData?.eval);
  const plainRows = groupSans(sans);
  const hasMoves = sans.length > 0;

  const lastMove = game.history({ verbose: true }).at(-1) as { from: string; to: string; san: string; captured?: string } | undefined;
  const analyzedClassifications = useMemo(() => classificationMapFromAnalysis(analysis), [analysis]);
  const analyzedRows = useMemo(() => groupLiveAnalysisMoves(sans, playtestAnalysis ? analysis : null), [analysis, playtestAnalysis, sans]);
  const rows = playtestAnalysis ? analyzedRows : plainRows;
  const moveClassifications = playtestAnalysis
    ? { ...analyzedClassifications, ...playtestMoveClassifications }
    : {};
  const visiblePly = liveCursor > 0 ? liveCursor : sans.length;
  const currentAnalyzedMove = playtestAnalysis ? analysis?.moves[visiblePly - 1] ?? null : null;
  const currentOpening = playtestAnalysis
    ? openingLabelForPosition(analysis, visiblePly, sans.slice(0, visiblePly))
    : detectOpening(sans);
  const currentClassification =
    playtestAnalysis
      ? moveClassifications[visiblePly - 1] ?? currentAnalyzedMove?.classification ?? branchMoveAnalysis?.classification ?? branchMoveClassification
      : null;
  const currentMoveUci =
    currentAnalyzedMove?.uci ?? liveHistory[visiblePly]?.lastMoveUci ?? branchMoveUci ?? (lastMove ? `${lastMove.from}${lastMove.to}` : null);
  const playedSquares = playtestAnalysis && currentMoveUci
    ? boardSquareHighlights(
        { uci: currentMoveUci, classification: currentClassification },
        "played"
      )
    : {};
  const selectedSquares = selectedSquareStyles(game, selectedSquare);
  const squareOverlays = playtestAnalysis
    ? { ...selectedSquares, ...playedSquares }
    : selectedSquares;
  const { legalMoves: liveLegalMoves, captureMoves: liveCaptureMoves } = getLegalMoves(game, selectedSquare);
  const liveArrowSquares = squareNameFromUci(evalData?.best_move);
  const whiteName = displayPlayerName(analysis?.metadata.white, "White");
  const blackName = displayPlayerName(analysis?.metadata.black, "Black");
  const liveSquareAnnotations = useMemo(() => {
    const annotations: Record<string, SquareAnnotation> = {};
    const squares = squareNameFromUci(currentMoveUci);

    if (squares && currentClassification) {
      const [, toSquare] = squares;
      annotations[toSquare] = {
        label: squareBadgeText(currentClassification, "played"),
        tone: squareBadgeTone(currentClassification, "played"),
        iconSrc: squareBadgeIcon(currentClassification, "played") ?? undefined,
      };
    }
    
    return annotations;
  }, [currentClassification, currentMoveUci]);
  const liveEndGameAnnotations = useMemo(
    () =>
      endGameBoardAnnotations({
        fen: game.fen(),
        isFinalPly: !!playtestAnalysis && !!analysis && visiblePly === analysis.moves.length,
        pgn: liveHistory[visiblePly]?.pgn ?? liveHistory[liveHistory.length - 1]?.pgn,
        result: analysis?.metadata.result,
        termination: analysis?.metadata.termination,
      }),
    [analysis, game, liveHistory, playtestAnalysis, visiblePly]
  );
  const combinedLiveSquareAnnotations = useMemo(
    () => ({ ...liveSquareAnnotations, ...liveEndGameAnnotations }),
    [liveSquareAnnotations, liveEndGameAnnotations]
  );

  return (
    <section className="game-review-shell grid items-stretch xl:grid-cols-[208px_minmax(620px,960px)_minmax(360px,1fr)]">
      <AppRail
        active={
          pendingGameReview?.source === "mygames"
            ? "mygames"
            : pendingGameReview?.source === "publicgames"
              ? "publicgames"
              : panelTab === "mygames"
                ? "mygames"
                : panelTab === "publicgames"
                  ? "publicgames"
                  : "playtest"
        }
        accountAvatarUrl={accountAvatarUrl}
        accountEmail={accountEmail}
        accountName={accountName}
        accountSyncError={accountSyncError}
        authConfigured={authConfigured}
        authLoading={authLoading}
        onFreshBoard={onFreshBoard}
        onHome={onHome}
        onMyGames={() => onSetPanelTab("mygames")}
        onPublicGames={() => onSetPanelTab("publicgames")}
        onSave={onSaveCurrentPgn}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
        saveDisabled={!hasMoves}
        userName={userName}
        onUserNameChange={onUserNameChange}
      />
      <div className={`board-column-shell review-surface-fade flex min-h-0 flex-col justify-center ${reviewSurfaceVisible !== false ? "review-surface-fade-visible" : ""}`}>
        <div
          className="board-eval-layout min-h-0 flex-1"
          data-eval-visible={playtestAnalysis}
          data-transitioning={boardTransitioning}
          style={{
            "--eval-column": "48px",
            "--eval-gap": "0.75rem",
            "--eval-row": "32px",
          } as CSSProperties}
        >
          <div
            className={`board-eval-slot min-h-0 min-w-0 overflow-hidden transition-[opacity,transform] duration-300 ease-out ${
              playtestAnalysis ? "translate-x-0 opacity-100" : "-translate-x-2 opacity-0"
            }`}
            style={{ visibility: playtestAnalysis ? "visible" : "hidden" }}
          />
          <div className="board-eval-stage min-h-0">
            <BoardStage
              topPlayer={{
                active: game.turn() === "b",
                color: "black",
                captures: captures.black,
                name: blackName,
                rating: analysis?.metadata.black_elo,
              }}
              bottomPlayer={{
                active: game.turn() === "w",
                color: "white",
                captures: captures.white,
                name: whiteName,
                rating: analysis?.metadata.white_elo,
              }}
              horizontalEvalBar={
                <div className={`eval-bar-fade ${playtestAnalysis ? "eval-bar-fade-visible" : ""}`}>
                  <EvalBar
                    key={`horizontal-${boardOrientation}`}
                    score={evalData?.eval ?? null}
                    whitePercent={whitePercent}
                    boardOrientation={boardOrientation}
                  />
                </div>
              }
              dragHoverSquare={dragHoverSquare}
              onFlipBoard={onFlipBoard}
              boardOrientation={boardOrientation}
              edgeToEdge
            >
              <div className="board-stage-transition" data-transitioning={boardTransitioning}>
                <ChessgroundBoard
                  key={boardOrientation}
                  fen={game.fen()}
                  orientation={boardOrientation}
                  turnColor={game.turn() === "w" ? "white" : "black"}
                  dests={getLegalDests(game)}
                  animationDuration={180}
                  onMove={(orig, dest) => {
                    onDrop(orig, dest);
                  }}
                  onSelect={(key) => {
                    onPieceClick(key);
                  }}
                >
                  <BoardSquareOverlay
                    squareOverlays={squareOverlays}
                    legalMoves={liveLegalMoves}
                    captureMoves={liveCaptureMoves}
                    orientation={boardOrientation}
                  />
                  {/* Only show badges when analysis mode is on */}
                  {playtestAnalysis && (
                    <BoardBadgeOverlay
                      annotations={combinedLiveSquareAnnotations}
                      orientation={boardOrientation}
                    />
                  )}
                  {/* Only show arrow in analysis mode, not sandbox mode */}
                  {playtestAnalysis && (
                    <BoardArrowOverlay
                      arrow={!suppressBoardArrow && liveArrowSquares ? [liveArrowSquares[0], liveArrowSquares[1]] : null}
                      color={REVIEW_ARROW_COLOR}
                      boardOrientation={boardOrientation}
                    />
                  )}
                </ChessgroundBoard>
              </div>
            </BoardStage>
          </div>
        </div>
      </div>

      <aside className="review-panel-shell flex flex-col overflow-hidden rounded-md border border-white/10 bg-[#203746]/82 p-4 shadow-2xl shadow-black/20">
        {pendingGameReview ? (
          <PendingGameReviewPanel
            pendingGameReview={pendingGameReview}
            isLoading={isLoading || loadingGameId === pendingGameReview.game.id}
            error={liveError}
            onBackToList={() => {
              const source = pendingGameReview.source;
              onClearPendingGameReview();
              onSetPanelTab(source);
            }}
          />
        ) : panelTab === "mygames" ? (
          <div className="move-scroll flex-1 space-y-3 overflow-y-auto pr-1">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-white">My Games</h2>
              <button
                onClick={() => setShowUploadInHistory(!showUploadInHistory)}
                title="Upload Game"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#101214] text-white transition hover:bg-white/10"
              >
                <Upload size={16} />
              </button>
            </div>
            {showUploadInHistory && (
              <div className="space-y-3 rounded-md border border-white/10 bg-[#142531] p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-white">Upload Game</h3>
                  <button
                    onClick={() => setShowUploadInHistory(false)}
                    className="inline-flex items-center justify-center rounded-md border border-white/10 bg-white/10 p-1 transition hover:bg-white/20"
                  >
                    <X size={14} className="text-stone-300" />
                  </button>
                </div>
                <textarea
                  value={uploadPgn}
                  onChange={(e) => onSetPgn(e.target.value)}
                  placeholder="Paste your PGN here..."
                  className="h-32 w-full resize-none rounded-md border border-white/10 bg-[#101214] p-2.5 text-sm text-stone-100 outline-none focus:border-sky-300/50"
                />
                {uploadError ? (
                  <div className="flex items-start gap-2 rounded-md border border-red-300/20 bg-red-500/10 p-2.5 text-xs leading-5 text-red-100">
                    <AlertCircle className="mt-0.5 shrink-0" size={14} />
                    <span>{uploadError}</span>
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={onAddPgn}
                    disabled={uploadIsLoading}
                    className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-white/10 bg-[#101214] px-3 text-xs font-bold text-white transition hover:bg-white/10 disabled:opacity-60"
                  >
                    <Upload size={14} />
                    Add Only
                  </button>
                  <button
                    onClick={onAnalyzePgn}
                    disabled={uploadIsLoading}
                    className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-emerald-300 px-3 text-xs font-bold text-stone-950 transition hover:bg-emerald-200 disabled:opacity-60"
                  >
                    {uploadIsLoading ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
                    {uploadIsLoading ? "Opening..." : "Add & Review"}
                  </button>
                </div>
              </div>
            )}
            <MyGamesCollection
              isReady={mounted}
              loadingGameId={loadingGameId}
              onDeleteSavedGame={onDeleteSaved}
              onLoadSavedGame={(game) => onLoadSaved(game, "mygames")}
              savedGames={savedGames}
            />
          </div>
        ) : panelTab === "publicgames" ? (
          <PublicGamesPanel loadingGameId={loadingGameId} onLoadGame={(game) => onLoadSaved(game, "publicgames")} />
        ) : (
          <LiveAnalysisPanel
            analysis={analysis}
            branchOriginPly={branchOriginPly}
            playtestBranchOriginCursor={playtestBranchOriginCursor}
            branchMoveClassification={branchMoveClassification}
            branchMoveAnalysis={branchMoveAnalysis}
            branchVariation={branchVariation}
            evalData={evalData}
            game={game}
            isLoading={isLoading}
            lastMove={lastMove}
            liveError={liveError}
            reviewRows={reviewRows}
            rows={rows}
            hasMoves={hasMoves}
            liveCursor={liveCursor}
            liveHistory={liveHistory}
            onMainlineSelect={onMainlineSelect}
            onUndo={onUndo}
            onRedo={onRedo}
            onReturnToReview={onReturnToReview}
            savedGames={savedGames}
            onLoadSaved={onLoadSaved}
            onSetPanelTab={onSetPanelTab}
            onBackToList={onBackToList}
            playtestAnalysis={playtestAnalysis}
            onTogglePlaytestAnalysis={onTogglePlaytestAnalysis}
            onExitPlaytestAnalysis={onExitPlaytestAnalysis}
            playtestMoveClassifications={moveClassifications}
            currentOpening={currentOpening}
          />
        )}
      </aside>
    </section>
  );
}

function PanelTabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-md text-sm font-bold transition ${
        active ? "bg-[#2d5268] text-white" : "text-stone-400 hover:bg-white/10 hover:text-stone-100"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function LiveMoveList({
  hasMoves,
  rows,
  moveClassifications = {},
}: {
  hasMoves: boolean;
  rows: { moveNumber: number; white?: AnalysisMove | string; black?: AnalysisMove | string }[];
  moveClassifications?: Record<number, Classification | null>;
}) {
  return (
    <div className="rounded-md border border-white/10 bg-[#142531] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-stone-500">Moves</p>
        <span className="text-xs text-stone-500">{hasMoves ? "Drag pieces to continue" : "Start with White"}</span>
      </div>
      <div className="move-scroll max-h-[300px] overflow-y-auto pr-1">
        {hasMoves ? (
          <div className="grid grid-cols-[26px_minmax(0,1fr)_minmax(0,1fr)] gap-x-1.5 gap-y-0.5 text-sm">
            {rows.map((row) => {
              const whiteIdx = (row.moveNumber - 1) * 2;
              const blackIdx = whiteIdx + 1;
              return (
                <div key={row.moveNumber} className="contents">
                  <div className="flex h-6 items-center justify-center text-[10px] font-semibold text-stone-500">{row.moveNumber}.</div>
                  <LiveMoveCell move={row.white} color="white" classificationOverride={moveClassifications[whiteIdx]} />
                  <LiveMoveCell move={row.black} color="black" classificationOverride={moveClassifications[blackIdx]} />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-md border border-white/10 bg-black/10 p-4 text-sm leading-6 text-stone-400">
            Drag a piece on the board. Legal moves are kept and the position eval updates after each move.
          </div>
        )}
      </div>
    </div>
  );
}

function LiveMoveCell({
  color,
  move,
  classificationOverride,
}: {
  color: "white" | "black";
  move?: AnalysisMove | string;
  classificationOverride?: Classification | null;
}) {
  if (!move) return <div className="h-6 rounded-sm" />;

  const san = typeof move === "string" ? move : move.san;
  const classification = classificationOverride !== undefined ? classificationOverride : (typeof move === "string" ? null : move.classification);
  const glyph = pieceGlyphFromSan(san, color);
  const moveText = glyph ? san.slice(1) : san;

  return (
    <div className="flex h-6 items-center rounded-sm px-2 text-[11px] font-semibold text-stone-300">
      {classification ? <ClassificationBadge classification={classification} className="mr-1 h-4 w-4" /> : null}
      {glyph ? <span className="mr-1 text-[12px] leading-none opacity-90">{glyph}</span> : null}
      <span className="truncate">{moveText}</span>
    </div>
  );
}

function PendingGameReviewPanel({
  error,
  isLoading,
  onBackToList,
  pendingGameReview,
}: {
  error?: string | null;
  isLoading: boolean;
  onBackToList: () => void;
  pendingGameReview: PendingGameReview;
}) {
  const { game, rows, source } = pendingGameReview;
  const players = gamePlayersFromTitle(game.title);
  const sourceLabel = source === "publicgames" ? "Public Games" : "My Games";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-white">Game Review</h2>
          <p className="mt-1 truncate text-xs font-semibold text-stone-400">
            {players.white} vs. {players.black}
          </p>
        </div>
        <button
          onClick={onBackToList}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-white/10 bg-[#101214] px-2.5 text-xs font-bold text-white transition hover:bg-white/10"
        >
          <ChevronLeft size={14} />
          {sourceLabel}
        </button>
      </div>

      <div className="mt-3 rounded-md border border-sky-200/15 bg-sky-300/[0.06] p-3 text-stone-100">
        <div className="flex items-center gap-2">
          {isLoading ? <Loader2 className="shrink-0 animate-spin text-sky-200" size={18} /> : <AlertCircle className="shrink-0 text-red-200" size={18} />}
          <div className="min-w-0">
            <div className="text-sm font-bold text-white">
              {isLoading ? "Loading game review..." : "Review could not load"}
            </div>
            <div className="mt-0.5 truncate text-xs text-stone-400">{cleanOpeningLabel(game.subtitle)}</div>
          </div>
        </div>
        {error && !isLoading ? (
          <div className="mt-3 rounded-sm border border-red-300/20 bg-red-500/10 px-2 py-1.5 text-xs leading-5 text-red-100">
            {error}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col rounded-md border border-white/10 bg-[#142531] p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase text-stone-500">Moves</p>
          <span className="text-xs text-stone-500">{game.moveCount} moves</span>
        </div>
        <div className="move-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          {rows.length ? (
            <div className="grid grid-cols-[26px_minmax(0,1fr)_minmax(0,1fr)] gap-x-1.5 gap-y-0.5 text-sm">
              {rows.map((row) => (
                <div key={row.moveNumber} className="contents">
                  <div className="flex h-6 items-center justify-center text-[10px] font-semibold text-stone-500">{row.moveNumber}.</div>
                  <LiveMoveCell move={row.white} color="white" />
                  <LiveMoveCell move={row.black} color="black" />
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-white/10 bg-black/10 p-4 text-sm leading-6 text-stone-400">
              Preparing the move list...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EvalBar({ score, whitePercent, boardOrientation = "white" }: { score: EvalScore | null; whitePercent: number; boardOrientation?: "white" | "black" }) {
  const blackPercent = 100 - whitePercent;
  const whiteAdvantage = whitePercent >= 50;
  const flipped = boardOrientation === "black";
  const topSegment = flipped ? "white" : "black";
  const dividerPercent = flipped ? whitePercent : blackPercent;
  const advantageSegment = whiteAdvantage ? "white" : "black";
  const labelPlacement = advantageSegment === topSegment ? "top-1" : "bottom-1";
  const labelOnWhite = advantageSegment === "white";
  const leftSegment = flipped ? "white" : "black";
  const leftPercent = flipped ? whitePercent : blackPercent;
  const rightPercent = 100 - leftPercent;
  const horizontalDividerPercent = leftPercent;

  const formatEvalBarScore = (evalScore: EvalScore | null) => {
    if (!evalScore) return "0.0";
    if (evalScore.mate !== null) {
      return `M${Math.abs(evalScore.mate)}`;
    }
    return (Math.abs(evalScore.cp) / 100).toFixed(1);
  };

  return (
    <div className="eval-bar-root relative flex h-full min-h-[520px] items-center justify-center">
      <div className="eval-bar-vertical relative h-full w-[26px] overflow-hidden rounded-sm border border-black/25 bg-[#101214] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_8px_20px_rgba(0,0,0,0.22)] sm:w-[30px]">
        <div
          className="absolute inset-x-0 bg-[#2d2d2b] transition-[height,top] duration-300 ease-out"
          style={{
            height: `${blackPercent}%`,
            top: flipped ? `${whitePercent}%` : "0%",
          }}
        />
        <div
          className="absolute inset-x-0 bg-[#f4ead8] transition-[height,top] duration-300 ease-out"
          style={{
            height: `${whitePercent}%`,
            top: flipped ? "0%" : `${blackPercent}%`,
          }}
        />
        <div
          className="absolute inset-x-0 h-px bg-black/35 transition-[top] duration-300 ease-out"
          style={{ top: `${dividerPercent}%` }}
        />
        <div
          className={`absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-center text-[10px] font-black leading-none ${labelPlacement} ${
            labelOnWhite ? "text-stone-950" : "text-white"
          }`}
        >
          {formatEvalBarScore(score)}
        </div>
      </div>
      <div className="eval-bar-horizontal relative hidden h-[22px] w-full overflow-hidden rounded-sm border border-black/25 bg-[#101214] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_8px_20px_rgba(0,0,0,0.18)]">
        <div
          className={`absolute inset-y-0 left-0 transition-[width] duration-300 ease-out ${
            leftSegment === "white" ? "bg-[#f4ead8]" : "bg-[#2d2d2b]"
          }`}
          style={{ width: `${leftPercent}%` }}
        />
        <div
          className={`absolute inset-y-0 right-0 transition-[width] duration-300 ease-out ${
            leftSegment === "white" ? "bg-[#2d2d2b]" : "bg-[#f4ead8]"
          }`}
          style={{ width: `${rightPercent}%` }}
        />
        <div
          className="absolute inset-y-0 w-px bg-black/35 transition-[left] duration-300 ease-out"
          style={{ left: `${horizontalDividerPercent}%` }}
        />
        <div className="absolute left-1/2 top-1/2 rounded-sm bg-black/35 px-1.5 py-0.5 text-[10px] font-black leading-none text-white -translate-x-1/2 -translate-y-1/2">
          {formatEvalBarScore(score)}
        </div>
      </div>
    </div>
  );
}

function ReviewPanel({
  analysis,
  activePly,
  branchVariation,
  canStepBack,
  canStepForward,
  engineLines,
  evalScore,
  onFirst,
  onNext,
  onLast,
  onPlayFromPosition,
  onReturnToPlaytest,
  onPrev,
  onSelectPly,
  positionStatus,
  selectedMove,
  rows,
  currentOpening,
  gameSource,
  loadingGameId,
  reviewTab,
  onReviewTabChange,
  showUploadInHistory,
  setShowUploadInHistory,
  uploadPgn,
  onSetPgn,
  onAddPgn,
  onAnalyzePgn,
  uploadError,
  uploadIsLoading,
  savedGames,
  onLoadSavedGame,
  onDeleteSavedGame,
}: {
  activePly: number;
  analysis: AnalysisResult;
  branchVariation?: MoveListVariation | null;
  canStepBack: boolean;
  canStepForward: boolean;
  engineLines: EngineLine[];
  selectedMove: AnalysisMove | null;
  evalScore: EvalScore | null;
  onFirst: () => void;
  onLast: () => void;
  onNext: () => void;
  onPlayFromPosition: () => void;
  onReturnToPlaytest?: () => void;
  onPrev: () => void;
  positionStatus: string;
  onSelectPly: (ply: number) => void;
  rows: { moveNumber: number; white?: AnalysisMove; black?: AnalysisMove }[];
  currentOpening: string;
  gameSource: GameSource | null;
  loadingGameId?: string | null;
  reviewTab: ReviewPanelTab;
  onReviewTabChange: (tab: ReviewPanelTab) => void;
  showUploadInHistory: boolean;
  setShowUploadInHistory: (value: boolean) => void;
  uploadPgn: string;
  onSetPgn: (value: string) => void;
  onAddPgn: () => void;
  onAnalyzePgn: () => void;
  uploadError?: string | null;
  uploadIsLoading: boolean;
  savedGames: SavedGame[];
  onLoadSavedGame: (game: SavedGame) => void;
  onDeleteSavedGame: (gameId: string) => void;
}) {
  const summary = analysis.summary;
  const activeLabel = selectedMove
    ? `${selectedMove.san} is ${/^[aeiou]/.test(classificationLabel(selectedMove.classification)) ? "an" : "a"} ${classificationLabel(selectedMove.classification)}`
    : "Start position";
  const engineSource = analysis.metadata.analysis_source === "stockfish" ? `Depth ${analysis.metadata.engine_depth}` : "Fallback";

  const navigation = (
    <div className="grid grid-cols-5 gap-2">
      <button
        onClick={onFirst}
        disabled={!canStepBack}
        className="inline-flex h-11 items-center justify-center rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
        aria-label="First move"
      >
        <ChevronLeft size={18} />
        <ChevronLeft className="-ml-3" size={18} />
      </button>
      <button
        onClick={onPrev}
        disabled={!canStepBack}
        className="inline-flex h-11 items-center justify-center rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
        aria-label="Previous move"
      >
        <ChevronLeft size={20} />
      </button>
      <div className="flex h-11 items-center justify-center rounded-md bg-[#101214] text-sm font-semibold text-stone-300">
        {activePly} / {analysis.moves.length}
      </div>
      <button
        onClick={onNext}
        disabled={!canStepForward}
        className="inline-flex h-11 items-center justify-center rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
        aria-label="Next move"
      >
        <ChevronRight size={20} />
      </button>
      <button
        onClick={onLast}
        disabled={!canStepForward}
        className="inline-flex h-11 items-center justify-center rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
        aria-label="Last move"
      >
        <ChevronRight size={18} />
        <ChevronRight className="-ml-3" size={18} />
      </button>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold text-white">Game Review</h2>
        </div>
        <div className="flex items-center gap-2">
          {/* Review/Graph Toggle - Icon only */}
          <div className="flex rounded-md border border-white/10 bg-[#101214] p-0.5">
            <button
              onClick={() => onReviewTabChange("review")}
              title="Review"
              className={`inline-flex h-7 w-7 items-center justify-center rounded transition ${
                reviewTab === "review"
                  ? "bg-white/10 text-white"
                  : "text-stone-400 hover:text-white"
              }`}
            >
              <Star size={14} />
            </button>
            <button
              onClick={() => onReviewTabChange("graph")}
              title="Graph"
              className={`inline-flex h-7 w-7 items-center justify-center rounded transition ${
                reviewTab === "graph"
                  ? "bg-white/10 text-white"
                  : "text-stone-400 hover:text-white"
              }`}
            >
              <BarChart3 size={14} />
            </button>
            {gameSource ? (
              <button
                onClick={() => onReviewTabChange("list")}
                title={gameSource === "publicgames" ? "Public Games" : "My Games"}
                className={`inline-flex h-7 w-7 items-center justify-center rounded transition ${
                  reviewTab === "list"
                    ? "bg-white/10 text-white"
                    : "text-stone-400 hover:bg-white/10 hover:text-white"
                }`}
              >
                <List size={14} />
              </button>
            ) : null}
          </div>
          <div className="rounded-md border border-white/10 bg-[#101214] px-3 py-1 text-sm font-bold text-white">{evalScore?.display ?? "0.00"}</div>
        </div>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        {reviewTab === "list" && gameSource ? (
          <GameSourceListView
            gameSource={gameSource}
            loadingGameId={loadingGameId}
            onAddPgn={onAddPgn}
            onAnalyzePgn={onAnalyzePgn}
            onDeleteSavedGame={onDeleteSavedGame}
            onLoadSavedGame={onLoadSavedGame}
            onSetPgn={onSetPgn}
            savedGames={savedGames}
            setShowUploadInHistory={setShowUploadInHistory}
            showUploadInHistory={showUploadInHistory}
            uploadError={uploadError}
            uploadIsLoading={uploadIsLoading}
            uploadPgn={uploadPgn}
          />
        ) : (
          <>
            <div className="rounded-md border border-white/10 bg-[#142531] p-2.5 text-stone-100 shadow-lg shadow-black/20">
              {reviewTab === "review" ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    {selectedMove ? (
                      <ClassificationBadge classification={selectedMove.classification} className="h-8 w-8" />
                    ) : (
                      <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full border px-1 text-[12px] font-black border-white/10 bg-white/[0.06] text-stone-200`}>
                        <Sparkles size={11} />
                      </span>
                    )}
                    <span className="text-sm font-semibold">{activeLabel}</span>
                  </div>
                  {currentOpening ? <OpeningNameRow opening={currentOpening} /> : null}
                  <CompactEngineLines lines={engineLines} positionStatus={positionStatus} sourceLabel={engineSource} />
                </>
              ) : (
                <AdvantageTimeline analysis={analysis} activePly={activePly} onSelectPly={onSelectPly} embedded />
              )}
            </div>
            {reviewTab === "graph" ? (
              <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1 move-scroll">
                <ReviewSummaryTable analysis={analysis} currentOpening={currentOpening} />
              </div>
            ) : null}
            {reviewTab === "review" && (
              <div className="mt-3 flex min-h-0 flex-1 flex-col">
                <MoveList rows={rows} activePly={activePly} onSelect={onSelectPly} variation={branchVariation} />
              </div>
            )}
            {reviewTab === "review" && (
              <div className="mt-3 space-y-3">
                {navigation}
                {onReturnToPlaytest ? (
                  <ReturnToPlaytestButton onClick={onReturnToPlaytest} />
                ) : (
                  <PlayFromPositionButton onClick={onPlayFromPosition} />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ReturnToPlaytestButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-sky-200/25 bg-sky-300/10 px-4 text-sm font-bold text-sky-100 transition hover:bg-sky-300/15"
    >
      <Play size={17} />
      Back To Playtest Game
    </button>
  );
}

function ReturnToMainlineButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-sky-200/25 bg-sky-300/10 px-4 text-sm font-bold text-sky-100 transition hover:bg-sky-300/15"
    >
      <GitBranch size={17} />
      Back To Mainline
    </button>
  );
}

function PlayFromPositionButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-sky-200/25 bg-sky-300/10 px-4 text-sm font-bold text-sky-100 transition hover:bg-sky-300/15"
    >
      <Play size={17} />
      Play From This Position
    </button>
  );
}

function AdvantageTimeline({
  activePly,
  analysis,
  onSelectPly,
  embedded = false,
}: {
  activePly: number;
  analysis: AnalysisResult;
  onSelectPly: (ply: number) => void;
  embedded?: boolean;
}) {
  const width = 320;
  const height = embedded ? 85 : 92;
  const paddingX = 6;
  const paddingY = 8;
  const midY = height / 2;
  const usableHeight = midY - paddingY;
  const turningPointPly = analysis.summary.biggest_turning_point?.ply ?? null;
  const turningPointMove = analysis.summary.biggest_turning_point;
  const swingMoves = analysis.moves.filter((move) =>
    move.classification === "blunder" || move.classification === "mistake" || move.classification === "inaccuracy"
  );
  const [hoverPly, setHoverPly] = useState<number | null>(null);

  const points = useMemo(() => {
    const timeline = analysis.moves.length
      ? [analysis.moves[0].eval_before, ...analysis.moves.map((move) => move.eval_after)]
      : [{ cp: 0, mate: null, display: "0.00" }];

    return timeline.map((score, index) => {
      const progress = timeline.length === 1 ? 0.5 : index / (timeline.length - 1);
      const x = paddingX + progress * (width - paddingX * 2);
      const y = evalToGraphY(score, midY, usableHeight, height);
      return { ply: index, score, x, y };
    });
  }, [analysis.moves, midY, paddingX, usableHeight]);

  const areaPath = points.length
    ? `M ${points[0].x} ${midY} L ${points.map((point) => `${point.x} ${point.y}`).join(" L ")} L ${points[points.length - 1].x} ${midY} Z`
    : "";
  const linePath = points.length
    ? `M ${points.map((point) => `${point.x} ${point.y}`).join(" L ")}`
    : "";
  const activePoint = points[Math.max(0, Math.min(activePly, points.length - 1))] ?? null;
  const hoverPoint = hoverPly !== null ? points[Math.max(0, Math.min(hoverPly, points.length - 1))] ?? null : null;
  const displayPoint = hoverPoint ?? activePoint;
  const turningPoint = turningPointPly !== null ? points[turningPointPly] ?? null : null;

  function plyFromGraphEvent(event: ReactMouseEvent<SVGSVGElement>) {
    if (!points.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const relativeX = ((event.clientX - bounds.left) / bounds.width) * width;
    const normalized = (relativeX - paddingX) / (width - paddingX * 2);
    return Math.round(Math.max(0, Math.min(1, normalized)) * (points.length - 1));
  }

  function handleSelect(event: ReactMouseEvent<SVGSVGElement>) {
    const nextPly = plyFromGraphEvent(event);
    if (nextPly === undefined) return;
    onSelectPly(nextPly);
  }

  function handleHover(event: ReactMouseEvent<SVGSVGElement>) {
    const nextPly = plyFromGraphEvent(event);
    if (nextPly === undefined) return;
    setHoverPly(nextPly);
  }

  return (
    <div className={embedded ? "" : "mt-3 rounded-md border border-white/10 bg-[#142531] p-2.5 shadow-lg shadow-black/20"}>
      <div className={embedded ? "" : "overflow-hidden rounded-md border border-white/10 bg-[#101c25] mt-2"}>
        {embedded ? null : (
          <div className="flex items-center justify-center px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            <span>{analysis.moves.length} plies</span>
          </div>
        )}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className={`block w-full cursor-pointer ${embedded ? "h-[114px]" : "h-[104px]"}`}
          onClick={handleSelect}
          onMouseMove={handleHover}
          onMouseLeave={() => setHoverPly(null)}
          role="img"
          aria-label="Advantage graph"
        >
          <rect x="0" y="0" width={width} height={height} fill="#0f172a" />
          {points.length ? (
            <path
              d={`M 0 ${points[0].y} L ${points.map((p) => `${p.x} ${p.y}`).join(" L ")} L ${width} ${points[points.length - 1].y} L ${width} ${height} L 0 ${height} Z`}
              fill="#f1f5f9"
            />
          ) : null}
          <line x1={0} y1={midY} x2={width} y2={midY} stroke="rgba(148,163,184,0.85)" strokeWidth="1.5" />
          {linePath ? (
            <path
              d={linePath}
              fill="none"
              stroke="rgba(148,163,184,0.8)"
              strokeWidth="1"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}

          {displayPoint ? (
            <>
              <line
                x1={displayPoint.x}
                y1={paddingY / 2}
                x2={displayPoint.x}
                y2={height - paddingY / 2}
                stroke="rgba(148,163,184,0.85)"
                strokeWidth="0.75"
              />
              <circle
                cx={displayPoint.x}
                cy={displayPoint.y}
                r="4.5"
                fill="rgba(125,211,252,1)"
                stroke="rgba(15,23,42,0.95)"
                strokeWidth="2"
              />
            </>
          ) : null}
        </svg>
        <div className="flex items-center justify-between px-2 py-1 text-[9px] text-stone-400">
          <span>Start</span>
          <span>{displayPoint ? `Ply ${displayPoint.ply} · ${displayPoint.score.display}` : "Even"}</span>
          <span>End</span>
        </div>
      </div>

      {embedded ? null : (
        <div className="mt-1.5 text-[10px] text-stone-400">
          {turningPointMove ? (
            <>
              Biggest swing:{" "}
              <span className="font-semibold text-stone-300">
                {turningPointMove.move_number}
                {turningPointMove.color === "black" ? "..." : "."} {turningPointMove.san}
              </span>
            </>
          ) : (
            "No major swing recorded for this review."
          )}
        </div>
      )}
    </div>
  );
}

const REVIEW_SUMMARY_CLASSIFICATIONS: Classification[] = [
  "brilliant",
  "great",
  "book",
  "best",
  "excellent",
  "good",
  "inaccuracy",
  "mistake",
  "miss",
  "blunder",
];

function reviewSummaryClassificationLabel(classification: Classification) {
  if (classification === "miss") return "miss";
  return classificationLabel(classification);
}

function reviewClassificationCounts(analysis: AnalysisResult) {
  const counts = {
    white: Object.fromEntries(REVIEW_SUMMARY_CLASSIFICATIONS.map((classification) => [classification, 0])) as Record<Classification, number>,
    black: Object.fromEntries(REVIEW_SUMMARY_CLASSIFICATIONS.map((classification) => [classification, 0])) as Record<Classification, number>,
  };

  for (const move of analysis.moves) {
    counts[move.color][move.classification] = (counts[move.color][move.classification] ?? 0) + 1;
  }

  return counts;
}

type ReviewPhase = "opening" | "middlegame" | "endgame";
type ReviewSide = "white" | "black";

const REVIEW_PHASES: Array<{ key: ReviewPhase; label: string }> = [
  { key: "opening", label: "Opening" },
  { key: "middlegame", label: "Middlegame" },
  { key: "endgame", label: "Endgame" },
];

function materialStateFromFen(fen: string) {
  const board = fen.split(" ")[0] ?? "";
  let nonKingPieces = 0;
  let queens = 0;

  for (const char of board) {
    const piece = char.toLowerCase();
    if (!"pnbrq".includes(piece)) continue;
    nonKingPieces += 1;
    if (piece === "q") queens += 1;
  }

  return { nonKingPieces, queens };
}

function reviewPhaseForMove(move: AnalysisMove): ReviewPhase {
  if (move.is_book || move.move_number <= 10) return "opening";

  const material = materialStateFromFen(move.fen_after);
  if (move.move_number >= 35 || material.nonKingPieces <= 10 || (material.queens === 0 && material.nonKingPieces <= 16)) {
    return "endgame";
  }

  return "middlegame";
}

type ReviewPhaseMetric = {
  accuracy: number | null;
  classification: Classification | null;
};

function accuracyFromExpectedLoss(expectedLoss: number) {
  const boundedLoss = Math.max(0, Math.min(expectedLoss, 1));
  return 103.1668 * Math.exp(-10 * boundedLoss) - 3.1669;
}

function accuracyForExpectedLosses(expectedLosses: number[]) {
  if (!expectedLosses.length) return null;
  const boundedLosses = expectedLosses.map((loss) => Math.max(0, Math.min(loss, 1)));
  const averageLoss = boundedLosses.reduce((total, loss) => total + loss, 0) / boundedLosses.length;
  const wholePhaseScore = accuracyFromExpectedLoss(averageLoss);
  const perMoveScore =
    boundedLosses.reduce((total, loss) => total + accuracyFromExpectedLoss(loss), 0) / boundedLosses.length;
  return Math.round(Math.max(0, Math.min(100, wholePhaseScore * 0.75 + perMoveScore * 0.25)) * 10) / 10;
}

function reviewPhaseScores(analysis: AnalysisResult) {
  const buckets = Object.fromEntries(
    REVIEW_PHASES.map(({ key }) => [
      key,
      {
        white: [] as AnalysisMove[],
        black: [] as AnalysisMove[],
      },
    ])
  ) as Record<ReviewPhase, Record<ReviewSide, AnalysisMove[]>>;

  for (const move of analysis.moves) {
    const phase = reviewPhaseForMove(move);
    buckets[phase][move.color].push(move);
  }

  const phaseIsReached = (phase: Exclude<ReviewPhase, "opening">) => {
    const phaseBucket = buckets[phase];
    return phaseBucket.white.length + phaseBucket.black.length >= 6 &&
      phaseBucket.white.length >= 2 &&
      phaseBucket.black.length >= 2;
  };

  const middlegameReached = phaseIsReached("middlegame");
  const endgameReached = phaseIsReached("endgame");

  if (!endgameReached) {
    const fallbackPhase: ReviewPhase = middlegameReached ? "middlegame" : "opening";
    buckets[fallbackPhase].white.push(...buckets.endgame.white);
    buckets[fallbackPhase].black.push(...buckets.endgame.black);
    buckets.endgame.white = [];
    buckets.endgame.black = [];
  }

  if (!middlegameReached) {
    buckets.opening.white.push(...buckets.middlegame.white);
    buckets.opening.black.push(...buckets.middlegame.black);
    buckets.middlegame.white = [];
    buckets.middlegame.black = [];
  }

  const totalMovesBySide = {
    white: analysis.moves.filter((move) => move.color === "white").length,
    black: analysis.moves.filter((move) => move.color === "black").length,
  };

  return Object.fromEntries(
    REVIEW_PHASES.map(({ key }) => [
      key,
      Object.fromEntries(
        (["white", "black"] as ReviewSide[]).map((color) => {
          const phaseMoves = buckets[key][color];
          if (!phaseMoves.length) {
            return [color, { accuracy: null, classification: null }];
          }

          const expectedLosses = phaseMoves.map((move) =>
            move.expected_points_loss ?? Math.max(0, (100 - classificationAccuracyScore(move.classification)) / 100)
          );
          const accuracy =
            phaseMoves.length === totalMovesBySide[color]
              ? analysis.summary[color].accuracy
              : accuracyForExpectedLosses(expectedLosses);
          const classification =
            accuracy === null ? null : phaseClassificationFromScore(accuracy, phaseMoves);

          return [color, { accuracy, classification }];
        })
      ),
    ])
  ) as Record<ReviewPhase, Record<ReviewSide, ReviewPhaseMetric>>;
}

function phaseClassificationFromScore(score: number, moves: AnalysisMove[] = []): Classification {
  if (score >= 95) return "brilliant";
  if (score >= 90) return "best";
  if (score >= 85) return "great";
  if (score >= 80) return "excellent";
  if (score >= 75) return "good";
  if (score >= 72) return "inaccuracy";
  if (score >= 60) {
    const mistakeCount = moves.filter((move) => move.classification === "mistake").length;
    const hasSevereError = moves.some(
      (move) => move.classification === "blunder" || move.classification === "miss"
    );
    if (moves.length >= 8 && !hasSevereError && mistakeCount / moves.length <= 0.2) {
      return "inaccuracy";
    }
    return "mistake";
  }
  return "blunder";
}

function numericPlayerRating(value?: string | null) {
  const rating = Number.parseInt(value ?? "", 10);
  return Number.isFinite(rating) && rating > 0 ? rating : null;
}

function expectedAccuracyForRating(rating: number) {
  return Math.max(62, Math.min(82, 65 + rating * 0.005));
}

function estimatedPerformanceRating(analysis: AnalysisResult, color: ReviewSide, counts: Record<ReviewSide, Record<Classification, number>>) {
  const sideMoves = analysis.moves.filter((move) => move.color === color).length;
  if (!sideMoves) return null;

  const playerRating = numericPlayerRating(color === "white" ? analysis.metadata.white_elo : analysis.metadata.black_elo) ?? 1200;
  const accuracy = analysis.summary[color].accuracy;
  const expectedAccuracy = expectedAccuracyForRating(playerRating);
  const qualityAdjustment =
    ((counts[color].brilliant || 0) * 35 +
      (counts[color].great || 0) * 15 +
      (counts[color].book || 0) * 6 +
      (counts[color].best || 0) * 6 +
      (counts[color].excellent || 0) * 2 -
      (counts[color].inaccuracy || 0) * 18 -
      (counts[color].mistake || 0) * 35 -
      (counts[color].miss || 0) * 45 -
      (counts[color].blunder || 0) * 60) /
    sideMoves;
  const classificationAdjustment = Math.max(-300, Math.min(300, qualityAdjustment * 12));
  const rawRating = playerRating + (accuracy - expectedAccuracy) * 31 + classificationAdjustment;
  return Math.max(100, Math.min(3200, Math.round(rawRating / 50) * 50));
}

function PhaseGradeBadge({
  metric,
  phaseLabel,
}: {
  metric: ReviewPhaseMetric;
  phaseLabel: string;
}) {
  if (metric.accuracy === null || metric.classification === null) {
    return <span className="text-center text-sm font-bold text-stone-500">-</span>;
  }

  const tooltip = `${phaseLabel} accuracy: ${metric.accuracy}%`;

  return (
    <div className="group relative flex items-center justify-center" title={tooltip}>
      <ClassificationBadge classification={metric.classification} className="h-5 w-5" />
      <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-[#0b141b] px-2 py-1 text-[11px] font-bold text-white shadow-xl group-hover:block">
        {tooltip}
      </div>
    </div>
  );
}

function ReviewSummaryTable({ analysis, currentOpening }: { analysis: AnalysisResult; currentOpening: string }) {
  const counts = useMemo(() => reviewClassificationCounts(analysis), [analysis]);
  const phaseScores = useMemo(() => reviewPhaseScores(analysis), [analysis]);
  const whitePerformanceRating = useMemo(() => estimatedPerformanceRating(analysis, "white", counts), [analysis, counts]);
  const blackPerformanceRating = useMemo(() => estimatedPerformanceRating(analysis, "black", counts), [analysis, counts]);
  const whiteName = displayPlayerName(analysis.metadata.white, "White");
  const blackName = displayPlayerName(analysis.metadata.black, "Black");
  const whiteRating = analysis.metadata.white_elo ?? "";
  const blackRating = analysis.metadata.black_elo ?? "";
  const resultLabel = analysis.metadata.result === "1/2-1/2" ? "Draw" : analysis.metadata.result || "*";

  return (
    <div className="space-y-3 rounded-md border border-white/10 bg-[#142531] p-3 text-stone-100 shadow-lg shadow-black/20">
      <div className="grid grid-cols-[72px_minmax(0,1fr)] items-end gap-2 text-sm">
        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-stone-500">Players</div>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_34px_minmax(0,1fr)] items-end gap-2">
          <div className="min-w-0 text-center">
            <div className="truncate font-bold text-white" title={whiteName}>{whiteName}</div>
            {whiteRating ? <div className="text-[11px] font-semibold text-stone-400">{whiteRating}</div> : null}
          </div>
          <div />
          <div className="min-w-0 text-center">
            <div className="truncate font-bold text-white" title={blackName}>{blackName}</div>
            {blackRating ? <div className="text-[11px] font-semibold text-stone-400">{blackRating}</div> : null}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-stone-500">Accuracy</div>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_34px_minmax(0,1fr)] items-center gap-2">
          <div className="rounded-md bg-white px-2 py-1 text-center text-sm font-black text-stone-950">{analysis.summary.white.accuracy}</div>
          <div />
          <div className="rounded-md bg-white/10 px-2 py-1 text-center text-sm font-black text-white">{analysis.summary.black.accuracy}</div>
        </div>
      </div>

      <div className="h-px bg-white/10" />

      <div className="space-y-2">
        {REVIEW_SUMMARY_CLASSIFICATIONS.map((classification) => (
          <div key={classification} className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2 text-sm">
            <div className="truncate font-semibold text-stone-200 capitalize">{reviewSummaryClassificationLabel(classification)}</div>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_40px_minmax(0,1fr)] items-center gap-2">
              <div className={`text-center text-lg font-black ${classificationTextColor(classification)}`}>{counts.white[classification] || 0}</div>
              <div className="flex justify-center">
                <ClassificationBadge classification={classification} className="h-7 w-7" />
              </div>
              <div className={`text-center text-lg font-black ${classificationTextColor(classification)}`}>{counts.black[classification] || 0}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="h-px bg-white/10" />

      <div className="space-y-2">
        <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2 text-sm">
          <div className="font-bold text-stone-400">Game Rating</div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_34px_minmax(0,1fr)] items-center gap-2">
            <div className="rounded-md bg-white px-2 py-1 text-center text-sm font-black text-stone-950">
              {whitePerformanceRating ?? "-"}
            </div>
            <div />
            <div className="rounded-md bg-white/10 px-2 py-1 text-center text-sm font-black text-white">
              {blackPerformanceRating ?? "-"}
            </div>
          </div>
        </div>

        {REVIEW_PHASES.map(({ key, label }) => (
          <div key={key} className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2 text-sm">
            <div className="font-bold text-stone-400">{label}</div>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_34px_minmax(0,1fr)] items-center gap-2">
              <PhaseGradeBadge metric={phaseScores[key].white} phaseLabel={label} />
              <div />
              <PhaseGradeBadge metric={phaseScores[key].black} phaseLabel={label} />
            </div>
          </div>
        ))}
      </div>

      <div className="h-px bg-white/10" />

      <div className="grid gap-2 text-sm">
        <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
          <span className="font-bold text-stone-400">Result</span>
          <span className="truncate text-right font-semibold text-white">{resultLabel}</span>
        </div>
        <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
          <span className="font-bold text-stone-400">Opening</span>
          <span className="truncate text-right font-semibold text-sky-100" title={currentOpening}>{currentOpening || cleanOpeningLabel(analysis.metadata.opening)}</span>
        </div>
      </div>
    </div>
  );
}

type BoardPlayer = {
  active: boolean;
  captures: CapturedPiece[];
  color: "white" | "black";
  name: string;
  rating?: string | null;
};

function BoardStage({
  bottomPlayer = { active: false, captures: [], color: "white", name: "White" },
  topPlayer = { active: false, captures: [], color: "black", name: "Black" },
  children,
  dragHoverSquare,
  edgeToEdge = false,
  horizontalEvalBar,
  onFlipBoard,
  boardOrientation = "white",
}: {
  bottomPlayer: BoardPlayer;
  topPlayer: BoardPlayer;
  children: ReactNode;
  dragHoverSquare?: string | null;
  edgeToEdge?: boolean;
  horizontalEvalBar?: ReactNode;
  onFlipBoard?: () => void;
  boardOrientation?: "white" | "black";
}) {
  // Swap players when board is flipped (black at bottom)
  const shouldSwap = boardOrientation === "black";
  const actualTopPlayer = shouldSwap ? bottomPlayer : topPlayer;
  const actualBottomPlayer = shouldSwap ? topPlayer : bottomPlayer;
  const boardAreaRef = useRef<HTMLDivElement | null>(null);
  const evalRowRef = useRef<HTMLDivElement | null>(null);
  const topRowRef = useRef<HTMLDivElement | null>(null);
  const bottomRowRef = useRef<HTMLDivElement | null>(null);
  const [boardAreaMetrics, setBoardAreaMetrics] = useState({ width: 0, height: 0, evalRowHeight: 0, topRowHeight: 0, bottomRowHeight: 0 });
  
  const topMaterialLead = captureMaterialTotal(actualTopPlayer.captures) - captureMaterialTotal(actualBottomPlayer.captures);
  const bottomMaterialLead = captureMaterialTotal(actualBottomPlayer.captures) - captureMaterialTotal(actualTopPlayer.captures);
  const boardGap = edgeToEdge ? 8 : 12;
  const verticalEvalVisible = Boolean(horizontalEvalBar) && boardAreaMetrics.evalRowHeight === 0;
  const verticalEvalWidth = verticalEvalVisible ? 48 : 0;
  const verticalEvalGap = verticalEvalVisible ? 12 : 0;
  const boardAvailableWidth = Math.max(0, boardAreaMetrics.width - verticalEvalWidth - verticalEvalGap);
  const boardAvailableHeight = Math.max(
    0,
    boardAreaMetrics.height - boardAreaMetrics.evalRowHeight - boardAreaMetrics.topRowHeight - boardAreaMetrics.bottomRowHeight - boardGap
  );
  const boardSize = Math.max(0, Math.floor(Math.min(boardAvailableWidth, boardAvailableHeight)));
  const boardMeasured = boardSize > 0;
  const fallbackBoardWidth = verticalEvalVisible ? "min(100%, 680px)" : "min(100%, 620px)";
  const fallbackBoardOnlyWidth = "min(100%, 620px)";
  const boardSizedRowStyle: CSSProperties = {
    width: boardMeasured ? `${boardSize}px` : fallbackBoardOnlyWidth,
  };
  const boardClusterStyle: CSSProperties = {
    width: boardMeasured ? `${boardSize + verticalEvalWidth + verticalEvalGap}px` : fallbackBoardWidth,
    visibility: boardMeasured ? "visible" : "hidden",
  };
  const boardAlignedRowStyle: CSSProperties = {
    ...boardSizedRowStyle,
    marginLeft: verticalEvalVisible ? `${verticalEvalWidth + verticalEvalGap}px` : 0,
  };

  useLayoutEffect(() => {
    const elements = [boardAreaRef.current, evalRowRef.current, topRowRef.current, bottomRowRef.current].filter(Boolean) as HTMLElement[];
    if (!elements.length) return;

    const updateSize = () => {
      const areaRect = boardAreaRef.current?.getBoundingClientRect();
      const evalRect = evalRowRef.current?.getBoundingClientRect();
      const topRect = topRowRef.current?.getBoundingClientRect();
      const bottomRect = bottomRowRef.current?.getBoundingClientRect();
      setBoardAreaMetrics((current) => {
        const next = {
          width: Math.floor(areaRect?.width ?? 0),
          height: Math.floor(areaRect?.height ?? 0),
          evalRowHeight: Math.ceil(evalRect?.height ?? 0),
          topRowHeight: Math.ceil(topRect?.height ?? 0),
          bottomRowHeight: Math.ceil(bottomRect?.height ?? 0),
        };
        if (
          current.width === next.width &&
          current.height === next.height &&
          current.evalRowHeight === next.evalRowHeight &&
          current.topRowHeight === next.topRowHeight &&
          current.bottomRowHeight === next.bottomRowHeight
        ) {
          return current;
        }
        return next;
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  const stageClassName = edgeToEdge
    ? "flex h-full min-h-0 w-full items-center justify-center overflow-visible rounded-none border-0 bg-transparent p-0 shadow-none"
    : "flex h-full min-h-0 w-full items-center justify-center overflow-hidden rounded-md border border-white/10 bg-[#243b4a]/70 p-2 shadow-2xl shadow-black/20 sm:p-3";
  const innerClassName = edgeToEdge
    ? "board-edge-inner flex h-full min-w-0 flex-col items-center justify-center gap-1"
    : "flex h-full w-full max-w-[880px] min-w-0 flex-col justify-center gap-1.5";

  return (
    <div className={stageClassName}>
      <div ref={boardAreaRef} className={innerClassName}>
        <div ref={evalRowRef} className="board-stage-horizontal-eval w-full min-w-0">
          <div
            className="mx-auto"
            style={{
              width: boardMeasured ? `${boardSize}px` : fallbackBoardOnlyWidth,
              visibility: boardMeasured ? "visible" : "hidden",
            }}
          >
            {horizontalEvalBar}
          </div>
        </div>
        <div ref={topRowRef} className="mx-auto min-w-0" style={boardClusterStyle}>
          <div className="flex min-w-0 items-center justify-between gap-2" style={boardAlignedRowStyle}>
            <BoardPlayerStrip materialLead={topMaterialLead} player={actualTopPlayer} />
            {onFlipBoard && (
              <button
                onClick={onFlipBoard}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/10 transition hover:bg-white/20"
                title="Flip board"
              >
                <RefreshCw size={16} className="text-stone-300" />
              </button>
            )}
          </div>
        </div>
        <div className="mx-auto flex min-w-0 items-center overflow-visible" style={boardClusterStyle}>
          {horizontalEvalBar ? (
            <div
              className="board-stage-vertical-eval"
              style={{
                height: boardMeasured ? `${boardSize}px` : fallbackBoardOnlyWidth,
              }}
            >
              {horizontalEvalBar}
            </div>
          ) : null}
          <div
            className="aspect-square max-h-full max-w-full shrink-0"
            style={{
              width: boardMeasured ? `${boardSize}px` : fallbackBoardOnlyWidth,
              height: boardMeasured ? `${boardSize}px` : fallbackBoardOnlyWidth,
            }}
          >
            {children}
          </div>
        </div>
        <div ref={bottomRowRef} className={edgeToEdge ? "mx-auto min-w-0 pt-2" : "mx-auto min-w-0"} style={boardClusterStyle}>
          <div style={boardAlignedRowStyle}>
            <BoardPlayerStrip materialLead={bottomMaterialLead} player={actualBottomPlayer} />
          </div>
        </div>
      </div>
    </div>
  );
}

function BoardPlayerStrip({
  materialLead,
  player,
}: {
  materialLead: number;
  player: BoardPlayer;
}) {
  const leadLabel = materialLead > 0 ? `+${Number.isInteger(materialLead) ? materialLead.toFixed(0) : materialLead.toFixed(1)}` : null;
  const captureGroups = groupedCapturedPieces(player.captures);

  return (
    <div className="min-h-[30px] min-w-0 flex-1 px-0.5 text-left sm:min-h-[32px]">
      <div className="grid min-w-0 grid-cols-1 gap-0.5 sm:grid-cols-[minmax(120px,auto)_minmax(0,1fr)] sm:items-center sm:gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              player.active
                ? "bg-sky-300 shadow-[0_0_10px_rgba(125,211,252,0.95)]"
                : player.color === "white"
                  ? "bg-stone-200/70"
                  : "bg-stone-900 ring-1 ring-white/20"
            }`}
          />
          <span className={`truncate text-sm font-bold leading-none ${player.active ? "text-white" : "text-stone-300"}`}>
            {player.name}
          </span>
          {player.rating ? (
            <span className="shrink-0 text-[12px] font-semibold leading-none text-stone-400">{player.rating}</span>
          ) : null}
        </div>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 text-[13px] leading-none text-stone-300 sm:gap-1.5 sm:text-[15px]">
          <div className="flex min-w-0 flex-nowrap items-center gap-x-1 overflow-hidden sm:gap-x-1.5">
            {captureGroups.length ? (
              captureGroups.map((pieces) => (
                <CapturedPieceStack key={`${player.color}-${pieces[0]?.color}-${pieces[0]?.type}`} pieces={pieces} />
              ))
            ) : (
              <span className="text-[10px] text-stone-500"> </span>
            )}
          </div>
          {leadLabel ? <span className="shrink-0 text-xs font-semibold text-stone-400">{leadLabel}</span> : null}
        </div>
      </div>
    </div>
  );
}

function CapturedPieceStack({ pieces }: { pieces: CapturedPiece[] }) {
  return (
    <span className="captured-piece-stack inline-flex shrink-0 items-center" title={`${pieces.length} ${pieces[0]?.color ?? ""} ${pieces[0]?.type ?? ""}`.trim()}>
      {pieces.map((piece, index) => (
        <span
          key={`${piece.color}-${piece.type}-${index}`}
          className="captured-piece-stack-item inline-flex shrink-0"
          style={{
            marginLeft: index === 0 ? 0 : "-0.58rem",
            zIndex: index + 1,
          }}
        >
          <CapturedPieceIcon piece={piece} />
        </span>
      ))}
    </span>
  );
}

function CapturedPieceIcon({ piece }: { piece: CapturedPiece }) {
  return (
    <img
      src={capturedPieceAsset(piece)}
      alt=""
      className="captured-piece-icon h-5 w-5 shrink-0 sm:h-6 sm:w-6"
      title={`${piece.color} ${piece.type}`}
      aria-hidden="true"
    />
  );
}

function CaptureAnimationOverlay({ capture, boardOrientation = "white" }: { capture: { square: string; piece: CapturedPiece } | null; boardOrientation?: "white" | "black" }) {
  if (!capture) return null;

  const pos = squareToPos(capture.square, boardOrientation);

  // Map to chessground piece classes
  const roleClass = capture.piece.type; // pawn, knight, bishop, rook, queen, king
  const colorClass = capture.piece.color; // white, black

  return (
    <div
      className="pointer-events-none absolute top-0 left-0 z-10"
      style={{
        width: "12.5%",
        height: "12.5%",
        transform: `translate(${pos.col * 100}%, ${pos.row * 100}%)`,
      }}
    >
      {/* Chessground-style piece that shrinks */}
      <div
        className={`piece ${roleClass} ${colorClass}`}
        style={{
          width: "100%",
          height: "100%",
          backgroundSize: "cover",
          animation: `captureShrink 200ms ease-out forwards`,
        }}
      />
    </div>
  );
}

function CompactEngineLines({
  lines,
  positionStatus,
  sourceLabel,
}: {
  lines: EngineLine[];
  positionStatus: string;
  sourceLabel: string;
}) {
  const topLines = lines.slice(0, 3);

  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden border-t border-white/10 pt-1.5">
      <div className="mb-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">
        <span className="min-w-0 truncate">Top Moves · {positionStatus}</span>
        <span className="shrink-0 whitespace-nowrap">{sourceLabel}</span>
      </div>

      {topLines.length ? (
        <div className="min-h-0 space-y-0.5 overflow-hidden">
          {topLines.map((line) => (
            <div
              key={`${line.rank}-${line.move ?? "none"}`}
              className={`grid h-6 grid-cols-[44px_minmax(0,1fr)] items-center gap-1.5 rounded-sm px-1 ${
                line.rank === 1
                  ? "bg-emerald-400/12"
                  : "bg-black/12"
              }`}
            >
              <span className={`inline-flex h-5 w-full shrink-0 items-center justify-center rounded-sm text-[12px] font-bold ${
                line.rank === 1
                  ? "bg-emerald-300/80 text-emerald-950"
                  : "bg-white/10 text-stone-200"
              }`}>
                {line.eval.display}
              </span>
              <span className="min-w-0 truncate font-mono text-[12px] text-stone-300">
                {line.line.slice(0, 5).join(" ") || line.move_san || line.move || "-"}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1 rounded-sm bg-black/12 px-1.5 py-1 text-[11px] text-stone-500">
          No engine suggestions stored for this position.
        </div>
      )}
    </div>
  );
}

function MoveList({
  activePly,
  onSelect,
  rows,
  timeline,
  variation,
}: {
  activePly: number;
  onSelect: (ply: number) => void;
  rows: { moveNumber: number; white?: AnalysisMove; black?: AnalysisMove }[];
  timeline?: ReactNode;
  variation?: MoveListVariation | null;
}) {
  const finalMoveNumber = rows[rows.length - 1]?.moveNumber ?? 0;

  return (
    <section className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-white/10 bg-[#142531]">
      {timeline ? <div className="border-b border-white/10 px-3 py-2">{timeline}</div> : null}
      <div className="grid grid-cols-[26px_minmax(0,1fr)_minmax(0,1fr)] gap-x-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">
        <div />
        <div>White</div>
        <div>Black</div>
      </div>
      <div className="move-scroll min-h-0 flex-1 overflow-y-auto p-3 pr-2">
        <div className="grid grid-cols-[26px_minmax(0,1fr)_minmax(0,1fr)] gap-x-1.5 gap-y-0.5 text-[12px]">
          {rows.map((row) => (
            <div key={row.moveNumber} className="contents">
              {variation && row.moveNumber === variation.insertBeforeMoveNumber ? (
                <VariationBlock variation={variation} />
              ) : null}
              <div className="flex h-6 items-center justify-center text-[10px] font-semibold text-stone-500">{row.moveNumber}.</div>
              <MoveButton move={row.white} activePly={activePly} onSelect={onSelect} />
              <MoveButton move={row.black} activePly={activePly} onSelect={onSelect} />
            </div>
          ))}
          {variation && variation.insertBeforeMoveNumber > finalMoveNumber ? <VariationBlock variation={variation} /> : null}
        </div>
      </div>
    </section>
  );
}

function VariationBlock({ variation }: { variation: MoveListVariation }) {
  return (
    <div className="col-span-3 mb-1 ml-5 rounded-sm border-l border-sky-200/35 bg-sky-300/[0.04] pl-2">
      <div className="grid grid-cols-[26px_minmax(0,1fr)_minmax(0,1fr)] gap-x-1.5 gap-y-0.5 py-1 text-[14px]">
        {variation.rows.map((row) => (
          <div key={`variation-${row.moveNumber}`} className="contents">
            <div className="flex h-5 items-center justify-center text-[10px] font-semibold text-sky-100/55">
              {row.moveNumber}.
            </div>
            <VariationMoveButton move={row.white} activePly={variation.activePly} />
            <VariationMoveButton move={row.black} activePly={variation.activePly} />
          </div>
        ))}
      </div>
    </div>
  );
}

function MoveButton({
  move,
  activePly,
  onSelect,
}: {
  move?: AnalysisMove;
  activePly: number;
  onSelect: (ply: number) => void;
}) {
  if (!move) {
    return <div className="h-6 rounded-sm" />;
  }

  const isActive = activePly === move.ply;
  const glyph = pieceGlyphFromSan(move.san, move.color);
  const moveText = glyph ? move.san.slice(1) : move.san;

  return (
    <button
      onClick={() => onSelect(move.ply)}
      className={`flex h-7 items-center justify-between gap-1 rounded-sm px-2 text-left text-[14px] transition ${
        isActive
          ? "bg-sky-300/14 text-white shadow-[inset_0_-1px_0_rgba(125,211,252,0.95)]"
          : "text-stone-300 hover:bg-white/[0.06] hover:text-white"
      }`}
    >
      <span className="inline-flex min-w-0 items-center gap-1 truncate font-semibold">
        {glyph ? <span className="text-[14px] leading-none opacity-90">{glyph}</span> : null}
        <span className="truncate">{moveText}</span>
      </span>
      <ClassificationBadge classification={move.classification} className="h-5 w-5" />
    </button>
  );
}

function VariationMoveButton({
  move,
  activePly,
}: {
  move?: VariationMove;
  activePly: number;
}) {
  if (!move) {
    return <div className="h-5 rounded-sm" />;
  }

  const glyph = pieceGlyphFromSan(move.san, move.color);
  const moveText = glyph ? move.san.slice(1) : move.san;
  const isActive = activePly === move.ply;

  return (
    <div
      className={`flex h-5 items-center gap-1 rounded-sm px-2 text-[10px] font-semibold ${
        isActive ? "bg-sky-300/14 text-white" : "text-sky-50/80"
      }`}
    >
      {glyph ? <span className="text-[12px] leading-none opacity-90">{glyph}</span> : null}
      <span className="truncate">{moveText}</span>
    </div>
  );
}

// Live analysis panel - matches ReviewPanel structure exactly
function LiveAnalysisPanel({
  analysis,
  branchOriginPly,
  playtestBranchOriginCursor,
  branchMoveClassification,
  branchMoveAnalysis,
  branchVariation,
  evalData,
  game,
  isLoading,
  lastMove,
  liveCursor,
  liveError,
  liveHistory,
  reviewRows,
  rows,
  hasMoves,
  onMainlineSelect,
  onUndo,
  onRedo,
  onReturnToReview,
  savedGames,
  onBackToList,
  onLoadSaved,
  onSetPanelTab,
  playtestAnalysis,
  onTogglePlaytestAnalysis,
  onExitPlaytestAnalysis,
  playtestMoveClassifications,
  currentOpening,
}: {
  analysis: AnalysisResult | null;
  branchOriginPly: number | null;
  playtestBranchOriginCursor: number | null;
  branchMoveClassification: Classification | null;
  branchMoveAnalysis: AnalysisMove | null;
  branchVariation: MoveListVariation | null;
  evalData: LivePositionEval | null;
  game: Chess;
  isLoading: boolean;
  lastMove?: { san: string } | null;
  liveCursor: number;
  liveError: string | null;
  liveHistory: LiveSnapshot[];
  reviewRows: { moveNumber: number; white?: AnalysisMove; black?: AnalysisMove }[];
  rows: { moveNumber: number; white?: AnalysisMove | string; black?: AnalysisMove | string }[];
  hasMoves: boolean;
  onMainlineSelect: (ply: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onReturnToReview: () => void;
  savedGames: SavedGame[];
  onBackToList: () => void;
  onLoadSaved: (game: SavedGame, source?: GameSource) => void;
  onSetPanelTab: (tab: PanelTab) => void;
  playtestAnalysis: boolean;
  onTogglePlaytestAnalysis: () => void;
  onExitPlaytestAnalysis: () => void;
  playtestMoveClassifications: Record<number, Classification | null>;
  currentOpening?: string;
}) {

  const isBranchMode = branchOriginPly !== null;
  const isPlaytestBranch = playtestBranchOriginCursor !== null;
  const branchEngineLines = branchMoveAnalysis?.engine_lines ?? evalData?.engine_lines ?? [];
  const branchEngineSource = branchMoveAnalysis ? "Branch review" : evalData?.source === "stockfish" ? `Depth ${evalData.engine_depth}` : "Fallback";
  const branchMoveSan = isBranchMode ? branchMoveAnalysis?.san ?? game.history({ verbose: true }).at(-1)?.san : null;
  const visiblePly = liveCursor > 0 ? liveCursor : rows.reduce((count, row) => count + (row.white ? 1 : 0) + (row.black ? 1 : 0), 0);
  const currentMove = rows
    .flatMap((row) => [row.white, row.black])
    .filter(Boolean)[visiblePly - 1];
  const currentMoveSan = isBranchMode ? branchMoveSan : typeof currentMove === "string" ? currentMove : currentMove?.san;
  const currentMoveClassification =
    isBranchMode
      ? branchMoveAnalysis?.classification ?? branchMoveClassification
      : (typeof currentMove === "string" ? null : currentMove?.classification) ??
        playtestMoveClassifications[visiblePly - 1] ??
        branchMoveClassification;
  const showAnalysisCard = playtestAnalysis || isBranchMode;
  const labelMove = currentMoveSan || lastMove?.san;
  const activeLabel = isPlaytestBranch
    ? `Branch from move ${playtestBranchOriginCursor}`
    : labelMove && currentMoveClassification
    ? `${labelMove} is ${/^[aeiou]/.test(classificationLabel(currentMoveClassification)) ? "an" : "a"} ${classificationLabel(currentMoveClassification)}`
    : labelMove && playtestAnalysis
      ? `Analyzing ${labelMove}`
    : isBranchMode
      ? `Branch from move ${branchOriginPly}`
      : hasMoves
        ? "Analysis position"
        : "Starting position";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header - Same as ReviewPanel */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {analysis && !playtestAnalysis && (
            <button
              onClick={onBackToList}
              title="Back to Old Games"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#101214] text-white transition hover:bg-white/10"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          <h2 className="text-xl font-semibold text-white">Game Review</h2>
        </div>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className={`shrink-0 overflow-hidden transition-[height,opacity,margin-bottom] duration-200 ease-out ${
            showAnalysisCard ? "mb-3 h-[192px] opacity-100" : "mb-0 h-0 opacity-0"
          }`}
        >
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-white/10 bg-[#142531] p-2.5 text-stone-100 shadow-lg shadow-black/20">
            {isLoading && !evalData && hasMoves ? (
              <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-300/30 border-t-sky-300" />
                <span className="text-xs text-stone-400">Analyzing position...</span>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <div className="flex min-w-0 items-center gap-2">
                  {labelMove && currentMoveClassification ? (
                    <ClassificationBadge classification={currentMoveClassification} className="h-8 w-8" />
                  ) : (
                    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border px-1 text-[12px] font-black border-white/10 bg-white/[0.06] text-stone-200">
                      <Sparkles size={11} />
                    </span>
                  )}
                  <span className="min-w-0 truncate text-sm font-semibold" title={activeLabel}>{activeLabel}</span>
                </div>
                {currentOpening ? <OpeningNameRow opening={currentOpening} /> : null}
                <CompactEngineLines
                  lines={isBranchMode ? branchEngineLines : evalData?.engine_lines ?? []}
                  positionStatus={gameStatus(game)}
                  sourceLabel={isBranchMode ? branchEngineSource : evalData?.source === "stockfish" ? `Depth ${evalData.engine_depth}` : "Fallback"}
                />
              </div>
            )}
          </div>
        </div>

        {liveError ? (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-red-300/20 bg-red-500/10 p-3 text-sm text-red-100">
            <AlertCircle className="mt-0.5 shrink-0" size={16} />
            <span>{liveError}</span>
          </div>
        ) : null}

        {/* Move list below - always shown */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {isBranchMode ? (
            <MoveList
              activePly={branchOriginPly}
              rows={reviewRows}
              onSelect={onMainlineSelect}
              variation={branchVariation}
            />
          ) : playtestAnalysis ? (
            <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
              <LiveMoveList hasMoves={hasMoves} rows={rows} moveClassifications={playtestMoveClassifications} />
            </div>
          ) : (
            <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
              <LiveMoveList hasMoves={hasMoves} rows={rows} />
            </div>
          )}
        </div>

        <div className="mt-3 grid grid-cols-4 gap-2">
          <button
            onClick={onUndo}
            disabled={liveCursor <= 0}
            className="inline-flex h-11 items-center justify-center rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
            aria-label="First move"
          >
            <ChevronLeft size={18} />
            <ChevronLeft className="-ml-3" size={18} />
          </button>
          <button
            onClick={onUndo}
            disabled={liveCursor <= 0}
            className="inline-flex h-11 items-center justify-center rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
            aria-label="Previous move"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            onClick={onRedo}
            disabled={liveCursor >= liveHistory.length - 1}
            className="inline-flex h-11 items-center justify-center rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
            aria-label="Next move"
          >
            <ChevronRight size={20} />
          </button>
          <button
            onClick={onRedo}
            disabled={liveCursor >= liveHistory.length - 1}
            className="inline-flex h-11 items-center justify-center rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
            aria-label="Last move"
          >
            <ChevronRight size={18} />
            <ChevronRight className="-ml-3" size={18} />
          </button>
        </div>
        <div className="mt-3">
          {isBranchMode ? (
            <ReturnToMainlineButton onClick={onReturnToReview} />
          ) : playtestAnalysis ? (
            <ReturnToPlaytestButton onClick={onExitPlaytestAnalysis} />
          ) : (
            <EnterAnalysisButton disabled={!hasMoves || isLoading} onClick={onTogglePlaytestAnalysis} />
          )}
        </div>
      </div>
    </div>
  );
}

function EnterAnalysisButton({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-sky-200/25 bg-sky-300/10 px-4 text-sm font-bold text-sky-100 transition hover:bg-sky-300/15 disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Sparkles size={17} />
      Enter Analysis
    </button>
  );
}
