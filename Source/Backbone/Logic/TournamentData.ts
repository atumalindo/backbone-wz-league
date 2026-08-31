import { response } from "express";
import { BackboneUser } from "../../Models/BackboneUser";
import { LPUser } from "../../Models/LPUser";
import { Match } from "../../Models/Matches";
import { Tournament } from "../../Models/Tournament";
import { BuildPrizeDistribution } from "./TournamentEconomy";
import { msg } from "../../Modules/Logger";
import { TournamentStatus, TournamentUserStatus, TournamentMatchStatus, TournamentPhaseType } from "../Config";
import { GetNextPhaseStarted, GetProperties } from "../Settings/Properties";
import { GetRulesSettings, GetRoundConfigs } from "../Settings/Rules";
import { GenerateBracketMatches, GetUserMatch, Qualify, GetMatchDeadline, AssignNextMatchIfNeeded } from "./GetMatches";
import { CheckPhases, CreateOrAssignMatch } from "./Internal/Phase";
import { GeneratePrizepoolId } from "../../Modules/Extensions";
import { info } from "console";
import { ResolveMatches } from "./Internal/Resolving";
import { TouchMatchPresence } from "./MatchPresence";
import { GetTournamentFormat } from "./TournamentRules";
import { TransitionMatch } from "./MatchStateMachine";

type PartyMember = {
  userId: string;
  status: number;
  checkIn: boolean;
  isPartyLeader: boolean;
  nick: string;
};

export interface PropertyData {
  "@name": string;
  "@value": string | undefined;
}

export interface RoundData {
  "@id": string;
  "@win-score": string;
  "@max-game-count": string;
  "@min-length": string;
  "@max-length": string;
  "@match-point-distribution"?: string;
}

export interface PhaseData {
  "@id": string;
  "@type": string;
  "@max-players": string;
  "@min-teams-per-match": string;
  "@max-teams-per-match": string;
  "@min-checkins-per-team": string;
  "@allow-skip": string;
  "@max-loses"?: string;
  "@game-point-distribution": string;
  "@match-point-distribution": string;
  "@allow-tiebreakers": string;
  "@score-tiebreaker-stats"?: string;
  "@fill-groups-vertically"?: string;
  "@force-unique-matches"?: string;
  "@group-count"?: string;
  "@match-point-distribution-custom"?: string;
  "@preferred-rematch-gap"?: string;
  round: RoundData[];
}

interface UserMatchResponse {
  id: string;
  secret: string;
  deadline: string;
  matchid: number;
  phaseid: number;
  groupid: number;
  roundid: number;
  playedgamecount: number;
  status: number;
  users: Array<{
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
  }>;
}

interface TournamentDataItem {
  id: number | string;
  type: string | number;
  status: number;
  tournamenttime: string;
  cashStatus: number;
  cashTournament: boolean;
  season: number;
  seasonpart: number;
  invitationopens: string;
  invitationcloses: string;
  maxinvites: number;
  partysize: number;
  currentinvites: number;
  phasecount: number;
  roundcount: number;
  sponsorimage: string;
  sponsorname: string;
  currentphaseid: number;
  currentphasestarted: string | null;
  nextphase: null | string;
  name: string;
  image: null;
  icon: string | undefined | null;
  "theme-color": string | undefined | null;
  data: {
    "tournament-data": {
      "invitation-setting": Array<{
        requirements?: Array<{
          "custom-requirement": Array<{
            "@name": string;
            "@value": string;
          }>;
        }>;
        "entry-fee"?: Array<{
          item: Array<{
            "@amount": string;
            "@type": string;
            "@id": string;
            "@external-id": string;
          }>;
        }>;
      }>;
      "rules-setting": Array<{
        phase: PhaseData[];
      }>;
      "prize-setting": Array<{
        reward: Array<{
          "@position": string;
          item: Array<{
            "@amount": string;
            "@type": string;
            "@id": string;
            "@external-id": string;
          }>;
        }>;
      }>;
      "property-setting": Array<{
        properties: Array<{
          property: PropertyData[];
        }>;
      }>;
      "description-data": Array<{
        language: Array<{
          "@code": string;
          name: Array<{
            "#text": Array<{
              value: string;
            }>;
          }>;
          policy: Array<{
            "@url": string;
          }>;
          general: Array<{
            "@main-icon": string | undefined;
            "@theme-color": string | undefined;
          }>;
        }>;
      }>;
      "sponsor-data": Array<{
        "@name": string;
        "@image": string;
      }>;
      "stream-data": Array<{
        "@stream-link": string;
      }>;
      "highlights-data": Array<{
        "@highlights-link": string;
      }>;
      "winner-data"?: Array<{ user: Array<{ "@user-id": string; "@nick": string }> }>;
    };
  };
  privateCode: null;
  inviteId: string | number | null;
  inviteAceptedAt: string | null;
  inviteDeclinedAt: null;
  inviteStatus: number;
  invitePartyId: unknown;
  inviteIsPartyLeader: boolean;
  invitePartyCode: null | string;
  checkIn: boolean;
  prizeDelivered: null | boolean;
  userPlace: number;
  isAdministrator: boolean;
  openregistration?: number;
}

interface TournamentResponse {
  party: PartyMember[];
  userPosition: unknown[];
  userMatch: UserMatchResponse | null;
  userMatches: UserMatchResponse[];
  tournamentData: TournamentDataItem[];
}

function ToJSON(Obj: any): any {
  if (!Obj) return Obj;
  if (Array.isArray(Obj)) return Obj.map(ToJSON);
  if (typeof Obj !== "object") return Obj;
  if (Obj.toJSON) return Obj.toJSON();
  if (Obj._doc) return ToJSON(Obj._doc);
  const Cleaned: any = {};
  for (const Key in Obj) {
    if (Key.startsWith("$") || Key.startsWith("_") || Key === "__v") continue;
    Cleaned[Key] = ToJSON(Obj[Key]);
  }
  return Cleaned;
}

