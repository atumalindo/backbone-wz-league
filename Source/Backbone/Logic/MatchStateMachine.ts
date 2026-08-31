import { Match, IMatch } from "../../Models/Matches";
import { TournamentMatchStatus } from "../Config";

const AllowedTransitions: Record<number, Set<number>> = {
  [TournamentMatchStatus.Unkown]: new Set([TournamentMatchStatus.Created]),
  [TournamentMatchStatus.Created]: new Set([
    TournamentMatchStatus.WaitingForOpponent,
    TournamentMatchStatus.GameReady,
    TournamentMatchStatus.Closed,
  ]),
  [TournamentMatchStatus.WaitingForOpponent]: new Set([
    TournamentMatchStatus.GameReady,
    TournamentMatchStatus.Closed,
  ]),
  [TournamentMatchStatus.GameReady]: new Set([
    TournamentMatchStatus.GameInProgress,
    TournamentMatchStatus.Closed,
  ]),
  [TournamentMatchStatus.GameInProgress]: new Set([
    TournamentMatchStatus.GameFinished,
    TournamentMatchStatus.MatchFinished,
    TournamentMatchStatus.Closed,
  ]),
  [TournamentMatchStatus.GameFinished]: new Set([
    TournamentMatchStatus.MatchFinished,
    TournamentMatchStatus.Closed,
  ]),
  [TournamentMatchStatus.MatchFinished]: new Set([TournamentMatchStatus.Closed]),
  [TournamentMatchStatus.Closed]: new Set(),
};

export function CanTransitionMatch(from: number, to: number): boolean {
  return from === to || Boolean(AllowedTransitions[from]?.has(to));
}

export function IsTerminalMatchStatus(status: number): boolean {
  return [
    TournamentMatchStatus.Closed,
    TournamentMatchStatus.MatchFinished,
  ].includes(Number(status));
}

/** Fecha/resove uma match somente se ela ainda estiver em um estado permitido. */
export async function TransitionMatch(
  matchId: string,
  fromStatuses: number[],
  toStatus: number,
  set: Record<string, any> = {},
  unset: Record<string, any> = {}
): Promise<IMatch | null> {
  if (!fromStatuses.some((status) => CanTransitionMatch(status, toStatus))) return null;
  return Match.findOneAndUpdate(
    { id: matchId, status: { $in: fromStatuses } },
    {
      $set: { ...set, status: toStatus, ...(toStatus === TournamentMatchStatus.Closed ? { closedAt: new Date() } : {}) },
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
      $inc: { stateVersion: 1 },
    },
    { new: true }
  ).lean() as any;
}

/** Marca qualificação uma única vez; chamadas concorrentes retornam null na segunda execução. */
export async function ClaimQualification(matchId: string): Promise<IMatch | null> {
  return Match.findOneAndUpdate(
    {
      id: matchId,
      qualificationApplied: { $ne: true },
      status: { $in: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished, TournamentMatchStatus.MatchFinished] },
    },
    { $set: { qualificationApplied: true, qualificationClaimedAt: new Date() }, $inc: { stateVersion: 1 } },
    { new: true }
  ).lean() as any;
}
