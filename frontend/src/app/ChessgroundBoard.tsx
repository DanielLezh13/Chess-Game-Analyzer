"use client";

import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Config } from "@lichess-org/chessground/config";
import type { Key, Color as CgColor } from "@lichess-org/chessground/types";

import "./chessground.css";

export type ChessgroundBoardProps = {
  fen: string;
  orientation?: "white" | "black";
  turnColor?: "white" | "black";
  viewOnly?: boolean;

  // legal move destinations: Map<fromSquare, toSquare[]>
  dests?: Map<string, string[]>;

  // animation
  animationEnabled?: boolean;
  animationDuration?: number;

  // events
  onMove?: (orig: string, dest: string, capturedPiece?: { color: string; role: string }) => void;
  onSelect?: (key: string) => void;

  // custom square colors
  darkSquareColor?: string;
  lightSquareColor?: string;
  mountDelayMs?: number;

  children?: ReactNode;
};

export default function ChessgroundBoard({
  fen,
  orientation = "white",
  turnColor = "white",
  viewOnly = false,
  dests,
  animationEnabled = true,
  animationDuration = 180,
  onMove,
  onSelect,
  darkSquareColor = "#6f95a8",
  lightSquareColor = "#d7e5e8",
  mountDelayMs = 0,
  children,
}: ChessgroundBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const cgRef = useRef<Api | null>(null);
  const [boardRevision, setBoardRevision] = useState(0);

  // Store callbacks in refs to avoid re-creating chessground on callback change
  const onMoveRef = useRef(onMove);
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    onMoveRef.current = onMove;
    onSelectRef.current = onSelect;
  }, [onMove, onSelect]);

  // Initialize chessground once
  useEffect(() => {
    if (!boardRef.current) return;

    let cg: Api | null = null;
    let mountTimer: number | null = null;
    const settleTimers: number[] = [];

    const mountBoard = () => {
      if (!boardRef.current) return;

      const config: Config = {
        fen,
        orientation: orientation as CgColor,
        turnColor: turnColor as CgColor,
        viewOnly,
        coordinates: false,
        highlight: {
          lastMove: false,
          check: false,
        },
        animation: {
          enabled: animationEnabled,
          duration: animationDuration,
        },
        movable: {
          free: false,
          color: turnColor as CgColor,
          dests: (dests ?? new Map()) as Map<Key, Key[]>,
          showDests: false,
        },
        draggable: {
          enabled: !viewOnly,
          distance: 0,
          showGhost: false,
        },
        selectable: {
          enabled: !viewOnly,
        },
        events: {
          move: (orig, dest, capturedPiece) => {
            onMoveRef.current?.(orig, dest, capturedPiece as { color: string; role: string } | undefined);
          },
          select: (key) => {
            onSelectRef.current?.(key);
          },
        },
        drawable: {
          enabled: false,
          visible: false,
        },
      };

      cg = Chessground(boardRef.current, config);
      cgRef.current = cg;
      setBoardRevision((revision) => revision + 1);

      [420].forEach((delay) => {
        const timer = window.setTimeout(() => {
          cgRef.current?.redrawAll();
          setBoardRevision((revision) => revision + 1);
        }, delay);
        settleTimers.push(timer);
      });
    };

    if (mountDelayMs > 0) {
      mountTimer = window.setTimeout(mountBoard, mountDelayMs);
    } else {
      mountBoard();
    }

    return () => {
      if (mountTimer !== null) {
        window.clearTimeout(mountTimer);
      }
      settleTimers.forEach((timer) => window.clearTimeout(timer));
      cg?.destroy();
      cgRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update config when props change
  useEffect(() => {
    if (!cgRef.current) return;

    cgRef.current.set({
      fen,
      orientation: orientation as CgColor,
      turnColor: turnColor as CgColor,
      viewOnly,
      animation: {
        enabled: animationEnabled,
        duration: animationDuration,
      },
      movable: {
        free: false,
        color: turnColor as CgColor,
        dests: (dests ?? new Map()) as Map<Key, Key[]>,
        showDests: false,
      },
      draggable: {
        enabled: !viewOnly,
        distance: 0,
        showGhost: false,
      },
      selectable: {
        enabled: !viewOnly,
      },
      highlight: {
        lastMove: false,
        check: false,
      },
    });
  }, [fen, orientation, turnColor, viewOnly, animationEnabled, animationDuration, dests]);

  // Paint custom square colors via canvas background
  useEffect(() => {
    if (!boardRef.current) return;
    const board = boardRef.current.querySelector("cg-board") as HTMLElement | null;
    if (!board) return;

    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const isDark = (row + col) % 2 === 1;
        ctx.fillStyle = isDark ? darkSquareColor : lightSquareColor;
        ctx.fillRect(col, row, 1, 1);
      }
    }

    board.style.backgroundImage = `url(${canvas.toDataURL()})`;
    board.style.backgroundSize = "cover";
    board.style.imageRendering = "pixelated";
  }, [boardRevision, darkSquareColor, lightSquareColor]);

  // Use portals to render overlays into cg-board after chessground creates it
  const [highlightContainer, setHighlightContainer] = useState<HTMLElement | null>(null);
  const [arrowContainer, setArrowContainer] = useState<HTMLElement | null>(null);
  const [coordinateContainer, setCoordinateContainer] = useState<HTMLElement | null>(null);
  const [badgeContainer, setBadgeContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!boardRef.current) return;
    // Find cg-board after chessground initializes
    const cgBoard = boardRef.current.querySelector("cg-board") as HTMLElement | null;
    if (cgBoard) {
      // Create highlight layer (z-[1], behind pieces)
      let highlightDiv = cgBoard.querySelector(".custom-highlights") as HTMLElement | null;
      if (!highlightDiv) {
        highlightDiv = document.createElement("div");
        highlightDiv.className = "custom-highlights pointer-events-none absolute inset-0 z-[1]";
        highlightDiv.style.boxSizing = "content-box";
        cgBoard.appendChild(highlightDiv);
      }
      setHighlightContainer(highlightDiv);

      // Create arrow layer (z-[3], above pieces)
      let arrowDiv = cgBoard.querySelector(".custom-arrows") as HTMLElement | null;
      if (!arrowDiv) {
        arrowDiv = document.createElement("div");
        arrowDiv.className = "custom-arrows pointer-events-none absolute inset-0 z-[3]";
        arrowDiv.style.boxSizing = "content-box";
        cgBoard.appendChild(arrowDiv);
      }
      setArrowContainer(arrowDiv);

      let coordinateDiv = cgBoard.querySelector(".custom-coordinates") as HTMLElement | null;
      if (!coordinateDiv) {
        coordinateDiv = document.createElement("div");
        coordinateDiv.className = "custom-coordinates pointer-events-none absolute inset-0 z-[4]";
        coordinateDiv.style.boxSizing = "content-box";
        coordinateDiv.style.imageRendering = "auto";
        cgBoard.appendChild(coordinateDiv);
      }
      setCoordinateContainer(coordinateDiv);

      // Keep badges outside cg-board so they don't inherit the pixelated board rendering.
      let badgeDiv = boardRef.current.querySelector(":scope > .custom-badges") as HTMLElement | null;
      if (!badgeDiv) {
        badgeDiv = document.createElement("div");
        badgeDiv.className = "custom-badges pointer-events-none absolute inset-0 z-[5]";
        badgeDiv.style.boxSizing = "content-box";
        boardRef.current.appendChild(badgeDiv);
      }
      setBadgeContainer(badgeDiv);
    }
  }, [boardRevision]);

  // Separate children into different layers
  const getLayer = (c: ReactNode): "highlight" | "arrow" | "badge" => {
    if (!c || typeof c !== "object") return "highlight";
    const typeName = ((c as { type?: { name?: string } }).type?.name ?? "").toLowerCase();
    if (typeName.includes("arrow") || typeName.includes("capture")) return "arrow";
    if (typeName.includes("badgeoverlay")) return "badge";
    if (typeName.includes("squareoverlay")) return "highlight"; // BoardSquareOverlay is highlights
    return "highlight";
  };

  const highlights = children && Array.isArray(children)
    ? children.filter((c) => getLayer(c) === "highlight")
    : children;

  const arrows = children && Array.isArray(children)
    ? children.filter((c) => getLayer(c) === "arrow")
    : null;

  const badges = children && Array.isArray(children)
    ? children.filter((c) => getLayer(c) === "badge")
    : null;

  return (
    <div
      ref={boardRef}
      className="cg-wrap"
      style={{ position: "relative", width: "100%", height: "100%", borderRadius: "3px", overflow: "hidden" }}
    >
      {highlightContainer ? createPortal(highlights, highlightContainer) : null}
      {arrowContainer ? createPortal(arrows, arrowContainer) : null}
      {coordinateContainer ? createPortal(<BoardCoordinateOverlay orientation={orientation} />, coordinateContainer) : null}
      {badgeContainer ? createPortal(badges, badgeContainer) : null}
    </div>
  );
}

