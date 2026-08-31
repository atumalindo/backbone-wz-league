import axios from "axios";
import { BuildPrizeBands } from "./TournamentRules";

export interface TournamentPrize {
  position: number;
  endPosition: number;
  amount: number;
  label: string;
}

/** Distribui o pool total entre as colocações, sempre preservando a soma integral. */
export function BuildPrizeDistribution(totalGems: number, maxInvites: number, tournamentOrParty: any): TournamentPrize[] {
  return BuildPrizeBands(totalGems, maxInvites, tournamentOrParty);
}

function EconomyBases(): string[] {
  return [process.env.ECONOMY_API_URL, process.env.GEMS_API_URL, process.env.BACKEND_URL, process.env.UNIVERSAL_BACKEND_URL, process.env.API_URL]
    .filter(Boolean)
    .map((url) => String(url).replace(/\/$/, ""));
}

/** Debita a taxa de entrada no serviço de economia configurado. Sem serviço configurado, taxa zero continua gratuita. */
export async function ChargeTournamentEntry(userId: string, tournamentId: string, amount: number, eventId = `signup:${String(tournamentId)}:${String(userId)}`): Promise<{ ok: boolean; balance?: number }> {
  const gems = Math.max(0, Math.floor(Number(amount) || 0));
  if (gems === 0) return { ok: true };
  const bases = [...new Set(EconomyBases())];
  if (bases.length === 0) return { ok: false };

  const paths = (process.env.GEMS_CHARGE_PATH || "/user/gems/charge,/user/gems/debit").split(",").map((path) => path.trim()).filter(Boolean);
  let lastError: unknown;
  for (const base of bases) {
    for (const path of paths) {
      try {
        const response = await axios.post(`${base}${path.startsWith("/") ? path : `/${path}`}`, { userId: String(userId), tournamentId: String(tournamentId), amount: gems, gems, eventId }, { timeout: 8000, headers: { "Content-Type": "application/json", ...(process.env.ECONOMY_INTERNAL_SECRET ? { "X-Economy-Secret": process.env.ECONOMY_INTERNAL_SECRET } : {}) } });
        const body = response.data || {};
        if (body.ok === false || body.success === false || body.status === "insufficient_funds" || body.status === "not_enough_gems") continue;
        return { ok: true, balance: Number(body.balance ?? body.gems ?? body.gemBalance) || undefined };
      } catch (error) {
        lastError = error;
      }
    }
  }
  console.error(`[economy] Falha ao debitar ${gems} gemas do usuário ${userId}`, lastError);
  return { ok: false };
}

export async function RefundTournamentEntry(userId: string, tournamentId: string, amount: number, eventId = `refund:${String(tournamentId)}:${String(userId)}`): Promise<void> {
  const gems = Math.max(0, Math.floor(Number(amount) || 0));
  if (gems === 0) return;
  const base = EconomyBases()[0];
  if (!base) return;
  const path = process.env.GEMS_REFUND_PATH || "/user/gems/refund";
  await axios.post(`${base}${path.startsWith("/") ? path : `/${path}`}`, { userId: String(userId), tournamentId: String(tournamentId), amount: gems, gems, eventId }, { timeout: 8000, headers: { "Content-Type": "application/json", ...(process.env.ECONOMY_INTERNAL_SECRET ? { "X-Economy-Secret": process.env.ECONOMY_INTERNAL_SECRET } : {}) } }).catch((error) => console.error("[economy] Falha ao estornar gemas", error));
}


export type TournamentPrizeAward = {
  mode: "gems" | "tag";
  amount?: number;
  tag?: string;
  expiresAt?: string | null;
  position: number;
};

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + Math.max(1, months));
  return result;
}

export function ResolveTournamentPrize(tournament: any, position: number): TournamentPrizeAward {
  const mode = tournament?.PrizeMode === "tag" ? "tag" : "gems";
  if (mode === "tag") {
    const value = Math.max(1, Number(tournament.PrizeTagDurationValue) || 1);
    const unit = tournament.PrizeTagDurationUnit || "permanent";
    let expiresAt: string | null = null;
    if (unit !== "permanent") {
      const now = new Date();
      const expires = unit === "hours" ? new Date(now.getTime() + value * 60 * 60 * 1000) : unit === "days" ? new Date(now.getTime() + value * 24 * 60 * 60 * 1000) : addMonths(now, value);
      expiresAt = expires.toISOString();
    }
    return { mode, tag: String(tournament.PrizeTag || "").trim(), expiresAt, position };
  }
  const prize = (tournament.Prizes || []).find((item: any) => position >= Number(item.position || 0) && position <= Number(item.endPosition || item.position || 0)) || (tournament.Prizes || [])[0];
  return { mode, amount: Math.max(0, Number(prize?.amount) || 0), position };
}

export async function AwardTournamentPrize(userId: string, nick: string, tournament: any, position: number): Promise<boolean> {
  const award = ResolveTournamentPrize(tournament, position);
  if (award.mode === "tag" && !award.tag) return false;
  if (award.mode === "gems" && !award.amount) return false;
  const base = EconomyBases()[0];
  if (!base) return false;
  const path = award.mode === "tag" ? "/user/tags/award" : "/user/gems/payout";
  const body = award.mode === "tag"
    ? { userId: String(userId), nick, tagName: award.tag, expiresAt: award.expiresAt, tournamentId: String(tournament.TournamentId), position, eventId: `payout:tag:${String(tournament.TournamentId)}:${String(userId)}:${position}` }
    : { userId: String(userId), nick, amount: award.amount, gems: award.amount, tournamentId: String(tournament.TournamentId), position, eventId: `payout:gems:${String(tournament.TournamentId)}:${String(userId)}:${position}` };
  try {
    const response = await axios.post(`${base}${path}`, body, { timeout: 10000, headers: { "Content-Type": "application/json", "X-Economy-Secret": process.env.ECONOMY_INTERNAL_SECRET || "" } });
    const data = response.data || {};
    return data.ok !== false && data.success !== false;
  } catch (error) {
    console.error(`[economy] Falha no payout ${award.mode} user=${userId} tournament=${tournament.TournamentId}`, error);
    return false;
  }
}
