import type { SupabaseClient, User } from "@supabase/supabase-js";

export type CloudSavedGame = {
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

type UserGameRow = {
  id: string;
  user_id: string;
  title: string;
  subtitle: string | null;
  pgn: string;
  updated_at_ms: number;
  game_date: string | null;
  result: string;
  termination: string | null;
  move_count: number;
  final_fen: string;
  white_accuracy: number | null;
  black_accuracy: number | null;
};

function toGameRow(game: CloudSavedGame, user: User): UserGameRow {
  return {
    id: game.id,
    user_id: user.id,
    title: game.title,
    subtitle: game.subtitle || null,
    pgn: game.pgn,
    updated_at_ms: game.uploadedAt || game.updatedAt,
    game_date: game.gameDate || null,
    result: game.result,
    termination: game.termination || null,
    move_count: game.moveCount,
    final_fen: game.finalFen,
    white_accuracy: game.whiteAccuracy ?? null,
    black_accuracy: game.blackAccuracy ?? null,
  };
}

function fromGameRow(row: UserGameRow): CloudSavedGame {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle ?? "",
    pgn: row.pgn,
    updatedAt: row.updated_at_ms,
    uploadedAt: row.updated_at_ms,
    gameDate: row.game_date ?? "",
    result: row.result,
    termination: row.termination ?? undefined,
    moveCount: row.move_count,
    finalFen: row.final_fen,
    whiteAccuracy: row.white_accuracy ?? undefined,
    blackAccuracy: row.black_accuracy ?? undefined,
  };
}

export async function loadCloudProfile(supabase: SupabaseClient, user: User) {
  const { data, error } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", user.id)
    .maybeSingle();

  if (error) throw error;
  return typeof data?.username === "string" ? data.username : "";
}

export async function saveCloudProfile(supabase: SupabaseClient, user: User, username: string) {
  const { error } = await supabase
    .from("profiles")
    .upsert({
      id: user.id,
      email: user.email ?? null,
      username: username.trim() || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });

  if (error) throw error;
}

export async function loadCloudGames(supabase: SupabaseClient, user: User) {
  const { data, error } = await supabase
    .from("user_games")
    .select("*")
    .eq("user_id", user.id)
    .order("game_date", { ascending: false, nullsFirst: false })
    .order("updated_at_ms", { ascending: false });

  if (error) throw error;
  return (data ?? []).map((row) => fromGameRow(row as UserGameRow));
}

export async function saveCloudGame(supabase: SupabaseClient, user: User, game: CloudSavedGame) {
  const { error } = await supabase
    .from("user_games")
    .upsert(toGameRow(game, user));

  if (error) throw error;
}

export async function saveCloudGames(supabase: SupabaseClient, user: User, games: CloudSavedGame[]) {
  if (!games.length) return;
  const { error } = await supabase
    .from("user_games")
    .upsert(games.map((game) => toGameRow(game, user)));

  if (error) throw error;
}

export async function deleteCloudGame(supabase: SupabaseClient, user: User, gameId: string) {
  const { error } = await supabase
    .from("user_games")
    .delete()
    .eq("id", gameId)
    .eq("user_id", user.id);

  if (error) throw error;
}