function FormatMatchDeadline(MatchData: any) {
  if (!MatchData) return null;
  const Clean = ToJSON(MatchData);
  if (Clean.deadline instanceof Date) {
    Clean.deadline = Clean.deadline.toISOString();
  }

  // R1 bye / WO fechado: client mostra QUALIFICADO só com played>=1 + winner
  // Sem isso aparece "não jogada" mesmo com status Closed.
  const st = Clean.status;
  const users = Array.isArray(Clean.users) ? Clean.users : [];
  const teamIds = new Set(
    users.map((u: any) => u && u["@team-id"]).filter(Boolean)
  );
  // O enum interno usa 3 para GameInProgress e 8 para Closed. A versão
  // anterior tratava 3 como encerrado, então o poll transformava uma partida
  // que estava começando em "já jogada" e o botão JOGAR oscilava.
  const numericStatus = Number(st);
  const isTerminalStatus =
    numericStatus === TournamentMatchStatus.Closed ||
    numericStatus === TournamentMatchStatus.GameFinished ||
    numericStatus === TournamentMatchStatus.MatchFinished ||
    numericStatus === 7 || // compatibilidade com snapshots legados
    st === "Closed" ||
    st === "GameFinished" ||
    st === "MatchFinished";
  // BUGFIX: "singleTeam" (só 1 time presente na partida) só significa bye/WO
  // de verdade no ROUND 1 — é lá que o gerador cria a partida já fechada com
  // 0/1 time. A partir do round 2, "1 time só" é o estado normal de
  // WaitingForOpponent (o vencedor entrou, o adversário ainda não). Sem o
  // filtro de roundid, essa função marcava @match-winner=1 numa partida que
  // ainda estava "em andamento" (status WaitingForOpponent), fazendo o client
  // achar que a partida já tinha sido ganha enquanto o status dizia o
  // contrário — daí o bracket mostrar "já ganhei" e o client travar
  // carregando infinito no round 2 em diante (bracket única fase e multi-fase).
  const isRoundOneBye = Number(Clean.roundid) === 1 && teamIds.size <= 1;

  const hasWinner = users.some(
    (u: any) => u && (u["@match-winner"] === "1" || u["@match-winner"] === 1)
  );
  // Só normaliza uma partida concluída quando ela já tem vencedor. Uma match
  // Closed sem vencedor pode ser uma "não jogada" e não deve virar qualificação
  // artificial durante o polling.
  const isCompleted = isRoundOneBye || (isTerminalStatus && hasWinner);

  if (isCompleted) {
    if (!Clean.playedgamecount || Number(Clean.playedgamecount) < 1) {
      Clean.playedgamecount = 1;
    }
    if (isRoundOneBye) {
      for (const u of users) {
        if (!u) continue;
        if (u["@match-winner"] == null || u["@match-winner"] === "0" || u["@match-winner"] === 0) {
          u["@match-winner"] = "1";
          u["@match-points"] = u["@match-points"] || "1";
          u["@team-score"] = u["@team-score"] || "1";
          u["@user-score"] = u["@user-score"] || "1";
          u["@checked-in"] = "1";
        }
      }
    }
    Clean.users = users;
  }

  return Clean;
}

async function GetUserData(UserId: string, TournamentId: string): Promise<any> {
  const User = await BackboneUser.findOne({ UserId }).lean();
  if (!User) return null;
  const Data = (User.Tournaments as any).get
    ? (User.Tournaments as any).get(TournamentId)
    : User.Tournaments[TournamentId];
  if (!Data) return null;
  return { ...Data, UserPosition: Data.UserPosition || [] };
}

