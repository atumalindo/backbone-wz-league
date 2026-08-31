import { BackboneUser, IBackboneUser, IUserMatch } from "../../Models/BackboneUser";
import { IMatch, Match } from "../../Models/Matches";
import { ITournament, Tournament } from "../../Models/Tournament";
import { TournamentMatchStatus, TournamentStatus, TournamentPhaseType } from "../Config";
import { GetRoundConfigs, RoundConfig } from "../Settings/Rules";
import * as crypto from "crypto";
import axios from "axios";
import { CreateOrAssignMatch, GetAllPartyMembers, QualifyPhase } from "./Internal/Phase";
import { GetTournamentFormat, GetQualificationCount } from "./TournamentRules";
import { AwardTournamentPrize, ResolveTournamentPrize } from "./TournamentEconomy";
import { ClaimQualification, TransitionMatch } from "./MatchStateMachine";

/** Notifica o backend universal: +1 crown / tournamentsWon */
export async function AwardTournamentMedal(userId: string, nick?: string, tournamentId?: string, countForLeaderboard = false): Promise<void> {
  const urls = [
    process.env.BACKEND_URL,
    process.env.UNIVERSAL_BACKEND_URL,
    process.env.API_URL,
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "https://baqui-endi.onrender.com",
  ].filter(Boolean) as string[];

  // remove duplicados
  const seen = new Set<string>();
  const list = urls.filter((u) => {
    const k = u.replace(/\/$/, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let lastErr: any = null;
  for (const base of list) {
    try {
      const res = await axios.post(
        `${base.replace(/\/$/, "")}/user/tournaments/win`,
        { userId: String(userId), amount: 1, nick: nick || "", tournamentId: tournamentId ? String(tournamentId) : "", countForLeaderboard },
        { timeout: 8000, headers: { "Content-Type": "application/json", ...(process.env.ECONOMY_INTERNAL_SECRET ? { "X-Economy-Secret": process.env.ECONOMY_INTERNAL_SECRET } : {}) } }
      );
      console.log(`[Medal] Awarded to userId=${userId} nick=${nick} via ${base}:`, res.data);
      return;
    } catch (e: any) {
      lastErr = e;
      const detail = e?.response?.data || e?.message || e;
      console.warn(`[Medal] Failed via ${base}:`, detail);
    }
  }
  console.error(`[Medal] ALL backends failed for userId=${userId} nick=${nick}`, lastErr?.message || lastErr);
}

interface TeamUser {
  "@user-id": string;
  "@team-id": string;
  "@checked-in": string;
  "@user-score": string;
  "@team-score": string;
  "@user-points": string;
  "@team-points": string;
  "@match-points": string;
  "@match-winner": string;
  "@nick": string;
  "@result"?: string;
  "@qualified"?: string;
}

const ActiveGenerations = new Map<string, Promise<void>>();
const ProcessedMatches = new Set<string>();
const BracketAssignmentLocks = new Map<string, Promise<IMatch | null>>();
const MatchModificationLocks = new Map<string, Promise<void>>();

function ShuffleArray<T>(Array: T[]): T[] {
  const Result = [...Array];
  for (let I = Result.length - 1; I > 0; I--) {
    const J = Math.floor(Math.random() * (I + 1));
    [Result[I], Result[J]] = [Result[J], Result[I]];
  }
  return Result;
}

function CalculateTotalRounds(TotalTeams: number, MinPerMatch: number, MaxPerMatch: number): number {
  if (MinPerMatch === 2 && MaxPerMatch === 2) {
    return Math.ceil(Math.log2(TotalTeams));
  }

  let Rounds = 0;
  let Remaining = TotalTeams;

  while (Remaining > 1) {
    Rounds++;
    const MatchesNeeded = Math.ceil(Remaining / MaxPerMatch);
    if (MatchesNeeded === 1) break;
    Remaining = MatchesNeeded * MinPerMatch;
  }

  return Rounds;
}

function CalculateDeadline(
  PhaseStart: Date,
  RoundNumber: number,
  Config: RoundConfig,
  _HasFullMatch: boolean,
  PreviousDeadline?: Date
): Date {
  // Sempre pelo MaxLength do ROUND (Rules.ts), nunca hardcode de final/semi
  const Minutes = Config.MaxLength;
  const BaseTime = RoundNumber === 1 ? PhaseStart : PreviousDeadline || PhaseStart;
  return new Date(BaseTime.getTime() + Minutes * 60 * 1000);
}

export function GetMatchDeadline(
  CurrentMatch: any,
  Tournament: ITournament,
  RoundConfigs: Map<number, RoundConfig>
): Date {
  const Config = RoundConfigs.get(CurrentMatch.roundid);
  if (!Config) return new Date(CurrentMatch.deadline);

  const Deadline = new Date(CurrentMatch.deadline);
  // WaitingForOpponent: deadline já é o fim do WO (sem buffer de jogo)
  if (CurrentMatch.status === TournamentMatchStatus.WaitingForOpponent) return Deadline;

  // GameReady: deadline no DB = fim do WO + buffer MinGameLength
  // Check-in/GO termina em deadline - buffer → janela efetiva começa no create
  const GameCount = Math.max(1, Config.MaxGameCount || 1);
  const BufferMin = Math.max(0, Config.MinGameLength || 0) * GameCount;
  // Sem -15s extra: evitava GO nos primeiros segundos em alguns clients
  return new Date(Deadline.getTime() - BufferMin * 60 * 1000);
}

/** Deadline de partida ativa a partir de AGORA — GO liberado na hora (não usa StartTime antigo). */
export function BuildActiveMatchDeadline(Config: RoundConfig, fullMatch: boolean): Date {
  const now = Date.now();
  // Buffer que GetMatchDeadline / client subtraem (MinGameLength)
  const minLen = Math.max(0, Config.MinGameLength || 0);
  if (fullMatch) {
    // 5 min de WO + buffer. Check-in window = deadline - buffer ≈ agora+5min (começa AGORA)
    return new Date(now + 5 * 60 * 1000 + minLen * 60 * 1000);
  }
  // Solo / waiting: MaxLength a partir de agora
  const maxLen = Math.max(minLen + 1, Config.MaxLength || 8);
  return new Date(now + maxLen * 60 * 1000);
}

export function GetTournamentData(User: any, TournamentId: string): any {
  return (User.Tournaments as any).get ? (User.Tournaments as any).get(TournamentId) : User.Tournaments[TournamentId];
}

async function BuildTeams(
  Users: any[],
  TournamentId: string,
  PartySize: number,
  MaxTeams?: number
): Promise<TeamUser[][]> {
  const Shuffled = ShuffleArray(Users);
  const Teams: TeamUser[][] = [];
  const FixedTeams: TeamUser[][] = [];
  const SinglePlayers: TeamUser[] = [];
  const Processed = new Set<string>();
  const EnrolledIds = new Set(Users.map((User) => String(User.UserId)));
  const Size = Math.max(1, PartySize || 1);

  const MakeTeamUser = (Member: any): TeamUser => ({
    "@user-id": String(Member.UserId),
    "@team-id": "",
    "@checked-in": "0",
    "@user-score": "0",
    "@team-score": "0",
    "@user-points": "0",
    "@team-points": "0",
    "@match-points": "0",
    "@match-winner": "0",
    "@nick": Member.Username || "Player",
  });

  for (const User of Shuffled) {
    const UserId = String(User.UserId);
    if (Processed.has(UserId)) continue;

    const TournamentData = GetTournamentData(User, TournamentId);
    let Members: any[] = Array.isArray(TournamentData?.PartyMembers)
      ? TournamentData.PartyMembers
          .filter((Member: any) => EnrolledIds.has(String(Member?.UserId)))
          .filter((Member: any, Index: number, List: any[]) =>
            List.findIndex((Candidate) => String(Candidate?.UserId) === String(Member?.UserId)) === Index
          )
      : [];

    // Um inscrito sem party é representado pelo próprio usuário em PartyMembers.
    // Ele fica separado temporariamente e será agrupado com outros avulsos abaixo.
    if (!Members.length || Members.length > Size) {
      Members = [{
        UserId,
        Username: User.Username || "Player",
        Status: 1,
        IsPartyLeader: true,
      }];
    }

    const Leader = Members.find((Member: any) => Member.IsPartyLeader) || Members[0];
    if (String(Leader.UserId) !== UserId && Members.length > 1) continue;

    const Team = Members
      .filter((Member: any) => !Processed.has(String(Member.UserId)))
      .slice(0, Size)
      .map(MakeTeamUser);
    if (!Team.length) continue;

    for (const Member of Team) Processed.add(String(Member["@user-id"]));

    if (Team.length === 1) {
      SinglePlayers.push(Team[0]);
    } else {
      // Parties reais permanecem juntas. Se estiverem incompletas, jogadores
      // avulsos serão usados para preencher seus slots antes de criar o último
      // grupo avulso incompleto.
      FixedTeams.push(Team);
    }
  }

  const IncompleteTeams = FixedTeams.filter((Team) => Team.length < Size);
  const CompleteTeams = FixedTeams.filter((Team) => Team.length >= Size);

  for (const Team of IncompleteTeams) {
    while (Team.length < Size && SinglePlayers.length > 0) {
      Team.push(SinglePlayers.shift()!);
    }
    CompleteTeams.push(Team);
  }

  // Junta jogadores avulsos em equipes completas. Se a quantidade não for
  // divisível pelo tamanho da party, apenas o último grupo ficará incompleto.
  for (let Index = 0; Index < SinglePlayers.length; Index += Size) {
    CompleteTeams.push(SinglePlayers.slice(Index, Index + Size));
  }

  const LimitedTeams = MaxTeams ? CompleteTeams.slice(0, MaxTeams) : CompleteTeams;
  Teams.push(...LimitedTeams);

  console.log(
    `[BuildTeams] tournament=${TournamentId} partySize=${Size} users=${Users.length} teams=${Teams.length} ` +
      `soloGrouped=${SinglePlayers.length === 0 ? "yes" : "no"}`
  );

  return Teams;
}

async function InitializePositions(
  TournamentId: string,
  PhaseId: number,
  PartySize: number,
  UserIds: Set<string>,
  GroupId: number = 0
): Promise<void> {
  const Users = await BackboneUser.find({ UserId: { $in: Array.from(UserIds) } }).lean();
  const Updates: any[] = [];

  for (const User of Users) {
    const TournamentData = GetTournamentData(User, TournamentId);
    if (!TournamentData) continue;

    if (!TournamentData.UserPosition) TournamentData.UserPosition = [];

    let Position = TournamentData.UserPosition.find((P: any) => P.phaseid === PhaseId && P.groupid === GroupId);

    if (!Position) {
      Position = {
        phaseid: PhaseId,
        rankposition: 0,
        sameposition: 0,
        matchloses: 0,
        totalpoints: 0,
        totalrounds: 0,
        groupid: GroupId,
      };
      TournamentData.UserPosition.push(Position);
    } else {
      Object.assign(Position, {
        rankposition: 0,
        sameposition: 0,
        matchloses: 0,
        totalpoints: 0,
        totalrounds: 0,
      });
    }

    Updates.push({
      updateOne: {
        filter: { UserId: User.UserId },
        update: { $set: { [`Tournaments.${TournamentId}`]: TournamentData } },
      },
    });

    if (PartySize > 1 && TournamentData.PartyMembers) {
      const IsLeader = TournamentData.PartyMembers.some((M: any) => M.IsPartyLeader && M.UserId === User.UserId);
      if (!IsLeader) continue;

      for (const Member of TournamentData.PartyMembers) {
        if (Member.UserId === User.UserId) continue;

        const MemberUser = Users.find((U) => U.UserId === Member.UserId);
        if (!MemberUser) continue;

        const MemberData = GetTournamentData(MemberUser, TournamentId);
        if (!MemberData) continue;

        if (!MemberData.UserPosition) MemberData.UserPosition = [];

        let MemberPosition = MemberData.UserPosition.find((P: any) => P.phaseid === PhaseId && P.groupid === GroupId);

        if (!MemberPosition) {
          MemberPosition = {
            phaseid: PhaseId,
            rankposition: 0,
            sameposition: 0,
            matchloses: 0,
            totalpoints: 0,
            totalrounds: 0,
            groupid: GroupId,
          };
          MemberData.UserPosition.push(MemberPosition);
        } else {
          Object.assign(MemberPosition, {
            rankposition: 0,
            sameposition: 0,
            matchloses: 0,
            totalpoints: 0,
            totalrounds: 0,
          });
        }

        Updates.push({
          updateOne: {
            filter: { UserId: Member.UserId },
            update: { $set: { [`Tournaments.${TournamentId}`]: MemberData } },
          },
        });
      }
    }
  }

  if (Updates.length > 0) {
    await BackboneUser.bulkWrite(Updates, { ordered: false });
  }
}

async function SaveMatchesToDatabase(Matches: IMatch[], TournamentId: string): Promise<void> {
  if (Matches.length === 0) return;

  try {
    await Match.insertMany(Matches, { ordered: false });

    const FirstRoundMatches = Matches.filter((M) => M.roundid === 1 && M.users.length > 0);
    if (FirstRoundMatches.length === 0) return;

    const UserMatchMap = new Map<string, IMatch>();

    for (const MatchDoc of FirstRoundMatches) {
      for (const User of MatchDoc.users) {
        const UserId = User["@user-id"];
        if (!UserMatchMap.has(UserId)) {
          UserMatchMap.set(UserId, MatchDoc);
        }
      }
    }

    const UserUpdates = Array.from(UserMatchMap.entries()).map(([UserId, MatchDoc]) => ({
      updateOne: {
        filter: { UserId, [`Tournaments.${TournamentId}`]: { $exists: true } },
        update: {
          $set: {
            [`Tournaments.${TournamentId}.UserMatch`]: JSON.parse(JSON.stringify(MatchDoc.toObject())),
          },
        },
      },
    }));

    if (UserUpdates.length > 0) {
      await BackboneUser.bulkWrite(UserUpdates, { ordered: false });
    }
  } catch (Error: any) {
    if (Error.code !== 11000) throw Error;
  }
}

function NextPowerOfTwo(N: number): number {
  if (N <= 1) return 2;
  let P = 1;
  while (P < N) P *= 2;
  return P;
}

async function GenerateSingleElimination(
  Tournament: ITournament,
  Teams: TeamUser[][],
  PhaseId: number,
  TournamentId: string,
  RoundConfigs: Map<number, RoundConfig>,
  PhaseStart: Date
): Promise<IMatch[]> {
  const format = GetTournamentFormat(Tournament);
  const PlayersPerTeam = format.playersPerTeam;
  const MaxTeamsPerMatch = format.maxTeamsPerMatch;

  // Times reais; a formação já agrupou jogadores avulsos e preencheu parties
  // incompletas. Se ainda faltar jogador, preserva somente a última equipe
  // incompleta para ela não desaparecer da bracket.
  const CompleteTeams = Teams.filter((T) => T.length === PlayersPerTeam);
  const IncompleteTeams = Teams.filter((T) => T.length > 0 && T.length < PlayersPerTeam);
  const FilledTeams = [...CompleteTeams, ...IncompleteTeams.slice(0, 1)];

  // Capacidade de equipes e capacidade de jogadores são conceitos distintos.
  const CapacityTeams = Math.max(
    2,
    Math.floor((Tournament.MaxInvites || FilledTeams.length || 2) / PlayersPerTeam)
  );

  // Bracket = potência de 2 da capacidade de equipes.
  const BracketSize =
    MaxTeamsPerMatch === 2
      ? NextPowerOfTwo(Math.max(CapacityTeams, FilledTeams.length, 2))
      : Math.max(CapacityTeams, FilledTeams.length, MaxTeamsPerMatch);

  // Espalha os jogadores na bracket (um embaixo do outro), NÃO empacota face a face.
  // Ex 2 jogadores / 4 vagas:
  //   slot 0 = A, slot 1 = vazio  → match1 A vs TBD (bye)
  //   slot 2 = B, slot 3 = vazio  → match2 B vs TBD (bye)
  // Assim cada um fica em uma chave (cima/baixo), não um contra o outro.
  const AllTeams: TeamUser[][] = Array.from({ length: BracketSize }, () => []);
  if (FilledTeams.length > 0) {
    if (FilledTeams.length === BracketSize) {
      for (let i = 0; i < FilledTeams.length; i++) AllTeams[i] = FilledTeams[i];
    } else {
      // Distribui com espaçamento uniforme nos slots da bracket
      for (let i = 0; i < FilledTeams.length; i++) {
        const slot = Math.floor((i * BracketSize) / FilledTeams.length);
        // Garante slot livre (se colidir, próximo vazio)
        let s = slot;
        while (s < BracketSize && AllTeams[s].length > 0) s++;
        if (s >= BracketSize) {
          s = 0;
          while (s < BracketSize && AllTeams[s].length > 0) s++;
        }
        if (s < BracketSize) AllTeams[s] = FilledTeams[i];
      }
    }
  }

  console.log(
    `[GenerateSE] filled=${FilledTeams.length} capacity=${CapacityTeams} bracketSize=${BracketSize} slots=${AllTeams.map((t, i) => (t.length ? i + ':Y' : i + ':N')).join(',')}`
  );

  const TotalRounds = CalculateTotalRounds(
    AllTeams.length,
    Tournament.MinPlayersPerMatch,
    MaxTeamsPerMatch
  );
  const CreatedMatches: IMatch[] = [];
  const FirstRoundUsers = new Set<string>();
  let LastDeadline: Date | undefined;
  let TeamsRemaining = AllTeams.length;

  for (let Round = 1; Round <= TotalRounds; Round++) {
    const MatchCount = Math.ceil(TeamsRemaining / MaxTeamsPerMatch);
    const Config = RoundConfigs.get(Round) || { MinGameLength: 8, MaxLength: 12, MaxGameCount: 1 };

    for (let MatchNum = 1; MatchNum <= MatchCount; MatchNum++) {
      const MatchId = `${TournamentId}${PhaseId}${Round}0${MatchNum}`;
      const Secret = crypto.randomBytes(32).toString("hex");
      const Users: TeamUser[] = [];
      let Status = TournamentMatchStatus.Created;
      let PlayedGameCount = 0;

      if (Round === 1) {
        // Slots empilhados: time de cima = slot 0, time de baixo = slot 1, etc.
        const TeamsInMatch: TeamUser[][] = [];
        for (let Slot = 0; Slot < MaxTeamsPerMatch; Slot++) {
          const TeamIndex = (MatchNum - 1) * MaxTeamsPerMatch + Slot;
          TeamsInMatch.push(TeamIndex < AllTeams.length ? AllTeams[TeamIndex] : []);
        }

        // Conta qualquer time com >=1 jogador (party incompleta ainda vale)
        const ValidTeams = TeamsInMatch.filter((T) => T.length >= 1).length;
        const SeenUserIds = new Set<string>();

        for (let Slot = 0; Slot < TeamsInMatch.length; Slot++) {
          const TeamId = (Slot + 1).toString();
          const TeamWithIds = TeamsInMatch[Slot]
            .filter((U) => {
              if (SeenUserIds.has(U["@user-id"])) return false;
              SeenUserIds.add(U["@user-id"]);
              return true;
            })
            .map((U) => ({ ...U, "@team-id": TeamId }));
          Users.push(...TeamWithIds);
        }

        Users.forEach((U) => FirstRoundUsers.add(U["@user-id"]));

        if (ValidTeams >= MaxTeamsPerMatch) {
          Status = TournamentMatchStatus.GameReady;
        } else if (ValidTeams <= 1) {
          // Bye / WO R1 (0 ou 1 time): SEMPRE Closed + played=1 + winner
          // Client: QUALIFICADO. Nunca Waiting/Created (vira "não jogada")
          Status = TournamentMatchStatus.Closed;
          PlayedGameCount = 1;
          for (const U of Users) {
            U["@match-winner"] = "1";
            U["@match-points"] = "1";
            U["@team-score"] = "1";
            U["@user-score"] = "1";
            U["@team-points"] = "1";
            U["@user-points"] = "1";
            U["@checked-in"] = "1";
            U["@result"] = "1";
            U["@qualified"] = "1";
          }
        } else {
          // 2+ times mas ainda sem lotação completa
          Status = TournamentMatchStatus.WaitingForOpponent;
        }
      }

      // Deadline a partir de AGORA no R1 (GO na hora). Rounds futuros: sequencial.
      let Deadline: Date;
      if (Round === 1) {
        const full =
          Status === TournamentMatchStatus.GameReady ||
          Status === TournamentMatchStatus.Closed;
        // Closed (bye) não precisa de timer útil; GameReady/Waiting usam now
        if (Status === TournamentMatchStatus.GameReady) {
          Deadline = BuildActiveMatchDeadline(Config, true);
        } else if (Status === TournamentMatchStatus.WaitingForOpponent) {
          Deadline = BuildActiveMatchDeadline(Config, false);
        } else {
          Deadline = BuildActiveMatchDeadline(Config, false);
        }
      } else {
        const WoMs = Config.MaxLength * 60 * 1000;
        const BaseTime = LastDeadline || PhaseStart;
        Deadline = new Date(BaseTime.getTime() + WoMs);
      }

      CreatedMatches.push(
        new Match({
          id: MatchId,
          matchid: MatchNum,
          secret: Secret,
          deadline: Deadline,
          phaseid: PhaseId,
          groupid: 0,
          roundid: Round,
          playedgamecount: PlayedGameCount,
          status: Status,
          tournamentid: TournamentId,
          users: Users,
        })
      );
    }

    TeamsRemaining =
      Tournament.MinPlayersPerMatch === MaxTeamsPerMatch && MaxTeamsPerMatch === 2
        ? MatchCount
        : MatchCount * Tournament.MinPlayersPerMatch;

    if (CreatedMatches.length > 0) {
      LastDeadline = CreatedMatches[CreatedMatches.length - 1].deadline;
    }
  }

  // Bye R1: NÃO coloca ninguém no R2 automaticamente.
  // Só marca R1 Closed/qualificado. Entrar na próxima match = quando o player der GO
  // (CreateOrAssignMatch / AssignNextMatchFromBracket).

  await InitializePositions(TournamentId, PhaseId, PlayersPerTeam, FirstRoundUsers);
  return CreatedMatches;
}

/**
 * Gera o calendário COMPLETO de confrontos (todas as rodadas de uma vez),
 * em vez de decidir os pareamentos dinamicamente conforme as pessoas vão
 * terminando as partidas. Isso evita o problema de "só jogo contra quem
 * tem pontuação parecida" em pools pequenos (o matchmaking dinâmico por
 * pontos em CreateOrAssignMatch, no Phase.ts, converge sempre pros mesmos
 * confrontos quando tem pouca gente inscrita).
 *
 * - MatchCapacity === 2 (1v1): usa o "circle method" clássico de round
 *   robin. Cada dupla se enfrenta EXATAMENTE uma vez em N-1 rodadas
 *   (N par) ou N rodadas com um bye por rodada (N ímpar). Se TotalRounds
 *   pedir mais rodadas do que o ciclo perfeito, reinicia o ciclo.
 * - MatchCapacity > 2 (lobbies com várias equipes por partida): não dá
 *   pra garantir "todo mundo com todo mundo" de forma exata (é um
 *   problema combinatório tipo "social golfer"), então usa uma busca
 *   gulosa: em cada rodada, testa várias distribuições aleatórias em
 *   grupos de MatchCapacity e fica com a que tiver MENOS pares repetidos
 *   em relação ao que já foi jogado nas rodadas anteriores.
 *
 * Retorna, pra cada rodada, uma lista de "partidas", cada partida sendo
 * uma lista de índices (posição em TeamIndices) representando os times
 * que caem juntos naquela partida.
 */
function GenerateRoundRobinSchedule(
  TeamCount: number,
  MatchCapacity: number,
  TotalRounds: number
): number[][][] {
  if (TeamCount <= 0 || TotalRounds <= 0) return [];

  if (MatchCapacity === 2) {
    const IsOdd = TeamCount % 2 !== 0;
    const Slots = IsOdd ? TeamCount + 1 : TeamCount; // último slot = "bye" se ímpar
    const ByeIndex = IsOdd ? TeamCount : -1;
    const CycleLength = Slots - 1;
    const Half = Slots / 2;

    let Positions = Array.from({ length: Slots }, (_, I) => I);
    const FullSchedule: number[][][] = [];

    for (let R = 0; R < TotalRounds; R++) {
      const CycleRound = R % CycleLength;

      if (CycleRound === 0 && R > 0) {
        // reinicia o ciclo (mais rodadas pedidas do que o round robin perfeito)
        Positions = Array.from({ length: Slots }, (_, I) => I);
      }

      const RoundMatches: number[][] = [];
      for (let I = 0; I < Half; I++) {
        const A = Positions[I];
        const B = Positions[Slots - 1 - I];
        if (A !== ByeIndex && B !== ByeIndex) RoundMatches.push([A, B]);
      }
      FullSchedule.push(RoundMatches);

      // gira o círculo, mantendo Positions[0] fixo
      const Last = Positions.pop()!;
      Positions.splice(1, 0, Last);
    }

    return FullSchedule;
  }

  // Multi-time por partida: solver guloso anti-repetição
  const Indices = Array.from({ length: TeamCount }, (_, I) => I);
  const PairPlayCount = Array.from({ length: TeamCount }, () => new Array(TeamCount).fill(0));
  const FullSchedule: number[][][] = [];
  const AttemptsPerRound = 250;

  for (let R = 0; R < TotalRounds; R++) {
    let BestGroups: number[][] | null = null;
    let BestScore = Infinity;

    for (let Attempt = 0; Attempt < AttemptsPerRound; Attempt++) {
      const Shuffled = ShuffleArray(Indices);
      const Groups: number[][] = [];
      for (let I = 0; I < Shuffled.length; I += MatchCapacity) {
        Groups.push(Shuffled.slice(I, I + MatchCapacity));
      }

      let Score = 0;
      for (const Group of Groups) {
        for (let A = 0; A < Group.length; A++) {
          for (let B = A + 1; B < Group.length; B++) {
            Score += PairPlayCount[Group[A]][Group[B]];
          }
        }
      }

      if (Score < BestScore) {
        BestScore = Score;
        BestGroups = Groups;
        if (Score === 0) break;
      }
    }

    FullSchedule.push(BestGroups!);
    for (const Group of BestGroups!) {
      for (let A = 0; A < Group.length; A++) {
        for (let B = A + 1; B < Group.length; B++) {
          PairPlayCount[Group[A]][Group[B]]++;
          PairPlayCount[Group[B]][Group[A]]++;
        }
      }
    }
  }

  return FullSchedule;
}

async function GenerateRoundRobinGroup(
  Tournament: ITournament,
  Teams: TeamUser[][],
  PhaseId: number,
  GroupId: number,
  TournamentId: string,
  RoundConfigs: Map<number, RoundConfig>,
  PhaseStart: Date
): Promise<IMatch[]> {
  const ValidTeams = Teams.filter((T) => T.length > 0);
  // Antes exigia >= 2 times pra sequer gerar a rodada 1 dessa fase — mas a
  // lógica logo abaixo (ValidTeamCount >= 1 → WaitingForOpponent) já foi
  // feita pra lidar com "sozinho na partida" esperando WO. Com essa trava em
  // 2, um jogador sozinho na fase (RoundRobin/Arena) nunca tinha partida
  // nenhuma criada — client ficava preso "carregando próxima partida" pra
  // sempre, sem sequer entrar na partida pra esperar o WO. Agora só bloqueia
  // se realmente não tem NINGUÉM.
  if (ValidTeams.length < 1) return [];

  const ShuffledTeams = ShuffleArray(ValidTeams);
  const CreatedMatches: IMatch[] = [];
  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  const TotalRounds = PhaseConfig.RoundCount || 1;

  // Calendário inteiro (todas as rodadas) gerado de uma vez só, no
  // início da fase — em vez de decidir os pareamentos das próximas
  // rodadas dinamicamente conforme as partidas vão terminando.
  const Schedule = GenerateRoundRobinSchedule(ShuffledTeams.length, GetTournamentFormat(Tournament).maxTeamsPerMatch, TotalRounds);

  for (let Round = 1; Round <= TotalRounds; Round++) {
    const Config = RoundConfigs.get(Round) || { MinGameLength: 8, MaxLength: 12, MaxGameCount: 1 };
    const RoundMatches = Schedule[Round - 1] || [];

    for (let MatchNum = 0; MatchNum < RoundMatches.length; MatchNum++) {
      const GroupPart = GroupId === 0 ? "0" : GroupId.toString();
      const MatchId = `${TournamentId}${PhaseId}${Round}${GroupPart}${MatchNum + 1}`;
      const Secret = crypto.randomBytes(32).toString("hex");
      const Users: TeamUser[] = [];

      const TeamIndicesInMatch = RoundMatches[MatchNum];
      const TeamsInMatch = TeamIndicesInMatch.map((Idx) => ShuffledTeams[Idx]).filter((T) => !!T);

      for (let Slot = 0; Slot < TeamsInMatch.length; Slot++) {
        const TeamId = (Slot + 1).toString();
        const TeamWithIds = TeamsInMatch[Slot].map((U) => ({ ...U, "@team-id": TeamId }));
        Users.push(...TeamWithIds);
      }

      const ValidTeamCount = new Set(Users.map((U) => U["@team-id"]).filter((T) => T)).size;
      let Status: TournamentMatchStatus;

      if (ValidTeamCount === GetTournamentFormat(Tournament).maxTeamsPerMatch) {
        Status = TournamentMatchStatus.GameReady;
      } else if (ValidTeamCount >= 1) {
        Status = TournamentMatchStatus.WaitingForOpponent;
      } else {
        Status = TournamentMatchStatus.Created;
      }

      let Deadline: Date;
      if (Round === 1 && Status === TournamentMatchStatus.GameReady) {
        Deadline = BuildActiveMatchDeadline(Config, true);
      } else if (Round === 1) {
        Deadline = BuildActiveMatchDeadline(Config, false);
      } else {
        Deadline = new Date(PhaseStart.getTime() + Config.MaxLength * 60 * 1000 * Round);
      }

      CreatedMatches.push(
        new Match({
          id: MatchId,
          matchid: MatchNum + 1,
          secret: Secret,
          deadline: Deadline,
          phaseid: PhaseId,
          groupid: GroupId,
          roundid: Round,
          playedgamecount: 0,
          status: Status,
          tournamentid: TournamentId,
          users: Users,
        })
      );
    }
  }

  return CreatedMatches;
}

async function GenerateRoundRobin(
  Tournament: ITournament,
  Teams: TeamUser[][],
  PhaseId: number,
  TournamentId: string,
  RoundConfigs: Map<number, RoundConfig>,
  PhaseStart: Date
): Promise<IMatch[]> {
  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  // mesma trava relaxada de GenerateRoundRobinGroup — 1 time sozinho ainda
  // precisa gerar a rodada 1 (WaitingForOpponent) pra poder esperar o WO.
  if (Teams.length < 1) return [];
  const CreatedMatches: IMatch[] = [];

  if (PhaseConfig.IsPhase) {
    const GroupCount = PhaseConfig.GroupCount || 1;

    if (GroupCount > 1) {
      const Groups: TeamUser[][][] = Array.from({ length: GroupCount }, () => []);

      for (let I = 0; I < Teams.length; I++) {
        Groups[I % GroupCount].push(Teams[I]);
      }

      for (let GroupId = 1; GroupId <= GroupCount; GroupId++) {
        const GroupTeams = Groups[GroupId - 1];
        // Mesmo um grupo com um único jogador precisa de uma match visível:
        // ele deve aguardar o adversário e receber WO no prazo, em vez de ficar
        // preso para sempre no estado "carregando próxima partida".
        if (GroupTeams.length < 1) continue;

        const GroupMatches = await GenerateRoundRobinGroup(
          Tournament,
          GroupTeams,
          PhaseId,
          GroupId,
          TournamentId,
          RoundConfigs,
          PhaseStart
        );
        CreatedMatches.push(...GroupMatches);

        const GroupUserIds = new Set<string>();
        GroupTeams.forEach((Team) => Team.forEach((User) => GroupUserIds.add(User["@user-id"])));

        if (GroupUserIds.size > 0) {
          await InitializePositions(TournamentId, PhaseId, GetTournamentFormat(Tournament).playersPerTeam, GroupUserIds, GroupId);
        }
      }
    } else {
      const Matches = await GenerateRoundRobinGroup(
        Tournament,
        Teams,
        PhaseId,
        1,
        TournamentId,
        RoundConfigs,
        PhaseStart
      );
      CreatedMatches.push(...Matches);

      const UserIds = new Set<string>();
      Teams.forEach((Team) => Team.forEach((User) => UserIds.add(User["@user-id"])));
      await InitializePositions(TournamentId, PhaseId, GetTournamentFormat(Tournament).playersPerTeam, UserIds, 1);
    }
  } else {
    const Matches = await GenerateRoundRobinGroup(
      Tournament,
      Teams,
      PhaseId,
      0,
      TournamentId,
      RoundConfigs,
      PhaseStart
    );
    CreatedMatches.push(...Matches);

    const UserIds = new Set<string>();
    Teams.forEach((Team) => Team.forEach((User) => UserIds.add(User["@user-id"])));
    await InitializePositions(TournamentId, PhaseId, GetTournamentFormat(Tournament).playersPerTeam, UserIds, 0);
  }

  return CreatedMatches;
}

async function UpdateTeamPositions(
  TournamentId: string,
  PhaseId: number,
  CurrentRound: number,
  SortedTeams: Array<{ teamId: string; userIds: string[]; teamScore: number; points: number }>,
  MinQualify: number
): Promise<void> {
  const AllUserIds = SortedTeams.flatMap((T) => T.userIds);
  const Users = await BackboneUser.find({ UserId: { $in: AllUserIds } }).lean();

  const AllPartyMembers = new Set<string>(AllUserIds);
  for (const User of Users) {
    const TournamentData = GetTournamentData(User, TournamentId);
    if (TournamentData?.PartyMembers) {
      for (const Member of TournamentData.PartyMembers) {
        if (Member.UserId) AllPartyMembers.add(Member.UserId);
      }
    }
  }

  const AllRelevantUsers = await BackboneUser.find({ UserId: { $in: Array.from(AllPartyMembers) } }).lean();
  const Updates: any[] = [];

  const UserPlacementMap = new Map<string, number>();
  for (let I = 0; I < SortedTeams.length; I++) {
    const Team = SortedTeams[I];
    for (const UserId of Team.userIds) {
      UserPlacementMap.set(UserId, I + 1);
    }
  }

  for (const User of AllRelevantUsers) {
    const TournamentData = GetTournamentData(User, TournamentId);
    if (!TournamentData) continue;
    if (!TournamentData.UserPosition) TournamentData.UserPosition = [];

    let Position = TournamentData.UserPosition.find((P: any) => P.phaseid === PhaseId && P.groupid === 0);
    if (!Position) {
      Position = {
        phaseid: PhaseId,
        rankposition: 0,
        sameposition: 0,
        matchloses: 0,
        totalpoints: 0,
        totalrounds: 0,
        groupid: 0,
      };
      TournamentData.UserPosition.push(Position);
    }

    const Placement = UserPlacementMap.get(User.UserId);
    if (!Placement) continue;

    Position.totalrounds = CurrentRound;
    const IsEliminated = Placement > MinQualify;

    if (IsEliminated) {
      Position.matchloses += 1;
      Position.totalpoints -= Placement - MinQualify;
    } else {
      Position.totalpoints += MinQualify - Placement + 1;
    }

    Position.rankposition = Placement;
    Position.sameposition = 0;

    Updates.push({
      updateOne: {
        filter: { UserId: User.UserId },
        update: { $set: { [`Tournaments.${TournamentId}.UserPosition`]: TournamentData.UserPosition } },
      },
    });
  }

  if (Updates.length > 0) {
    await BackboneUser.bulkWrite(Updates, { ordered: false });
  }
}

export async function GenerateBracketMatches(Tournament: ITournament): Promise<void> {
  const PhaseId = Tournament.CurrentPhaseId || 1;
  const TournamentId = Tournament.TournamentId.toString();

  const ExistingGeneration = ActiveGenerations.get(TournamentId);
  if (ExistingGeneration) return ExistingGeneration;

  const GenerationTask = (async () => {
    try {
      const PhaseConfig = Tournament.Phases[PhaseId - 1];
      if (!PhaseConfig) return;

      let Users = await BackboneUser.find({
        [`Tournaments.${TournamentId}.SignedUp`]: true,
      }).lean();

      // Fallback: key numérica
      if (Users.length === 0 && !isNaN(Number(TournamentId))) {
        Users = await BackboneUser.find({
          [`Tournaments.${Number(TournamentId)}.SignedUp`]: true,
        }).lean();
      }

      console.log(
        `[GenerateBracket] tournament=${TournamentId} signedUp=${Users.length} phase=${PhaseId}`
      );

      const ExistingCount = await Match.countDocuments({
        tournamentid: TournamentId,
        phaseid: PhaseId,
      });

      if (ExistingCount > 0) {
        // Bracket já existe: se tem inscritos fora das matches, REFAZ (bug pre-start vazio)
        const matches = await Match.find({
          tournamentid: TournamentId,
          phaseid: PhaseId,
        })
          .select("users status roundid playedgamecount")
          .lean();
        const inBracket = new Set<string>();
        for (const m of matches) {
          for (const u of m.users || []) {
            if (u["@user-id"]) inBracket.add(String(u["@user-id"]));
          }
        }
        const missing = Users.filter((u: any) => !inBracket.has(String(u.UserId)));
        if (Users.length === 0) {
          console.log(`[GenerateBracket] already exists, 0 signed — keep`);
          return;
        }
        if (missing.length === 0 && inBracket.size > 0) {
          console.log(
            `[GenerateBracket] already exists ok inBracket=${inBracket.size}`
          );
          return;
        }

        // BUGFIX: essa função roda em TODO poll de tournamentGetData/GetMatches.
        // Antes, sempre que "missing" > 0 (ex: alguém se inscreveu depois do
        // bracket já ter sido gerado, ou qualquer glitch de dados) o código
        // apagava TODAS as partidas da fase com deleteMany — mesmo com gente
        // já com check-in feito, em GameInProgress ou já avançada de rodada.
        // Isso derrubava o jogador NO MEIO da partida (o "aperto jogar e sai
        // automaticamente, e ao entrar aparece juntando de novo" que o
        // usuário relatou) toda vez que esse regen disparava por baixo dele.
        // Agora: só regenera do zero se o bracket ainda estiver intocado
        // (ninguém deu check-in, nenhuma partida em andamento, ninguém além
        // da rodada 1). Com progresso real, mantém tudo como está — o
        // inscrito tardio só não ganha vaga retroativa, o que é bem menos
        // ruim que apagar partidas de quem já está jogando.
        const HasRealProgress = matches.some((m: any) => {
          if (m.roundid > 1 && (m.users || []).length > 0) return true;
          if (m.status === TournamentMatchStatus.GameInProgress) return true;
          if ((m.users || []).some((u: any) => u["@checked-in"] === "1")) return true;
          return false;
        });

        if (HasRealProgress) {
          console.warn(
            `[GenerateBracket] SKIP regen (bracket já tem progresso real) missing=${missing.length} inBracket=${inBracket.size} signed=${Users.length}`
          );
          return;
        }

        // Tem inscritos que não estão no bracket, mas nada foi jogado ainda → apaga e regenera
        console.log(
          `[GenerateBracket] REGEN missing=${missing.length} inBracket=${inBracket.size} signed=${Users.length}`
        );
        await Match.deleteMany({ tournamentid: TournamentId, phaseid: PhaseId });
      }

      if (Users.length === 0) {
        console.log(`[GenerateBracket] no signed users yet — skip`);
        return;
      }

      const PhaseStartTime =
        PhaseId === 1 ? new Date(Tournament.StartTime) : Tournament.CurrentPhaseStarted || new Date();
      const RoundConfigs = GetRoundConfigs(Tournament, PhaseId);
      let Teams: TeamUser[][] = [];
      let CreatedMatches: IMatch[] = [];

      const PhaseType = Number(PhaseConfig.PhaseType);
      const PhaseMaxTeams =
        PhaseConfig.MaxTeams || Math.ceil(Users.length / GetTournamentFormat(Tournament).playersPerTeam);

      if (PhaseType === TournamentPhaseType.RoundRobin) {
        Teams = await BuildTeams(Users, TournamentId, GetTournamentFormat(Tournament).playersPerTeam);
        CreatedMatches = await GenerateRoundRobin(
          Tournament,
          Teams,
          PhaseId,
          TournamentId,
          RoundConfigs,
          PhaseStartTime
        );
      } else if (PhaseType === TournamentPhaseType.Arena) {
        Teams = await BuildTeams(Users, TournamentId, GetTournamentFormat(Tournament).playersPerTeam);
        CreatedMatches = await GenerateRoundRobin(
          Tournament,
          Teams,
          PhaseId,
          TournamentId,
          RoundConfigs,
          PhaseStartTime
        );
      } else {
        // Single elim: só times reais. O GenerateSingleElimination faz o pad power-of-2.
        const MaxTeams = Math.min(PhaseMaxTeams, 256);
        Teams = await BuildTeams(Users, TournamentId, GetTournamentFormat(Tournament).playersPerTeam, MaxTeams);
        CreatedMatches = await GenerateSingleElimination(
          Tournament,
          Teams,
          PhaseId,
          TournamentId,
          RoundConfigs,
          PhaseStartTime
        );
      }

      if (CreatedMatches.length > 0) {
        await SaveMatchesToDatabase(CreatedMatches, TournamentId);

        // Bye R1: UserMatch fica no bye Closed (QUALIFICADO).
        // NÃO mexe no R2 — só entra na próxima quando der GO.
        const Round1Byes = CreatedMatches.filter(
          (M) =>
            M.roundid === 1 &&
            (M.status === TournamentMatchStatus.GameFinished ||
              M.status === TournamentMatchStatus.Closed) &&
            M.users.some((U) => U["@match-winner"] === "1")
        );

        // Marca bye winners como qualificados no UserPosition + histórico UserMatches
        for (const ByeMatch of Round1Byes) {
          const WinnerIds = [
            ...new Set(
              ByeMatch.users
                .filter((U) => U["@match-winner"] === "1")
                .map((U) => U["@user-id"])
            ),
          ];
          if (WinnerIds.length === 0) continue;

          const ClaimedBye = await ClaimQualification(ByeMatch.id);
          if (!ClaimedBye) continue;
          const ByePayload = JSON.parse(JSON.stringify(ClaimedBye));

          try {
            // Empurra o bye pro histórico
            await BackboneUser.updateMany(
              {
                UserId: { $in: WinnerIds },
                [`Tournaments.${TournamentId}`]: { $exists: true },
              },
              {
                $push: {
                  [`Tournaments.${TournamentId}.UserMatches`]: ByePayload,
                },
              }
            );

            // Atualiza posição: 1 round concluído, rank 1, +1 ponto (qualificado)
            const Winners = await BackboneUser.find({ UserId: { $in: WinnerIds } });
            for (const W of Winners) {
              const TD = W.Tournaments?.get?.(TournamentId);
              if (!TD) continue;
              if (!TD.UserPosition) TD.UserPosition = [];
              let Pos = TD.UserPosition.find(
                (P: any) => P.phaseid === PhaseId && P.groupid === 0
              );
              if (!Pos) {
                Pos = {
                  phaseid: PhaseId,
                  rankposition: 1,
                  sameposition: 0,
                  matchloses: 0,
                  totalpoints: 1,
                  totalrounds: 1,
                  groupid: 0,
                };
                TD.UserPosition.push(Pos);
              } else {
                Pos.totalrounds = Math.max(Pos.totalrounds || 0, 1);
                Pos.rankposition = 1;
                Pos.matchloses = 0;
                Pos.totalpoints = Math.max(Pos.totalpoints || 0, 1);
              }
              W.markModified(`Tournaments.${TournamentId}`);
              await W.save();
            }
            console.log(
              `[GenerateBracket] Bye qualified users=${WinnerIds.join(",")} match=${ByeMatch.id}`
            );
          } catch (e) {
            console.error("[GenerateBracket] Bye qualify position failed:", e);
          }
        }

        // WO automático SÓ no round 1 — nunca em rounds seguintes / final
        // (se só 1 inscrito no torneio inteiro, o bye do R1 já resolve + final com 1 time
        //  só declara campeão se LastRoundNum === 1, i.e. bracket de 1 jogo)
        try {
          const AllRounds = [
            ...new Set(CreatedMatches.map((M) => M.roundid)),
          ].sort((A, B) => A - B);
          const LastRoundNum = AllRounds[AllRounds.length - 1] || 1;
          const LastRoundMatches = CreatedMatches.filter(
            (M) => M.roundid === LastRoundNum
          );

          for (const FinalMatch of LastRoundMatches) {
            const Teams = new Set(
              FinalMatch.users.map((U) => U["@team-id"]).filter((Id) => !!Id)
            );
            // Campeão automático só se a "final" for o próprio round 1 (WO único)
            if (LastRoundNum === 1 && Teams.size === 1 && FinalMatch.users.length > 0) {
              const UpdatedFinalUsers = FinalMatch.users.map((U) => ({
                ...U,
                "@match-winner": "1",
                "@match-points": "1",
                "@team-score": "1",
                "@user-score": "1",
                "@checked-in": "1",
              }));
              const ClosedFinal = await TransitionMatch(
                FinalMatch.id,
                [FinalMatch.status],
                TournamentMatchStatus.Closed,
                {
                  users: UpdatedFinalUsers,
                  playedgamecount: Math.max(FinalMatch.playedgamecount || 0, 1),
                }
              );
              if (!ClosedFinal) continue;
              const ClaimedFinal = await ClaimQualification(FinalMatch.id);
              const FinalSnapshot = ClaimedFinal || await Match.findOne({ id: FinalMatch.id }).lean();
              if (!FinalSnapshot || !FinalSnapshot.qualificationApplied) continue;

              const ChampIds = [
                ...new Set(FinalSnapshot.users.map((U) => U["@user-id"])),
              ];
              const Winners: { nick: string; userId: string; rewardType?: "gems" | "tag"; rewardAmount?: number; rewardTag?: string; rewardExpiresAt?: Date | null }[] = [];
              for (const Id of ChampIds) {
                const U = await BackboneUser.findOne({ UserId: Id });
                if (U) Winners.push({ nick: U.Username || Id, userId: Id });
      const award = ResolveTournamentPrize(Tournament, 1);
      Winners[Winners.length - 1] = { ...Winners[Winners.length - 1], rewardType: award.mode, rewardAmount: award.amount, rewardTag: award.tag, rewardExpiresAt: award.expiresAt ? new Date(award.expiresAt) : null };
              }

              if (Winners.length > 0) {
                const FinishUpdate = await Tournament.updateOne(
                  { TournamentId: TournamentId, Status: { $ne: TournamentStatus.Finished } },
                  {
                    $set: {
                      Winners: Winners,
                      Status: TournamentStatus.Finished,
                      "Properties.FinishedAt": new Date(),
                    },
                  }
                );
                if (FinishUpdate.modifiedCount === 0) continue;
                for (const W of Winners) {
                  await BackboneUser.updateOne(
                    {
                      UserId: W.userId,
                      [`Tournaments.${TournamentId}`]: { $exists: true },
                    },
                    {
                      $set: {
                        [`Tournaments.${TournamentId}.FinalPlace`]: 1,
                        [`Tournaments.${TournamentId}.UserMatch`]: null,
                      },
                      $push: {
                        [`Tournaments.${TournamentId}.UserMatches`]: JSON.parse(
                          JSON.stringify(
                              FinalSnapshot
                          )
                        ),
                      },
                    }
                  );
                  await AwardTournamentPrize(W.userId, W.nick, Tournament, Number((W as any).position || 1));
          await AwardTournamentMedal(W.userId, W.nick, String(Tournament.TournamentId), Boolean((Tournament as any).CountForLeaderboard ?? (Tournament as any).Properties?.CountForLeaderboard));
                }
                console.log(
                  `[GenerateBracket] AUTO CHAMPION tournament=${TournamentId} winners=${ChampIds.join(",")} final=${FinalMatch.id}`
                );
              }
            }
          }
        } catch (ChampErr) {
          console.error("[GenerateBracket] auto champion failed:", ChampErr);
        }
      }
    } catch (Error) {
      throw Error;
    } finally {
      ActiveGenerations.delete(TournamentId);
    }
  })();

  ActiveGenerations.set(TournamentId, GenerationTask);
  return GenerationTask;
}

async function QualifyFromBracket(User: IBackboneUser, Tournament: ITournament): Promise<void> {
  const UserTournamentData = User.Tournaments.get(Tournament.TournamentId.toString());
  if (!UserTournamentData?.UserMatch) return;

  const PhaseId = Tournament.CurrentPhaseId || 1;
  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  const CurrentMatch = UserTournamentData.UserMatch;
  const MatchId = CurrentMatch.id;

  if (ProcessedMatches.has(MatchId)) return;
  ProcessedMatches.add(MatchId);

  const DatabaseMatch = await Match.findOne({ id: CurrentMatch.id });
  if (!DatabaseMatch) return;

  const AllTeamIds = new Set<string>();
  for (const User of DatabaseMatch.users) {
    if (User["@team-id"]) AllTeamIds.add(User["@team-id"]);
  }

  const TeamScores = new Map<string, { points: number; teamScore: number; userIds: string[] }>();
  for (const TeamId of AllTeamIds) {
    const TeamUsers = DatabaseMatch.users.filter((U) => U["@team-id"] === TeamId);
    const UserIds = TeamUsers.map((U) => U["@user-id"]);
    TeamScores.set(TeamId, { points: 0, teamScore: 0, userIds: UserIds });
  }

  for (const User of DatabaseMatch.users) {
    if (User["@team-id"]) {
      const TeamData = TeamScores.get(User["@team-id"])!;
      const MatchPoints = parseInt(User["@match-points"] || "0");
      const TeamScore = parseInt(User["@team-score"] || "0");
      TeamData.points += MatchPoints;
      TeamData.teamScore = Math.max(TeamData.teamScore, TeamScore);
    }
  }

  const SortedTeams = Array.from(TeamScores.entries())
    .sort((A, B) => {
      if (B[1].teamScore !== A[1].teamScore) return B[1].teamScore - A[1].teamScore;
      return B[1].points - A[1].points;
    })
    .map(([TeamId, Data]) => ({ teamId: TeamId, ...Data }));

  if (SortedTeams.length === 0) return;

  const NextRound = CurrentMatch.roundid + 1;
  const NextMatches = await Match.find({
    tournamentid: Tournament.TournamentId.toString(),
    phaseid: PhaseId,
    roundid: NextRound,
    groupid: 0,
  }).lean();

  const IsLastRound = NextMatches.length === 0;
  const MinQualify = GetQualificationCount(Tournament, IsLastRound);

  let QualifyingTeams: string[];
  let EliminatedTeams: string[];

  if (IsLastRound) {
    QualifyingTeams = [SortedTeams[0].teamId];
    EliminatedTeams = SortedTeams.slice(1).map((T) => T.teamId);
  } else {
    QualifyingTeams = SortedTeams.slice(0, MinQualify).map((T) => T.teamId);
    EliminatedTeams = SortedTeams.slice(MinQualify).map((T) => T.teamId);
  }

  const QualifyingUserIds = new Set<string>();
  const EliminatedUserIds = new Set<string>();

  for (const Team of SortedTeams) {
    if (QualifyingTeams.includes(Team.teamId)) {
      Team.userIds.forEach((Id) => QualifyingUserIds.add(Id));
    } else if (EliminatedTeams.includes(Team.teamId)) {
      Team.userIds.forEach((Id) => EliminatedUserIds.add(Id));
    }
  }

  const AllEliminatedPartyMembers = new Set<string>();
  for (const UserId of EliminatedUserIds) {
    const PartyMembers = await GetAllPartyMembers(UserId, Tournament.TournamentId.toString());
    for (const MemberId of PartyMembers) {
      AllEliminatedPartyMembers.add(MemberId);
    }
  }

  const Closed = await TransitionMatch(
    CurrentMatch.id,
    [CurrentMatch.status],
    TournamentMatchStatus.Closed,
    { users: DatabaseMatch.users }
  );
  if (!Closed) return;

  const Claimed = await ClaimQualification(CurrentMatch.id);
  if (!Claimed) {
    ProcessedMatches.delete(MatchId);
    return;
  }
  const UpdatedMatch = Claimed;

  const MatchCopy = {
    id: UpdatedMatch.id,
    secret: UpdatedMatch.secret,
    deadline: UpdatedMatch.deadline,
    matchid: UpdatedMatch.matchid,
    phaseid: UpdatedMatch.phaseid,
    groupid: UpdatedMatch.groupid,
    roundid: UpdatedMatch.roundid,
    playedgamecount: UpdatedMatch.playedgamecount,
    status: UpdatedMatch.status,
    tournamentid: UpdatedMatch.tournamentid,
    users: UpdatedMatch.users,
  };

  const EliminatedUsers = Array.from(AllEliminatedPartyMembers);
  const QualifiedUsers = Array.from(QualifyingUserIds);

  const PhaseTypeNum = Number(PhaseConfig.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
  const PhaseType = TournamentPhaseType[PhaseTypeNum] as keyof typeof TournamentPhaseType;

  if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") {
    await UpdateTeamPositions(
      Tournament.TournamentId.toString(),
      PhaseId,
      CurrentMatch.roundid,
      SortedTeams,
      MinQualify
    );
  }

  const EliminatedUpdates = EliminatedUsers.map((Id) => ({
    updateOne: {
      filter: { UserId: Id, [`Tournaments.${Tournament.TournamentId}`]: { $exists: true } },
      update: {
        $set: {
          [`Tournaments.${Tournament.TournamentId}.KnockedOut`]: true,
          [`Tournaments.${Tournament.TournamentId}.UserMatch`]: null,
        },
        $push: { [`Tournaments.${Tournament.TournamentId}.UserMatches`]: MatchCopy },
      },
    },
  }));

  if (EliminatedUpdates.length > 0) {
    await BackboneUser.bulkWrite(EliminatedUpdates, { ordered: false });
  }

  const IsLastPhase = PhaseId === Tournament.Phases.length;

  if (IsLastPhase && IsLastRound) {
    const AllQualifiedPartyMembers = new Set<string>();
    for (const UserId of QualifiedUsers) {
      const PartyMembers = await GetAllPartyMembers(UserId, Tournament.TournamentId.toString());
      for (const MemberId of PartyMembers) {
        AllQualifiedPartyMembers.add(MemberId);
      }
    }

    const Winners: { nick: string; userId: string; rewardType?: "gems" | "tag"; rewardAmount?: number; rewardTag?: string; rewardExpiresAt?: Date | null }[] = [];
    for (const UserId of AllQualifiedPartyMembers) {
      const WinnerUser = await BackboneUser.findOne({ UserId });
      const nick =
        (WinnerUser as any)?.Username ||
        (WinnerUser as any)?.Nickname ||
        String(UserId);
      Winners.push({ nick: String(nick), userId: String(UserId) });
      const award = ResolveTournamentPrize(Tournament, 1);
      Winners[Winners.length - 1] = { ...Winners[Winners.length - 1], rewardType: award.mode, rewardAmount: award.amount, rewardTag: award.tag, rewardExpiresAt: award.expiresAt ? new Date(award.expiresAt) : null };
    }

    if (Winners.length > 0) {
      const tid = Tournament.TournamentId;
      const finishUpdate = {
        $set: {
          Winners: Winners,
          Status: TournamentStatus.Finished,
          "Properties.FinishedAt": new Date(),
        },
      };
      await Tournament.updateOne({ TournamentId: tid }, finishUpdate);
      await Tournament.updateOne({ TournamentId: String(tid) }, finishUpdate);
      for (const W of Winners) {
        try {
          await BackboneUser.updateOne(
            { UserId: W.userId, [`Tournaments.${tid}`]: { $exists: true } },
            {
              $set: {
                [`Tournaments.${tid}.FinalPlace`]: 1,
                [`Tournaments.${tid}.UserMatch`]: null,
              },
            }
          );
          // +1 medalha no backend (crowns + tournamentsWon) → ranking e perfil
          await AwardTournamentPrize(W.userId, W.nick, Tournament, Number((W as any).position || 1));
          await AwardTournamentMedal(W.userId, W.nick, String(Tournament.TournamentId), Boolean((Tournament as any).CountForLeaderboard ?? (Tournament as any).Properties?.CountForLeaderboard));
        } catch (e) {
          console.error("[Qualify] FinalPlace/Medal failed:", e);
        }
      }
      console.log(
        `[Qualify] Tournament ${tid} FINISHED winners=${Winners.map((w) => `${w.nick}(${w.userId})`).join(",")}`
      );
    } else {
      console.warn(
        `[Qualify] Last round but NO winners tournament=${Tournament.TournamentId} qualified=${QualifiedUsers.join(",")}`
      );
    }
  }


  const AllQualifiedPartyMembers = new Set<string>();
  for (const UserId of QualifiedUsers) {
    const PartyMembers = await GetAllPartyMembers(UserId, Tournament.TournamentId.toString());
    for (const MemberId of PartyMembers) {
      AllQualifiedPartyMembers.add(MemberId);
    }
  }

  const QualifiedUpdates = Array.from(AllQualifiedPartyMembers).map((Id) => ({
    updateOne: {
      filter: { UserId: Id, [`Tournaments.${Tournament.TournamentId}`]: { $exists: true } },
      update: {
        $set: { [`Tournaments.${Tournament.TournamentId}.UserMatch`]: null },
        $push: { [`Tournaments.${Tournament.TournamentId}.UserMatches`]: MatchCopy },
      },
    },
  }));

  if (QualifiedUpdates.length > 0) {
    await BackboneUser.bulkWrite(QualifiedUpdates, { ordered: false });
  }

  ProcessedMatches.delete(MatchId);
}

async function AssignNextMatchFromBracket(User: IBackboneUser, Tournament: ITournament): Promise<IMatch | null> {
  const UserTournamentData = User.Tournaments.get(Tournament.TournamentId.toString());
  if (!UserTournamentData) return null;

  if (UserTournamentData.PartyMembers && UserTournamentData.PartyMembers.length > 0) {
    const CurrentMember = UserTournamentData.PartyMembers.find((M: any) => M.UserId === User.UserId);
    if (!CurrentMember?.IsPartyLeader) return null;
  }

  const TournamentId = Tournament.TournamentId.toString();
  const PhaseId = Tournament.CurrentPhaseId || 1;
  const format = GetTournamentFormat(Tournament);
  const MaxTeamsPerMatch = format.maxTeamsPerMatch;
  const LockKey = `${TournamentId}-${PhaseId}-${User.UserId}`;

  if (BracketAssignmentLocks.has(LockKey)) {
    return BracketAssignmentLocks.get(LockKey)!;
  }

  const Task = (async () => {
    try {
      const PartyIds = new Set<string>([User.UserId]);
      if (UserTournamentData.PartyMembers) {
        for (const Member of UserTournamentData.PartyMembers) {
          if (Member?.UserId) PartyIds.add(Member.UserId);
        }
      }
      const PartyArray = Array.from(PartyIds);

      const FreshUser = await BackboneUser.findOne({ UserId: User.UserId }).lean();
      if (!FreshUser) return null;

      const FreshData = (FreshUser.Tournaments as any).get
        ? (FreshUser.Tournaments as any).get(TournamentId)
        : FreshUser.Tournaments[TournamentId];

      if (!FreshData) return null;
      if (FreshData.KnockedOut) return null;

      const PhaseConfig = Tournament.Phases[PhaseId - 1];
      const TypeNum = Number(PhaseConfig.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
      const PhaseType = TournamentPhaseType[TypeNum] as keyof typeof TournamentPhaseType;

      if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") {
        const CurrentPosition = FreshData.UserPosition?.find((P: any) => P.phaseid === PhaseId && P.groupid === 0);
        if (CurrentPosition && CurrentPosition.matchloses > 0) return null;
      }

      if (FreshData?.UserMatch?.id) {
        // UserMatch é apenas um cache. Nunca devolva esse snapshot sem validar
        // o documento real: depois de um WO/resultado ele pode continuar salvo
        // por alguns polls e fazer o client alternar para uma partida cancelada.
        const CachedMatch = await Match.findOne({
          id: String(FreshData.UserMatch.id),
          tournamentid: TournamentId,
          phaseid: PhaseId,
          "users.@user-id": { $in: PartyArray },
          status: {
            $nin: [
              TournamentMatchStatus.Closed,
              TournamentMatchStatus.GameFinished,
              TournamentMatchStatus.MatchFinished,
            ],
          },
        }).lean();

        if (CachedMatch) {
          return {
            id: CachedMatch.id,
            secret: CachedMatch.secret,
            deadline: CachedMatch.deadline,
            matchid: CachedMatch.matchid,
            phaseid: CachedMatch.phaseid,
            groupid: CachedMatch.groupid,
            roundid: CachedMatch.roundid,
            playedgamecount: CachedMatch.playedgamecount,
            status: CachedMatch.status,
            tournamentid: CachedMatch.tournamentid,
            users: CachedMatch.users,
          } as IMatch;
        }

        await BackboneUser.updateOne(
          { UserId: User.UserId, [`Tournaments.${TournamentId}`]: { $exists: true } },
          { $set: { [`Tournaments.${TournamentId}.UserMatch`]: null } }
        );
      }

      const LastMatch = FreshData?.UserMatches?.[FreshData.UserMatches.length - 1];
      if (!LastMatch) return null;

      const NextRound = LastMatch.roundid + 1;

      const ExistingMatch = await Match.findOne({
        tournamentid: TournamentId,
        phaseid: PhaseId,
        roundid: NextRound,
        groupid: 0,
        "users.@user-id": { $in: PartyArray },
        status: {
          $nin: [
            TournamentMatchStatus.Closed,
            TournamentMatchStatus.GameFinished,
            TournamentMatchStatus.MatchFinished,
          ],
        },
      }).lean();

      if (ExistingMatch) {
        const MatchData = {
          id: ExistingMatch.id,
          secret: ExistingMatch.secret,
          deadline: ExistingMatch.deadline,
          matchid: ExistingMatch.matchid,
          phaseid: ExistingMatch.phaseid,
          groupid: ExistingMatch.groupid,
          roundid: ExistingMatch.roundid,
          playedgamecount: ExistingMatch.playedgamecount,
          status: ExistingMatch.status,
          tournamentid: ExistingMatch.tournamentid,
          users: ExistingMatch.users,
        };

        await BackboneUser.updateMany(
          { UserId: { $in: PartyArray }, [`Tournaments.${TournamentId}`]: { $exists: true } },
          { $set: { [`Tournaments.${TournamentId}.UserMatch`]: MatchData } }
        );

        return MatchData as IMatch;
      }

      const DatabaseMatch = await Match.findOne({ id: LastMatch.id }).lean();
      if (!DatabaseMatch) return null;

      const AllTeamIds = new Set<string>();
      for (const User of DatabaseMatch.users) {
        if (User["@team-id"]) AllTeamIds.add(User["@team-id"]);
      }

      const TeamScores = new Map<string, { points: number; teamScore: number; userIds: string[] }>();
      for (const TeamId of AllTeamIds) {
        const TeamUsers = DatabaseMatch.users.filter((U) => U["@team-id"] === TeamId);
        const UserIds = TeamUsers.map((U) => U["@user-id"]);
        TeamScores.set(TeamId, { points: 0, teamScore: 0, userIds: UserIds });
      }

      for (const User of DatabaseMatch.users) {
        if (User["@team-id"]) {
          const TeamData = TeamScores.get(User["@team-id"])!;
          const MatchPoints = parseInt(User["@match-points"] || "0");
          const TeamScore = parseInt(User["@team-score"] || "0");
          TeamData.points += MatchPoints;
          TeamData.teamScore = Math.max(TeamData.teamScore, TeamScore);
        }
      }

      const SortedTeams = Array.from(TeamScores.entries())
        .sort((A, B) => {
          if (B[1].teamScore !== A[1].teamScore) return B[1].teamScore - A[1].teamScore;
          return B[1].points - A[1].points;
        })
        .map(([TeamId, Data]) => ({ teamId: TeamId, ...Data }));

      const MinQualify = GetQualificationCount(Tournament, false);
      const QualifyingTeams = SortedTeams.slice(0, MinQualify).map((T) => T.teamId);

      const UserTeamId = DatabaseMatch.users.find((U) => U["@user-id"] === User.UserId)?.["@team-id"];
      if (!UserTeamId || !QualifyingTeams.includes(UserTeamId)) return null;

      const SortedNextMatches = await Match.find({
        tournamentid: TournamentId,
        phaseid: PhaseId,
        roundid: NextRound,
        groupid: 0,
      }).sort({ matchid: 1 });

      if (SortedNextMatches.length === 0) return null;

      const QualifyingTeamUsers = new Map<string, TeamUser[]>();
      for (const User of DatabaseMatch.users) {
        if (QualifyingTeams.includes(User["@team-id"])) {
          if (!QualifyingTeamUsers.has(User["@team-id"])) {
            QualifyingTeamUsers.set(User["@team-id"], []);
          }
          QualifyingTeamUsers.get(User["@team-id"])!.push(User);
        }
      }

      const SortedQualifyingTeams = QualifyingTeams.map((TeamId) => QualifyingTeamUsers.get(TeamId)!);

      const BaseSlotIndex = (LastMatch.matchid - 1) * MinQualify;

      let MyTeamIndex = -1;
      for (let i = 0; i < SortedQualifyingTeams.length; i++) {
        const TeamUsers = SortedQualifyingTeams[i];
        if (TeamUsers.some((U) => U["@user-id"] === User.UserId)) {
          MyTeamIndex = i;
          break;
        }
      }

      if (MyTeamIndex === -1) return null;

      const TeamUsers = SortedQualifyingTeams[MyTeamIndex];
      const AbsoluteSlotIndex = BaseSlotIndex + MyTeamIndex;
      const TargetMatchIndex = Math.floor(AbsoluteSlotIndex / MaxTeamsPerMatch);
      const SlotInTargetMatch = AbsoluteSlotIndex % MaxTeamsPerMatch;

      const TargetMatch = SortedNextMatches[TargetMatchIndex];
      if (!TargetMatch) return null;

      const MatchLockKey = `match-${TargetMatch.id}`;

      while (MatchModificationLocks.has(MatchLockKey)) {
        await MatchModificationLocks.get(MatchLockKey);
      }

      const ModifyTask = (async () => {
        try {
          const CurrentMatch = await Match.findOne({ id: TargetMatch.id }).lean();
          if (!CurrentMatch) return;

          const AlreadyInMatch = CurrentMatch.users.some((U: any) => PartyArray.includes(U["@user-id"]));
          if (AlreadyInMatch) return;

          const DoubleCheckUser = await BackboneUser.findOne({ UserId: User.UserId }).lean();
          if (!DoubleCheckUser) return;

          const DoubleCheckData = (DoubleCheckUser.Tournaments as any).get
            ? (DoubleCheckUser.Tournaments as any).get(TournamentId)
            : DoubleCheckUser.Tournaments[TournamentId];

          if (!DoubleCheckData) return;
          if (DoubleCheckData.KnockedOut) return;

          if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") {
            const DoubleCheckPosition = DoubleCheckData.UserPosition?.find(
              (P: any) => P.phaseid === PhaseId && P.groupid === 0
            );
            if (DoubleCheckPosition && DoubleCheckPosition.matchloses > 0) return;
          }

          const NewTeamId = (SlotInTargetMatch + 1).toString();

          const UniqueUsers = Array.from(new Map(TeamUsers.map((u) => [u["@user-id"], u])).values()).slice(
            0,
            GetTournamentFormat(Tournament).playersPerTeam
          );

          const NewUsers = UniqueUsers.map((U: any) => ({
            "@user-id": U["@user-id"],
            "@team-id": NewTeamId,
            "@checked-in": "0",
            "@nick": U["@nick"],
            "@user-score": "0",
            "@team-score": "0",
            "@user-points": "0",
            "@team-points": "0",
            "@match-points": "0",
            "@match-winner": "0",
          }));

          let UpdatedMatch = await Match.findOneAndUpdate(
            {
              id: TargetMatch.id,
              status: {
                $in: [
                  TournamentMatchStatus.Created,
                  TournamentMatchStatus.WaitingForOpponent,
                  TournamentMatchStatus.GameReady,
                ],
              },
              "users.@user-id": { $nin: PartyArray },
            },
            {
              $push: { users: { $each: NewUsers } },
            },
            { new: true }
          );

          if (!UpdatedMatch) {
            UpdatedMatch = await Match.findOne({ id: TargetMatch.id });
          }
          if (!UpdatedMatch) return;
          if (!UpdatedMatch.users.some((U: any) => PartyArray.includes(U["@user-id"]))) {
            return;
          }

          const UniqueTeams = new Set(
            UpdatedMatch.users.map((U: any) => U["@team-id"]).filter((Id: string) => Id !== "")
          ).size;

          const OldStatus = UpdatedMatch.status;
          const DesiredStatus = UniqueTeams >= MaxTeamsPerMatch
            ? TournamentMatchStatus.GameReady
            : UniqueTeams >= 1
              ? TournamentMatchStatus.WaitingForOpponent
              : TournamentMatchStatus.Created;

          const now = Date.now();
          const FIVE_MIN = 5 * 60 * 1000;
          const RoundConfigs = GetRoundConfigs(Tournament, PhaseId);
          const Cfg = RoundConfigs.get(UpdatedMatch.roundid) || {
            MaxLength: 12,
            MinGameLength: 8,
            MaxGameCount: 1,
          };
          const StateFields: Record<string, any> = {};

          if (UniqueTeams >= MaxTeamsPerMatch) {
            // Match cheia, inclusive Solo 1v1v1v1: 5 min de WO. O buffer
            // adicional continua compatível com o deadline consumido pelo client.
            const displayMs = FIVE_MIN + (Cfg.MinGameLength || 0) * 60 * 1000;
            StateFields.deadline = new Date(now + displayMs);
            console.log(
              `[AssignBracket] FULL match=${UpdatedMatch.id} teams=${UniqueTeams}/${MaxTeamsPerMatch} deadline=+${Math.round(displayMs/60000)}min (5min WO)`
            );
          } else if (UniqueTeams === 1) {
            StateFields.deadline = new Date(now + Cfg.MaxLength * 60 * 1000);
            console.log(`[AssignBracket] waiting match=${UpdatedMatch.id} → ${Cfg.MaxLength}min`);
          }

          const TransitionedMatch = await TransitionMatch(
            String(UpdatedMatch.id),
            [OldStatus],
            DesiredStatus,
            StateFields
          );
          UpdatedMatch = TransitionedMatch as any || await Match.findOne({ id: TargetMatch.id });
          if (!UpdatedMatch) return;

          // Sempre sincroniza UserMatch de TODOS na match (evita um ver o outro "sumir")
          {
            const FinalMatchData = await Match.findOne({ id: TargetMatch.id }).lean();
            if (FinalMatchData) {
              const AllMatchUserIds = FinalMatchData.users.map((U: any) => U["@user-id"]);
              const MatchDataForUsers = {
                id: FinalMatchData.id,
                secret: FinalMatchData.secret,
                deadline: FinalMatchData.deadline,
                matchid: FinalMatchData.matchid,
                phaseid: FinalMatchData.phaseid,
                groupid: FinalMatchData.groupid,
                roundid: FinalMatchData.roundid,
                playedgamecount: FinalMatchData.playedgamecount,
                status: FinalMatchData.status,
                tournamentid: FinalMatchData.tournamentid,
                users: FinalMatchData.users,
              };

              await BackboneUser.updateMany(
                { UserId: { $in: AllMatchUserIds }, [`Tournaments.${TournamentId}`]: { $exists: true } },
                { $set: { [`Tournaments.${TournamentId}.UserMatch`]: MatchDataForUsers } }
              );
            }
          }
        } finally {
          MatchModificationLocks.delete(MatchLockKey);
        }
      })();

      MatchModificationLocks.set(MatchLockKey, ModifyTask);
      await ModifyTask;

      const FinalMatch = await Match.findOne({ id: TargetMatch.id }).lean();
      if (!FinalMatch) return null;

      const MyTeamInMatch = FinalMatch.users.some((U: any) => PartyArray.includes(U["@user-id"]));
      if (!MyTeamInMatch) return null;

      const MatchData = {
        id: FinalMatch.id,
        secret: FinalMatch.secret,
        deadline: FinalMatch.deadline,
        matchid: FinalMatch.matchid,
        phaseid: FinalMatch.phaseid,
        groupid: FinalMatch.groupid,
        roundid: FinalMatch.roundid,
        playedgamecount: FinalMatch.playedgamecount,
        status: FinalMatch.status,
        tournamentid: FinalMatch.tournamentid,
        users: FinalMatch.users,
      };

      await BackboneUser.updateMany(
        { UserId: { $in: PartyArray }, [`Tournaments.${TournamentId}`]: { $exists: true } },
        { $set: { [`Tournaments.${TournamentId}.UserMatch`]: MatchData } }
      );

      return MatchData as IMatch;
    } catch (Err) {
      throw Err;
    } finally {
      BracketAssignmentLocks.delete(LockKey);
    }
  })();

  BracketAssignmentLocks.set(LockKey, Task);
  return Task;
}

export async function Qualify(User: IBackboneUser, Tournament: ITournament): Promise<void> {
  const UserTournamentData = User.Tournaments.get(Tournament.TournamentId.toString());
  if (!UserTournamentData?.UserMatch) return;
  const PhaseId = Tournament.CurrentPhaseId || 1;
  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  if (!PhaseConfig) return;
  const PhaseType = Number(PhaseConfig.PhaseType);
  const CurrentMatch = UserTournamentData.UserMatch;
  const DatabaseMatch = await Match.findOne({ id: CurrentMatch.id });
  if (!DatabaseMatch) return;
  const HasWinner = DatabaseMatch.users.some((U: any) => U["@match-winner"] === "1");
  if (!HasWinner) {
    const UserTeamId = DatabaseMatch.users.find((U: any) => U["@user-id"] === User.UserId)?.["@team-id"];
    if (UserTeamId) {
      for (const MatchUser of DatabaseMatch.users) {
        if (MatchUser["@team-id"] === UserTeamId) {
          MatchUser["@match-winner"] = "1";
          MatchUser["@match-points"] = "1";
          MatchUser["@team-score"] = "1";
        } else {
          MatchUser["@match-winner"] = "0";
          MatchUser["@match-points"] = "0";
          MatchUser["@team-score"] = "0";
        }
      }

      const StampedMatch = await TransitionMatch(
        String(DatabaseMatch.id),
        [DatabaseMatch.status],
        DatabaseMatch.status,
        { users: DatabaseMatch.users }
      );
      if (!StampedMatch) return;

      const FreshMatch = StampedMatch;
      if (FreshMatch) {
        UserTournamentData.UserMatch = {
          id: FreshMatch.id,
          secret: FreshMatch.secret,
          deadline: FreshMatch.deadline,
          matchid: FreshMatch.matchid,
          phaseid: FreshMatch.phaseid,
          groupid: FreshMatch.groupid,
          roundid: FreshMatch.roundid,
          playedgamecount: FreshMatch.playedgamecount,
          status: FreshMatch.status,
          tournamentid: FreshMatch.tournamentid,
          users: FreshMatch.users,
        };
      }
    }
  }
  if (PhaseType === TournamentPhaseType.RoundRobin || PhaseType === TournamentPhaseType.Arena) {
    await QualifyPhase(User, Tournament);
  } else {
    await QualifyFromBracket(User, Tournament);
  }
}
export async function GetUserMatch(User: IBackboneUser, Tournament: ITournament): Promise<IUserMatch | null> {
  const PhaseId = Tournament.CurrentPhaseId || 1;
  const UserTournamentData = User.Tournaments.get(Tournament.TournamentId.toString());
  if (!UserTournamentData || UserTournamentData.KnockedOut) return null;
  const UserPosition = UserTournamentData.UserPosition?.find((P: any) => P.phaseid === PhaseId);
  const GroupId = UserPosition?.groupid || 0;
  const LastClosedMatch = await Match.findOne({
    "users.@user-id": User.UserId,
    tournamentid: Tournament.TournamentId.toString(),
    phaseid: PhaseId,
    groupid: GroupId,
    status: { $in: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished] },
  })
    .sort({ roundid: -1 })
    .select("roundid")
    .lean();
  const MinRound = LastClosedMatch ? LastClosedMatch.roundid + 1 : 1;
  // IMPORTANTE: incluir GameInProgress — senão quando os 2 dão check-in/session
  // o status vira 3 e GetUserMatch retorna null → client expulsa OS DOIS
  let FoundMatch = await Match.findOne({
    "users.@user-id": User.UserId,
    tournamentid: Tournament.TournamentId.toString(),
    phaseid: PhaseId,
    groupid: GroupId,
    roundid: { $gte: MinRound },
    status: {
      $nin: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished, TournamentMatchStatus.MatchFinished],
    },
  })
    .sort({ roundid: 1, matchid: 1 })
    .lean();
  // Durante a criação da primeira partida, a posição pode ainda estar em
  // grupo 0 enquanto o gerador já persistiu o grupo real.
  if (!FoundMatch) {
    FoundMatch = await Match.findOne({
      "users.@user-id": User.UserId,
      tournamentid: { $in: [Tournament.TournamentId.toString(), Number(Tournament.TournamentId)] },
      phaseid: PhaseId,
      roundid: { $gte: MinRound },
      status: {
        $nin: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished, TournamentMatchStatus.MatchFinished],
      },
    }).sort({ roundid: 1, matchid: 1 }).lean();
  }
  if (!FoundMatch && UserTournamentData.UserMatch?.id) {
    FoundMatch = await Match.findOne({
      id: UserTournamentData.UserMatch.id,
      status: { $nin: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished, TournamentMatchStatus.MatchFinished] },
    }).lean();
  }
  if (FoundMatch) {
    // O deadline persistido é a única fonte de verdade. Renovar este campo em
    // cada poll fazia o botão ficar eternamente "atualizando" e impedia o
    // contador de chegar a 00; o loop de resolução é quem fecha WO/não jogada.
    const deadline = FoundMatch.deadline;

    return {
      id: FoundMatch.id,
      secret: FoundMatch.secret,
      deadline,
      matchid: FoundMatch.matchid,
      phaseid: FoundMatch.phaseid,
      groupid: FoundMatch.groupid,
      roundid: FoundMatch.roundid,
      playedgamecount: FoundMatch.playedgamecount,
      status: FoundMatch.status,
      users: JSON.parse(JSON.stringify(FoundMatch.users)),
      tournamentid: FoundMatch.tournamentid,
    };
  }
  return null;
}

