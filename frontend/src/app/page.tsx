"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
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
  FileText,
  FolderOpen,
  GitBranch,
  History,
  Layers,
  List,
  Loader2,
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
import type { AnalysisMove, AnalysisResult, Classification, EngineLine, EvalScore, LivePositionEval } from "@/lib/types";

// Chessground-based board (no dynamic import needed)

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const RECENT_GAMES_KEY = "chess-review:recent-games";
const USER_NAME_KEY = "chess-review:user-name";

// Board colors (used by ChessgroundBoard defaults and arrow overlay)

// Convert centipawns to winning probability (sigmoid function)
function centipawnsToWinningProbability(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
}

// Classify a move based on winning probability delta
function classifyFromWinningProbabilityDelta(beforeProb: number, afterProb: number, bestMoveProb: number | null): Classification {
  const delta = Math.abs(beforeProb - afterProb);
  const bestDelta = bestMoveProb !== null ? Math.abs(beforeProb - bestMoveProb) : 0;
  
  // If the move was significantly better than the best move (within tolerance)
  if (bestDelta < 2 && delta < 5) {
    return "best";
  }
  
  // If the move was excellent (very close to best)
  if (bestDelta < 5 && delta < 10) {
    return "excellent";
  }
  
  // Classification based on winning probability loss
  if (delta >= 20) {
    return "blunder";
  }
  if (delta >= 15) {
    return "mistake";
  }
  if (delta >= 10) {
    return "inaccuracy";
  }
  if (delta >= 5) {
    return "miss";
  }
  if (delta < 2) {
    return "best";
  }
  
  return "good";
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
  if (evalScore.mate !== null) return evalScore.cp >= 0 ? 1 : -1;
  const clamped = Math.max(-700, Math.min(700, evalScore.cp));
  return clamped / 700;
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

type PanelTab = "analysis" | "graph" | "history" | "upload";
type ReviewPanelTab = "review" | "graph" | "history";
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
  gameDate: string;
  result: string;
  moveCount: number;
  finalFen: string;
  whiteAccuracy?: number;
  blackAccuracy?: number;
};

type LiveSnapshot = {
  pgn: string;
  fen: string;
  lastMoveUci?: string;
};