// Helper: convert square name to grid position (0-indexed col, row from top-left for white orientation)
export function squareToPos(square: string, orientation: "white" | "black"): { col: number; row: number } {
  const file = square.charCodeAt(0) - 97; // a=0, h=7
  const rank = parseInt(square[1]) - 1;   // 1=0, 8=7
  if (orientation === "white") {
    return { col: file, row: 7 - rank };
  }
  return { col: 7 - file, row: rank };
}

function BoardCoordinateOverlay({ orientation = "white" }: { orientation?: "white" | "black" }) {
  const files = orientation === "white"
    ? ["a", "b", "c", "d", "e", "f", "g", "h"]
    : ["h", "g", "f", "e", "d", "c", "b", "a"];
  const ranks = orientation === "white"
    ? ["8", "7", "6", "5", "4", "3", "2", "1"]
    : ["1", "2", "3", "4", "5", "6", "7", "8"];
  const coordinateTextStyle: CSSProperties = {
    fontSize: "clamp(8px, 1.7cqw, 14px)",
    lineHeight: 1,
    padding: "clamp(2px, 0.55cqw, 5px)",
  };

  function coordinateColor(row: number, col: number) {
    return (row + col) % 2 === 1 ? "rgba(216, 235, 240, 0.88)" : "rgba(25, 54, 68, 0.76)";
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-[4] select-none">
      {ranks.map((rank, row) => (
        <span
          key={`rank-${rank}`}
          className="absolute font-black"
          style={{
            ...coordinateTextStyle,
            color: coordinateColor(row, 0),
            textShadow: "0 1px 1px rgba(255,255,255,0.18)",
            left: "0%",
            top: `${row * 12.5}%`,
            width: "12.5%",
            height: "12.5%",
          }}
        >
          {rank}
        </span>
      ))}
      {files.map((file, col) => (
        <span
          key={`file-${file}`}
          className="absolute flex items-end justify-end font-black"
          style={{
            ...coordinateTextStyle,
            color: coordinateColor(7, col),
            textShadow: "0 1px 1px rgba(255,255,255,0.18)",
            left: `${col * 12.5}%`,
            top: "87.5%",
            width: "12.5%",
            height: "12.5%",
          }}
        >
          {file}
        </span>
      ))}
    </div>
  );
}

