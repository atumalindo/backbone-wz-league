import { TournamentPhaseType } from "../Config";

export type TournamentMode = "teams" | "solo";

export interface TournamentFormat {
  mode: TournamentMode;
  playersPerTeam: number;
  maxTeamsPerMatch: number;
  matchPlayerCapacity: number;
  minTeamsPerMatch: number;
}

/** Normaliza dados novos e legados (`times`, party 1 + capacidade > 2). */
export function NormalizeTournamentMode(tournament: any): TournamentMode {
  const raw = String(tournament?.Properties?.Mode || tournament?.mode || "").toLowerCase();
  if (raw === "solo" || raw === "ffa" || raw === "free-for-all") return "solo";
  if (Number(tournament?.PartySize || tournament?.PlayersPerTeam || tournament?.playersPerTeam || 1) === 1 && Number(tournament?.MaxPlayersPerMatch || tournament?.MaxTeamsPerMatch || tournament?.maxTeamsPerMatch || 2) > 2) {
    return "solo";
  }
  return "teams";
}

export function GetTournamentFormat(tournament: any): TournamentFormat {
  const mode = NormalizeTournamentMode(tournament);
  if (mode === "solo") {
    return {
      mode,
      playersPerTeam: 1,
      maxTeamsPerMatch: 4,
      matchPlayerCapacity: 4,
      minTeamsPerMatch: 4,
    };
  }

  const playersPerTeam = Math.max(1, Number(tournament?.PlayersPerTeam ?? tournament?.playersPerTeam ?? tournament?.PartySize ?? 1) || 1);
  const maxTeamsPerMatch = Math.max(2, Number(tournament?.MaxTeamsPerMatch ?? tournament?.maxTeamsPerMatch ?? tournament?.MaxPlayersPerMatch ?? 2) || 2);
  return {
    mode,
    playersPerTeam,
    maxTeamsPerMatch,
    matchPlayerCapacity: maxTeamsPerMatch * playersPerTeam,
    minTeamsPerMatch: 2,
  };
}

export function GetCompetitorSlots(maxInvites: number, tournamentOrParty: any): number {
  const playersPerTeam = typeof tournamentOrParty === "number"
    ? Math.max(1, Number(tournamentOrParty) || 1)
    : GetTournamentFormat(tournamentOrParty).playersPerTeam;
  return Math.max(1, Math.floor((Number(maxInvites) || 1) / playersPerTeam));
}

/** Rounds necessários para percorrer os competidores respeitando a capacidade da match. */
export function CalculateRoundCount(maxInvites: number, tournament: any, phaseType: string): number {
  const format = GetTournamentFormat(tournament);
  const competitors = GetCompetitorSlots(maxInvites, format.playersPerTeam);
  if (phaseType === "roundrobin") {
    return Math.max(1, Math.ceil((competitors - 1) / Math.max(1, format.maxTeamsPerMatch - 1)));
  }

  let remaining = competitors;
  let rounds = 0;
  while (remaining > 1) {
    rounds++;
    const matches = Math.ceil(remaining / format.maxTeamsPerMatch);
    if (matches <= 1) break;
    remaining = matches * Math.max(1, Math.floor(format.maxTeamsPerMatch / 2));
  }
  return Math.max(1, rounds);
}

export function GetQualificationCount(tournament: any, isLastRound: boolean): number {
  if (isLastRound) return 1;
  return Math.max(1, Math.floor(GetTournamentFormat(tournament).maxTeamsPerMatch / 2));
}

export function IsTournamentPhaseType(phase: any, expected: TournamentPhaseType): boolean {
  return Number(phase?.PhaseType) === Number(expected);
}

export interface PrizeBand {
  position: number;
  endPosition: number;
  amount: number;
  label: string;
}

/**
 * Distribui o pool de gemas nas faixas dos 5 últimos rounds do bracket
 * (Top 1 / Top 2 / Top 3-4 / Top 5-8 / Top 9-16 / Top 17-32) e preserva a
 * soma integral do pool — nada é perdido por arredondamento.
 *
 * Regras (refletem exatamente a estrutura de eliminação do bracket):
 *  - Top 1 sempre recebe a maior premiação.
 *  - Top 2 recebe menos que o Top 1.
 *  - Top 3-4 recebem a mesma quantidade entre si, menor que o Top 2.
 *  - Top 5-8 recebem a mesma quantidade entre si, menor que o Top 3-4.
 *  - Top 9-16 recebem a mesma quantidade entre si, menor que o Top 5-8.
 *  - Top 17-32 recebem a mesma quantidade entre si, menor que o Top 9-16.
 *  - Uma faixa só existe se o bracket tiver jogadores suficientes para ela
 *    (ex.: bracket de 3 rounds/8 jogadores para no Top 5-8, não existe Top 9-16).
 *  - Em brackets com mais de 32 jogadores (6+ rounds), quem cai fora do
 *    Top 32 (ex.: perde no 1º round de um bracket de 64) não recebe gemas —
 *    só as 5 últimas faixas do bracket são premiadas.
 */
export function BuildPrizeBands(totalGems: number, maxInvites: number, tournamentOrParty: any): PrizeBand[] {
  const total = Math.max(0, Math.floor(Number(totalGems) || 0));
  if (total <= 0) return [];
  const slots = GetCompetitorSlots(maxInvites, tournamentOrParty);
  const MAX_BANDS = 6; // Top 1, Top 2, Top 3-4, Top 5-8, Top 9-16, Top 17-32 (5 últimos rounds do bracket)
  const bands: Array<{ position: number; endPosition: number; weight: number; label: string }> = [
    { position: 1, endPosition: 1, weight: 5, label: "Top 1" },
  ];
  if (slots >= 2) bands.push({ position: 2, endPosition: 2, weight: 3, label: "Top 2" });
  // Cada faixa seguinte dobra de tamanho (3-4, 5-8, 9-16, 17-32, ...), espelhando
  // as rodadas eliminatórias do bracket. A próxima faixa sempre começa logo
  // após o fim da anterior, sem sobreposição e sem buracos.
  for (let position = 3; position <= slots && bands.length < MAX_BANDS; ) {
    const endPosition = Math.min(slots, position * 2 - 2);
    bands.push({ position, endPosition, weight: Math.max(1, 4 - Math.round(Math.log2(position))), label: `Top ${position}-${endPosition}` });
    position = endPosition + 1;
  }
  const weightTotal = bands.reduce((sum, band) => sum + band.weight, 0);
  const prizes = bands.map((band) => {
    const size = band.endPosition - band.position + 1;
    const bandTotal = Math.floor((total * band.weight) / weightTotal);
    return { position: band.position, endPosition: band.endPosition, label: band.label, amount: Math.floor(bandTotal / size) };
  });
  // O arredondamento para baixo de cada faixa nunca "some" com gemas: qualquer
  // sobra vai inteira para o Top 1, garantindo que a soma distribuída seja
  // sempre exatamente igual ao pool total configurado — nunca menos.
  const paid = prizes.reduce((sum, prize) => sum + prize.amount * (prize.endPosition - prize.position + 1), 0);
  if (prizes.length > 0) prizes[0].amount += Math.max(0, total - paid);
  return prizes.filter((prize) => prize.amount > 0);
}

/** Campos canônicos para novos documentos; aliases antigos continuam sendo lidos. */
export function BuildFormatFields(tournament: any): Record<string, any> {
  const format = GetTournamentFormat(tournament);
  return {
    PlayersPerTeam: format.playersPerTeam,
    MaxTeamsPerMatch: format.maxTeamsPerMatch,
    MatchCapacity: format.matchPlayerCapacity,
  };
}