export async function TournamentGetData(
  TournamentId: number,
  GetAll: number,
  Ready: number,
  Token: string
): Promise<TournamentResponse | { message: string }> {
  const [Tour, LPAccount] = await Promise.all([
    Tournament.findOne({ TournamentId }),
    LPUser.findOne({ AccessToken: Token }).lean(),
  ]);
  if (!Tour || !LPAccount) return { message: "" };
  const User = await BackboneUser.findOne({ UserId: LPAccount.UserId });
  if (!User) return { message: "" };

  // Contagem estável de inscritos (string + number key) — NÃO decrementa no GetData
  const tidStr = String(TournamentId);
  const tidNum = Number(TournamentId);
  const signedQuery: any[] = [
    { [`Tournaments.${tidStr}.SignedUp`]: true },
  ];
  if (!isNaN(tidNum) && String(tidNum) === tidStr) {
    signedQuery.push({ [`Tournaments.${tidNum}.SignedUp`]: true });
  }
  const SignedCount = await BackboneUser.countDocuments({ $or: signedQuery });

  // GetData NUNCA baixa CurrentInvites (só sobe se count real for maior).
  const safeInvites =
    typeof Tour.CurrentInvites === "number" ? Tour.CurrentInvites : 0;
  if (SignedCount > safeInvites) {
    console.log(
      `[TournamentData] CurrentInvites UP ${tidStr}: ${safeInvites} → ${SignedCount}`
    );
    Tour.CurrentInvites = SignedCount;
    await Tournament.updateOne(
      { TournamentId: Tour.TournamentId },
      { $set: { CurrentInvites: SignedCount } }
    ).catch(() => {});
  } else {
    Tour.CurrentInvites = Math.max(safeInvites, SignedCount);
  }

  const Starts = new Date(Tour.StartTime);
  // Inscricao abre bem antes; FECHA no StartTime
  const Opens = Tour.SignupStart
    ? new Date(Tour.SignupStart)
    : new Date(Starts.getTime() - 24 * 60 * 60 * 1000);
  const Closes = new Date(Starts.getTime());
  const Now = new Date();
  let Status = TournamentStatus.NotStarted;

  // Vencedor já gravado → Finished na hora
  if (Array.isArray(Tour.Winners) && Tour.Winners.length > 0) {
    Status = TournamentStatus.Finished;
    if (Tour.Status !== TournamentStatus.Finished) {
      if (!Tour.Properties) (Tour as any).Properties = {};
      if (!(Tour.Properties as any).FinishedAt) (Tour.Properties as any).FinishedAt = new Date();
      await Tournament.updateOne(
        { TournamentId: Tour.TournamentId, Status: { $ne: TournamentStatus.Finished } },
        { $set: { Status: TournamentStatus.Finished, "Properties.FinishedAt": (Tour.Properties as any).FinishedAt } }
      ).catch(() => {});
      Tour.Status = TournamentStatus.Finished;
    }
  } else if (Tour.Status !== TournamentStatus.Canceled && Tour.Status !== TournamentStatus.Finished) {
    if (Now < Opens) {
      Status = TournamentStatus.NotStarted;
    } else if (Now < Starts) {
      Status = TournamentStatus.InvitationOpen;
    } else {
      try {
        await GenerateBracketMatches(Tour);
      } catch (e) {
        console.error("[TournamentData] GenerateBracket on start:", e);
      }
      if (!Tour.CurrentPhaseStarted || Tour.Status !== TournamentStatus.Running) {
        Tour.CurrentPhaseId = Tour.CurrentPhaseId || 1;
        Tour.CurrentPhaseStarted = new Date(Date.now() - 1000);
        Tour.NextPhaseStarted =
          Tour.NextPhaseStarted ||
          new Date(Date.now() + (await GetNextPhaseStarted(Tour)));
        const ActivationUpdate = await Tournament.updateOne(
          { TournamentId: Tour.TournamentId, Status: { $nin: [TournamentStatus.Finished, TournamentStatus.Canceled] } },
          {
            $set: {
              CurrentPhaseId: Tour.CurrentPhaseId,
              CurrentPhaseStarted: Tour.CurrentPhaseStarted,
              NextPhaseStarted: Tour.NextPhaseStarted,
              Status: TournamentStatus.Running,
            },
          }
        ).catch(() => ({ modifiedCount: 0 } as any));
        if (ActivationUpdate.modifiedCount > 0) Tour.Status = TournamentStatus.Running;
      }
      Status = TournamentStatus.Running;
      const Phase = Tour.CurrentPhaseId || 1;
      const IsFinalPhase = Phase === Tour.Phases.length;
      if (IsFinalPhase) {
        const AllMatches = await Match.find({
          tournamentid: tidStr,
          phaseid: Phase,
          groupid: 0,
        }).lean();
        let LastRoundNumber = 0;
        for (const MatchDoc of AllMatches) {
          if (MatchDoc.roundid > LastRoundNumber) {
            LastRoundNumber = MatchDoc.roundid;
          }
        }
        const LastRoundMatches = AllMatches.filter((m) => m.roundid === LastRoundNumber);
        const AllLastRoundClosed =
          LastRoundMatches.length > 0 &&
          LastRoundMatches.every(
            (m) =>
              m.status === TournamentMatchStatus.Closed ||
              m.status === TournamentMatchStatus.GameFinished
          );
        if (AllLastRoundClosed) {
          if (!Tour.Winners || Tour.Winners.length === 0) {
            const finalMatch = LastRoundMatches[0];
            if (finalMatch?.users?.length) {
              const winnerIds = [
                ...new Set(
                  finalMatch.users
                    .filter((u: any) => u["@match-winner"] === "1")
                    .map((u: any) => String(u["@user-id"]))
                ),
              ];
              const winners: { nick: string; userId: string }[] = [];
              for (const id of winnerIds) {
                const u = await BackboneUser.findOne({ UserId: id }).lean();
                winners.push({
                  nick: (u as any)?.Username || id,
                  userId: id,
                });
              }
              if (winners.length > 0) {
                const FinishUpdate = await Tournament.updateOne(
                  { TournamentId: Tour.TournamentId, Status: { $ne: TournamentStatus.Finished } },
                  {
                    $set: {
                      Winners: winners,
                      Status: TournamentStatus.Finished,
                      "Properties.FinishedAt": new Date(),
                    },
                  }
                ).catch(() => ({ modifiedCount: 0 } as any));
                if (FinishUpdate.modifiedCount > 0) {
                  Tour.Winners = winners;
                  Tour.Status = TournamentStatus.Finished;
                  Status = TournamentStatus.Finished;
                }
              }
            }
          }
          if (Array.isArray(Tour.Winners) && Tour.Winners.length > 0) {
            Tour.Status = TournamentStatus.Finished;
            Status = TournamentStatus.Finished;
          }
        }
      }
    }
  } else {
    Status = Tour.Status;
  }

  const Response: TournamentResponse = {
    party: [],
    userPosition: [],
    userMatch: null,
    userMatches: [],
    tournamentData: [
      {
        id: Tour.TournamentId,
        type: Tour.TournamentType,
        status: Status,
        // ✅ CORRIGIDO: agora mostra o tempo real do torneio
        tournamenttime: Starts.toISOString(),
        cashStatus: 0,
        cashTournament: false,
        season: 1,
        seasonpart: 1,
        invitationopens: Opens.toISOString(),
        invitationcloses: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        maxinvites: Tour.MaxInvites,
        partysize: GetTournamentFormat(Tour).playersPerTeam,
        currentinvites: Tour.CurrentInvites,
        phasecount: Tour.Phases.length,
        roundcount: Tour.RoundCount,
        sponsorimage: "",
        sponsorname: "",
        currentphaseid: Status === TournamentStatus.Running ? (Tour.CurrentPhaseId || 1) : (Tour.CurrentPhaseId || 0),
        currentphasestarted:
          Status === TournamentStatus.Running
            ? (Tour.CurrentPhaseStarted || Starts).toISOString()
            : Tour.CurrentPhaseStarted?.toISOString() || null,
        nextphase: Tour.NextPhaseStarted?.toISOString() || null,
        name: Tour.TournamentName,
        image: null,
        icon: Tour.TournamentImage,
        "theme-color": Tour.TournamentColor,
        data: {
          "tournament-data": {
            "invitation-setting": [
              {
                requirements: [
                  { "custom-requirement": [{ "@name": "server_region", "@value": Tour.Region.toLowerCase() }] },
                ],
              },
            ],
            "rules-setting": [GetRulesSettings(Tour)],
            "prize-setting": [
              {
                reward: (Tour.Prizes && Tour.Prizes.length > 0
                  ? Tour.Prizes
                  : BuildPrizeDistribution(Tour.PrizePoolGems || 0, Tour.MaxInvites || 1, Tour)).length > 0
                  ? (() => {
                      const prizes = Tour.Prizes && Tour.Prizes.length > 0
                        ? Tour.Prizes
                        : BuildPrizeDistribution(Tour.PrizePoolGems || 0, Tour.MaxInvites || 1, Tour);
                      console.log(`[TournamentData] Sending prizes for tournament ${Tour.TournamentId}:`, prizes);
                      return prizes.map((prize) => ({
                        "@position": prize.position.toString(),
                        item: [
                          {
                            "@amount": prize.amount.toString(),
                            "@type": "10",
                            "@id": Tour.PrizepoolId?.toString() || "1019395748292202883",
                            "@external-id": "4",
                          },
                        ],
                      }));
                    })()
                  : (() => {
                      console.log(`[TournamentData] No prizes configured for tournament ${Tour.TournamentId}, using default`);
                      return [
                                                  {
                            "@position": "1",
                            item: [{ "@amount": "0", "@type": "10", "@id": "1019395748292202883", "@external-id": "10" }],
                          },

                      ];
                    })(),
              },
            ],
            "property-setting": GetProperties(Tour),
            "description-data": [
              {
                language: [
                  {
                    "@code": "en",
                    name: [{ "#text": [{ value: Tour.TournamentName }] }],
                    policy: [{ "@url": "" }],
                    general: [{ "@main-icon": Tour.TournamentImage, "@theme-color": Tour.TournamentColor }],
                  },
                ],
              },
            ],
            "sponsor-data": [{ "@name": "", "@image": "" }],
            "stream-data": [{ "@stream-link": Tour.Properties.StreamURL ?? "" }],
            "highlights-data": [{ "@highlights-link": Tour.Properties.HighlightsURL ?? "" }],
            "winner-data":
              (Tour.Winners?.length ?? 0) > 0
                ? [{ user: (Tour.Winners ?? []).map((W: any) => ({ "@user-id": W.userId, "@nick": W.nick })) }]
                : undefined,
          },
        },
        privateCode: null,
        inviteId: null,
        inviteAceptedAt: null,
        inviteDeclinedAt: null,
        inviteStatus: TournamentUserStatus.Invited,
        invitePartyId: null,
        inviteIsPartyLeader: false,
        invitePartyCode: null,
        checkIn: false,
        prizeDelivered: null,
        userPlace: 0,
        isAdministrator: false,
      },
    ],
  };

  // Se já tem vencedores, preenche winner UI na mesma response
  if (Array.isArray(Tour.Winners) && Tour.Winners.length > 0) {
    Response.tournamentData[0].status = TournamentStatus.Finished;
    const me = Tour.Winners.find((W: any) => String(W.userId) === String(User.UserId));
    if (me) {
      Response.tournamentData[0].userPlace = 1;
      Response.tournamentData[0].prizeDelivered = true;
    }
  }

  const Info = User.Tournaments?.get(TournamentId.toString());
  const IsAdmin = Tour.Properties.AdminIds.includes(User.UserId);
  const IsInviteOnly = Boolean(Tour.Properties?.IsInvitationOnly) && Array.isArray(Tour.Properties?.InvitedIds) && Tour.Properties.InvitedIds.length > 0;
  const IsInvited = IsInviteOnly && Tour.Properties?.InvitedIds?.includes(User.UserId);

  if (IsAdmin) Response.tournamentData[0].isAdministrator = true;
  Response.tournamentData[0].openregistration = IsInviteOnly && !IsInvited && !IsAdmin ? 0 : (Info?.SignedUp ? 0 : 1);

  if (Tour.EntryFee && Tour.EntryFee > 0) {
    Response.tournamentData[0].data["tournament-data"]["invitation-setting"].push({
      "entry-fee": [
        {
          item: [
            {
              "@amount": Tour.EntryFee.toString(),
              "@type": "10",
              "@id": Tour.PrizepoolId?.toString() || "null",
              "@external-id": "4",
            },
          ],
        },
      ],
    });
  }

  if (!Info?.SignedUp) return Response;

  if (IsInviteOnly && !IsInvited && !IsAdmin) {
    Response.tournamentData[0].inviteStatus = TournamentUserStatus.Invited;
    return Response;
  }

  Response.tournamentData[0].inviteId = Info.InviteId?.toString() || null;
  Response.tournamentData[0].invitePartyId = Info.InviteId?.toString() || null;
  if (GetTournamentFormat(Tour).playersPerTeam > 1) Response.tournamentData[0].invitePartyCode = Info.PartyCode || null;
  Response.tournamentData[0].inviteStatus = TournamentUserStatus.Confirmed;
  Response.tournamentData[0].inviteAceptedAt = Info.AcceptedAt
    ? new Date(Info.AcceptedAt).toISOString()
    : new Date().toISOString();
  Response.tournamentData[0].checkIn = true;

  if (Info.PartyMembers) {
    Response.party = Info.PartyMembers.map((PartyUser: any) => ({
      userId: PartyUser.UserId.toString(),
      status: PartyUser.Status,
      checkIn: true,
      isPartyLeader: PartyUser.IsPartyLeader,
      nick: PartyUser.Username,
    }));
    if (User.Username !== Response.party.find((p) => p.userId === User.UserId)?.nick) {
      const TeammatesUserIds = Info.PartyMembers.map((pm: any) => pm.UserId);
      const DatabaseTeammates = await BackboneUser.find({ UserId: { $in: TeammatesUserIds } }).lean();
      Info.PartyMembers = Info.PartyMembers.map((pm: any) => {
        const fresh = DatabaseTeammates.find((u) => u.UserId === pm.UserId);
        return fresh ? { ...pm, Username: fresh.Username } : pm;
      });
      Response.party = Info.PartyMembers.map((PartyUser: any) => ({
        userId: PartyUser.UserId.toString(),
        status: PartyUser.Status,
        checkIn: true,
        isPartyLeader: PartyUser.IsPartyLeader,
        nick: PartyUser.Username,
      }));
      await User.save();
    }
    const CurrentUser = Info.PartyMembers.find((PartyUser: any) => PartyUser.UserId === User.UserId);
    if (CurrentUser) {
      Response.tournamentData[0].inviteIsPartyLeader = CurrentUser.IsPartyLeader;
      if (Info.PartyMembers.some((any) => any.IsKicked))
        Response.tournamentData[0].inviteStatus = TournamentUserStatus.KickedOutByAdmin;
    }
  }

  if (Now < Starts) {
    await User.save().catch(() => {});
    return Response;
  }

  // Já começou: flags OBRIGATÓRIAS pro botão JOGAR
  if (!(Array.isArray(Tour.Winners) && Tour.Winners.length > 0) && Status !== TournamentStatus.Finished) {
    Response.tournamentData[0].status = TournamentStatus.Running;
    Status = TournamentStatus.Running;
  }
  Response.tournamentData[0].currentphaseid = Math.max(1, Tour.CurrentPhaseId || 1);

  {
    const phaseStart = Tour.CurrentPhaseStarted
      ? new Date(Tour.CurrentPhaseStarted).getTime()
      : Starts.getTime();
    const unlocked = Math.min(phaseStart, Date.now() - 1000);
    Response.tournamentData[0].currentphasestarted = new Date(unlocked).toISOString();
  }

  Response.tournamentData[0].checkIn = true;
  Response.tournamentData[0].inviteStatus = TournamentUserStatus.Confirmed;
  Response.tournamentData[0].phasecount = Math.max(1, Tour.Phases?.length || 1);

  if (
    Now < Starts &&
    User.Tournaments?.get(Tour.TournamentId.toString())?.PartyMembers?.length !== GetTournamentFormat(Tour).playersPerTeam &&
    Info.PartyMembers
  ) {
    Info.PartyMembers.forEach((PartyUser: any) => (PartyUser.Status = TournamentUserStatus.PartyNotFull));
    Response.tournamentData[0].inviteStatus = TournamentUserStatus.PartyNotFull;
  }

  const Phase = Tour.CurrentPhaseId || 1;
  const UserData = await GetUserData(User.UserId, TournamentId.toString());
  Response.userPosition = UserData ? UserData.UserPosition : [];

  if (GetAll === 0 && !Info?.SignedUp) {
    Response.party = [];
    Response.tournamentData = [];
  }

  let DatabaseMatch = await GetUserMatch(User, Tour);
  // O cliente pode consultar com GetAll=0 logo após a inscrição. Nesse caso,
  // não espere uma segunda consulta GetAll=1 para criar a partida, pois o
  // botão Jogar desaparece ao receber userMatch=null.
  // IMPORTANTE: isto só pode auto-atribuir a partida quando o jogador ainda
  // não jogou NENHUMA partida neste torneio (1ª partida — sem isso o client
  // ficava preso "carregando próxima partida" pra sempre, ver comentários
  // abaixo). Depois de vencer/qualificar, UserMatch é limpo pra null de
  // propósito (ver QualifyPhase/QualifyFromBracket) para esperar o jogador
  // apertar "GO" — NUNCA auto-atribuir a próxima partida nesse caso, senão
  // o jogador é jogado direto pra próxima partida sem dar GO.
  if (!DatabaseMatch && !Info.KnockedOut && Info.SignedUp && !(Info.UserMatches?.length > 0)) {
    try {
      // BUGFIX: antes só gerava o bracket aqui quando a fase ATUAL era
      // SingleEliminationBracket. Fases RoundRobin/Arena (típicas de 1ª/2ª
      // fase em torneios de 2+ fases) dependiam 100% da chamada mais acima
      // (perto do cálculo de Status=Running) — se aquela chamada tivesse
      // sido pulada por qualquer motivo (ex: request concorrente, Tour
      // ainda não salvo com CurrentPhaseId certo), a fase RoundRobin/Arena
      // nunca tinha suas partidas geradas aqui e o jogador ficava preso
      // "carregando próxima partida" pra sempre — enquanto a fase final
      // (bracket) sempre se recuperava por causa deste bloco. Chamando
      // sempre (é idempotente — GenerateBracketMatches já checa se as
      // partidas da fase existem antes de recriar) cobre os dois casos.
      await GenerateBracketMatches(Tour);

      // BUGFIX PRINCIPAL: GenerateBracketMatches, pra fases RoundRobin/Arena,
      // pode ter acabado de gravar o UserPosition (com o groupid da fase)
      // deste jogador PELA PRIMEIRA VEZ agora mesmo (dentro desta mesma
      // requisição) — mas o objeto `User`/`Info` em memória foi carregado
      // ANTES dessa gravação, então ainda não tem esse groupid. Sem
      // recarregar, AssignNextMatchIfNeeded/GetUserMatch calculam
      // groupid=0 (padrão) só por não achar a entrada — só que a partida
      // foi criada com groupid=1 (fases RoundRobin não-agrupadas usam
      // groupid=1; ver GenerateRoundRobin). Resultado: nunca encontram a
      // própria partida e o client fica preso "carregando próxima partida"
      // pra sempre — só na 1ª fase de torneios de 2+ fases, porque a fase
      // final (bracket) sempre usa groupid=0, que já é o padrão. Recarrega
      // só o UserPosition fresco do banco e aplica no objeto em memória
      // (mesma referência que Info, então AssignNextMatchIfNeeded enxerga).
      try {
        const FreshUser = await BackboneUser.findOne({ UserId: User.UserId }).lean();
        const FreshInfo = FreshUser
          ? (FreshUser.Tournaments as any)?.get
            ? (FreshUser.Tournaments as any).get(TournamentId.toString())
            : (FreshUser.Tournaments as any)?.[TournamentId.toString()]
          : null;
        if (FreshInfo?.UserPosition?.length) {
          Info.UserPosition = FreshInfo.UserPosition;
        }
      } catch (refreshErr) {
        console.error("[TournamentData] Falha ao atualizar UserPosition em memória:", refreshErr);
      }

      await AssignNextMatchIfNeeded(User, Tour);
      DatabaseMatch = await GetUserMatch(User, Tour);
    } catch (e) {
      // Esse era o único ponto da cadeia (geração do bracket + atribuição da
      // 1ª partida) sem try/catch. Uma falha aqui derrubava a promise inteira
      // de TournamentGetData sem resposta pro client → "carregando próxima
      // partida" travado, especificamente na primeira partida do torneio.
      // Agora: loga o erro e deixa o client tentar de novo no próximo poll.
      console.error("[TournamentData] Falha ao criar/atribuir a 1ª partida:", e);
    }
  }
  Response.userMatch = DatabaseMatch ? FormatMatchDeadline(DatabaseMatch) : null;

  // Poll de dados só vira presença real depois que a sessão de jogo começou.
  // Antes disso, o usuário pode estar apenas olhando o lobby ou a fila.
  if (DatabaseMatch && Number(DatabaseMatch.status) === TournamentMatchStatus.GameInProgress) {
    await TouchMatchPresence(String(DatabaseMatch.id), String(User.UserId), true).catch((error) => {
      console.error("[TournamentData] Falha no heartbeat da match:", error);
    });
  }

  if (Info.UserMatch && Info.UserMatch.id) {
    const CachedMatchId = String(Info.UserMatch.id);
    const ValidateMatch = await Match.findOne({
      id: CachedMatchId,
      status: {
        $in: [
          TournamentMatchStatus.Closed,
          TournamentMatchStatus.GameFinished,
          TournamentMatchStatus.MatchFinished,
        ],
      },
    }).lean();
    if (ValidateMatch) {
      const LiveMatchId = DatabaseMatch?.id ? String(DatabaseMatch.id) : null;
      if (LiveMatchId && LiveMatchId !== CachedMatchId) {
        // O cache ainda aponta para a rodada anterior, mas GetUserMatch já
        // encontrou uma partida ativa. Não devolva null neste poll: isso fazia
        // o botão JOGAR piscar entre "jogar" e "cancelado".
        Info.UserMatch = Response.userMatch as any;
        await BackboneUser.updateOne(
          { UserId: User.UserId },
          { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: Response.userMatch } }
        );
      } else {
        Info.UserMatch = null;
        await BackboneUser.updateOne(
          { UserId: User.UserId },
          { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: null } }
        );
        Response.userMatch = null;
      }
    }
  }

  if (Info.UserMatches?.length > 0) {
    Response.userMatches = Info.UserMatches.map((OldMatches: any) => FormatMatchDeadline(OldMatches));
  }

  if (Ready === 0 && Response.userMatch) {
    const UpdatedMatch = await Match.findOne({ id: Response.userMatch.id }).lean();
    if (UpdatedMatch) {
      Response.userMatch = FormatMatchDeadline(UpdatedMatch);
      await BackboneUser.findOneAndUpdate(
        { UserId: User.UserId },
        { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: Response.userMatch } }
      );
    }
  }

      if ((Ready === 1 || !Response.userMatch) && GetAll === 1) {

    const PhaseConfig = Tour.Phases[Phase - 1];
    const TypeNum = Number(PhaseConfig.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
    const PhaseType = TournamentPhaseType[TypeNum] as keyof typeof TournamentPhaseType;
    if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") {
      const Pos = Info.UserPosition?.find((Pos: any) => Pos.phaseid === Phase);
      if (Pos && Pos.matchloses > 0) {
        Info.KnockedOut = true;
      }
    }
    // Só entra na próxima partida quando o client mandar readyForNextMatch=1
    // (o "GO" apertado de verdade pelo jogador). Sem o "&& Ready === 1" aqui,
    // qualquer poll feito logo depois de vencer/qualificar (UserMatch == null
    // de propósito, esperando o GO) já entrava sozinho na próxima partida —
    // era exatamente o "GO automático" que não pode acontecer.
    if (!Response.userMatch && !Info.KnockedOut && Ready === 1) {
      try {
        await AssignNextMatchIfNeeded(User, Tour);
        const NewMatch = await GetUserMatch(User, Tour);
        if (NewMatch) Response.userMatch = FormatMatchDeadline(NewMatch);
      } catch (e) {
        console.error("[TournamentData] Falha ao atribuir próxima partida (readyForNextMatch):", e);
      }
    }
  }

      if ((Ready === 1 || !Response.userMatch) && GetAll === 0 && Response.userMatch) {

    const PhaseConfig = Tour.Phases[Phase - 1];
    const TypeNum = Number(PhaseConfig.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
    const PhaseType = TournamentPhaseType[TypeNum] as keyof typeof TournamentPhaseType;
    if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") {
      const Pos = Info.UserPosition?.find((Pos: any) => Pos.phaseid === Phase);
      if (Pos && Pos.matchloses > 0) {
        Info.KnockedOut = true;
      }
    }
    if (Info.KnockedOut) {
      Response.userMatch = null;
      if (Info.UserMatches?.length > 0) {
        Response.userMatches = Info.UserMatches.map((HistoryMatch: any) => FormatMatchDeadline(HistoryMatch));
      }
      const UserData = await GetUserData(User.UserId, TournamentId.toString());
      Response.userPosition = UserData ? UserData.UserPosition : [];
      await User.save();
      return ToJSON(Response);
    }

    const CurrentMatch = await Match.findOne({ id: Response.userMatch.id }).lean();
    if (!CurrentMatch) {
      Response.userMatch = null;
      await BackboneUser.findOneAndUpdate(
        { UserId: User.UserId },
        { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: null } }
      );
      await User.save();
      return ToJSON(Response);
    }

    if (
      CurrentMatch.status === TournamentMatchStatus.Closed ||
      CurrentMatch.status === TournamentMatchStatus.GameFinished
    ) {
      Response.userMatch = null;
      await BackboneUser.findOneAndUpdate(
        { UserId: User.UserId },
        { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: null } }
      );
      await User.save();
      return ToJSON(Response);
    }

    const UserInMatch = CurrentMatch.users.find((MatchUser: any) => MatchUser["@user-id"] === User.UserId);
    if (!UserInMatch) {
      Response.userMatch = null;
      await BackboneUser.findOneAndUpdate(
        { UserId: User.UserId },
        { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: null } }
      );
      await User.save();
      return ToJSON(Response);
    }

    const WinnerInMatch = CurrentMatch.users.find((MatchUser: any) => MatchUser["@match-winner"] === "1");
    if (WinnerInMatch) {
      const WinnerId = WinnerInMatch["@user-id"];
      const Winner = await BackboneUser.findOne({ UserId: WinnerId });
      if (Winner) {
        await Qualify(Winner, Tour);
        if (WinnerId === User.UserId) {
          Response.userMatch = null;
          await BackboneUser.findOneAndUpdate(
            { UserId: User.UserId },
            { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: null } }
          ).catch(() => {});
          const UpdatedUser = await BackboneUser.findOne({ UserId: User.UserId });
          const UpdatedInfo = UpdatedUser?.Tournaments.get(Tour.TournamentId.toString());
          const hist = UpdatedInfo?.UserMatches;
          if (hist && hist.length > 0) {
            Response.userMatches = hist.map((HistoryMatch: any) => FormatMatchDeadline(HistoryMatch));
          }
        }
      }

      const FreshAfterQualify = await Tournament.findOne({ TournamentId: Tour.TournamentId }).lean();
      if (
        FreshAfterQualify &&
        Array.isArray((FreshAfterQualify as any).Winners) &&
        (FreshAfterQualify as any).Winners.length > 0
      ) {
        const winners = (FreshAfterQualify as any).Winners as { nick: string; userId: string }[];
        Response.tournamentData[0].status = TournamentStatus.Finished;
        Response.tournamentData[0].data["tournament-data"]["winner-data"] = [
          {
            user: winners.map((W) => ({
              "@user-id": String(W.userId),
              "@nick": String(W.nick || W.userId),
            })),
          },
        ];
        if (winners.some((W) => String(W.userId) === String(User.UserId))) {
          Response.tournamentData[0].userPlace = 1;
          Response.tournamentData[0].prizeDelivered = true;
        }
      }
      await User.save().catch(() => {});
      return ToJSON(Response);
    }

    if (UserInMatch["@checked-in"] === "1") {
      const TournamentFormat = GetTournamentFormat(Tour);
      if (CurrentMatch.status === TournamentMatchStatus.GameInProgress) {
        const RefreshedInProgress = await Match.findOne({ id: Response.userMatch.id }).lean();
        Response.userMatch = FormatMatchDeadline(RefreshedInProgress || CurrentMatch);
        await User.save().catch(() => {});
        return ToJSON(Response);
      }

      const PartyIds =
        Info.PartyMembers?.map((PartyUser: any) => PartyUser.UserId.toString()) || [User.UserId];
      const CheckedInUsers = CurrentMatch.users.filter(
        (MatchUser: any) => MatchUser["@checked-in"] === "1"
      );
      const OtherTeamsCheckedIn = CurrentMatch.users.some(
        (MatchUser: any) =>
          !PartyIds.includes(MatchUser["@user-id"]) && MatchUser["@checked-in"] === "1"
      );
      const UniqueTeams = new Set(
        (CurrentMatch.users || []).map((u: any) => u["@team-id"]).filter(Boolean)
      );

      if (
        OtherTeamsCheckedIn ||
        UniqueTeams.size >= TournamentFormat.maxTeamsPerMatch ||
        CurrentMatch.status === TournamentMatchStatus.GameReady
      ) {
        if (OtherTeamsCheckedIn || UniqueTeams.size >= TournamentFormat.maxTeamsPerMatch) {
          const RefreshedFull = await Match.findOne({ id: Response.userMatch.id }).lean();
          Response.userMatch = FormatMatchDeadline(RefreshedFull || CurrentMatch);
          await User.save().catch(() => {});
          return ToJSON(Response);
        }
      }

      const Configs = GetRoundConfigs(Tour);
      const Deadline = GetMatchDeadline(CurrentMatch, Tour, Configs);
      const CurrentPhaseConfig = Tour.Phases[(Tour.CurrentPhaseId || 1) - 1];
      const IsFinalBracketPhase =
        (Tour.CurrentPhaseId || 1) === (Tour.Phases?.length || 1) &&
        Number(CurrentPhaseConfig?.PhaseType) === TournamentPhaseType.SingleEliminationBracket;
      const GracePeriod = Deadline;
      const IsPassed = IsFinalBracketPhase && Now >= GracePeriod;

      if (IsPassed) {
        const AllPartyCheckedIn = PartyIds.every((PartyId: string) =>
          CheckedInUsers.some((CheckedUser: any) => CheckedUser["@user-id"] === PartyId)
        );
        if (
          AllPartyCheckedIn &&
          !OtherTeamsCheckedIn &&
          UniqueTeams.size < TournamentFormat.maxTeamsPerMatch
        ) {
          const UpdatedUsers = CurrentMatch.users.map((MatchUser: any) => {
            if (PartyIds.includes(MatchUser["@user-id"])) {
              return {
                ...MatchUser,
                "@match-winner": "1",
                "@match-points": "1",
                "@team-score": "1",
                "@user-score": "1",
                "@team-points": "1",
                "@user-points": "1",
                "@checked-in": "1",
              };
            }
            return {
              ...MatchUser,
              "@match-winner": "0",
              "@match-points": "0",
              "@team-score": "0",
              "@user-score": "0",
              "@checked-in": MatchUser["@checked-in"] || "0",
            };
          });
          const Closed = await TransitionMatch(
            Response.userMatch!.id,
            [CurrentMatch.status],
            TournamentMatchStatus.Closed,
            {
              users: UpdatedUsers,
              // SEMPRE >= 1 para o client mostrar QUALIFICADO e não "não jogada"
              playedgamecount: Math.max(1, CurrentMatch.playedgamecount || 0, 1),
            }
          );
          if (Closed) {
            // O qualificador precisa receber o snapshot fechado, mas o claim
            // permanece dentro de QualifyPhase/QualifyFromBracket para que o
            // mesmo caminho funcione em RR, Arena e Bracket.
            const UserInfoForQualification = User.Tournaments.get(Tour.TournamentId.toString());
            if (UserInfoForQualification) UserInfoForQualification.UserMatch = Closed as any;
            await Qualify(User, Tour);
          }
          // Devolve a match fechada na história IMEDIATAMENTE (qualificado na hora)
          const ClosedSnap = await Match.findOne({ id: Response.userMatch!.id }).lean();
          if (ClosedSnap) {
            const Formatted = FormatMatchDeadline({
              ...ClosedSnap,
              status: TournamentMatchStatus.Closed,
              playedgamecount: Math.max(1, ClosedSnap.playedgamecount || 1),
              users: UpdatedUsers,
            });
            Response.userMatches = [Formatted, ...((Response.userMatches as any[]) || [])];
            // opcional: ainda mostra a match atual como closed (alguns clients preferem)
            Response.userMatch = Formatted;
          } else {
            Response.userMatch = null;
          }
          // Mantém UserMatch = match Closed (qualificado) em vez de null
          // (null faz o client piscar "não jogada")
          await BackboneUser.findOneAndUpdate(
            { UserId: User.UserId },
            {
              $set: {
                [`Tournaments.${Tour.TournamentId}.UserMatch`]:
                  Response.userMatch || null,
              },
            }
          ).catch(() => {});
          const UpdatedUser = await BackboneUser.findOne({ UserId: User.UserId });
          const UpdatedInfo = UpdatedUser?.Tournaments.get(Tour.TournamentId.toString());
          const histWo = UpdatedInfo?.UserMatches;
          if (histWo && histWo.length > 0) {
            Response.userMatches = histWo.map((HistoryMatch: any) => FormatMatchDeadline(HistoryMatch));
          }
          const UserDataAfterWo = await GetUserData(User.UserId, TournamentId.toString());
          Response.userPosition = UserDataAfterWo ? UserDataAfterWo.UserPosition : [];
          await User.save().catch(() => {});
          return ToJSON(Response);
        }
      }

      const RefreshedMatch = await Match.findOne({ id: Response.userMatch.id }).lean();
      Response.userMatch = FormatMatchDeadline(RefreshedMatch);
      await User.save().catch(() => {});
      return ToJSON(Response);
    }

    await Match.updateOne(
      {
        id: Response.userMatch.id,
        status: {
          $nin: [
            TournamentMatchStatus.Closed,
            TournamentMatchStatus.GameFinished,
          ],
        },
      },
      { $set: { "users.$[elem].@checked-in": "1" } },
      { arrayFilters: [{ "elem.@user-id": User.UserId.toString() }] }
    );

    const FreshMatch = await Match.findOne({ id: Response.userMatch.id }).lean();
    if (FreshMatch) {
      Response.userMatch = FormatMatchDeadline(FreshMatch);
      const AllIds = (FreshMatch.users || []).map((u: any) => u["@user-id"]).filter(Boolean);
      const MatchPayload = FormatMatchDeadline(FreshMatch);
      if (AllIds.length > 0) {
        await BackboneUser.updateMany(
          { UserId: { $in: AllIds }, [`Tournaments.${Tour.TournamentId}`]: { $exists: true } },
          { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: MatchPayload } }
        );
      } else {
        await BackboneUser.findOneAndUpdate(
          { UserId: User.UserId },
          { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: MatchPayload } }
        );
      }

      if (FreshMatch.status === TournamentMatchStatus.WaitingForOpponent) {
        const UniqueTeams = new Set(FreshMatch.users.map((U: any) => U["@team-id"]).filter((T: string) => T));
        if (UniqueTeams.size === GetTournamentFormat(Tour).maxTeamsPerMatch) {
          const Configs = GetRoundConfigs(Tour);
          const Config = Configs.get(FreshMatch.roundid);
          let NewDeadline: Date;
          if (Config) {
            const GameCount = Config.MaxGameCount;
            const TotalMinutes = GameCount * Config.MinGameLength;
            const AdjustedMinutes = TotalMinutes === Config.MaxLength ? TotalMinutes - 1 : TotalMinutes;
            const SubtractedTime = AdjustedMinutes * 60 * 1000 + 15000;
            const CheckInTime = 0;
            NewDeadline = new Date(Date.now() + CheckInTime + SubtractedTime);
          } else {
            NewDeadline = new Date(Date.now() + 2.5 * 60 * 1000);
          }
          await TransitionMatch(
            FreshMatch.id,
            [TournamentMatchStatus.WaitingForOpponent],
            TournamentMatchStatus.GameReady,
            { deadline: NewDeadline }
          );
          const UpdatedFreshMatch = await Match.findOne({ id: FreshMatch.id }).lean();
          if (UpdatedFreshMatch) {
            Response.userMatch = FormatMatchDeadline(UpdatedFreshMatch);
            await BackboneUser.findOneAndUpdate(
              { UserId: User.UserId },
              { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: FormatMatchDeadline(UpdatedFreshMatch) } }
            );
          }
        }
      }
    }
  } else if (Info.UserMatch && !Info.UserMatch.id) {
    const DatabaseMatch = await GetUserMatch(User, Tour);
    if (DatabaseMatch) {
      await BackboneUser.findOneAndUpdate(
        { UserId: User.UserId },
        { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: FormatMatchDeadline(DatabaseMatch) } }
      );
    }
  }

  if (Info.KnockedOut || Info.PartyMembers.some((me) => me.UserId == User.UserId && me.IsKicked)) {
    Response.userMatch = null;
    if (Info.UserMatches?.length > 0) {
      Response.userMatches = Info.UserMatches.map((Match: any) => FormatMatchDeadline(Match));
    }
    const UserData = await GetUserData(User.UserId, TournamentId.toString());
    Response.userPosition = UserData ? UserData.UserPosition : [];
  }

  if (Info.FinalPlace > 0 && Tour.Winners) {
    Response.tournamentData[0].userPlace = Info.FinalPlace;
    Response.tournamentData[0].prizeDelivered = true;
  }

  // Após Qualify / final: recarrega Winners do DB
  try {
    const FreshTour = await Tournament.findOne({ TournamentId: Tour.TournamentId }).lean();
    if (FreshTour && Array.isArray((FreshTour as any).Winners) && (FreshTour as any).Winners.length > 0) {
      const winners = (FreshTour as any).Winners as { nick: string; userId: string }[];
      Response.tournamentData[0].status = TournamentStatus.Finished;
      Response.tournamentData[0].data["tournament-data"]["winner-data"] = [
        {
          user: winners.map((W) => ({
            "@user-id": String(W.userId),
            "@nick": String(W.nick || W.userId),
          })),
        },
      ];
      const me = winners.find((W) => String(W.userId) === String(User.UserId));
      if (me) {
        Response.tournamentData[0].userPlace = 1;
        Response.tournamentData[0].prizeDelivered = true;
      }
      if ((FreshTour as any).Status !== TournamentStatus.Finished) {
        await Tournament.updateOne(
          { TournamentId: Tour.TournamentId },
          {
            $set: {
              Status: TournamentStatus.Finished,
              "Properties.FinishedAt": new Date(),
            },
          }
        ).catch(() => {});
      }
    }
  } catch (e) {
    console.error("[TournamentData] winner refresh failed:", e);
  }

  await User.save().catch(() => {});
  return ToJSON(Response);
}


