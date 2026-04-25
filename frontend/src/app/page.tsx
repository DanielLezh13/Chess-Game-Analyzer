"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Chess, type Square } from "chess.js";
import {
  defaultPieces,
  type PieceRenderObject,
  type SquareRenderer,
} from "react-chessboard";
import {
  AlertCircle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  FolderOpen,
  GitBranch,
  History,
  List,
  Loader2,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  Star,
  Undo2,
  Upload,
} from "lucide-react";
import type { AnalysisMove, AnalysisResult, Classification, EngineLine, EvalScore, LivePositionEval } from "@/lib/types";

const Chessboard = dynamic(() => import("react-chessboard").then((mod) => mod.Chessboard), {
  ssr: false,
});

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const RECENT_GAMES_KEY = "chess-review:recent-games";

const BOARD_STYLE = { borderRadius: "3px", height: "100%", overflow: "hidden", width: "100%" };
const DARK_SQUARE_STYLE = {
  backgroundColor: "#6f95a8",
  backgroundImage: "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(0,0,0,0.08))",
};
const LIGHT_SQUARE_STYLE = {
  backgroundColor: "#d7e5e8",
  backgroundImage: "linear-gradient(145deg, rgba(255,255,255,0.28), rgba(83,121,137,0.08))",
};

const PIECES = Object.fromEntries(
  Object.entries(defaultPieces).map(([piece, Piece]) => [
    piece,
    (props?: { fill?: string; square?: string; svgStyle?: CSSProperties }) => (
      <Piece
        {...props}
        fill={piece.startsWith("w") ? "#edf2f2" : "#22282c"}
        svgStyle={{
          ...props?.svgStyle,
          filter: piece.startsWith("w")
            ? "drop-shadow(0 2px 1px rgba(0,0,0,0.42)) drop-shadow(0 0 1px rgba(0,0,0,0.55))"
            : "drop-shadow(0 2px 1px rgba(255,255,255,0.18)) drop-shadow(0 0 1px rgba(0,0,0,0.62))",
        }}
      />
    ),
  ])
) as PieceRenderObject;

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

type PanelTab = "analysis" | "upload" | "history";
type ReviewPanelTab = "review" | "moves" | "graph";
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
};

type LiveSnapshot = {
  pgn: string;
  fen: string;
};

function loadRecentGames() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_GAMES_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as SavedGame[]).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function recentGameFromAnalysis(pgn: string, result: AnalysisResult): SavedGame {
  const white = result.metadata.white || "White";
  const black = result.metadata.black || "Black";
  const opening = result.metadata.opening && result.metadata.opening !== "Unknown" ? result.metadata.opening : "PGN review";
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: `${white} vs ${black}`,
    subtitle: `${opening} · ${result.metadata.result}`,
    pgn,
    updatedAt: Date.now(),
  };
}

