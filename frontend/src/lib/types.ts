export type Classification =
  | "book"
  | "brilliant"
  | "best"
  | "great"
  | "excellent"
  | "good"
  | "miss"
  | "inaccuracy"
  | "mistake"
  | "blunder";

export type EvalScore = {
  cp: number;
  mate: number | null;
  display: string;
};

export type EngineLine = {
  rank: number;
  move: string | null;
  move_san: string | null;
  line: string[];
  eval: EvalScore;
};

export type AnalysisMove = {
  ply: number;
  move_number: number;
  color: "white" | "black";
  san: string;
  uci: string;
  fen_before: string;
  fen_after: string;
  captured_piece: {
    type: "pawn" | "knight" | "bishop" | "rook" | "queen";
    color: "white" | "black";
    value: number;
  } | null;
  material_balance_cp: number;
  material_balance_display: string;
  is_book?: boolean;
  opening?: string;
  eco?: string;
  eval_before: EvalScore;
  eval_after: EvalScore;
  best_move: string | null;
  best_move_san: string | null;
  best_line: string[];
  engine_lines: EngineLine[];
  reply_engine_lines: EngineLine[];
  centipawn_loss: number;
  expected_points_loss?: number;
  missed_tactical_gain_cp?: number;
  classification: Classification;
  explanation: string;
};

export type AnalysisResult = {
  metadata: {
    event: string;
    site: string;
    date: string;
    white: string;
    black: string;
    white_elo?: string;
    black_elo?: string;
    result: string;
    termination?: string;
    opening: string;
    initial_fen: string;
    analysis_source: string;
    engine_depth: number;
  };
  moves: AnalysisMove[];
  summary: {
    white: SideSummary;
    black: SideSummary;
    material_balance_cp: number;
    material_balance_display: string;
    captured: {
      white: { type: "pawn" | "knight" | "bishop" | "rook" | "queen"; color: "white" | "black"; value: number }[];
      black: { type: "pawn" | "knight" | "bishop" | "rook" | "queen"; color: "white" | "black"; value: number }[];
    };
    biggest_turning_point: {
      ply: number;
      move_number: number;
      color: "white" | "black";
      san: string;
      centipawn_loss: number;
      classification: Classification;
    } | null;
    total_plies: number;
  };
};

export type SideSummary = {
  inaccuracy: number;
  mistake: number;
  blunder: number;
  accuracy: number;
};

export type LivePositionEval = {
  fen: string;
  turn: "white" | "black";
  eval: EvalScore;
  best_move: string | null;
  best_move_san: string | null;
  best_line: string[];
  engine_lines: EngineLine[];
  source: string;
  engine_depth: number;
  material_balance_cp: number;
  material_balance_display: string;
  is_check: boolean;
  is_checkmate: boolean;
  is_draw: boolean;
};