let TournamentActivationLoop: NodeJS.Timeout | null = null;
let TournamentActivationRunning = false;

/** Mantém torneios cujo horário chegou em estado Running e garante a criação do bracket. */
export function StartTournamentActivationLoop(): NodeJS.Timeout {
  if (TournamentActivationLoop) return TournamentActivationLoop;

  const activate = async (): Promise<void> => {
    if (TournamentActivationRunning) return;
    TournamentActivationRunning = true;
    try {
      const now = new Date();
      const tournaments = await Tournament.find({
        Status: { $nin: [TournamentStatus.Canceled, TournamentStatus.Finished] },
        StartTime: { $lte: now },
      });
      for (const tournament of tournaments) {
        try {
          await GenerateBracketMatches(tournament as any);
          if (tournament.Status !== TournamentStatus.Running) {
            const currentPhaseId = tournament.CurrentPhaseId || 1;
            const currentPhaseStarted = tournament.CurrentPhaseStarted || new Date(Date.now() - 1000);
            const nextPhaseStarted = tournament.NextPhaseStarted || new Date(Date.now() + 60 * 60 * 1000);
            await Tournament.updateOne(
              {
                TournamentId: tournament.TournamentId,
                Status: { $nin: [TournamentStatus.Canceled, TournamentStatus.Finished] },
              },
              {
                $set: {
                  Status: TournamentStatus.Running,
                  CurrentPhaseId: currentPhaseId,
                  CurrentPhaseStarted: currentPhaseStarted,
                  NextPhaseStarted: nextPhaseStarted,
                },
              }
            );
          }
        } catch (error) {
          console.error(`[TournamentActivation] Falha no torneio ${tournament.TournamentId}:`, error);
        }
      }
    } catch (error) {
      console.error("[TournamentActivation] Falha no ciclo:", error);
    } finally {
      TournamentActivationRunning = false;
    }
  };

  void activate();
  TournamentActivationLoop = setInterval(() => void activate(), 5000);
  TournamentActivationLoop.unref?.();
  return TournamentActivationLoop;
}