function loadRecentGames() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_GAMES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];

    // Migrate old saved games to new format
    return (parsed as any[]).map((game) => {
      let subtitle = game.subtitle;
      // Fix ECO codes in subtitle using explicit ECO matching
      if (subtitle && subtitle.match(/^[A-Za-z]\d+$/)) {
        const ecoCode = subtitle.toUpperCase();
        const ecoMatches = OPENINGS.filter((o) => o.eco === ecoCode);
        if (ecoMatches.length > 0) {
          // Prefer the longest move-sequence match
          const longestMatch = ecoMatches.reduce((prev, current) =>
            current.moves.length > prev.moves.length ? current : prev
          );
          subtitle = longestMatch.name;
        } else {
          subtitle = `ECO ${subtitle}`;
        }
      }

      if (game.result && typeof game.moveCount === 'number' && game.finalFen) {
        return { ...game, subtitle, gameDate: game.gameDate || "" } as SavedGame;
      }
      // Migrate old format or fix invalid data
      const tempGame = new Chess();
      tempGame.loadPgn(game.pgn);
      const finalFen = tempGame.fen();
      const moveCount = tempGame.history().length;
      let gameResult = "*";
      if (finalFen.includes(" 1-0")) gameResult = "1-0";
      else if (finalFen.includes(" 0-1")) gameResult = "0-1";
      else if (finalFen.includes(" 1/2-1/2")) gameResult = "1/2-1/2";
      return {
        id: game.id,
        title: game.title,
        subtitle,
        pgn: game.pgn,
        updatedAt: game.updatedAt,
        gameDate: (game as any).gameDate || "",
        result: gameResult,
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

function recentGameFromAnalysis(pgn: string, result: AnalysisResult): SavedGame {
  const white = result.metadata.white || "White";
  const black = result.metadata.black || "Black";
  let opening = result.metadata.opening && result.metadata.opening !== "Unknown" ? result.metadata.opening : "PGN review";
  // If opening is just an ECO code (like "A40", "A45", "a40", "a45"), try to find the full name
  if (opening.match(/^[A-Za-z]\d+$/)) {
    const ecoCode = opening.toUpperCase();
    const ecoMatches = OPENINGS.filter((o) => o.eco === ecoCode);
    if (ecoMatches.length > 0) {
      // Prefer the longest move-sequence match
      const longestMatch = ecoMatches.reduce((prev, current) =>
        current.moves.length > prev.moves.length ? current : prev
      );
      opening = longestMatch.name;
    } else {
      // If not found in our database, just show the ECO code
      opening = `ECO ${opening}`;
    }
  }
  const game = new Chess();
  game.loadPgn(pgn);
  const finalFen = game.fen();
  const moveCount = game.history().length;

  // Calculate result from FEN
  let gameResult = "*";
  if (finalFen.includes(" 1-0")) gameResult = "1-0";
  else if (finalFen.includes(" 0-1")) gameResult = "0-1";
  else if (finalFen.includes(" 1/2-1/2")) gameResult = "1/2-1/2";

  // Calculate accuracy (average of move classifications)
  const whiteMoves = result.moves.filter((_, i) => i % 2 === 0);
  const blackMoves = result.moves.filter((_, i) => i % 2 === 1);

  const calculateAccuracy = (moves: AnalysisMove[]) => {
    if (moves.length === 0) return null;
    let total = 0;
    let count = 0;
    for (const move of moves) {
      if (move.classification) {
        const score = classificationAccuracyScore(move.classification);
        total += score;
        count++;
      }
    }
    return count > 0 ? Math.round((total / count) * 10) / 10 : null;
  };

  const whiteAccuracy = calculateAccuracy(whiteMoves);
  const blackAccuracy = calculateAccuracy(blackMoves);

  return {
    id: `${Date.now()}`,
    title: `${white} vs ${black}`,
    subtitle: opening,
    pgn,
    updatedAt: Date.now(),
    gameDate: result.metadata.date || "",
    result: gameResult,
    moveCount,
    finalFen,
    whiteAccuracy: whiteAccuracy ?? undefined,
    blackAccuracy: blackAccuracy ?? undefined,
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

function classificationIndicator(classification: Classification) {
  if (classification === "brilliant") return "!!";
  if (classification === "great") return "!";
  if (classification === "best") return "★";
  if (classification === "excellent") return "!";
  if (classification === "good") return "✓";
  if (classification === "book") return "♜";
  if (classification === "miss") return "x";
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
  if (classification === "miss") return "text-stone-950 bg-[var(--move-missed)] border-white/40";
  if (classification === "inaccuracy") return "text-stone-950 bg-[var(--move-inaccuracy)] border-white/35";
  if (classification === "mistake") return "text-white bg-[var(--move-mistake)] border-white/30";
  return "text-white bg-[var(--move-blunder)] border-white/35";
}

function classificationOverlayTone(classification?: Classification | null) {
  if (!classification) return "text-white bg-black/55";
  return `${classificationTone(classification)} shadow-[0_1px_4px_rgba(0,0,0,0.35)]`;
}

function classificationLabel(classification: Classification) {
  if (classification === "best") return "best";
  if (classification === "great") return "great";
  if (classification === "excellent") return "excellent";
  if (classification === "good") return "good";
  if (classification === "miss") return "miss";
  if (classification === "inaccuracy") return "inaccuracy";
  if (classification === "mistake") return "mistake";
  if (classification === "blunder") return "blunder";
  if (classification === "brilliant") return "brilliant";
  return "book";
}

function boardSquareHighlights(
  move?: { uci?: string | null; classification?: Classification | null } | null,
  kind: "best" | "played" = "played"
): Record<string, CSSProperties> {
  if (!move) return {};
  const squares = squareNameFromUci(move.uci ?? undefined);
  if (!squares) return {};
  const [fromSquare, toSquare] = squares;

  // If no classification (live mode), use sky blue for both squares
  if (!move.classification) {
    const skyBlue = "rgba(125, 211, 252, 0.55)";
    return {
      [fromSquare]: {
        backgroundColor: skyBlue,
      },
      [toSquare]: {
        backgroundColor: skyBlue,
      },
    };
  }

  // If classification exists (review mode), use classification color
  const playedPalette = move.classification === "blunder"
    ? {
        color: "rgba(234, 88, 12, 0.55)",
      }
    : move.classification === "mistake"
      ? {
          color: "rgba(249, 115, 22, 0.55)",
        }
      : move.classification === "inaccuracy" || move.classification === "miss"
        ? {
            color: "rgba(234, 179, 8, 0.55)",
          }
        : move.classification === "good"
          ? {
              color: "rgba(132, 204, 22, 0.55)",
            }
        : move.classification === "excellent" || move.classification === "best" || move.classification === "brilliant"
          ? {
              color: "rgba(34, 197, 94, 0.55)",
            }
          : move.classification === "great"
            ? {
                color: "rgba(59, 130, 246, 0.55)",
              }
            : {
                color: "rgba(59, 130, 246, 0.55)",
              };
  const color = kind === "best" ? "rgba(34, 197, 94, 0.55)" : playedPalette.color;

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

function squareBadgeText(classification?: Classification | null, kind: "played" | "best" = "played") {
  if (kind === "best") return "*";
  if (!classification) return ".";
  if (classification === "brilliant") return "!!";
  if (classification === "best") return "*";
  if (classification === "great") return "!";
  if (classification === "excellent") return "!!";
  if (classification === "good") return "+";
  if (classification === "book") return "B";
  if (classification === "miss") return "x";
  if (classification === "inaccuracy") return "?!";
  if (classification === "mistake") return "?";
  return "??";
}

function squareBadgeTone(classification?: Classification | null, kind: "played" | "best" = "played") {
  if (kind === "best") return "text-white bg-[#8bc34a]";
  if (!classification) return "text-stone-100 bg-black/55";
  if (classification === "book") return "text-white bg-[#b08d67]";
  if (classification === "brilliant") return "text-white bg-[#1eb8b2]";
  if (classification === "great") return "text-white bg-[#75bf44]";
  if (classification === "best") return "text-white bg-[#8bc34a]";
  if (classification === "excellent") return "text-white bg-[#89b07f]";
  if (classification === "good") return "text-white bg-[#87b36f]";
  if (classification === "miss") return "text-white bg-[#d8b11a]";
  if (classification === "inaccuracy") return "text-white bg-[#e8b132]";
  if (classification === "mistake") return "text-white bg-[#f08a3e]";
  return "text-white bg-[#ea5b4f]";
}

function squareBadgeIcon(classification?: Classification | null, kind: "played" | "best" = "played") {
  if (kind === "best") return "/move-badges/best.png";
  if (!classification) return null;
  if (classification === "brilliant") return "/move-badges/brilliant.png";
  if (classification === "great") return "/move-badges/great.png";
  if (classification === "best") return "/move-badges/best.png";
  if (classification === "excellent") return "/move-badges/excellent.png";
  if (classification === "good") return "/move-badges/good.png";
  if (classification === "book") return "/move-badges/book.png";
  if (classification === "miss") return "/move-badges/miss.png";
  if (classification === "inaccuracy") return "/move-badges/inaccuracy.png";
  if (classification === "mistake") return "/move-badges/mistake.png";
  if (classification === "blunder") return "/move-badges/blunder.png";
  return null;
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
  const [pgn, setPgn] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>("history");
  const [reviewTab, setReviewTab] = useState<ReviewPanelTab>("review");
  const [showUploadInHistory, setShowUploadInHistory] = useState(false);
  const [historyView, setHistoryView] = useState<"list" | "analysis">("list");
  const [savedGames, setSavedGames] = useState<SavedGame[]>(() => {
    const games = loadRecentGames();
    // Sort by gameDate (newest first), fallback to updatedAt if no gameDate
    return games.sort((a, b) => {
      const dateA = a.gameDate || new Date(a.updatedAt).toISOString().split('T')[0];
      const dateB = b.gameDate || new Date(b.updatedAt).toISOString().split('T')[0];
      return dateB.localeCompare(dateA);
    });
  });
  const [liveStartFen, setLiveStartFen] = useState(INITIAL_FEN);
  const [livePgn, setLivePgn] = useState("");
  const [liveFen, setLiveFen] = useState(INITIAL_FEN);
  const [userName, setUserName] = useState("");
  const [boardOrientation, setBoardOrientation] = useState<"white" | "black">("white");
  const [mounted, setMounted] = useState(false);

  // Mark as mounted after hydration to avoid SSR mismatches
  useEffect(() => {
    setMounted(true);
  }, []);

  // Load user name from localStorage on client to avoid hydration mismatch
  useEffect(() => {
    const storedName = localStorage.getItem(USER_NAME_KEY) ?? "";
    setUserName(storedName);
  }, []);

  // Save user name to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(USER_NAME_KEY, userName);
    }
  }, [userName]);

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
  const [liveSeedCaptures, setLiveSeedCaptures] = useState<CaptureSummary>(() => emptyCaptureSummary());
  const [liveEval, setLiveEval] = useState<LivePositionEval | null>(null);
  const [liveLoading, setLiveLoading] = useState(true);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [activePly, setActivePly] = useState(0);
  const [branchOriginPly, setBranchOriginPly] = useState<number | null>(null);
  const [branchMoveUci, setBranchMoveUci] = useState<string | null>(null);
  const [branchMoveClassification, setBranchMoveClassification] = useState<Classification | null>(null);
  const [branchMoveEvalBefore, setBranchMoveEvalBefore] = useState<EvalScore | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [dragHoverSquare, setDragHoverSquare] = useState<string | null>(null);
  const pieceClickRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Calculate branch move classification from eval difference
  useEffect(() => {
    if (!branchMoveEvalBefore || !liveEval || !branchMoveUci) return;

    const beforeProb = centipawnsToWinningProbability(branchMoveEvalBefore.cp);
    const afterProb = centipawnsToWinningProbability(liveEval.eval.cp);
    
    // Get the best move's winning probability
    let bestMoveProb = null;
    if (liveEval.best_move) {
      const bestMoveSquares = squareNameFromUci(liveEval.best_move);
      if (bestMoveSquares) {
        // We'd need to simulate the best move to get its eval, but for now use current eval
        // as an approximation (this isn't perfect but works for the basic case)
        bestMoveProb = afterProb;
      }
    }

    const classification = classifyFromWinningProbabilityDelta(beforeProb, afterProb, bestMoveProb);
    setBranchMoveClassification(classification);
  }, [branchMoveEvalBefore, liveEval, branchMoveUci]);

  const boardFen = activePly === 0 ? analysis?.metadata.initial_fen ?? INITIAL_FEN : analysis?.moves[activePly - 1]?.fen_after ?? INITIAL_FEN;
  const reviewBoard = useMemo(() => new Chess(boardFen), [boardFen]);
  // Compute classifications for moves if missing (API might not always return them)
  const computedAnalysis = useMemo(() => {
    if (!analysis) return null;
    const moves = analysis.moves.map((move, index) => {
      if (move.classification) return move; // Already has classification
      
      // Compute classification from eval change
      const prevEval = index > 0 ? analysis.moves[index - 1].eval_after : { cp: 0, mate: null };
      const currEval = move.eval_after;
      const bestLine = move.engine_lines?.[0];
      
      if (bestLine) {
        const prevProb = centipawnsToWinningProbability(prevEval.cp ?? 0);
        const currProb = centipawnsToWinningProbability(currEval.cp ?? 0);
        const bestProb = centipawnsToWinningProbability(bestLine.eval.cp ?? 0);
        const classification = classifyFromWinningProbabilityDelta(prevProb, currProb, bestProb);
        return { ...move, classification };
      }
      return move;
    });
    return { ...analysis, moves };
  }, [analysis]);
  
  const selectedMove = activePly > 0 ? computedAnalysis?.moves[activePly - 1] ?? null : null;
  const evalScore = currentEval(computedAnalysis, activePly);
  const whitePercent = evalToWhitePercent(evalScore);
  
  const moveRows = useMemo(() => classifyMoveGroups(computedAnalysis?.moves ?? []), [computedAnalysis]);
  const reviewSans = useMemo(() => reviewBoard.history({ verbose: true }).map(m => m.san), [boardFen]);
  const currentOpening = useMemo(() => detectOpening(reviewSans), [reviewSans]);
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
    ? boardSquareHighlights({ uci: branchMoveUci, classification: branchMoveClassification ?? undefined }, "played")
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
    ...(branchOriginPly !== null ? branchPlayedSquares : reviewPlayedSquares), 
    ...interactionSquareStyles 
  };
  // Use liveGame for legal moves when in branch mode
  const { legalMoves: reviewLegalMoves, captureMoves: reviewCaptureMoves } = getLegalMoves(
    branchOriginPly !== null ? liveGame : reviewBoard, 
    selectedSquare
  );
  // Branch arrow: show best move from engine
  const branchArrowSquares = branchOriginPly !== null && liveEval?.engine_lines[0]?.move 
    ? squareNameFromUci(liveEval.engine_lines[0].move)
    : null;
  // Branch annotations: badge for the last branch move
  const branchSquareAnnotations = useMemo(() => {
    if (!branchOriginPly || !branchMoveUci) return {};
    const annotations: Record<string, SquareAnnotation> = {};
    const squares = squareNameFromUci(branchMoveUci);
    if (squares && branchMoveClassification) {
      const [, toSquare] = squares;
      annotations[toSquare] = {
        label: squareBadgeText(branchMoveClassification, "played"),
        tone: squareBadgeTone(branchMoveClassification, "played"),
        iconSrc: squareBadgeIcon(branchMoveClassification, "played") ?? undefined,
      };
    }
    return annotations;
  }, [branchOriginPly, branchMoveUci, branchMoveClassification]);

  useEffect(() => {
    // Run engine analysis in live mode OR when in branch mode (branchOriginPly !== null)
    if (!liveMode && branchOriginPly === null) return;

    const controller = new AbortController();

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
        setActivePly((value) => Math.min(moveCount, value + 1));
        setSelectedSquare(null);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setActivePly((value) => Math.max(0, value - 1));
        setSelectedSquare(null);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [analysis, liveMode]);

  useEffect(() => {
    if (!liveMode && branchOriginPly === null) return;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (tagName === "INPUT" || tagName === "TEXTAREA" || target?.isContentEditable) return;

      if (event.key === "ArrowLeft") {
        if (liveCursor > 0) {
          const snapshot = liveHistory[liveCursor - 1];
          event.preventDefault();
          setLiveCursor(liveCursor - 1);
          setLivePgn(snapshot.pgn);
          setLiveFen(snapshot.fen);
          setLiveLoading(true);
          setLiveError(null);
          setBranchMoveUci(snapshot.lastMoveUci ?? null);
          setBranchMoveClassification(null);
        } else if (branchOriginPly !== null) {
          // At start of branch, go back to main review
          event.preventDefault();
          returnToReview();
        }
      }

      if (event.key === "ArrowRight" && liveCursor < liveHistory.length - 1) {
        const snapshot = liveHistory[liveCursor + 1];
        event.preventDefault();
        setLiveCursor(liveCursor + 1);
        setLivePgn(snapshot.pgn);
        setLiveFen(snapshot.fen);
        setLiveLoading(true);
        setLiveError(null);
        setBranchMoveUci(snapshot.lastMoveUci ?? null);
        setBranchMoveClassification(null);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [liveCursor, liveHistory, liveMode, branchOriginPly]);

  async function submitAnalysis(sourcePgn?: string) {
    const cleanPgn = normalizePgn(sourcePgn ?? pgn);
    if (!cleanPgn) {
      setError("Paste a PGN first.");
      return;
    }

    const preserveCurrentShell = liveMode || !!analysis;
    setIsLoading(true);
    setError(null);
    setActivePly(0);
    setBranchOriginPly(null);
    setBranchMoveUci(null);
    setBranchMoveClassification(null);
    setBranchMoveEvalBefore(null);
    setSelectedSquare(null);
    setPgn(cleanPgn);

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
      setAnalysis(payload);
      setPanelTab("analysis");
      setLiveMode(false);
      setActivePly(payload.moves.length);
      saveRecentGame(cleanPgn, payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Analysis failed.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  function resetLiveBoard() {
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
  }

  function startLiveBoard() {
    setAnalysis(null);
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

  // Analyze the current sandbox board and enter analysis mode
  async function analyzeSandboxBoard() {
    if (!livePgn) {
      setLiveError("Make some moves first.");
      return;
    }
    setIsLoading(true);
    setLiveError(null);
    try {
      const response = await fetch(`${API_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn: livePgn }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.detail ?? "Analysis failed.");
      }
      setAnalysis(payload);
      setLiveMode(false);
      setActivePly(payload.moves.length);
      saveRecentGame(livePgn, payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Analysis failed.";
      setLiveError(message);
    } finally {
      setIsLoading(false);
    }
  }

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
    // Use current liveFen as base (for continuing branch moves), not liveStartFen
    const nextSnapshot = snapshotAfterMove(liveFen, livePgn, sourceSquare, targetSquare);
    if (!nextSnapshot) return false;
    const nextCursor = liveCursor + 1;

    setLiveLoading(true);
    setLiveError(null);
    if (targetSquare) setSelectedSquare(targetSquare);
    setLiveHistory((current) => [...current.slice(0, liveCursor + 1), nextSnapshot]);
    setLiveCursor(nextCursor);
    setLivePgn(nextSnapshot.pgn);
    setLiveFen(nextSnapshot.fen);
    // Set branch move UCI from snapshot (includes the move that was just made)
    setBranchMoveUci(nextSnapshot.lastMoveUci ?? null);
    setBranchMoveClassification(null);
    // Capture eval BEFORE this move (current liveEval) for classification delta
    setBranchMoveEvalBefore(liveEval?.eval ?? { cp: 0, mate: null, display: "0.0" });
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
      // At the start of branch, return to main game review
      returnToReview();
      return;
    }
    const snapshot = liveHistory[liveCursor - 1];
    setLiveLoading(true);
    setLiveError(null);
    setLiveCursor(liveCursor - 1);
    setLivePgn(snapshot.pgn);
    setLiveFen(snapshot.fen);
    // Update branchMoveUci to the current snapshot's lastMoveUci (the move that led to this position)
    setBranchMoveUci(snapshot.lastMoveUci ?? null);
    setBranchMoveClassification(null);
  }

  function redoLiveMove() {
    if (!canRedoLiveMove) return;
    const snapshot = liveHistory[liveCursor + 1];
    setLiveLoading(true);
    setLiveError(null);
    setLiveCursor(liveCursor + 1);
    setLivePgn(snapshot.pgn);
    setLiveFen(snapshot.fen);
    // Update branchMoveUci to the redone move's UCI
    setBranchMoveUci(snapshot.lastMoveUci ?? null);
    setBranchMoveClassification(null);
  }

  function saveRecentGame(cleanPgn: string, result: AnalysisResult) {
    const savedGame = recentGameFromAnalysis(cleanPgn, result);
    setSavedGames((current) => {
      const next = [savedGame, ...current.filter((game) => game.pgn !== cleanPgn)];
      // Sort by gameDate (newest first), fallback to updatedAt if no gameDate
      const sorted = next.sort((a, b) => {
        const dateA = a.gameDate || new Date(a.updatedAt).toISOString().split('T')[0];
        const dateB = b.gameDate || new Date(b.updatedAt).toISOString().split('T')[0];
        return dateB.localeCompare(dateA);
      });
      window.localStorage.setItem(RECENT_GAMES_KEY, JSON.stringify(sorted));
      return sorted;
    });
  }

  function saveDraftGame(cleanPgn: string, title: string, subtitle: string) {
    setSavedGames((current) => {
      const game = new Chess();
      game.loadPgn(cleanPgn);
      const finalFen = game.fen();
      const moveCount = game.history().length;

      let gameResult = "*";
      if (finalFen.includes(" 1-0")) gameResult = "1-0";
      else if (finalFen.includes(" 0-1")) gameResult = "0-1";
      else if (finalFen.includes(" 1/2-1/2")) gameResult = "1/2-1/2";

      const savedGame: SavedGame = {
        id: `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        subtitle,
        pgn: cleanPgn,
        updatedAt: Date.now(),
        gameDate: "",
        result: gameResult,
        moveCount,
        finalFen,
      };
      const next = [savedGame, ...current.filter((game) => game.pgn !== cleanPgn)];
      // Sort by gameDate (newest first), fallback to updatedAt if no gameDate
      const sorted = next.sort((a, b) => {
        const dateA = a.gameDate || new Date(a.updatedAt).toISOString().split('T')[0];
        const dateB = b.gameDate || new Date(b.updatedAt).toISOString().split('T')[0];
        return dateB.localeCompare(dateA);
      });
      window.localStorage.setItem(RECENT_GAMES_KEY, JSON.stringify(sorted));
      return sorted;
    });
  }

  function saveCurrentGame() {
    const cleanPgn = normalizePgn(liveMode ? livePgn : pgn);
    if (!cleanPgn) return;

    if (!liveMode && analysis) {
      saveRecentGame(cleanPgn, analysis);
      return;
    }

    saveDraftGame(cleanPgn, branchOriginPly !== null ? "Branch line" : "Live board", `${openingLabelForDraft()} · draft`);
  }

  function openingLabelForDraft() {
    if (analysis && branchOriginPly !== null) return analysis.metadata.opening || "Analysis branch";
    return liveOpening;
  }

  function loadSavedGame(game: SavedGame) {
    setPgn(game.pgn);
    void submitAnalysis(game.pgn);
  }

  // Load a saved game into the sandbox/LiveBoard without switching to review mode
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
      setHistoryView("analysis"); // Switch to analysis view to see the game
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
    setLiveMode(false);
    setSelectedSquare(null);
    setBranchOriginPly(null);
    setBranchMoveUci(null);
    setBranchMoveClassification(null);
    setBranchMoveEvalBefore(null);
    setPanelTab("analysis");
  }

  function jumpToMainlineReview(ply: number) {
    setActivePly(ply);
    setSelectedSquare(null);
    returnToReview();
  }

  function goToPreviousMove() {
    setActivePly((value) => Math.max(0, value - 1));
    setSelectedSquare(null);
  }

  function goToNextMove() {
    if (!analysis) return;
    setActivePly((value) => Math.min(analysis.moves.length, value + 1));
    setSelectedSquare(null);
  }

  return (
    <main className="min-h-screen px-4 py-3 text-stone-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-[1620px] flex-col gap-3">
        {liveMode || !analysis ? (
          <LiveBoard
            analysis={analysis}
            boardOrientation={boardOrientation}
            branchVariation={branchVariation}
            branchOriginPly={branchOriginPly}
            branchMoveUci={branchMoveUci}
            branchMoveClassification={branchMoveClassification}
            captures={liveCapturedPieces}
            evalData={liveEval}
            game={liveGame}
            isLoading={liveLoading}
            liveCursor={liveCursor}
            liveError={liveError}
            liveHistory={liveHistory}
            canRedo={canRedoLiveMove}
            onAnalyzePgn={() => submitAnalysis()}
            onAnalyzeLive={() => submitAnalysis(livePgn)}
            onBackToList={() => {
                          setPanelTab("history");
                          setHistoryView("list");
                          setAnalysis(null);
                          setActivePly(0);
                          setBranchOriginPly(null);
                          setLiveMode(true);
                          resetLiveBoard();
                        }}
            onDrop={handleBoardDrop}
            onFlipBoard={() => setBoardOrientation(boardOrientation === "white" ? "black" : "white")}
            onFreshBoard={startLiveBoard}
            onLoadSaved={loadGameToSandbox}
            onMainlineSelect={jumpToMainlineReview}
            showUploadInHistory={showUploadInHistory}
            setShowUploadInHistory={setShowUploadInHistory}
            historyView={historyView}
            setHistoryView={setHistoryView}
            mounted={mounted}
            onPieceClick={handleBoardPieceClick}
            onPieceDrag={(square) => setDragHoverSquare(square)}
            onReset={resetLiveBoard}
            onRedo={redoLiveMove}
            onReturnToReview={returnToReview}
            onSample={() => setPgn(SAMPLE_PGN)}
            onSaveCurrentPgn={saveCurrentGame}
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
            uploadError={error}
            uploadIsLoading={isLoading}
            uploadPgn={pgn}
            userName={userName}
            onUserNameChange={setUserName}
          />
        ) : (
          <section className="grid items-stretch gap-5 xl:grid-cols-[208px_minmax(620px,960px)_minmax(360px,1fr)]">
            <AppRail
              active={panelTab === "history" ? "history" : "board"}
              onFreshBoard={startLiveBoard}
              onHistory={() => setPanelTab("history")}
              onSave={saveCurrentGame}
              saveDisabled={reviewSans.length === 0}
              userName={userName}
              onUserNameChange={setUserName}
            />
            <div className="flex h-[calc(100vh-1.5rem)] min-h-0 flex-col justify-center">
              <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-[48px_minmax(0,1fr)]">
                <EvalBar score={evalScore} whitePercent={whitePercent} boardOrientation={boardOrientation} />
                <BoardStage
                  topPlayer={{
                    active: reviewBoard.turn() === "b",
                    accuracy: analysis.summary.black.accuracy,
                    color: "black",
                    captures: reviewCapturedPieces.black,
                    name: analysis.metadata.black || "Black",
                  }}
                  bottomPlayer={{
                    active: reviewBoard.turn() === "w",
                    accuracy: analysis.summary.white.accuracy,
                    color: "white",
                    captures: reviewCapturedPieces.white,
                    name: analysis.metadata.white || "White",
                  }}
                  onFlipBoard={() => setBoardOrientation(boardOrientation === "white" ? "black" : "white")}
                  boardOrientation={boardOrientation}
                >
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
                      annotations={branchOriginPly !== null ? branchSquareAnnotations : reviewSquareAnnotations}
                      orientation={boardOrientation}
                    />
                    <BoardArrowOverlay
                      arrow={branchOriginPly !== null 
                        ? (branchArrowSquares ? [branchArrowSquares[0], branchArrowSquares[1]] : null)
                        : (reviewArrowSquares ? [reviewArrowSquares[0], reviewArrowSquares[1]] : null)
                      }
                      color={REVIEW_ARROW_COLOR}
                      boardOrientation={boardOrientation}
                    />
                    <CaptureAnimationOverlay capture={capturedPieceAnim} boardOrientation={boardOrientation} />
                  </ChessgroundBoard>
                </BoardStage>
              </div>
            </div>

            <aside className="flex h-[calc(100vh-1.5rem)] min-h-0 flex-col overflow-hidden rounded-md border border-white/10 bg-[#203746]/82 p-4 shadow-2xl shadow-black/20">
              {panelTab === "analysis" ? (
                branchOriginPly !== null ? (
                  <LiveAnalysisPanel
                    analysis={analysis}
                    branchOriginPly={branchOriginPly}
                    branchMoveClassification={branchMoveClassification}
                    branchVariation={branchVariation}
                    evalData={liveEval}
                    game={liveGame}
                    isLoading={liveLoading}
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
                          setPanelTab("history");
                          setHistoryView("list");
                          setAnalysis(null);
                          setActivePly(0);
                          setBranchOriginPly(null);
                          setLiveMode(true);
                          resetLiveBoard();
                        }}
                  />
                ) : (
                  <ReviewPanel
                    activePly={activePly}
                    analysis={analysis}
                    branchVariation={branchVariation}
                    canStepBack={canStepBack}
                    canStepForward={canStepForward}
                    engineLines={reviewEngineLines}
                    evalScore={evalScore}
                    onFirst={() => { setActivePly(0); setSelectedSquare(null); }}
                    onLast={() => { setActivePly(analysis.moves.length); setSelectedSquare(null); }}
                    onNext={goToNextMove}
                    onPlayFromPosition={playFromReviewPosition}
                    onPrev={goToPreviousMove}
                    positionStatus={reviewPositionStatus}
                    onSelectPly={(ply) => { setActivePly(ply); setSelectedSquare(null); }}
                    rows={moveRows}
                    selectedMove={selectedMove}
                    currentOpening={currentOpening}
                    onSetPanelTab={setPanelTab}
                    savedGames={savedGames}
                    onLoadSavedGame={loadSavedGame}
                    onBackToList={() => {
                          setPanelTab("history");
                          setHistoryView("list");
                          setAnalysis(null);
                          setActivePly(0);
                          setBranchOriginPly(null);
                          setLiveMode(true);
                          resetLiveBoard();
                        }}
                  />
                )
              ) : panelTab === "history" ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-xl font-semibold text-white">Old Games</h2>
                    <div className="flex items-center gap-2">
                      {/* Toggle button - shows icon for the OTHER view */}
                      <button
                        onClick={() => setHistoryView(historyView === "list" ? "analysis" : "list")}
                        title={historyView === "list" ? "Switch to Analysis" : "Switch to List"}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#101214] text-white transition hover:bg-white/10"
                      >
                        {historyView === "list" ? <BarChart3 size={16} /> : <List size={16} />}
                      </button>
                      <button
                        onClick={() => setShowUploadInHistory(!showUploadInHistory)}
                        title="Upload Game"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#101214] text-white transition hover:bg-white/10"
                      >
                        <Upload size={16} />
                      </button>
                    </div>
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
                        value={pgn}
                        onChange={(e) => setPgn(e.target.value)}
                        placeholder="Paste your PGN here..."
                        className="h-32 w-full resize-none rounded-md border border-white/10 bg-[#101214] p-2.5 text-sm text-stone-100 outline-none focus:border-sky-300/50"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => setPgn(SAMPLE_PGN)}
                          className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-amber-300 px-3 text-xs font-bold text-stone-950 transition hover:bg-amber-200"
                        >
                          <Sparkles size={14} />
                          Sample
                        </button>
                        <button
                          onClick={() => submitAnalysis()}
                          disabled={isLoading}
                          className="inline-flex h-8 flex-1 items-center justify-center gap-2 rounded-md bg-emerald-300 px-3 text-xs font-bold text-stone-950 transition hover:bg-emerald-200 disabled:opacity-60"
                        >
                          {isLoading ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
                          {isLoading ? "Analyzing..." : "Analyze"}
                        </button>
                      </div>
                    </div>
                  )}
                  {savedGames.length ? (
                    savedGames.map((game) => (
                      <button
                        key={game.id}
                        onClick={() => loadSavedGame(game)}
                        className="flex w-full items-center justify-between gap-3 rounded-md border border-white/10 bg-white/[0.04] p-3 text-left transition hover:bg-white/10"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-bold text-white">{game.title}</span>
                          <span className="mt-1 block truncate text-xs text-stone-400">{game.subtitle}</span>
                        </span>
                        <FolderOpen className="shrink-0 text-sky-200" size={18} />
                      </button>
                    ))
                  ) : (
                    <div className="rounded-md border border-white/10 bg-[#142531] p-4 text-sm leading-6 text-stone-400">
                      Games you upload or review from the board will show here.
                    </div>
                  )}
                </div>
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
                      <button
                        onClick={() => submitAnalysis()}
                        disabled={isLoading}
                        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-emerald-300 px-5 text-sm font-bold text-stone-950 transition hover:bg-emerald-200 disabled:opacity-60"
                      >
                        {isLoading ? <Loader2 className="animate-spin" size={17} /> : <Sparkles size={17} />}
                        {isLoading ? "Analyzing..." : "Analyze Uploaded Game"}
                      </button>
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
  onFreshBoard,
  onHistory,
  onSave,
  saveDisabled,
  userName,
  onUserNameChange,
}: {
  active: "board" | "history";
  onFreshBoard: () => void;
  onHistory: () => void;
  onSave: () => void;
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
      {isEditingName ? (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-white/10 bg-[#142531] px-2 py-1.5">
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
            className="min-w-0 flex-1 rounded-sm bg-transparent px-1 text-sm text-stone-100 outline-none"
            autoFocus
          />
          <div className="flex items-center gap-1 shrink-0">
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
        <div className="mb-3">
          <button
            onClick={() => setIsEditingName(true)}
            className="sidebar-rail-button w-full"
          >
            <span className="sidebar-rail-button__icon shrink-0">
              {userName ? <User size={17} /> : <User size={17} className="text-stone-400" />}
            </span>
            <span className="sidebar-rail-button__label">{userName || "Set your name"}</span>
          </button>
        </div>
      )}
      <div className="mb-1 flex items-center gap-2 px-2 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-100/45">
        <span className="h-2 w-2 rounded-full bg-sky-100/50" />
        Menu
      </div>
      <div className="grid gap-1.5">
        <RailButton active={active === "history"} icon={<History size={17} />} label="Old Games" onClick={onHistory} />
      </div>
      <div className="mt-3 border-t border-white/10 px-1 pt-3">
        <RailButton active={false} disabled={saveDisabled} icon={<Save size={17} />} label="Save PGN" onClick={onSave} />
      </div>
    </nav>
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

function LiveBoard({
  analysis,
  boardOrientation,
  branchVariation,
  branchOriginPly,
  branchMoveUci,
  branchMoveClassification,
  canRedo,
  captures,
  evalData,
  game,
  isLoading,
  liveCursor,
  liveError,
  liveHistory,
  onAnalyzePgn,
  onAnalyzeLive,
  onDrop,
  onBackToList,
  onFlipBoard,
  onFreshBoard,
  onLoadSaved,
  onMainlineSelect,
  onPieceClick,
  onPieceDrag,
  onReset,
  onRedo,
  onReturnToReview,
  onSample,
  onSaveCurrentPgn,
  onSetPanelTab,
  onSetPgn,
  onSquareClick,
  onUndo,
  panelTab,
  reviewRows,
  savedGames,
  uploadError,
  uploadIsLoading,
  uploadPgn,
  dragHoverSquare,
  selectedSquare,
  sans,
  showUploadInHistory,
  setShowUploadInHistory,
  historyView,
  setHistoryView,
  mounted,
  userName,
  onUserNameChange,
}: {
  analysis: AnalysisResult | null;
  boardOrientation: "white" | "black";
  branchVariation: MoveListVariation | null;
  branchOriginPly: number | null;
  branchMoveUci: string | null;
  branchMoveClassification: Classification | null;
  canRedo: boolean;
  captures: CaptureSummary;
  dragHoverSquare: string | null;
  evalData: LivePositionEval | null;
  game: Chess;
  isLoading: boolean;
  liveCursor: number;
  liveError: string | null;
  liveHistory: { pgn: string; fen: string }[];
  onAnalyzePgn: () => void;
  onAnalyzeLive: () => void;
  onDrop: (sourceSquare: string, targetSquare: string | null) => boolean;
  onBackToList: () => void;
  onFlipBoard?: () => void;
  onFreshBoard: () => void;
  onLoadSaved: (game: SavedGame) => void;
  onMainlineSelect: (ply: number) => void;
  onPieceClick: (square: string | null) => void;
  onPieceDrag: (square: string | null) => void;
  onReset: () => void;
  onRedo: () => void;
  onReturnToReview: () => void;
  onSample: () => void;
  onSaveCurrentPgn: () => void;
  onSetPanelTab: (tab: PanelTab) => void;
  onSetPgn: (pgn: string) => void;
  onSquareClick: (square: string | null) => void;
  onUndo: () => void;
  panelTab: PanelTab;
  reviewRows: { moveNumber: number; white?: AnalysisMove; black?: AnalysisMove }[];
  savedGames: SavedGame[];
  uploadError: string | null;
  uploadIsLoading: boolean;
  uploadPgn: string;
  selectedSquare: string | null;
  sans: string[];
  showUploadInHistory: boolean;
  setShowUploadInHistory: (value: boolean) => void;
  historyView: "list" | "analysis";
  setHistoryView: (view: "list" | "analysis") => void;
  mounted: boolean;
  userName: string;
  onUserNameChange: (value: string) => void;
}) {
  const whitePercent = evalToWhitePercent(evalData?.eval);
  const rows = groupSans(sans);
  const hasMoves = sans.length > 0;
  const lastMove = game.history({ verbose: true }).at(-1) as { from: string; to: string; san: string; captured?: string } | undefined;
  const playedSquares = lastMove ? boardSquareHighlights({ uci: `${lastMove.from}${lastMove.to}` }, "played") : {};
  
  // Classification color overlay for branch moves (shown after engine rating)
  // Only show in analysis view, not list view
  const classificationOverlays: Record<string, CSSProperties> = {};
  if (historyView === "analysis" && branchMoveUci && branchMoveClassification) {
    const squares = squareNameFromUci(branchMoveUci);
    if (squares) {
      const [fromSquare, toSquare] = squares;
      const classificationColors: Record<string, string> = {
        blunder: "rgba(234, 88, 12, 0.55)",
        mistake: "rgba(249, 115, 22, 0.55)",
        inaccuracy: "rgba(234, 179, 8, 0.55)",
        miss: "rgba(234, 179, 8, 0.55)",
        good: "rgba(132, 204, 22, 0.55)",
        excellent: "rgba(34, 197, 94, 0.55)",
        best: "rgba(34, 197, 94, 0.55)",
        brilliant: "rgba(34, 197, 94, 0.55)",
        great: "rgba(59, 130, 246, 0.55)",
        book: "rgba(176, 141, 103, 0.55)",
      };
      const color = classificationColors[branchMoveClassification] || "rgba(59, 130, 246, 0.55)";
      classificationOverlays[fromSquare] = { backgroundColor: color };
      classificationOverlays[toSquare] = { backgroundColor: color };
    }
  }
  
  const squareStyles = { ...playedSquares, ...selectedSquareStyles(game, selectedSquare) };
  // Classification overlays take precedence over selection (blue) when available
  const squareOverlays = { ...playedSquares, ...selectedSquareStyles(game, selectedSquare), ...classificationOverlays };
  const { legalMoves: liveLegalMoves, captureMoves: liveCaptureMoves } = getLegalMoves(game, selectedSquare);
  const liveArrowSquares = squareNameFromUci(evalData?.best_move);
  const whiteName = analysis?.metadata.white || "White";
  const blackName = analysis?.metadata.black || "Black";
  const liveSquareAnnotations = useMemo(() => {
    const annotations: Record<string, SquareAnnotation> = {};
    
    // Add badge for last move
    if (lastMove) {
      annotations[lastMove.to] = {
        label: squareBadgeText(null, "played"),
        tone: "text-stone-100 bg-black/[0.55]",
        iconSrc: undefined,
      };
    }
    
    // Add branch move badge with classification
    if (branchMoveUci) {
      const squares = squareNameFromUci(branchMoveUci);
      if (squares && branchMoveClassification) {
        const [, toSquare] = squares;
        annotations[toSquare] = {
          label: squareBadgeText(branchMoveClassification, "played"),
          tone: squareBadgeTone(branchMoveClassification, "played"),
          iconSrc: squareBadgeIcon(branchMoveClassification, "played") ?? undefined,
        };
      }
    }
    
    return annotations;
  }, [lastMove, branchMoveUci, branchMoveClassification]);

  return (
    <section className="grid items-stretch gap-5 xl:grid-cols-[208px_minmax(620px,960px)_minmax(360px,1fr)] animate-in fade-in duration-300">
      <AppRail
        active={panelTab === "history" ? "history" : "board"}
        onFreshBoard={onFreshBoard}
        onHistory={() => onSetPanelTab("history")}
        onSave={onSaveCurrentPgn}
        saveDisabled={!hasMoves}
        userName={userName}
        onUserNameChange={onUserNameChange}
      />
      <div className="flex h-[calc(100vh-1.5rem)] min-h-0 flex-col justify-center">
        <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-[48px_minmax(0,1fr)]">
          <EvalBar score={evalData?.eval ?? null} whitePercent={whitePercent} boardOrientation={boardOrientation} />
          <BoardStage
            topPlayer={{
              active: game.turn() === "b",
              accuracy: analysis?.summary.black.accuracy,
              color: "black",
              captures: captures.black,
              name: blackName,
            }}
            bottomPlayer={{
              active: game.turn() === "w",
              accuracy: analysis?.summary.white.accuracy,
              color: "white",
              captures: captures.white,
              name: whiteName,
            }}
            dragHoverSquare={dragHoverSquare}
            onFlipBoard={onFlipBoard}
            boardOrientation={boardOrientation}
          >
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
              {/* Only show badges in analysis view, not list view */}
              {historyView === "analysis" && (
                <BoardBadgeOverlay
                  annotations={liveSquareAnnotations}
                  orientation={boardOrientation}
                />
              )}
              {/* Only show arrow in analysis mode, not sandbox mode */}
              {analysis && (
                <BoardArrowOverlay
                  arrow={liveArrowSquares ? [liveArrowSquares[0], liveArrowSquares[1]] : null}
                  color={REVIEW_ARROW_COLOR}
                  boardOrientation={boardOrientation}
                />
              )}
            </ChessgroundBoard>
          </BoardStage>
        </div>
      </div>

      <aside className="flex h-[calc(100vh-1.5rem)] flex-col overflow-hidden rounded-md border border-white/10 bg-[#203746]/82 p-4 shadow-2xl shadow-black/20">
        {panelTab === "analysis" ? (
          <LiveAnalysisPanel
            analysis={analysis}
            branchOriginPly={branchOriginPly}
            branchMoveClassification={branchMoveClassification}
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
          />
        ) : (
          <div className="move-scroll flex-1 space-y-4 overflow-y-auto pr-1">
          {panelTab === "upload" ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold text-white">Upload Game</h2>
                <button
                onClick={onSample}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-amber-300 px-3 text-sm font-bold text-stone-950 transition hover:bg-amber-200"
              >
                <ClipboardPaste size={15} />
                Sample
              </button>
            </div>
            <textarea
              value={uploadPgn}
              onChange={(event) => onSetPgn(event.target.value)}
              spellCheck={false}
              placeholder='[Event "My Game"]&#10;1. e4 e5 2. Nf3 Nc6 ...'
              className="move-scroll min-h-[360px] w-full resize-none rounded-md border border-white/10 bg-[#0f1921] p-4 font-mono text-sm leading-6 text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-sky-200/50"
            />
            {uploadError ? (
              <div className="flex items-start gap-2 rounded-md border border-red-300/20 bg-red-500/10 p-3 text-sm text-red-100">
                <AlertCircle className="mt-0.5 shrink-0" size={16} />
                <span>{uploadError}</span>
              </div>
            ) : null}
            <button
              onClick={onAnalyzePgn}
              disabled={uploadIsLoading}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-emerald-300 px-5 text-sm font-bold text-stone-950 transition hover:bg-emerald-200 disabled:opacity-60"
            >
              {uploadIsLoading ? <Loader2 className="animate-spin" size={17} /> : <Sparkles size={17} />}
              {uploadIsLoading ? "Analyzing..." : "Analyze Uploaded Game"}
            </button>
            </div>
          ) : null}

          {panelTab === "history" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold text-white">Old Games</h2>
                <div className="flex items-center gap-2">
                  {/* Toggle button - shows icon for the OTHER view */}
                  <button
                    onClick={() => setHistoryView(historyView === "list" ? "analysis" : "list")}
                    title={historyView === "list" ? "Switch to Analysis" : "Switch to List"}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#101214] text-white transition hover:bg-white/10"
                  >
                    {historyView === "list" ? <BarChart3 size={16} /> : <List size={16} />}
                  </button>
                  <button
                    onClick={() => setShowUploadInHistory(!showUploadInHistory)}
                    title="Upload Game"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#101214] text-white transition hover:bg-white/10"
                  >
                    <Upload size={16} />
                  </button>
                </div>
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
                  <div className="flex gap-2">
                    <button
                      onClick={onSample}
                      className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-amber-300 px-3 text-xs font-bold text-stone-950 transition hover:bg-amber-200"
                    >
                      <Sparkles size={14} />
                      Sample
                    </button>
                    <button
                      onClick={onAnalyzePgn}
                      disabled={uploadIsLoading}
                      className="inline-flex h-8 flex-1 items-center justify-center gap-2 rounded-md bg-emerald-300 px-3 text-xs font-bold text-stone-950 transition hover:bg-emerald-200 disabled:opacity-60"
                    >
                      {uploadIsLoading ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
                      {uploadIsLoading ? "Analyzing..." : "Analyze"}
                    </button>
                  </div>
                </div>
              )}
              {historyView === "list" ? (
                !mounted ? (
                  <div className="rounded-md border border-white/10 bg-[#142531] p-4 text-sm leading-6 text-stone-400">
                    Loading games...
                  </div>
                ) : savedGames.length ? (
                  savedGames.map((game) => (
                    <div
                      key={game.id}
                      className="group relative rounded-md border border-white/10 bg-white/[0.04] p-3 transition hover:bg-white/10"
                    >
                      <button
                        onClick={() => onLoadSaved(game)}
                        className="w-full text-left"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex flex-col gap-0.5 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <div className="h-2 w-2 rounded-full bg-white" />
                                <span className="text-sm font-semibold text-white">{game.title.split(' vs ')[0]}</span>
                              </div>
                              {game.whiteAccuracy !== undefined && (
                                <span className="text-xs font-semibold text-white w-12 text-right">{game.whiteAccuracy}%</span>
                              )}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <div className="h-2 w-2 rounded-full bg-stone-900" />
                                <span className="text-sm font-semibold text-white">{game.title.split(' vs ')[1]}</span>
                              </div>
                              {game.blackAccuracy !== undefined && (
                                <span className="text-xs font-semibold text-white w-12 text-right">{game.blackAccuracy}%</span>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-0.5">
                            {game.result !== "*" && (
                              <span className="text-sm font-bold text-white">{game.result}</span>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                          <span className="text-stone-400">{game.subtitle}</span>
                          <span className="text-stone-400">{typeof game.moveCount === 'number' ? game.moveCount : '?'} moves</span>
                        </div>
                        <div className="mt-1 text-[11px] text-stone-500">
                          {game.gameDate || new Date(game.updatedAt).toLocaleDateString()}
                        </div>
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="rounded-md border border-white/10 bg-[#142531] p-4 text-sm leading-6 text-stone-400">
                    Games you upload or review from the board will show here.
                  </div>
                )
              ) : (
                /* Analysis view - show full LiveAnalysisPanel */
                <LiveAnalysisPanel
                  analysis={analysis}
                  branchOriginPly={branchOriginPly}
                  branchMoveClassification={branchMoveClassification}
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
                />
              )}
            </div>
          ) : null}
          </div>
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
}: {
  hasMoves: boolean;
  rows: { moveNumber: number; white?: AnalysisMove | string; black?: AnalysisMove | string }[];
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
}: {
  color: "white" | "black";
  move?: AnalysisMove | string;
}) {
  if (!move) return <div className="h-6 rounded-sm" />;

  const san = typeof move === "string" ? move : move.san;
  const classification = typeof move === "string" ? null : move.classification;
  const glyph = pieceGlyphFromSan(san, color);
  const moveText = glyph ? san.slice(1) : san;
  const badgeIcon = classification ? squareBadgeIcon(classification, "played") : null;

  return (
    <div className="flex h-6 items-center rounded-sm px-2 text-[11px] font-semibold text-stone-300">
      {badgeIcon ? (
        <img
          src={badgeIcon}
          alt={classification ?? ""}
          className="mr-1 h-4 w-4 shrink-0 object-contain"
          title={classification ?? ""}
        />
      ) : null}
      {glyph ? <span className="mr-1 text-[12px] leading-none opacity-90">{glyph}</span> : null}
      <span className="truncate">{moveText}</span>
    </div>
  );
}

function EvalBar({ score, whitePercent, boardOrientation = "white" }: { score: EvalScore | null; whitePercent: number; boardOrientation?: "white" | "black" }) {
  const blackPercent = 100 - whitePercent;
  const whiteAdvantage = whitePercent >= 50;
  const labelPlacement = whiteAdvantage ? "bottom-1" : "top-1";

  // When board is flipped, swap the arrow position
  const shouldFlip = boardOrientation === "black";
  const arrowPosition = shouldFlip ? 100 - blackPercent : blackPercent;

  // Format score to 2 digits max
  const formatScore = (display: string) => {
    if (!display) return "0.0";
    const num = parseFloat(display);
    if (isNaN(num)) return display;
    return num.toFixed(1);
  };

  return (
    <div className="relative flex h-14 items-center justify-center sm:h-auto sm:min-h-[520px]">
      <div className="relative h-full w-[26px] overflow-hidden rounded-sm border border-black/25 bg-[#101214] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_8px_20px_rgba(0,0,0,0.22)] sm:w-[30px]">
        <div
          className="absolute inset-x-0 top-0 bg-[#2d2d2b] transition-[height] duration-300 ease-out"
          style={{ height: `${blackPercent}%` }}
        />
        <div
          className="absolute inset-x-0 bottom-0 bg-[#f4ead8] transition-[height] duration-300 ease-out"
          style={{ height: `${whitePercent}%` }}
        />
        <div
          className="absolute inset-x-0 h-px bg-black/35 transition-[top] duration-300 ease-out"
          style={{ top: `${arrowPosition}%` }}
        />
        <div
          className={`absolute left-1/2 -translate-x-1/2 text-center text-[10px] font-black leading-none ${labelPlacement} ${
            whiteAdvantage ? "text-stone-950" : "text-white"
          }`}
        >
          {formatScore(score?.display ?? "0.0")}
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
  onPrev,
  onSelectPly,
  positionStatus,
  selectedMove,
  rows,
  currentOpening,
  onSetPanelTab,
  savedGames,
  onLoadSavedGame,
  onBackToList,
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
  onPrev: () => void;
  positionStatus: string;
  onSelectPly: (ply: number) => void;
  rows: { moveNumber: number; white?: AnalysisMove; black?: AnalysisMove }[];
  currentOpening: string;
  onSetPanelTab: (tab: PanelTab) => void;
  savedGames: SavedGame[];
  onLoadSavedGame: (game: SavedGame) => void;
  onBackToList: () => void;
}) {
  const [reviewTab, setReviewTab] = useState<ReviewPanelTab>("review");
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
          {analysis && (
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
        <div className="flex items-center gap-2">
          {/* Review/Graph Toggle - Icon only */}
          <div className="flex rounded-md border border-white/10 bg-[#101214] p-0.5">
            <button
              onClick={() => setReviewTab("review")}
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
              onClick={() => setReviewTab("graph")}
              title="Graph"
              className={`inline-flex h-7 w-7 items-center justify-center rounded transition ${
                reviewTab === "graph"
                  ? "bg-white/10 text-white"
                  : "text-stone-400 hover:text-white"
              }`}
            >
              <BarChart3 size={14} />
            </button>
          </div>
          <div className="rounded-md border border-white/10 bg-[#101214] px-3 py-1 text-sm font-bold text-white">{evalScore?.display ?? "0.00"}</div>
        </div>
      </div>

      {currentOpening ? (
        <div className="mt-3 rounded-md border border-sky-300/30 bg-sky-900/20 px-3 py-2">
          <p className="text-sm font-semibold text-sky-200">{currentOpening}</p>
        </div>
      ) : null}

      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="rounded-md border border-white/10 bg-[#142531] p-2.5 text-stone-100 shadow-lg shadow-black/20">
          {reviewTab === "review" ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {selectedMove ? (
                  <div className="relative h-6 w-6 shrink-0">
                    <img
                      src={squareBadgeIcon(selectedMove.classification, "played") ?? undefined}
                      alt={classificationLabel(selectedMove.classification)}
                      className="h-full w-full object-contain"
                    />
                  </div>
                ) : (
                  <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full border px-1 text-[12px] font-black border-white/10 bg-white/[0.06] text-stone-200`}>
                    <Sparkles size={11} />
                  </span>
                )}
                <span className="text-sm font-semibold">{activeLabel}</span>
              </div>
              <CompactEngineLines lines={engineLines} positionStatus={positionStatus} sourceLabel={engineSource} />
            </>
          ) : (
            <AdvantageTimeline analysis={analysis} activePly={activePly} onSelectPly={onSelectPly} embedded />
          )}
        </div>
        {reviewTab === "review" && (
          <div className="mt-3 flex min-h-0 flex-1 flex-col">
            <MoveList rows={rows} activePly={activePly} onSelect={onSelectPly} variation={branchVariation} />
          </div>
        )}
        {reviewTab === "review" && (
          <div className="mt-3 space-y-3">
            {navigation}
            <PlayFromPositionButton onClick={onPlayFromPosition} />
          </div>
        )}
      </div>
    </div>
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

  const points = useMemo(() => {
    const timeline = analysis.moves.length
      ? [analysis.moves[0].eval_before, ...analysis.moves.map((move) => move.eval_after)]
      : [{ cp: 0, mate: null, display: "0.00" }];

    return timeline.map((score, index) => {
      const progress = timeline.length === 1 ? 0.5 : index / (timeline.length - 1);
      const x = paddingX + progress * (width - paddingX * 2);
      const y = midY - evalToGraphUnit(score) * usableHeight;
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
  const turningPoint = turningPointPly !== null ? points[turningPointPly] ?? null : null;

  function handleSelect(event: ReactMouseEvent<SVGSVGElement>) {
    if (!points.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const relativeX = ((event.clientX - bounds.left) / bounds.width) * width;
    const normalized = (relativeX - paddingX) / (width - paddingX * 2);
    const nextPly = Math.round(Math.max(0, Math.min(1, normalized)) * (points.length - 1));
    onSelectPly(nextPly);
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

          {activePoint ? (
            <>
              <line
                x1={activePoint.x}
                y1={paddingY / 2}
                x2={activePoint.x}
                y2={height - paddingY / 2}
                stroke="rgba(148,163,184,0.85)"
                strokeWidth="0.75"
              />
              <circle
                cx={activePoint.x}
                cy={activePoint.y}
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
          <span>{activePoint ? `Ply ${activePoint.ply} · ${activePoint.score.display}` : "Even"}</span>
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

type BoardPlayer = {
  accuracy?: number | null;
  active: boolean;
  captures: CapturedPiece[];
  color: "white" | "black";
  name: string;
};

function BoardStage({
  bottomPlayer = { active: false, captures: [], color: "white", name: "White" },
  topPlayer = { active: false, captures: [], color: "black", name: "Black" },
  children,
  dragHoverSquare,
  onFlipBoard,
  boardOrientation = "white",
}: {
  bottomPlayer: BoardPlayer;
  topPlayer: BoardPlayer;
  children: ReactNode;
  dragHoverSquare?: string | null;
  onFlipBoard?: () => void;
  boardOrientation?: "white" | "black";
}) {
  // Swap players when board is flipped (black at bottom)
  const shouldSwap = boardOrientation === "black";
  const actualTopPlayer = shouldSwap ? bottomPlayer : topPlayer;
  const actualBottomPlayer = shouldSwap ? topPlayer : bottomPlayer;
  
  const topMaterialLead = captureMaterialTotal(actualTopPlayer.captures) - captureMaterialTotal(actualBottomPlayer.captures);
  const bottomMaterialLead = captureMaterialTotal(actualBottomPlayer.captures) - captureMaterialTotal(actualTopPlayer.captures);

  return (
    <div className="flex min-h-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-[#243b4a]/70 p-2 shadow-2xl shadow-black/20 sm:p-3">
      <div className="flex h-full w-full max-w-[880px] min-w-0 flex-col justify-center gap-1.5">
        <div className="flex items-center justify-between">
          <BoardPlayerStrip materialLead={topMaterialLead} player={actualTopPlayer} />
          {onFlipBoard && (
            <button
              onClick={onFlipBoard}
              className="inline-flex items-center justify-center rounded-md border border-white/10 bg-white/10 p-1.5 transition hover:bg-white/20"
              title="Flip board"
            >
              <RefreshCw size={16} className="text-stone-300" />
            </button>
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
          <div className="h-full aspect-square max-h-full max-w-full">{children}</div>
        </div>
        <BoardPlayerStrip materialLead={bottomMaterialLead} player={actualBottomPlayer} />
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

  return (
    <div className="flex min-h-[34px] items-center justify-between gap-3 px-1 text-left">
      <div className="flex min-w-0 flex-1 items-center gap-2">
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
          {player.accuracy !== undefined && player.accuracy !== null ? (
            <span className="shrink-0 text-[12px] font-semibold leading-none text-stone-400">{player.accuracy}%</span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[15px] leading-none text-stone-300">
          {player.captures.length ? (
            <>
              {player.captures.slice(0, 7).map((piece, index) => (
                <CapturedPieceIcon key={`${player.color}-${piece.type}-${piece.color}-${index}`} piece={piece} />
              ))}
              {player.captures.length > 7 ? <span className="text-xs text-stone-400">+{player.captures.length - 7}</span> : null}
              {leadLabel ? <span className="ml-1.5 text-xs font-semibold text-stone-400">{leadLabel}</span> : null}
            </>
          ) : (
            <span className="text-[10px] text-stone-500"> </span>
          )}
        </div>
      </div>
    </div>
  );
}

function CapturedPieceIcon({ piece }: { piece: CapturedPiece }) {
  return (
    <span
      className={`inline-flex w-5 h-5 justify-center items-center text-base font-black leading-none ${
        piece.color === "white"
          ? "text-[#f3f0e8]"
          : "text-[#171a1d]"
      }`}
      title={`${piece.color} ${piece.type}`}
    >
      {capturedPieceGlyph(piece.type, piece.color)}
    </span>
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
    <div className="mt-2 border-t border-white/10 pt-1.5">
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">
        <span className="truncate">Top Moves · {positionStatus}</span>
        <span>{sourceLabel}</span>
      </div>

      {topLines.length ? (
        <div className="space-y-0.5">
          {topLines.map((line) => (
            <div
              key={`${line.rank}-${line.move ?? "none"}`}
              className={`grid grid-cols-[44px_minmax(0,1fr)] items-center gap-1.5 rounded-sm px-1 py-0.5 ${
                line.rank === 1
                  ? "bg-emerald-400/12"
                  : "bg-black/12"
              }`}
            >
              <span className={`inline-flex h-5 w-full shrink-0 items-center justify-center rounded-sm text-[12px] font-bold ${
                line.rank === 1
                  ? "bg-emerald-300/80 text-emerald-950"
                  : "bg-white/12 text-stone-200"
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
        <div className="rounded-sm bg-black/12 px-1.5 py-1 text-[11px] text-stone-500">
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
  const badgeIcon = move.classification ? squareBadgeIcon(move.classification, "played") : null;

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
      {badgeIcon ? (
        <img
          src={badgeIcon}
          alt={move.classification ?? ""}
          className="h-4 w-4 shrink-0 object-contain"
          title={move.classification ?? ""}
        />
      ) : null}
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
  branchMoveClassification,
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
}: {
  analysis: AnalysisResult | null;
  branchOriginPly: number | null;
  branchMoveClassification: Classification | null;
  branchVariation: MoveListVariation | null;
  evalData: LivePositionEval | null;
  game: Chess;
  isLoading: boolean;
  lastMove?: { san: string } | null;
  liveCursor: number;
  liveError: string | null;
  liveHistory: { pgn: string; fen: string }[];
  reviewRows: { moveNumber: number; white?: AnalysisMove; black?: AnalysisMove }[];
  rows: { moveNumber: number; white?: AnalysisMove | string; black?: AnalysisMove | string }[];
  hasMoves: boolean;
  onMainlineSelect: (ply: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onReturnToReview: () => void;
  savedGames: SavedGame[];
  onBackToList: () => void;
  onLoadSaved: (game: SavedGame) => void;
  onSetPanelTab: (tab: PanelTab) => void;
}) {
  const [liveTab, setLiveTab] = useState<"review" | "graph" | "history">("review");

  const isBranchMode = branchOriginPly !== null;
  const activeLabel = lastMove && branchMoveClassification
    ? `${lastMove.san} is ${/^[aeiou]/.test(classificationLabel(branchMoveClassification)) ? "an" : "a"} ${classificationLabel(branchMoveClassification)}`
    : isBranchMode
      ? `Branch from move ${branchOriginPly}`
      : hasMoves
        ? "Analysis position"
        : "Starting position";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden animate-in fade-in duration-200">
      {/* Header - Same as ReviewPanel */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {analysis && (
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
        <div className="flex items-center gap-2">
          {/* Review/Graph Toggle - Icon only */}
          <div className="flex rounded-md border border-white/10 bg-[#101214] p-0.5">
            <button
              onClick={() => setLiveTab("review")}
              title="Review"
              className={`inline-flex h-7 w-7 items-center justify-center rounded transition ${
                liveTab === "review"
                  ? "bg-white/10 text-white"
                  : "text-stone-400 hover:text-white"
              }`}
            >
              <Star size={14} />
            </button>
            <button
              onClick={() => setLiveTab("graph")}
              title="Graph"
              className={`inline-flex h-7 w-7 items-center justify-center rounded transition ${
                liveTab === "graph"
                  ? "bg-white/10 text-white"
                  : "text-stone-400 hover:text-white"
              }`}
            >
              <BarChart3 size={14} />
            </button>
          </div>
          <div className="rounded-md border border-white/10 bg-[#101214] px-3 py-1 text-sm font-bold text-white">
            {isLoading ? "..." : evalData?.eval.display ?? "0.00"}
          </div>
        </div>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="rounded-md border border-white/10 bg-[#142531] p-2.5 text-stone-100 shadow-lg shadow-black/20">
          {liveTab === "review" ? (
            isLoading ? (
              /* Loading state - exact same size as content */
              <div className="flex h-[135.5px] flex-col items-center justify-center gap-3">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-300/30 border-t-sky-300" />
                <span className="text-xs text-stone-400">Analyzing position...</span>
              </div>
            ) : (
              <>
                {/* Move info - Same format as ReviewPanel */}
                <div className="flex flex-wrap items-center gap-2">
                  {lastMove && branchMoveClassification ? (
                    <div className="relative h-6 w-6 shrink-0">
                      <img
                        src={squareBadgeIcon(branchMoveClassification, "played") ?? undefined}
                        alt={classificationLabel(branchMoveClassification)}
                        className="h-full w-full object-contain"
                      />
                    </div>
                  ) : (
                    <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full border px-1 text-[12px] font-black border-white/10 bg-white/[0.06] text-stone-200`}>
                      <Sparkles size={11} />
                    </span>
                  )}
                  <span className="text-sm font-semibold">{activeLabel}</span>
                </div>
                <CompactEngineLines
                  lines={evalData?.engine_lines ?? []}
                  positionStatus={gameStatus(game)}
                  sourceLabel={evalData?.source === "stockfish" ? `Depth ${evalData.engine_depth}` : "Fallback"}
                />
              </>
            )
          ) : analysis ? (
            <AdvantageTimeline analysis={analysis} activePly={branchOriginPly ?? 0} onSelectPly={onMainlineSelect} embedded />
          ) : (
            <div className="flex h-40 items-center justify-center text-stone-400">
              <BarChart3 size={32} className="mx-auto mb-2 opacity-50" />
              <p>No graph data available</p>
            </div>
          )}
        </div>

        {liveError ? (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-red-300/20 bg-red-500/10 p-3 text-sm text-red-100">
            <AlertCircle className="mt-0.5 shrink-0" size={16} />
            <span>{liveError}</span>
          </div>
        ) : null}

        {/* Move list below - Show in both sandbox and analysis modes */}
        {liveTab === "review" && (
          <div className="mt-3 flex min-h-0 flex-1 flex-col">
            {isBranchMode && analysis ? (
              <MoveList
                activePly={0}
                onSelect={onMainlineSelect}
                rows={reviewRows}
                variation={branchVariation}
              />
            ) : (
              <LiveMoveList hasMoves={hasMoves} rows={rows} />
            )}
          </div>
        )}

        {/* Navigation buttons - Show in both sandbox and analysis modes */}
        {liveTab === "review" && (
          <div className="mt-3 grid grid-cols-5 gap-2">
            <button
              onClick={() => { /* Go to first move */ onUndo(); }}
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
            <div className="flex h-11 items-center justify-center rounded-md bg-[#101214]">
              <GitBranch size={18} className="text-sky-300" />
            </div>
            <button
              onClick={onRedo}
              disabled={liveCursor >= liveHistory.length - 1}
              className="inline-flex h-11 items-center justify-center rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
              aria-label="Next move"
            >
              <ChevronRight size={20} />
            </button>
            <button
              onClick={() => { /* Go to last move */ onRedo(); }}
              disabled={liveCursor >= liveHistory.length - 1}
              className="inline-flex h-11 items-center justify-center rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
              aria-label="Last move"
            >
              <ChevronRight size={18} />
              <ChevronRight className="-ml-3" size={18} />
            </button>
          </div>
        )}

        {/* Return to mainline button for branch mode */}
        {isBranchMode && (
          <button
            onClick={onReturnToReview}
            className="mt-3 inline-flex h-11 items-center justify-center gap-2 rounded-md border border-sky-200/25 bg-sky-300/10 px-4 text-sm font-semibold text-sky-100 transition hover:bg-sky-300/15"
          >
            <GitBranch size={16} />
            Return To Mainline Review
          </button>
        )}
      </div>
    </div>
  );
}