export async function AssignNextMatchIfNeeded(User: IBackboneUser, Tournament: ITournament): Promise<IMatch | null> {
  const UserInfo = User.Tournaments.get(Tournament.TournamentId.toString());
  if (!UserInfo || UserInfo.KnockedOut) return null;
  const PhaseId = Tournament.CurrentPhaseId || 1;
  const PhaseConfig = Tournament.Phases[PhaseId - 1];
  if (!PhaseConfig) return null;
  const PhaseType = Number(PhaseConfig.PhaseType);
  if (PhaseType === TournamentPhaseType.RoundRobin || PhaseType === TournamentPhaseType.Arena) {
    return await CreateOrAssignMatch(User, Tournament);
  } else {
    return await AssignNextMatchFromBracket(User, Tournament);
  }
}
export async function GetTournamentMatches(
  TournamentId: string,
  PhaseId: number,
  GroupId: number,
  FromRound: number,
  ToRound: number,
  MaxResults: number,
  Page: number
) {
  const Skip = (Page - 1) * MaxResults;
  const Phase = PhaseId || 1;
  const Query: any = { tournamentid: TournamentId, phaseid: Phase, groupid: GroupId };
  if (FromRound > 0 && ToRound > 0) {
    Query.roundid = { $gte: FromRound, $lte: ToRound };
  }
  const [Matches, Total] = await Promise.all([
    Match.find(Query).sort({ roundid: 1, matchid: 1 }).skip(Skip).limit(MaxResults).lean(),
    Match.countDocuments(Query),
  ]);
  const FormattedMatches = Matches.map((M) => {
    const users = Array.isArray(M.users) ? M.users.map((u: any) => ({ ...u })) : [];
    let status = M.status;
    let played = M.playedgamecount || 0;

    // Normaliza bye R1: 1 time só → sempre QUALIFICADO (Closed + winner + played)
    if (M.roundid === 1) {
      const teamIds = new Set(
        users.map((u: any) => u["@team-id"]).filter((id: any) => !!id)
      );
      if (teamIds.size === 1 && users.length > 0) {
        status = TournamentMatchStatus.Closed;
        played = Math.max(played, 1);
        for (const u of users) {
          u["@match-winner"] = "1";
          u["@match-points"] = u["@match-points"] || "1";
          u["@team-score"] = u["@team-score"] || "1";
          u["@user-score"] = u["@user-score"] || "1";
          u["@checked-in"] = "1";
        }
      }
    }

    return {
      id: M.id,
      secret: null,
      deadline: M.deadline,
      matchid: M.matchid,
      phaseid: M.phaseid,
      groupid: M.groupid,
      roundid: M.roundid,
      playedgamecount: played,
      status,
      users,
      tournamentid: M.tournamentid,
    };
  });
  return {
    pagination: { totalResultCount: Total, maxResults: MaxResults, currentPage: Page },
    matches: FormattedMatches,
  };
}