const OPENINGS = [
  { moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"], name: "Ruy Lopez" },
  { moves: ["e4", "e5", "Nf3", "Nc6", "Bc4"], name: "Italian Game" },
  { moves: ["e4", "e5", "Nf3", "Nf6"], name: "Petrov Defense" },
  { moves: ["e4", "c5"], name: "Sicilian Defense" },
  { moves: ["e4", "e6"], name: "French Defense" },
  { moves: ["e4", "c6"], name: "Caro-Kann Defense" },
  { moves: ["e4", "d5"], name: "Scandinavian Defense" },
  { moves: ["d4", "d5", "c4"], name: "Queen's Gambit" },
  { moves: ["d4", "Nf6", "c4", "g6"], name: "King's Indian Defense" },
  { moves: ["d4", "Nf6", "c4", "e6"], name: "Queen's Pawn Game" },
  { moves: ["c4"], name: "English Opening" },
  { moves: ["Nf3"], name: "Reti Opening" },
];

function detectOpening(sans: string[]) {
  let match = "Starting position";
  for (const opening of OPENINGS) {
    const isMatch = opening.moves.every((move, index) => sans[index] === move);
    if (isMatch && opening.moves.length <= sans.length) {
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
  const playedPalette = move.classification === "blunder"
    ? {
        from: "rgba(248, 113, 113, 0.2)",
        to: "rgba(248, 113, 113, 0.34)",
        border: "rgba(248, 113, 113, 0.55)",
      }
    : move.classification === "mistake"
      ? {
          from: "rgba(251, 146, 60, 0.2)",
          to: "rgba(251, 146, 60, 0.34)",
          border: "rgba(251, 146, 60, 0.55)",
        }
      : move.classification === "inaccuracy" || move.classification === "miss"
        ? {
            from: "rgba(250, 204, 21, 0.18)",
            to: "rgba(250, 204, 21, 0.3)",
            border: "rgba(250, 204, 21, 0.5)",
          }
        : move.classification === "good" || move.classification === "excellent"
          ? {
              from: "rgba(163, 230, 53, 0.18)",
              to: "rgba(163, 230, 53, 0.3)",
              border: "rgba(163, 230, 53, 0.5)",
            }
          : move.classification === "great" || move.classification === "best" || move.classification === "brilliant"
            ? {
                from: "rgba(74, 222, 128, 0.18)",
                to: "rgba(74, 222, 128, 0.34)",
                border: "rgba(74, 222, 128, 0.58)",
              }
            : {
                from: "rgba(120, 201, 255, 0.2)",
                to: "rgba(120, 201, 255, 0.34)",
                border: "rgba(120, 201, 255, 0.48)",
              };
  const base = kind === "best" ? "rgba(74, 222, 128, 0.18)" : playedPalette.from;
  const to = kind === "best" ? "rgba(74, 222, 128, 0.34)" : playedPalette.to;

  return {
    [fromSquare]: {
      backgroundColor: base,
      boxShadow: `inset 0 0 0 1px ${kind === "best" ? "rgba(74, 222, 128, 0.32)" : playedPalette.border}`,
    },
    [toSquare]: {
      backgroundColor: to,
      boxShadow: `inset 0 0 0 ${kind === "best" ? "2px" : "1px"} ${kind === "best" ? "rgba(74, 222, 128, 0.58)" : playedPalette.border}`,
    },
  };
}

function selectedSquareStyles(game: Chess, selectedSquare: string | null): Record<string, CSSProperties> {
  if (!selectedSquare) return {};

  const nextStyles: Record<string, CSSProperties> = {
    [selectedSquare]: {
      boxShadow: "inset 0 0 0 2px rgba(248, 250, 252, 0.65), inset 0 0 22px rgba(125, 211, 252, 0.18)",
      backgroundColor: "rgba(125, 211, 252, 0.22)",
    },
  };

  for (const move of legalMoveTargets(game, selectedSquare)) {
    nextStyles[move.to] = move.captured
      ? {
          boxShadow: "inset 0 0 0 3px rgba(125, 211, 252, 0.6)",
          backgroundColor: "rgba(125, 211, 252, 0.12)",
        }
      : {
          backgroundImage: "radial-gradient(circle, rgba(248,250,252,0.65) 0, rgba(248,250,252,0.65) 18%, transparent 22%)",
        };
  }

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

function boardSquareRenderer(
  annotations: Record<string, { label: string; tone: string }>
) : SquareRenderer {
  return function renderSquare({ square, children }: { square: string; children?: ReactNode }) {
    const annotation = annotations[square];
    return (
      <div className="relative h-full w-full">
        {children}
        {annotation ? (
          <span
            className={`absolute right-0.5 top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-white/15 px-1 text-[9px] font-black leading-none shadow-sm ${annotation.tone}`}
          >
            {annotation.label}
          </span>
        ) : null}
      </div>
    );
  };
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
  if (kind === "best") return "★";
  if (!classification) return "•";
  if (classification === "brilliant") return "!!";
  if (classification === "best") return "★";
  if (classification === "great" || classification === "excellent") return "!";
  if (classification === "good") return "✓";
  if (classification === "book") return "♜";
  if (classification === "miss") return "x";
  if (classification === "inaccuracy") return "?!";
  if (classification === "mistake") return "?";
  return "??";
}

export default function Home() {
  const [pgn, setPgn] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>("analysis");
  const [savedGames, setSavedGames] = useState<SavedGame[]>(loadRecentGames);
  const [liveStartFen, setLiveStartFen] = useState(INITIAL_FEN);
  const [livePgn, setLivePgn] = useState("");
  const [liveFen, setLiveFen] = useState(INITIAL_FEN);
  const [liveHistory, setLiveHistory] = useState<LiveSnapshot[]>([{ pgn: "", fen: INITIAL_FEN }]);
  const [liveCursor, setLiveCursor] = useState(0);
  const [liveSeedCaptures, setLiveSeedCaptures] = useState<CaptureSummary>(() => emptyCaptureSummary());
  const [liveEval, setLiveEval] = useState<LivePositionEval | null>(null);
  const [liveLoading, setLiveLoading] = useState(true);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [activePly, setActivePly] = useState(0);
  const [branchOriginPly, setBranchOriginPly] = useState<number | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const pieceClickRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const boardFen = activePly === 0 ? analysis?.metadata.initial_fen ?? INITIAL_FEN : analysis?.moves[activePly - 1]?.fen_after ?? INITIAL_FEN;
  const reviewBoard = useMemo(() => new Chess(boardFen), [boardFen]);
  const selectedMove = activePly > 0 ? analysis?.moves[activePly - 1] ?? null : null;
  const evalScore = currentEval(analysis, activePly);
  const whitePercent = evalToWhitePercent(evalScore);
  const moveRows = useMemo(() => classifyMoveGroups(analysis?.moves ?? []), [analysis]);
  const reviewPositionStatus = gameStatus(reviewBoard);
  const reviewEngineLines = activePly === 0
    ? analysis?.moves[0]?.engine_lines ?? []
    : selectedMove?.reply_engine_lines ?? [];
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
  const reviewCapturedPieces = useMemo(
    () => capturedPiecesFromMoves((analysis?.moves ?? []).slice(0, activePly)),
    [analysis, activePly]
  );
  const activeBoardGame = liveMode ? liveGame : reviewBoard;
  const interactionSquareStyles = useMemo(
    () => selectedSquareStyles(activeBoardGame, selectedSquare),
    [activeBoardGame, selectedSquare]
  );
  const reviewSquareStyles = { ...reviewPlayedSquares, ...interactionSquareStyles };

  useEffect(() => {
    if (!liveMode) return;

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
  }, [liveFen, liveMode]);

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
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setActivePly((value) => Math.max(0, value - 1));
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [analysis, liveMode]);

  useEffect(() => {
    if (!liveMode) return;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (tagName === "INPUT" || tagName === "TEXTAREA" || target?.isContentEditable) return;

      if (event.key === "ArrowLeft" && liveCursor > 0) {
        const snapshot = liveHistory[liveCursor - 1];
        event.preventDefault();
        setLiveCursor(liveCursor - 1);
        setLivePgn(snapshot.pgn);
        setLiveFen(snapshot.fen);
        setLiveLoading(true);
        setLiveError(null);
      }

      if (event.key === "ArrowRight" && liveCursor < liveHistory.length - 1) {
        const snapshot = liveHistory[liveCursor + 1];
        event.preventDefault();
        setLiveCursor(liveCursor + 1);
        setLivePgn(snapshot.pgn);
        setLiveFen(snapshot.fen);
        setLiveLoading(true);
        setLiveError(null);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [liveCursor, liveHistory, liveMode]);

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
    setSelectedSquare(null);
    setError(null);
    resetLiveBoard();
    setLiveMode(true);
    setPanelTab("analysis");
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
    };
  }

  function handleLiveDrop(sourceSquare: string, targetSquare: string | null) {
    const nextSnapshot = snapshotAfterMove(liveStartFen, livePgn, sourceSquare, targetSquare);
    if (!nextSnapshot) return false;
    const nextCursor = liveCursor + 1;

    setLiveLoading(true);
    setLiveError(null);
    setSelectedSquare(null);
    setLiveHistory((current) => [...current.slice(0, liveCursor + 1), nextSnapshot]);
    setLiveCursor(nextCursor);
    setLivePgn(nextSnapshot.pgn);
    setLiveFen(nextSnapshot.fen);
    return true;
  }

  function handleReviewBranchDrop(sourceSquare: string, targetSquare: string | null) {
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
    setSelectedSquare(null);
    setLiveMode(true);
    setPanelTab("analysis");
    return true;
  }

  function handleBoardDrop(sourceSquare: string, targetSquare: string | null) {
    return liveMode ? handleLiveDrop(sourceSquare, targetSquare) : handleReviewBranchDrop(sourceSquare, targetSquare);
  }

  function handleBoardSquareClick(square: string | null) {
    if (!square) {
      setSelectedSquare(null);
      return;
    }
    if (pieceClickRef.current === square) {
      pieceClickRef.current = null;
      return;
    }
    const currentGame = liveMode ? liveGame : reviewBoard;
    const piece = currentGame.get(square as Square);
    if (selectedSquare && selectedSquare !== square && handleBoardDrop(selectedSquare, square)) {
      return;
    }

    if (selectedSquare === square) {
      setSelectedSquare(null);
      return;
    }

    if (piece && piece.color === currentGame.turn()) {
      setSelectedSquare(square);
      return;
    }

    setSelectedSquare(null);
  }

  function handleBoardPieceClick(square: string | null) {
    if (!square) {
      setSelectedSquare(null);
      return;
    }
    pieceClickRef.current = square;
    const currentGame = liveMode ? liveGame : reviewBoard;
    const piece = currentGame.get(square as Square);
    if (!piece || piece.color !== currentGame.turn()) {
      setSelectedSquare(null);
      return;
    }
    setSelectedSquare((current) => (current === square ? null : square));
  }

  function undoLiveMove() {
    if (liveCursor <= 0) return;
    const snapshot = liveHistory[liveCursor - 1];
    setLiveLoading(true);
    setLiveError(null);
    setLiveCursor(liveCursor - 1);
    setLivePgn(snapshot.pgn);
    setLiveFen(snapshot.fen);
  }

  function redoLiveMove() {
    if (!canRedoLiveMove) return;
    const snapshot = liveHistory[liveCursor + 1];
    setLiveLoading(true);
    setLiveError(null);
    setLiveCursor(liveCursor + 1);
    setLivePgn(snapshot.pgn);
    setLiveFen(snapshot.fen);
  }

  function saveRecentGame(cleanPgn: string, result: AnalysisResult) {
    const savedGame = recentGameFromAnalysis(cleanPgn, result);
    setSavedGames((current) => {
      const next = [savedGame, ...current.filter((game) => game.pgn !== cleanPgn)].slice(0, 5);
      window.localStorage.setItem(RECENT_GAMES_KEY, JSON.stringify(next));
      return next;
    });
  }

  function saveDraftGame(cleanPgn: string, title: string, subtitle: string) {
    setSavedGames((current) => {
      const savedGame: SavedGame = {
        id: `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        subtitle,
        pgn: cleanPgn,
        updatedAt: Date.now(),
      };
      const next = [savedGame, ...current.filter((game) => game.pgn !== cleanPgn)].slice(0, 5);
      window.localStorage.setItem(RECENT_GAMES_KEY, JSON.stringify(next));
      return next;
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

  function showUpload() {
    setPanelTab("upload");
  }

  function showHistory() {
    setPanelTab("history");
  }

  function playFromReviewPosition() {
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
    setPanelTab("analysis");
  }

  function jumpToMainlineReview(ply: number) {
    setActivePly(ply);
    returnToReview();
  }

  function goToPreviousMove() {
    setActivePly((value) => Math.max(0, value - 1));
  }

  function goToNextMove() {
    if (!analysis) return;
    setActivePly((value) => Math.min(analysis.moves.length, value + 1));
  }

  return (
    <main className="min-h-screen px-4 py-3 text-stone-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-[1620px] flex-col gap-3">
        {liveMode || !analysis ? (
          <LiveBoard
            analysis={analysis}
            branchVariation={branchVariation}
            branchOriginPly={branchOriginPly}
            captures={liveCapturedPieces}
            evalData={liveEval}
            game={liveGame}
            isLoading={liveLoading}
            liveError={liveError}
            canRedo={canRedoLiveMove}
            onAnalyzePgn={() => submitAnalysis()}
            onAnalyzeLive={() => submitAnalysis(livePgn)}
            onDrop={handleBoardDrop}
            onFreshBoard={startLiveBoard}
            onHistory={showHistory}
            onLoadSaved={loadSavedGame}
            onMainlineSelect={jumpToMainlineReview}
            onPieceClick={handleBoardPieceClick}
            onReset={resetLiveBoard}
            onRedo={redoLiveMove}
            onReturnToReview={returnToReview}
            onSample={() => setPgn(SAMPLE_PGN)}
            onSaveCurrentPgn={saveCurrentGame}
            onSetPanelTab={setPanelTab}
            onSetPgn={setPgn}
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
          />
        ) : (
          <section className="grid items-stretch gap-5 xl:grid-cols-[208px_minmax(620px,960px)_minmax(360px,1fr)]">
            <AppRail
              active={panelTab === "upload" ? "upload" : panelTab === "history" ? "history" : "board"}
              onFreshBoard={startLiveBoard}
              onHistory={showHistory}
              onSave={saveCurrentGame}
              onUpload={showUpload}
              saveDisabled={!pgn}
            />
            <div className="flex h-[calc(100vh-1.5rem)] min-h-0 flex-col justify-center">
              <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-[48px_minmax(0,1fr)]">
                <EvalBar score={evalScore} whitePercent={whitePercent} />
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
                >
                  <Chessboard
                    options={{
                      position: boardFen,
                      pieces: PIECES,
                      allowDragging: true,
                      allowDragOffBoard: false,
                      dragActivationDistance: 0,
                      allowDrawingArrows: false,
                      canDragPiece: ({ square }) => {
                        const piece = square ? reviewBoard.get(square as Square) : null;
                        return !!piece && piece.color === reviewBoard.turn();
                      },
                      arrows: reviewArrowSquares
                        ? [{ startSquare: reviewArrowSquares[0], endSquare: reviewArrowSquares[1], color: "rgba(74, 222, 128, 0.82)" }]
                        : [],
                      boardStyle: BOARD_STYLE,
                      darkSquareStyle: DARK_SQUARE_STYLE,
                      lightSquareStyle: LIGHT_SQUARE_STYLE,
                      squareStyles: reviewSquareStyles,
                      draggingPieceStyle: {
                        filter: "drop-shadow(0 12px 20px rgba(0,0,0,0.35))",
                        transform: "scale(1.04)",
                      },
                      draggingPieceGhostStyle: { opacity: 0 },
                      onPieceClick: ({ square }) => handleBoardPieceClick(square),
                      onPieceDrop: ({ sourceSquare, targetSquare }) => handleBoardDrop(sourceSquare, targetSquare),
                      onSquareClick: ({ square }) => handleBoardSquareClick(square),
                      showAnimations: true,
                    }}
                  />
                </BoardStage>
              </div>
            </div>

            <aside className="flex h-[calc(100vh-1.5rem)] min-h-0 flex-col overflow-hidden rounded-md border border-white/10 bg-[#203746]/82 p-4 shadow-2xl shadow-black/20">
              {panelTab === "analysis" ? (
                <ReviewPanel
                  activePly={activePly}
                  analysis={analysis}
                  canStepBack={canStepBack}
                  canStepForward={canStepForward}
                  engineLines={reviewEngineLines}
                  evalScore={evalScore}
                  onFirst={() => setActivePly(0)}
                  onLast={() => setActivePly(analysis.moves.length)}
                  onNext={goToNextMove}
                  onPlayFromPosition={playFromReviewPosition}
                  onPrev={goToPreviousMove}
                  positionStatus={reviewPositionStatus}
                  onSelectPly={setActivePly}
                  rows={moveRows}
                  selectedMove={selectedMove}
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

                  {panelTab === "history" ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="text-xl font-semibold text-white">Recent Games</h2>
                        <span className="text-sm text-stone-500">Max 5</span>
                      </div>
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
  onUpload,
  saveDisabled,
}: {
  active: "board" | "upload" | "history" | "bot";
  onFreshBoard: () => void;
  onHistory: () => void;
  onSave: () => void;
  onUpload: () => void;
  saveDisabled?: boolean;
}) {
  return (
    <nav className="sidebar-rail">
      <div className="mb-1 flex items-center gap-2 px-2 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-100/45">
        <span className="h-2 w-2 rounded-full bg-sky-100/50" />
        Menu
      </div>
      <div className="grid gap-1.5">
        <RailButton active={active === "board"} icon={<Play size={17} />} label="Fresh Board" onClick={onFreshBoard} />
        <RailButton active={active === "upload"} icon={<Upload size={17} />} label="Upload Game" onClick={onUpload} />
        <RailButton active={active === "history"} icon={<History size={17} />} label="Old Games" onClick={onHistory} />
        <RailButton active={active === "bot"} disabled icon={<Sparkles size={17} />} label="Play Bot" onClick={() => undefined} />
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
  branchVariation,
  branchOriginPly,
  canRedo,
  captures,
  evalData,
  game,
  isLoading,
  liveError,
  onAnalyzePgn,
  onAnalyzeLive,
  onDrop,
  onFreshBoard,
  onHistory,
  onLoadSaved,
  onMainlineSelect,
  onPieceClick,
  onReset,
  onRedo,
  onReturnToReview,
  onSaveCurrentPgn,
  onSample,
  onSetPanelTab,
  onSetPgn,
  onSquareClick,
  onUndo,
  panelTab,
  reviewRows,
  savedGames,
  selectedSquare,
  sans,
  uploadError,
  uploadIsLoading,
  uploadPgn,
}: {
  analysis: AnalysisResult | null;
  branchVariation: MoveListVariation | null;
  branchOriginPly: number | null;
  canRedo: boolean;
  captures: CaptureSummary;
  evalData: LivePositionEval | null;
  game: Chess;
  isLoading: boolean;
  liveError: string | null;
  onAnalyzePgn: () => void;
  onAnalyzeLive: () => void;
  onDrop: (sourceSquare: string, targetSquare: string | null) => boolean;
  onFreshBoard: () => void;
  onHistory: () => void;
  onLoadSaved: (game: SavedGame) => void;
  onMainlineSelect: (ply: number) => void;
  onPieceClick: (square: string | null) => void;
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
  selectedSquare: string | null;
  sans: string[];
  uploadError: string | null;
  uploadIsLoading: boolean;
  uploadPgn: string;
}) {
  const whitePercent = evalToWhitePercent(evalData?.eval);
  const rows = groupSans(sans);
  const hasMoves = sans.length > 0;
  const lastMove = game.history({ verbose: true }).at(-1) as { from: string; to: string; captured?: string } | undefined;
  const playedSquares = lastMove ? boardSquareHighlights({ uci: `${lastMove.from}${lastMove.to}` }, "played") : {};
  const squareStyles = { ...playedSquares, ...selectedSquareStyles(game, selectedSquare) };
  const liveArrowSquares = squareNameFromUci(evalData?.best_move);
  const whiteName = analysis?.metadata.white || "White";
  const blackName = analysis?.metadata.black || "Black";
  const liveSquareAnnotations = lastMove
    ? {
        [lastMove.to]: {
          label: squareBadgeText(null, "played"),
          tone: "text-stone-100 bg-black/[0.55]",
        },
      }
    : {};

  return (
    <section className="grid items-stretch gap-5 xl:grid-cols-[208px_minmax(620px,960px)_minmax(360px,1fr)]">
      <AppRail
        active={panelTab === "upload" ? "upload" : panelTab === "history" ? "history" : "board"}
        onFreshBoard={onFreshBoard}
        onHistory={onHistory}
        onSave={onSaveCurrentPgn}
        onUpload={() => onSetPanelTab("upload")}
        saveDisabled={!hasMoves}
      />
      <div className="flex h-[calc(100vh-1.5rem)] min-h-0 flex-col justify-center">
        <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-[48px_minmax(0,1fr)]">
          <EvalBar score={evalData?.eval ?? null} whitePercent={whitePercent} />
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
          >
            <Chessboard
              options={{
                position: game.fen(),
                pieces: PIECES,
                allowDragging: !game.isGameOver(),
                dragActivationDistance: 0,
                allowDrawingArrows: false,
                allowDragOffBoard: false,
                canDragPiece: ({ square }) => {
                  const piece = square ? game.get(square as Square) : null;
                  return !!piece && piece.color === game.turn();
                },
                arrows: liveArrowSquares
                  ? [{ startSquare: liveArrowSquares[0], endSquare: liveArrowSquares[1], color: "rgba(74, 222, 128, 0.82)" }]
                  : [],
                boardStyle: BOARD_STYLE,
                darkSquareStyle: DARK_SQUARE_STYLE,
                lightSquareStyle: LIGHT_SQUARE_STYLE,
                squareStyles,
                squareRenderer: boardSquareRenderer(liveSquareAnnotations),
                draggingPieceStyle: {
                  filter: "drop-shadow(0 12px 20px rgba(0,0,0,0.35))",
                  transform: "scale(1.04)",
                },
                draggingPieceGhostStyle: { opacity: 0 },
                onPieceClick: ({ square }) => onPieceClick(square),
                onPieceDrop: ({ sourceSquare, targetSquare }) => onDrop(sourceSquare, targetSquare),
                onSquareClick: ({ square }) => onSquareClick(square),
                showAnimations: true,
              }}
            />
          </BoardStage>
        </div>
      </div>

      <aside className="flex h-[calc(100vh-1.5rem)] flex-col overflow-hidden rounded-md border border-white/10 bg-[#203746]/82 p-4 shadow-2xl shadow-black/20">
        {panelTab === "analysis" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-white">Analysis</h2>
              <div className="rounded-md border border-white/10 bg-[#101214] px-3 py-1 text-sm font-bold text-white">
                {isLoading ? "..." : evalData?.eval.display ?? "0.00"}
              </div>
            </div>
            <div className="mt-3 rounded-md border border-white/10 bg-[#142531] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-stone-200">
                      <BarChart3 size={12} />
                    </span>
                    <span className="truncate text-sm font-semibold">
                      {branchOriginPly !== null ? `Branch line from move ${branchOriginPly}` : hasMoves ? "Analysis position" : "Starting position"}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-5 text-stone-300">
                    {evalData?.best_move_san
                      ? `Best move is ${evalData.best_move_san}. The board stays interactive, so you can keep exploring from here.`
                      : "Make moves on the board or load a PGN to start a deeper review."}
                  </p>
                </div>
                <div className="shrink-0 rounded-md bg-black/25 px-2 py-1 text-sm font-bold text-white">
                  {isLoading ? "..." : evalData?.eval.display ?? "0.00"}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-stone-300">
                <span className="rounded-md bg-white/[0.06] px-2 py-1">Turn {evalData?.turn === "black" ? "Black" : "White"}</span>
                <span className="rounded-md bg-white/[0.06] px-2 py-1">Material {evalData?.material_balance_display ?? "+0.0"}</span>
                <span className="rounded-md bg-white/[0.06] px-2 py-1">{evalData?.source === "stockfish" ? `Depth ${evalData.engine_depth}` : "Fallback"}</span>
              </div>
              <CompactEngineLines
                lines={evalData?.engine_lines ?? []}
                positionStatus={gameStatus(game)}
                sourceLabel={evalData?.source === "stockfish" ? `Depth ${evalData.engine_depth}` : "Fallback"}
              />
            </div>
            {liveError ? (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-red-300/20 bg-red-500/10 p-3 text-sm text-red-100">
                <AlertCircle className="mt-0.5 shrink-0" size={16} />
                <span>{liveError}</span>
              </div>
            ) : null}
            {branchOriginPly !== null && analysis ? (
              <MoveList
                activePly={0}
                onSelect={onMainlineSelect}
                rows={reviewRows}
                timeline={
                  <AdvantageTimeline
                    analysis={analysis}
                    activePly={branchOriginPly}
                    onSelectPly={onMainlineSelect}
                    embedded
                  />
                }
                variation={branchVariation}
              />
            ) : (
              <LiveMoveList hasMoves={hasMoves} rows={rows} />
            )}
            <div className="mt-3 grid grid-cols-4 gap-2">
              <button
                onClick={onUndo}
                disabled={!hasMoves}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
              >
                <Undo2 size={18} />
                Undo
              </button>
              <button
                onClick={onRedo}
                disabled={!canRedo}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40"
              >
                <ChevronRight size={18} />
                Redo
              </button>
              <button
                onClick={onReset}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-white/10 text-sm font-semibold transition hover:bg-white/10"
              >
                <RotateCcw size={18} />
                Reset
              </button>
              <button
                onClick={onAnalyzeLive}
                disabled={!hasMoves}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-emerald-300 px-3 text-sm font-bold text-stone-950 transition hover:bg-emerald-200 disabled:opacity-50"
              >
                <Sparkles size={17} />
                Review
              </button>
            </div>
            {branchOriginPly !== null ? (
              <button
                onClick={onReturnToReview}
                className="mt-3 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-sky-200/25 bg-sky-300/10 px-4 text-sm font-semibold text-sky-100 transition hover:bg-sky-300/15"
              >
                <GitBranch size={16} />
                Return To Mainline Review
              </button>
            ) : null}
          </div>
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
              <h2 className="text-xl font-semibold text-white">Recent Games</h2>
              <span className="text-sm text-stone-500">Max 5</span>
            </div>
            {savedGames.length ? (
              savedGames.map((game) => (
                <button
                  key={game.id}
                  onClick={() => onLoadSaved(game)}
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
  rows: { moveNumber: number; white?: string; black?: string }[];
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
                <LiveMoveCell san={row.white} color="white" />
                <LiveMoveCell san={row.black} color="black" />
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
  san,
}: {
  color: "white" | "black";
  san?: string;
}) {
  if (!san) return <div className="h-6 rounded-sm" />;

  const glyph = pieceGlyphFromSan(san, color);
  const moveText = glyph ? san.slice(1) : san;

  return (
    <div className="flex h-6 items-center rounded-sm px-2 text-[11px] font-semibold text-stone-300">
      {glyph ? <span className="mr-1 text-[12px] leading-none opacity-90">{glyph}</span> : null}
      <span className="truncate">{moveText}</span>
    </div>
  );
}

function EvalBar({ score, whitePercent }: { score: EvalScore | null; whitePercent: number }) {
  const blackPercent = 100 - whitePercent;
  const whiteAdvantage = whitePercent >= 50;
  const labelPlacement = whiteAdvantage ? "bottom-1" : "top-1";
  const labelTone = whiteAdvantage ? "white" : "black";

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
          style={{ top: `${blackPercent}%` }}
        />
      </div>
      <div
        className={`pointer-events-none absolute left-1/2 min-w-[38px] -translate-x-1/2 rounded-sm px-1.5 py-1 text-center text-[10px] font-black leading-none shadow-md ${
          labelTone === "white"
            ? "bg-[#f4ead8] text-stone-950 ring-1 ring-stone-950/15"
            : "bg-[#2d2d2b] text-white ring-1 ring-white/15"
        } ${labelPlacement}`}
      >
        {score?.display ?? "0.00"}
      </div>
    </div>
  );
}

function ReviewPanel({
  activePly,
  analysis,
  canStepBack,
  canStepForward,
  engineLines,
  selectedMove,
  evalScore,
  onFirst,
  onLast,
  onNext,
  onPlayFromPosition,
  onPrev,
  positionStatus,
  onSelectPly,
  rows,
}: {
  activePly: number;
  analysis: AnalysisResult;
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
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-400">{analysis.metadata.opening} · {analysis.metadata.result}</p>
          <h2 className="text-xl font-semibold text-white">Game Review</h2>
        </div>
        <div className="rounded-md border border-white/10 bg-[#101214] px-3 py-1 text-sm font-bold text-white">{evalScore?.display ?? "0.00"}</div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 rounded-md bg-[#142531] p-1">
        <PanelTabButton active={reviewTab === "review"} icon={<Star size={16} />} label="Review" onClick={() => setReviewTab("review")} />
        <PanelTabButton active={reviewTab === "moves"} icon={<List size={16} />} label="Moves" onClick={() => setReviewTab("moves")} />
        <PanelTabButton active={reviewTab === "graph"} icon={<BarChart3 size={16} />} label="Graph" onClick={() => setReviewTab("graph")} />
      </div>

      {reviewTab === "review" ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="rounded-md border border-white/10 bg-[#142531] p-2.5 text-stone-100 shadow-lg shadow-black/20">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full border px-1 text-[11px] font-black ${selectedMove ? classificationTone(selectedMove.classification) : "border-white/10 bg-white/[0.06] text-stone-200"}`}>
                    {selectedMove ? classificationIndicator(selectedMove.classification) : <Sparkles size={11} />}
                  </span>
                  <span className="truncate text-sm font-semibold">{activeLabel}</span>
                </div>
                <p className="mt-1.5 text-[11px] leading-5 text-stone-300">
                  {selectedMove ? selectedMove.explanation : "The board stays in review mode. Click any move on the right to snap the position."}
                </p>
              </div>
              <div className="shrink-0 rounded-md bg-black/25 px-2 py-1 text-sm font-bold text-white">{evalScore?.display ?? "0.00"}</div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-stone-300">
              <span className="rounded-md bg-white/[0.06] px-2 py-1">Material {selectedMove?.material_balance_display ?? summary.material_balance_display}</span>
              {selectedMove?.captured_piece ? (
                <span className="rounded-md bg-white/[0.06] px-2 py-1">
                  Captured {selectedMove.captured_piece.type} {materialCaptureLabel(selectedMove.captured_piece)}
                </span>
              ) : null}
            </div>
            <CompactEngineLines lines={engineLines} positionStatus={positionStatus} sourceLabel={engineSource} />
          </div>
          <div className="mt-auto space-y-3 pt-3">
            {navigation}
            <PlayFromPositionButton onClick={onPlayFromPosition} />
          </div>
        </div>
      ) : null}

      {reviewTab === "moves" ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          <MoveList rows={rows} activePly={activePly} onSelect={onSelectPly} />
          <div className="mt-3 space-y-3">
            {navigation}
            <PlayFromPositionButton onClick={onPlayFromPosition} />
          </div>
        </div>
      ) : null}

      {reviewTab === "graph" ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          <div className="rounded-md border border-white/10 bg-[#142531] p-3">
            <AdvantageTimeline analysis={analysis} activePly={activePly} onSelectPly={onSelectPly} />
          </div>
          <div className="mt-auto space-y-3 pt-3">
            {navigation}
            <PlayFromPositionButton onClick={onPlayFromPosition} />
          </div>
        </div>
      ) : null}
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
  const height = embedded ? 72 : 92;
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
    <div className={embedded ? "rounded-md border border-white/10 bg-[#101c25] p-1.5" : "mt-3 rounded-md border border-white/10 bg-[#142531] p-2.5 shadow-lg shadow-black/20"}>
      <div className={`overflow-hidden rounded-md border border-white/10 bg-[#101c25] ${embedded ? "" : "mt-2"}`}>
        <div className="flex items-center justify-between px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-stone-500">
          <span>White</span>
          <span>{analysis.moves.length} plies</span>
          <span>Black</span>
        </div>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className={`block w-full cursor-pointer ${embedded ? "h-[76px]" : "h-[104px]"}`}
          onClick={handleSelect}
          role="img"
          aria-label="Advantage graph"
        >
          <defs>
            <linearGradient id="advantage-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgba(226, 232, 240, 0.2)" />
              <stop offset="48%" stopColor="rgba(125, 211, 252, 0.18)" />
              <stop offset="52%" stopColor="rgba(34, 197, 94, 0.14)" />
              <stop offset="100%" stopColor="rgba(10, 15, 21, 0.04)" />
            </linearGradient>
          </defs>

          <rect x="0" y="0" width={width} height={midY} fill="rgba(255,255,255,0.02)" />
          <rect x="0" y={midY} width={width} height={midY} fill="rgba(0,0,0,0.18)" />
          <line x1={0} y1={midY} x2={width} y2={midY} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 4" />

          {areaPath ? <path d={areaPath} fill="url(#advantage-fill)" /> : null}
          {linePath ? (
            <path
              d={linePath}
              fill="none"
              stroke="rgba(125, 211, 252, 0.95)"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}

          {turningPoint ? (
            <circle
              cx={turningPoint.x}
              cy={turningPoint.y}
              r="3.5"
              fill="rgba(251, 191, 36, 0.95)"
              stroke="rgba(15, 23, 42, 0.95)"
              strokeWidth="1.5"
            />
          ) : null}

          {swingMoves.map((move) => {
            const point = points[move.ply];
            if (!point) return null;
            const tone = move.classification === "blunder"
              ? "rgba(248, 113, 113, 0.9)"
              : move.classification === "mistake"
                ? "rgba(251, 146, 60, 0.9)"
                : "rgba(250, 204, 21, 0.9)";
            return (
              <line
                key={`swing-${move.ply}`}
                x1={point.x}
                y1={midY - 5}
                x2={point.x}
                y2={midY + 5}
                stroke={tone}
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            );
          })}

          {activePoint ? (
            <>
              <line
                x1={activePoint.x}
                y1={paddingY / 2}
                x2={activePoint.x}
                y2={height - paddingY / 2}
                stroke="rgba(255,255,255,0.18)"
                strokeDasharray="3 4"
              />
              <circle
                cx={activePoint.x}
                cy={activePoint.y}
                r="4.5"
                fill="rgba(248, 250, 252, 0.98)"
                stroke="rgba(14, 116, 144, 0.95)"
                strokeWidth="2"
              />
            </>
          ) : null}
        </svg>
        <div className="flex items-center justify-between px-2 py-1 text-[10px] text-stone-500">
          <span>Start</span>
          <span>{activePoint ? `Ply ${activePoint.ply} · ${activePoint.score.display}` : "Even"}</span>
          <span>End</span>
        </div>
      </div>

      <div className={`text-[10px] text-stone-400 ${embedded ? "mt-1" : "mt-1.5"}`}>
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
}: {
  bottomPlayer: BoardPlayer;
  topPlayer: BoardPlayer;
  children: ReactNode;
}) {
  const topMaterialLead = captureMaterialTotal(topPlayer.captures) - captureMaterialTotal(bottomPlayer.captures);
  const bottomMaterialLead = captureMaterialTotal(bottomPlayer.captures) - captureMaterialTotal(topPlayer.captures);

  return (
    <div className="flex min-h-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-[#243b4a]/70 p-2 shadow-2xl shadow-black/20 sm:p-3">
      <div className="flex h-full w-full max-w-[880px] min-w-0 flex-col justify-center gap-1.5">
        <BoardPlayerStrip materialLead={topMaterialLead} player={topPlayer} />
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
          <div className="h-full aspect-square max-h-full max-w-full">{children}</div>
        </div>
        <BoardPlayerStrip materialLead={bottomMaterialLead} player={bottomPlayer} />
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
            <span className="shrink-0 text-[11px] font-semibold leading-none text-stone-400">{player.accuracy}%</span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-0.5 text-[15px] leading-none text-stone-300">
          {player.captures.length ? (
            <>
              {player.captures.slice(0, 7).map((piece, index) => (
                <CapturedPieceIcon key={`${player.color}-${piece.type}-${piece.color}-${index}`} piece={piece} />
              ))}
              {player.captures.length > 7 ? <span className="text-xs text-stone-400">+{player.captures.length - 7}</span> : null}
              {leadLabel ? <span className="ml-1 text-xs font-semibold text-stone-400">{leadLabel}</span> : null}
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
  const isWhitePiece = piece.color === "white";

  return (
    <span
      className={`inline-flex w-[18px] justify-center text-[18px] font-black leading-none ${
        isWhitePiece
          ? "text-[#f3f0e8] [text-shadow:0_1px_1px_rgba(0,0,0,0.75),0_0_1px_rgba(0,0,0,0.9)]"
          : "text-[#171a1d] [text-shadow:0_1px_0_rgba(255,255,255,0.34),0_0_1px_rgba(0,0,0,0.8)]"
      }`}
      title={`${piece.color} ${piece.type}`}
    >
      {capturedPieceGlyph(piece.type, piece.color)}
    </span>
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
      <div className="mb-1 flex items-center justify-between gap-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-stone-500">
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
              <span className={`inline-flex h-5 w-full shrink-0 items-center justify-center rounded-sm text-[10px] font-bold ${
                line.rank === 1
                  ? "bg-emerald-300/80 text-emerald-950"
                  : "bg-white/12 text-stone-200"
              }`}>
                {line.eval.display}
              </span>
              <span className="min-w-0 truncate font-mono text-[10px] text-stone-300">
                {line.line.slice(0, 5).join(" ") || line.move_san || line.move || "-"}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-sm bg-black/12 px-1.5 py-1 text-[10px] text-stone-500">
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
      <div className="grid grid-cols-[26px_minmax(0,1fr)_minmax(0,1fr)] gap-x-1.5 gap-y-0.5 py-1 text-[11px]">
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
      className={`grid h-6 grid-cols-[minmax(0,1fr)_14px] items-center gap-1 rounded-sm px-2 text-left text-[11px] transition ${
        isActive
          ? "bg-sky-300/14 text-white shadow-[inset_0_-1px_0_rgba(125,211,252,0.95)]"
          : "text-stone-300 hover:bg-white/[0.06] hover:text-white"
      }`}
    >
      <span className="inline-flex min-w-0 items-center gap-1 truncate font-semibold">
        {glyph ? <span className="text-[12px] leading-none opacity-90">{glyph}</span> : null}
        <span className="truncate">{moveText}</span>
      </span>
      <span
        className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border px-0.5 text-[8px] font-black ${classificationTone(move.classification)}`}
        title={move.classification}
      >
        {classificationIndicator(move.classification)}
      </span>
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
      {glyph ? <span className="text-[11px] leading-none opacity-90">{glyph}</span> : null}
      <span className="truncate">{moveText}</span>
    </div>
  );
}