// Overlay component for square highlights and legal moves (z-[1], behind pieces)
export function BoardSquareOverlay({
  squareOverlays,
  legalMoves,
  captureMoves,
  orientation = "white",
}: {
  squareOverlays?: Record<string, CSSProperties>;
  legalMoves?: Set<string>;
  captureMoves?: Set<string>;
  orientation?: "white" | "black";
}) {
  const overlayEntries = squareOverlays ? Object.entries(squareOverlays) : [];
  const legalMoveEntries = legalMoves ? [...legalMoves] : [];

  return (
    <>
      {/* Square color overlays (highlights) */}
      {overlayEntries.map(([sq, style]) => {
        const pos = squareToPos(sq, orientation);
        return (
          <div
            key={`ov-${sq}`}
            className="absolute top-0 left-0"
            style={{
              width: "12.5%",
              height: "12.5%",
              transform: `translate(${pos.col * 100}%, ${pos.row * 100}%)`,
              backgroundColor: style.backgroundColor,
              boxShadow: style.boxShadow,
            }}
          />
        );
      })}

      {/* Legal move dots / capture rings */}
      {legalMoveEntries.map((sq) => {
        const pos = squareToPos(sq, orientation);
        const isCapture = captureMoves?.has(sq);
        return (
          <div
            key={`lm-${sq}`}
            className="absolute top-0 left-0 flex items-center justify-center"
            style={{
              width: "12.5%",
              height: "12.5%",
              transform: `translate(${pos.col * 100}%, ${pos.row * 100}%)`,
              animation: "fadeIn 150ms ease-out",
            }}
          >
            {isCapture ? (
              <div
                className="rounded-full"
                style={{
                  width: "100%",
                  height: "100%",
                  border: "4px solid rgba(128, 128, 128, 0.5)",
                  backgroundColor: "transparent",
                }}
              />
            ) : (
              <div
                className="rounded-full"
                style={{
                  width: "33.33%",
                  height: "33.33%",
                  backgroundColor: "rgba(128, 128, 128, 0.5)",
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

// Overlay component for move badges (z-[5], above everything)
export function BoardBadgeOverlay({
  annotations,
  orientation = "white",
}: {
  annotations?: Record<string, { label: string; tone: string; iconSrc?: string }>;
  orientation?: "white" | "black";
}) {
  const annotationEntries = annotations ? Object.entries(annotations) : [];

  return (
    <>
      {annotationEntries.map(([sq, ann]) => {
        const pos = squareToPos(sq, orientation);
        const isRightEdge = pos.col === 7;
        const isTopEdge = pos.row === 0;
        const annotationStyle: CSSProperties = isTopEdge && isRightEdge
          ? { top: 4, right: 4, transform: "none" }
          : isTopEdge
            ? { top: 4, right: 0, transform: "translate(38%, 0)" }
            : isRightEdge
              ? { top: 0, right: 4, transform: "translate(0, -38%)" }
              : { top: 0, right: 0, transform: "translate(38%, -38%)" };

        return (
          <div
            key={`ann-${sq}`}
            className="absolute top-0 left-0"
            style={{
              width: "12.5%",
              height: "12.5%",
              transform: `translate(${pos.col * 100}%, ${pos.row * 100}%)`,
            }}
          >
            <div className="relative h-full w-full">
              {ann.iconSrc ? (
                <img
                  src={ann.iconSrc}
                  alt={ann.label}
                  className="board-badge-image pointer-events-none absolute z-40 h-[52%] w-[52%] object-contain"
                  style={annotationStyle}
                />
              ) : (
                <span
                  className={`move-badge-text pointer-events-none absolute z-40 h-[44%] min-w-[44%] rounded-full px-1.5 shadow-sm ${ann.tone}`}
                  style={annotationStyle}
                >
                  {ann.label}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
