"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetAllPartyMembers = GetAllPartyMembers;
exports.CreateOrAssignMatch = CreateOrAssignMatch;
exports.CheckPhases = CheckPhases;
exports.QualifyPhase = QualifyPhase;
const Config_1 = require("../../Config");
const BackboneUser_1 = require("../../../Models/BackboneUser");
const Tournament_1 = require("../../../Models/Tournament");
const Matches_1 = require("../../../Models/Matches");
const Properties_1 = require("../../Settings/Properties");
const GetMatches_1 = require("../GetMatches");
const TournamentRules_1 = require("../TournamentRules");
const MatchStateMachine_1 = require("../MatchStateMachine");
const AssignmentLocks = new Map();
async function GetAllPartyMembers(UserId, TournamentId) {
    const Members = new Set([UserId]);
    const User = await BackboneUser_1.BackboneUser.findOne({ UserId }).lean();
    if (!User)
        return Members;
    const Data = User.Tournaments.get
        ? User.Tournaments.get(TournamentId)
        : User.Tournaments[TournamentId];
    if (Data?.PartyMembers) {
        for (const Member of Data.PartyMembers) {
            if (Member?.UserId)
                Members.add(Member.UserId);
        }
    }
    return Members;
}
async function IsPartyLeader(UserId, TournamentId) {
    const User = await BackboneUser_1.BackboneUser.findOne({ UserId }).lean();
    if (!User)
        return false;
    const Data = User.Tournaments.get
        ? User.Tournaments.get(TournamentId)
        : User.Tournaments[TournamentId];
    if (!Data?.PartyMembers || Data.PartyMembers.length === 0) {
        return true;
    }
    const CurrentMember = Data.PartyMembers.find((M) => M.UserId === UserId);
    return CurrentMember?.IsPartyLeader === true;
}
async function GetPartyLeaderId(UserId, TournamentId) {
    const User = await BackboneUser_1.BackboneUser.findOne({ UserId }).lean();
    if (!User)
        return UserId;
    const Data = User.Tournaments.get
        ? User.Tournaments.get(TournamentId)
        : User.Tournaments[TournamentId];
    if (!Data?.PartyMembers || Data.PartyMembers.length === 0) {
        return UserId;
    }
    const Leader = Data.PartyMembers.find((M) => M.IsPartyLeader === true);
    return Leader?.UserId || UserId;
}
async function CreateOrAssignMatch(User, Tournament) {
    const PhaseId = Tournament.CurrentPhaseId || 1;
    const TournamentId = Tournament.TournamentId.toString();
    const UserInfo = User.Tournaments.get(TournamentId);
    if (!UserInfo)
        return null;
    const PhaseConfig = Tournament.Phases[PhaseId - 1];
    if (!PhaseConfig)
        return null;
    if (UserInfo.PartyMembers && UserInfo.PartyMembers.length > 0) {
        const CurrentMember = UserInfo.PartyMembers.find((M) => M.UserId === User.UserId);
        if (!CurrentMember?.IsPartyLeader) {
            return null;
        }
    }
    const LockKey = `${TournamentId}-${PhaseId}-${User.UserId}`;
    if (AssignmentLocks.has(LockKey))
        return AssignmentLocks.get(LockKey);
    const Task = (async () => {
        try {
            const UserPosition = UserInfo.UserPosition?.find((P) => P.phaseid === PhaseId);
            const GroupId = UserPosition?.groupid || 0;
            const PartyIds = new Set([User.UserId]);
            if (UserInfo.PartyMembers) {
                for (const Member of UserInfo.PartyMembers) {
                    if (Member?.UserId)
                        PartyIds.add(Member.UserId);
                }
            }
            const PartyArray = Array.from(PartyIds);
            const ActiveMatch = await Matches_1.Match.findOne({
                tournamentid: TournamentId,
                phaseid: PhaseId,
                groupid: GroupId,
                "users.@user-id": { $in: PartyArray },
                status: {
                    $nin: [
                        Config_1.TournamentMatchStatus.Closed,
                        Config_1.TournamentMatchStatus.GameFinished,
                        Config_1.TournamentMatchStatus.MatchFinished,
                    ],
                },
            })
                .sort({ roundid: 1, matchid: 1 })
                .lean();
            if (ActiveMatch) {
                return {
                    id: ActiveMatch.id,
                    secret: ActiveMatch.secret,
                    deadline: ActiveMatch.deadline,
                    matchid: ActiveMatch.matchid,
                    phaseid: ActiveMatch.phaseid,
                    groupid: ActiveMatch.groupid,
                    roundid: ActiveMatch.roundid,
                    playedgamecount: ActiveMatch.playedgamecount,
                    status: ActiveMatch.status,
                    tournamentid: ActiveMatch.tournamentid,
                    users: ActiveMatch.users,
                };
            }
            const LastCompleted = await Matches_1.Match.findOne({
                tournamentid: TournamentId,
                phaseid: PhaseId,
                groupid: GroupId,
                "users.@user-id": { $in: PartyArray },
                status: { $in: [Config_1.TournamentMatchStatus.Closed, Config_1.TournamentMatchStatus.GameFinished] },
            })
                .sort({ roundid: -1 })
                .select("roundid")
                .lean();
            const NextRoundId = (LastCompleted?.roundid || 0) + 1;
            const Available = await Matches_1.Match.find({
                tournamentid: TournamentId,
                phaseid: PhaseId,
                groupid: GroupId,
                roundid: NextRoundId,
                "users.@user-id": { $nin: PartyArray },
                status: { $in: [Config_1.TournamentMatchStatus.Created, Config_1.TournamentMatchStatus.WaitingForOpponent] },
            })
                .select("id users status matchid deadline roundid")
                .sort({ matchid: 1 })
                .lean();
            if (Available.length === 0)
                return null;
            const format = (0, TournamentRules_1.GetTournamentFormat)(Tournament);
            const MaxTeams = format.maxTeamsPerMatch;
            const UserPoints = UserPosition?.totalpoints || 0;
            const AllMatchUserIds = new Set();
            for (const M of Available) {
                for (const U of M.users) {
                    AllMatchUserIds.add(U["@user-id"]);
                }
            }
            const OpponentUsers = await BackboneUser_1.BackboneUser.find({
                UserId: { $in: Array.from(AllMatchUserIds) },
            })
                .select("UserId Tournaments")
                .lean();
            const OpponentPoints = new Map();
            for (const OppUser of OpponentUsers) {
                const OppData = OppUser.Tournaments.get
                    ? OppUser.Tournaments.get(TournamentId)
                    : OppUser.Tournaments[TournamentId];
                if (OppData) {
                    const OppPos = OppData.UserPosition?.find((P) => P.phaseid === PhaseId && P.groupid === GroupId);
                    if (OppPos) {
                        OpponentPoints.set(OppUser.UserId, OppPos.totalpoints || 0);
                    }
                }
            }
            const ScoredMatches = Available.map((M) => {
                const Teams = new Set(M.users.map((U) => U["@team-id"]).filter((T) => T));
                if (Teams.size >= MaxTeams)
                    return { match: M, score: -999999 };
                const HasConflict = M.users.some((U) => PartyIds.has(U["@user-id"]));
                if (HasConflict)
                    return { match: M, score: -999999 };
                if (M.users.length === 0)
                    return { match: M, score: 10000 };
                const MatchUserIds = M.users.map((U) => U["@user-id"]);
                const AvgPoints = MatchUserIds.reduce((Sum, Id) => Sum + (OpponentPoints.get(Id) || 0), 0) / MatchUserIds.length;
                const Diff = Math.abs(UserPoints - AvgPoints);
                return { match: M, score: 10000 - Diff };
            });
            ScoredMatches.sort((A, B) => B.score - A.score);
            let Selected = null;
            for (const Item of ScoredMatches) {
                if (Item.score > -999999) {
                    Selected = Item.match;
                    break;
                }
            }
            if (!Selected) {
                for (const M of Available) {
                    const Teams = new Set(M.users.map((U) => U["@team-id"]).filter((T) => T));
                    if (Teams.size >= MaxTeams)
                        continue;
                    const HasConflict = M.users.some((U) => PartyIds.has(U["@user-id"]));
                    if (HasConflict)
                        continue;
                    Selected = M;
                    break;
                }
            }
            if (!Selected)
                return null;
            const MinTeams = format.minTeamsPerMatch;
            const ExistingTeamIds = Selected.users.map((U) => U["@team-id"]).filter((T) => T);
            const NewTeamId = (Math.max(0, ...ExistingTeamIds.map((Id) => parseInt(Id))) + 1).toString();
            const NewUsers = Array.from(PartyIds).map((Id) => {
                const UserData = Id === User.UserId ? User : UserInfo.PartyMembers?.find((M) => M.UserId === Id);
                return {
                    "@user-id": Id,
                    "@team-id": NewTeamId,
                    "@checked-in": "0",
                    "@user-score": "0",
                    "@team-score": "0",
                    "@user-points": "0",
                    "@team-points": "0",
                    "@match-points": "0",
                    "@match-winner": "0",
                    "@nick": UserData?.Username || "",
                };
            });
            const UniqueTeams = new Set([...Selected.users, ...NewUsers].map((U) => U["@team-id"]).filter((T) => T)).size;
            const OldStatus = Selected.status;
            const NewStatus = UniqueTeams >= MinTeams ? Config_1.TournamentMatchStatus.GameReady : Config_1.TournamentMatchStatus.WaitingForOpponent;
            const UpdateQuery = { $push: { users: { $each: NewUsers } }, $set: { status: NewStatus } };
            if (NewStatus === Config_1.TournamentMatchStatus.GameReady) {
                // 5 min WO + buffer MinGameLength (client às vezes subtrai)
                const FIVE_MIN = 5 * 60 * 1000;
                const buffer = 6 * 60 * 1000;
                UpdateQuery.$set.deadline = new Date(Date.now() + FIVE_MIN + buffer);
            }
            else if (UniqueTeams === 1) {
                UpdateQuery.$set.deadline = new Date(Date.now() + 12 * 60 * 1000);
            }
            const Updated = await Matches_1.Match.findOneAndUpdate({
                id: Selected.id,
                "users.@user-id": { $nin: PartyArray },
                status: { $in: [Config_1.TournamentMatchStatus.Created, Config_1.TournamentMatchStatus.WaitingForOpponent] },
            }, UpdateQuery, { new: true }).lean();
            if (!Updated) {
                const Retry = await Matches_1.Match.findOne({
                    tournamentid: TournamentId,
                    phaseid: PhaseId,
                    groupid: GroupId,
                    roundid: NextRoundId,
                    "users.@user-id": { $in: PartyArray },
                    status: { $nin: [Config_1.TournamentMatchStatus.Closed, Config_1.TournamentMatchStatus.GameFinished] },
                }).lean();
                if (Retry) {
                    return {
                        id: Retry.id,
                        secret: Retry.secret,
                        deadline: Retry.deadline,
                        matchid: Retry.matchid,
                        phaseid: Retry.phaseid,
                        groupid: Retry.groupid,
                        roundid: Retry.roundid,
                        playedgamecount: Retry.playedgamecount,
                        status: Retry.status,
                        tournamentid: Retry.tournamentid,
                        users: Retry.users,
                    };
                }
                return null;
            }
            const MatchData = {
                id: Updated.id,
                secret: Updated.secret,
                deadline: Updated.deadline,
                matchid: Updated.matchid,
                phaseid: Updated.phaseid,
                groupid: Updated.groupid,
                roundid: Updated.roundid,
                playedgamecount: Updated.playedgamecount,
                status: Updated.status,
                tournamentid: Updated.tournamentid,
                users: Updated.users,
            };
            const AllUserIds = Updated.users.map((U) => U["@user-id"]);
            await BackboneUser_1.BackboneUser.updateMany({ UserId: { $in: AllUserIds }, [`Tournaments.${TournamentId}`]: { $exists: true } }, { $set: { [`Tournaments.${TournamentId}.UserMatch`]: MatchData } });
            return MatchData;
        }
        catch (Err) {
            throw Err;
        }
        finally {
            AssignmentLocks.delete(LockKey);
        }
    })();
    AssignmentLocks.set(LockKey, Task);
    return Task;
}
async function GetLeaderId(UserId, TournamentId) {
    const User = await BackboneUser_1.BackboneUser.findOne({ UserId }).lean();
    if (!User)
        return UserId;
    const Data = User.Tournaments.get
        ? User.Tournaments.get(TournamentId)
        : User.Tournaments[TournamentId];
    if (!Data?.PartyMembers?.length)
        return UserId;
    const Leader = Data.PartyMembers.find((M) => M.IsPartyLeader);
    return Leader ? Leader.UserId : UserId;
}
async function UpdatePositions(TournamentId, PhaseId, GroupId) {
    const Matches = await Matches_1.Match.find({
        tournamentid: TournamentId,
        phaseid: PhaseId,
        groupid: GroupId,
        status: { $in: [Config_1.TournamentMatchStatus.Closed, Config_1.TournamentMatchStatus.GameFinished] },
    }).lean();
    const Stats = new Map();
    for (const Match of Matches) {
        const Teams = new Map();
        for (const U of Match.users) {
            const TeamId = U["@team-id"];
            if (!TeamId)
                continue;
            if (!Teams.has(TeamId))
                Teams.set(TeamId, []);
            Teams.get(TeamId).push(U);
        }
        for (const [TeamId, TeamUsers] of Teams.entries()) {
            if (TeamUsers.length === 0)
                continue;
            const Points = parseInt(TeamUsers[0]["@match-points"] || "0");
            const TeamScore = parseInt(TeamUsers[0]["@team-score"] || "0");
            const UserScore = parseInt(TeamUsers[0]["@user-score"] || "0");
            const Score = Math.max(TeamScore, UserScore);
            const Winner = TeamUsers.some((U) => U["@match-winner"] === "1");
            // A equipe da partida pode ser sintética (jogadores avulsos juntos),
            // portanto a composição real vem dos usuários do @team-id e não da
            // PartyMembers persistida de um único jogador.
            const Members = new Set(TeamUsers.map((TeamUser) => String(TeamUser["@user-id"])).filter(Boolean));
            const Leader = Array.from(Members).sort()[0];
            if (!Stats.has(Leader)) {
                Stats.set(Leader, {
                    Points: 0,
                    Wins: 0,
                    Loses: 0,
                    Rounds: 0,
                    Members: Members,
                    GameWins: 0,
                    GameLoses: 0,
                    LoseWeight: 0,
                });
            }
            const Stat = Stats.get(Leader);
            Stat.Rounds += 1;
            if (Winner) {
                Stat.Wins += 1;
                Stat.Points += Points > 0 ? Points : 1;
                Stat.GameWins += Score > 0 ? Score : 1;
            }
            else {
                Stat.Loses += 1;
                let OpponentScore = 0;
                for (const [OtherTeam, OtherUsers] of Teams.entries()) {
                    if (OtherTeam !== TeamId) {
                        const OtherWinner = OtherUsers.some((U) => U["@match-winner"] === "1");
                        if (OtherWinner) {
                            const OtherTeamScore = parseInt(OtherUsers[0]["@team-score"] || "0");
                            const OtherUserScore = parseInt(OtherUsers[0]["@user-score"] || "0");
                            OpponentScore = Math.max(OtherTeamScore, OtherUserScore);
                            break;
                        }
                    }
                }
                Stat.GameLoses += OpponentScore > 0 ? OpponentScore : 1;
                Stat.LoseWeight += Stat.Rounds;
            }
        }
    }
    const Rankings = Array.from(Stats.entries()).map(([Leader, Stat]) => ({
        Leader,
        Members: Stat.Members,
        Points: Stat.Points,
        Wins: Stat.Wins,
        Loses: Stat.Loses,
        Rounds: Stat.Rounds,
        GameWins: Stat.GameWins,
        GameLoses: Stat.GameLoses,
        LoseWeight: Stat.LoseWeight,
    }));
    Rankings.sort((A, B) => {
        if (B.Points !== A.Points)
            return B.Points - A.Points;
        if (B.Wins !== A.Wins)
            return B.Wins - A.Wins;
        if (A.Loses !== B.Loses)
            return A.Loses - B.Loses;
        if (B.GameWins !== A.GameWins)
            return B.GameWins - A.GameWins;
        if (A.GameLoses !== B.GameLoses)
            return A.GameLoses - B.GameLoses;
        if (A.LoseWeight !== B.LoseWeight)
            return A.LoseWeight - B.LoseWeight;
        return 0;
    });
    const AllIds = new Set();
    for (const Rank of Rankings) {
        for (const Mid of Rank.Members)
            AllIds.add(Mid);
    }
    const Users = await BackboneUser_1.BackboneUser.find({ UserId: { $in: Array.from(AllIds) } }).lean();
    const UserMap = new Map(Users.map((U) => [U.UserId, U]));
    const Ops = [];
    for (let I = 0; I < Rankings.length; I++) {
        const Team = Rankings[I];
        const Rank = I + 1;
        for (const MemberId of Team.Members) {
            const User = UserMap.get(MemberId);
            if (!User)
                continue;
            const Data = User.Tournaments.get
                ? User.Tournaments.get(TournamentId)
                : User.Tournaments[TournamentId];
            if (!Data)
                continue;
            if (!Data.UserPosition)
                Data.UserPosition = [];
            let Entry = Data.UserPosition.find((P) => P.phaseid === PhaseId && P.groupid === GroupId);
            if (!Entry) {
                Entry = {
                    phaseid: PhaseId,
                    rankposition: Rank,
                    sameposition: 0,
                    matchloses: Team.Loses,
                    totalpoints: Team.Points,
                    totalrounds: Team.Rounds,
                    groupid: GroupId,
                };
                Data.UserPosition.push(Entry);
            }
            else {
                Entry.rankposition = Rank;
                Entry.sameposition = 0;
                Entry.matchloses = Team.Loses;
                Entry.totalpoints = Team.Points;
                Entry.totalrounds = Team.Rounds;
            }
            Ops.push({
                updateOne: {
                    filter: { UserId: MemberId },
                    update: { $set: { [`Tournaments.${TournamentId}`]: Data } },
                },
            });
        }
    }
    if (Ops.length > 0)
        await BackboneUser_1.BackboneUser.bulkWrite(Ops);
}
async function CheckPhases(T) {
    const Now = new Date();
    const Current = T.CurrentPhaseId;
    const Phase = T.Phases[Current - 1];
    if (!Phase)
        return;
    const Next = Current + 1;
    const NextPhase = T.Phases[Next - 1];
    if (!NextPhase)
        return;
    const TypeNum = Number(Phase.PhaseType) || Config_1.TournamentPhaseType.SingleEliminationBracket;
    const Type = Config_1.TournamentPhaseType[TypeNum];
    // BUGFIX: antes só avançava de fase quando batia o relógio (NextPhaseStarted),
    // calculado como a duração MÁXIMA de todas as rodadas da fase (pior caso).
    // Se todo mundo terminasse de jogar as rodadas de RoundRobin/Arena antes
    // desse horário (o normal, já que ninguém demora o tempo máximo em toda
    // partida), o jogador ficava sem próxima partida (não existe rodada N+1) e
    // sem avanço de fase pra ir pro bracket — o client fica preso "carregando
    // próxima partida" até o relógio bater sozinho. Torneios só-bracket nunca
    // tinham esse problema pois nem entram nesse fluxo (NextPhase inexistente).
    // Agora: se não sobrar nenhuma partida pendente da fase atual, antecipa
    // o início da próxima fase pra daqui a 3 minutos (em vez de esperar o
    // horário de pior-caso já calculado) — ver bloco "termina cedo" abaixo.
    //
    // BUGFIX 2: partidas de RoundRobin/Arena são criadas sob demanda (só quando
    // alguém aperta pra jogar — ver CreateOrAssignMatch). Isso significa que,
    // no exato momento em que a fase 1 começa, ainda NÃO existe nenhuma partida
    // no banco pra essa fase — "0 pendentes" batia com "0 no total", e o check
    // acima (PendingMatches === 0) tratava isso como "fase inteira concluída"
    // e pulava direto pra fase final (bracket) antes de qualquer jogador
    // conseguir jogar a fase 1. Agora exige que já exista pelo menos 1 partida
    // criada nessa fase, e dá uma folga mínima desde o início da fase, antes
    // de considerar "tudo concluído" por ausência de partidas pendentes.
    let AllMatchesDone = false;
    if (Type === "RoundRobin" || Type === "Arena") {
        const PhaseStartedAt = T.CurrentPhaseStarted || T.StartTime;
        const GracePeriodMs = 90 * 1000;
        const HasGracePeriodPassed = Now.getTime() - new Date(PhaseStartedAt).getTime() >= GracePeriodMs;
        const TotalMatches = await Matches_1.Match.countDocuments({
            tournamentid: T.TournamentId.toString(),
            phaseid: Current,
            roundid: { $lte: Phase.RoundCount || T.RoundCount },
        });
        const PendingMatches = await Matches_1.Match.countDocuments({
            tournamentid: T.TournamentId.toString(),
            phaseid: Current,
            roundid: { $lte: Phase.RoundCount || T.RoundCount },
            status: { $nin: [Config_1.TournamentMatchStatus.Closed, Config_1.TournamentMatchStatus.GameFinished] },
        });
        AllMatchesDone = HasGracePeriodPassed && TotalMatches > 0 && PendingMatches === 0;
    }
    // Quando a fase termina cedo (todo mundo já jogou todas as rodadas antes
    // do prazo máximo), não promove pra próxima fase IMEDIATAMENTE — dá um
    // respiro de 3 minutos antes da próxima fase começar (tempo pra ver
    // resultado/classificação e se preparar). Só antecipamos o relógio
    // (NextPhaseStarted) na primeira vez que detectamos isso; se já tiver
    // sido antecipado antes (inclusive por outro tick), não empurra de novo
    // pra mais tarde nem reinicia a contagem.
    if (AllMatchesDone) {
        const EarlyTarget = new Date(Now.getTime() + 3 * 60 * 1000);
        if (!T.NextPhaseStarted || T.NextPhaseStarted.getTime() > EarlyTarget.getTime()) {
            await Tournament_1.Tournament.updateOne({ TournamentId: T.TournamentId }, { $set: { NextPhaseStarted: EarlyTarget } });
            T.NextPhaseStarted = EarlyTarget;
            return;
        }
    }
    if (!T.NextPhaseStarted || Now < T.NextPhaseStarted)
        return;
    const QualTime = new Date(T.NextPhaseStarted.getTime() - 2 * 60 * 1000);
    const ShouldQual = AllMatchesDone || Now >= QualTime;
    // BUGFIX: antes exigia Phase.IsPhase===true pra rodar a qualificação.
    // IsPhase só vem true quando a fase foi criada como "roundrobin"
    // (PhaseType===3) — fases "arena" (PhaseType===1) SEMPRE são construídas
    // com IsPhase:false (ver Bot.ts / WebAdmin server.js), mesmo quando usadas
    // como fase intermediária de um torneio de 2+ fases. Resultado: numa fase
    // Arena não-final, QualifyGroups nunca rodava, ninguém era promovido/
    // eliminado pra fase seguinte e o torneio ficava travado nela. RoundRobin
    // e Arena são tratados de forma idêntica em todo o resto do fluxo (ver
    // AssignNextMatchIfNeeded, GenerateBracketMatches), então a qualificação
    // deve valer pros dois — o "Type" já garante que só entra aqui pra essas
    // duas fases, então IsPhase não precisa (nem deve) fazer parte da checagem.
    if ((Type === "RoundRobin" || Type === "Arena") && ShouldQual && (Phase.GroupCount || 1) >= 1) {
        await QualifyGroups(T, Current, Next);
    }
    const Delay = await (0, Properties_1.GetNextPhaseStarted)(T, Next);
    await Tournament_1.Tournament.updateOne({ TournamentId: T.TournamentId }, { $set: { CurrentPhaseId: Next, CurrentPhaseStarted: new Date(), NextPhaseStarted: new Date(Date.now() + Delay) } });
    const Updated = await Tournament_1.Tournament.findOne({ TournamentId: T.TournamentId });
    if (Updated)
        await (0, GetMatches_1.GenerateBracketMatches)(Updated);
}
async function QualifyGroups(T, Current, Next) {
    const CurrentPhase = T.Phases[Current - 1];
    const NextPhase = T.Phases[Next - 1];
    // BUGFIX: mesma causa do gate em CheckPhases — não exige mais IsPhase
    // (que fica false pra fases "arena"), só que a próxima fase exista.
    // GroupCount cai pra 1 quando ausente/zero (é o valor que as fases
    // criadas pelo Bot.ts/WebAdmin sempre usam de qualquer forma).
    if (!NextPhase)
        return;
    const Groups = CurrentPhase.GroupCount || 1;
    const NextMax = NextPhase.MaxTeams || 0;
    const PerGroup = Math.floor(NextMax / Groups);
    const Promises = [];
    for (let G = 1; G <= Groups; G++) {
        Promises.push(QualifyTop(T.TournamentId.toString(), Current, G, PerGroup));
    }
    await Promise.all(Promises);
}
async function QualifyTop(TournamentId, PhaseId, GroupId, Count) {
    await UpdatePositions(TournamentId, PhaseId, GroupId);
    const Users = await BackboneUser_1.BackboneUser.find({
        [`Tournaments.${TournamentId}.SignedUp`]: true,
        [`Tournaments.${TournamentId}.UserPosition`]: { $elemMatch: { phaseid: PhaseId, groupid: GroupId } },
    }).lean();
    const TeamMap = new Map();
    const CompletedMatches = await Matches_1.Match.find({
        tournamentid: TournamentId,
        phaseid: PhaseId,
        groupid: GroupId,
        status: { $in: [Config_1.TournamentMatchStatus.Closed, Config_1.TournamentMatchStatus.GameFinished] },
    }).lean();
    // As equipes automáticas não existem em PartyMembers; sua identidade está
    // na composição de usuários do @team-id. Mantemos uma chave estável pelos
    // IDs para não separar os avulsos na classificação da fase.
    for (const MatchDoc of CompletedMatches) {
        const Teams = new Map();
        for (const MatchUser of MatchDoc.users || []) {
            const TeamId = String(MatchUser["@team-id"] || "");
            const UserId = String(MatchUser["@user-id"] || "");
            if (!TeamId || !UserId)
                continue;
            if (!Teams.has(TeamId))
                Teams.set(TeamId, new Set());
            Teams.get(TeamId).add(UserId);
        }
        for (const Members of Teams.values()) {
            const MemberIds = Array.from(Members).sort();
            if (!MemberIds.length)
                continue;
            const TeamKey = MemberIds.join("|");
            if (TeamMap.has(TeamKey))
                continue;
            const Leader = MemberIds[0];
            const LeaderUser = await BackboneUser_1.BackboneUser.findOne({ UserId: Leader }).lean();
            if (!LeaderUser)
                continue;
            const Data = LeaderUser.Tournaments.get
                ? LeaderUser.Tournaments.get(TournamentId)
                : LeaderUser.Tournaments[TournamentId];
            const Pos = Data?.UserPosition?.find((P) => P.phaseid === PhaseId && P.groupid === GroupId);
            if (!Pos)
                continue;
            TeamMap.set(TeamKey, {
                Leader,
                Members,
                Rank: Pos.rankposition || 9999,
                Points: Pos.totalpoints || 0,
                Loses: Pos.matchloses || 0,
                Rounds: Pos.totalrounds || 0,
            });
        }
    }
    // Inclui inscritos que ainda não tiveram uma partida fechada, mantendo o
    // comportamento anterior para a classificação inicial da fase. Jogadores
    // já cobertos por uma equipe automática não entram novamente como solos.
    const CoveredUserIds = new Set();
    for (const Team of TeamMap.values()) {
        for (const MemberId of Team.Members)
            CoveredUserIds.add(String(MemberId));
    }
    for (const User of Users) {
        if (CoveredUserIds.has(String(User.UserId)))
            continue;
        const Data = User.Tournaments.get
            ? User.Tournaments.get(TournamentId)
            : User.Tournaments[TournamentId];
        const Pos = Data?.UserPosition?.find((P) => P.phaseid === PhaseId && P.groupid === GroupId);
        if (!Pos)
            continue;
        const Members = new Set([String(User.UserId)]);
        const TeamKey = Array.from(Members).sort().join("|");
        if (TeamMap.has(TeamKey))
            continue;
        TeamMap.set(TeamKey, {
            Leader: String(User.UserId),
            Members,
            Rank: Pos.rankposition || 9999,
            Points: Pos.totalpoints || 0,
            Loses: Pos.matchloses || 0,
            Rounds: Pos.totalrounds || 0,
        });
    }
    const Sorted = Array.from(TeamMap.values()).sort((A, B) => {
        if (A.Rank !== B.Rank)
            return A.Rank - B.Rank;
        if (A.Points !== B.Points)
            return B.Points - A.Points;
        if (A.Loses !== B.Loses)
            return A.Loses - B.Loses;
        return B.Rounds - A.Rounds;
    });
    const Qualified = Sorted.slice(0, Math.min(Count, Sorted.length));
    const Eliminated = Sorted.slice(Qualified.length);
    const QualIds = new Set();
    for (const Team of Qualified) {
        for (const Mid of Team.Members)
            QualIds.add(Mid);
    }
    const ElimIds = new Set();
    for (const Team of Eliminated) {
        for (const Mid of Team.Members)
            ElimIds.add(Mid);
    }
    const AllIds = new Set([...QualIds, ...ElimIds]);
    const AllUsers = await BackboneUser_1.BackboneUser.find({ UserId: { $in: Array.from(AllIds) } }).lean();
    const Ops = [];
    for (const User of AllUsers) {
        const Data = User.Tournaments.get
            ? User.Tournaments.get(TournamentId)
            : User.Tournaments[TournamentId];
        if (!Data)
            continue;
        if (QualIds.has(User.UserId)) {
            Data.KnockedOut = false;
            Ops.push({
                updateOne: {
                    filter: { UserId: User.UserId },
                    update: { $set: { [`Tournaments.${TournamentId}`]: Data } },
                },
            });
        }
        else if (ElimIds.has(User.UserId)) {
            Data.KnockedOut = true;
            Data.UserMatch = null;
            Ops.push({
                updateOne: {
                    filter: { UserId: User.UserId },
                    update: { $set: { [`Tournaments.${TournamentId}`]: Data } },
                },
            });
        }
    }
    if (Ops.length > 0)
        await BackboneUser_1.BackboneUser.bulkWrite(Ops);
}
async function QualifyPhase(User, Tournament) {
    const Info = User.Tournaments.get(Tournament.TournamentId.toString());
    if (!Info || !Info.UserMatch)
        return;
    const PhaseId = Tournament.CurrentPhaseId || 1;
    const PhaseConfig = Tournament.Phases[PhaseId - 1];
    if (!PhaseConfig)
        return;
    const TypeNum = Number(PhaseConfig.PhaseType) || Config_1.TournamentPhaseType.SingleEliminationBracket;
    const Type = Config_1.TournamentPhaseType[TypeNum];
    if (Type !== "RoundRobin" && Type !== "Arena")
        return;
    const DbMatch = await Matches_1.Match.findOne({ id: Info.UserMatch.id }).lean();
    if (!DbMatch)
        return;
    const RoundId = DbMatch.roundid;
    const GroupId = DbMatch.groupid;
    const TournamentId = Tournament.TournamentId.toString();
    const AllTeams = new Set();
    for (const U of DbMatch.users) {
        if (U["@team-id"])
            AllTeams.add(U["@team-id"]);
    }
    const TeamScores = new Map();
    for (const TeamId of AllTeams) {
        const TeamUsers = DbMatch.users.filter((U) => U["@team-id"] === TeamId);
        const HasWinner = TeamUsers.some((U) => U["@match-winner"] === "1");
        const Score = TeamUsers.reduce((Sum, U) => Sum + parseInt(U["@team-score"] || "0"), 0);
        TeamScores.set(TeamId, { Score, HasWinner });
    }
    const Sorted = Array.from(TeamScores.entries())
        .sort((A, B) => {
        if (A[1].HasWinner !== B[1].HasWinner)
            return A[1].HasWinner ? -1 : 1;
        return B[1].Score - A[1].Score;
    })
        .map(([TeamId]) => TeamId);
    const Winners = [];
    const Losers = [];
    if (Sorted.length > 0) {
        const TopScore = TeamScores.get(Sorted[0]).Score;
        const TopWinner = TeamScores.get(Sorted[0]).HasWinner;
        for (const TeamId of Sorted) {
            const Data = TeamScores.get(TeamId);
            if (Data.Score === TopScore && Data.HasWinner === TopWinner) {
                Winners.push(TeamId);
            }
            else {
                Losers.push(TeamId);
            }
        }
    }
    const WinIds = new Set();
    const LoseIds = new Set();
    for (const U of DbMatch.users) {
        if (Winners.includes(U["@team-id"])) {
            WinIds.add(U["@user-id"]);
            U["@match-points"] = "1";
            U["@match-winner"] = "1";
            if (!U["@team-score"] || U["@team-score"] === "0")
                U["@team-score"] = "1";
        }
        else if (Losers.includes(U["@team-id"])) {
            LoseIds.add(U["@user-id"]);
            U["@match-points"] = "0";
            U["@match-winner"] = "0";
            if (!U["@team-score"])
                U["@team-score"] = "0";
        }
    }
    // WinIds/LoseIds já foram construídos a partir dos usuários da partida.
    // Não expanda pela party persistida: uma equipe automática pode combinar
    // jogadores de parties diferentes, e todos eles precisam avançar juntos.
    const WinMembers = new Set(WinIds);
    const LoseMembers = new Set(LoseIds);
    const Closed = await (0, MatchStateMachine_1.TransitionMatch)(DbMatch.id, [
        Config_1.TournamentMatchStatus.GameInProgress,
        Config_1.TournamentMatchStatus.GameFinished,
        Config_1.TournamentMatchStatus.MatchFinished,
        Config_1.TournamentMatchStatus.Closed,
    ], Config_1.TournamentMatchStatus.Closed, { users: DbMatch.users });
    if (!Closed)
        return;
    const Claimed = await (0, MatchStateMachine_1.ClaimQualification)(DbMatch.id);
    if (!Claimed)
        return;
    const Updated = Claimed;
    const MatchCopy = {
        id: Updated.id,
        secret: Updated.secret,
        deadline: Updated.deadline,
        matchid: Updated.matchid,
        phaseid: Updated.phaseid,
        groupid: Updated.groupid,
        roundid: Updated.roundid,
        playedgamecount: Updated.playedgamecount,
        status: Updated.status,
        tournamentid: Updated.tournamentid,
        users: Updated.users,
    };
    await UpdatePositions(TournamentId, PhaseId, GroupId);
    const TotalRounds = PhaseConfig.RoundCount || Tournament.RoundCount;
    const IsLast = RoundId === TotalRounds;
    // BUGFIX: antes essa parte apontava TODO MUNDO (vencedor e perdedor) já
    // direto pro confronto da próxima rodada assim que a partida fechava —
    // e como esse confronto já nasce com o roster completo (calendário
    // pré-gerado, ver GenerateRoundRobinGroup), o client mostrava a próxima
    // partida "já em andamento" sem a pessoa precisar apertar em jogar. O
    // calendário já existe fixo (resolve o problema de sempre cair com a
    // mesma galera), mas ninguém deve ser jogado automaticamente pra
    // próxima partida — cada um só entra nela quando pedir (botão jogar),
    // e isso já cai em CreateOrAssignMatch, que acha o confronto certo na
    // hora (ele já existe, só precisa ser "puxado"). Por isso aqui
    // simplesmente zera o UserMatch de todo mundo, igual já fazia antes
    // pra quem perdia.
    const WinOps = [];
    for (const Id of WinMembers) {
        const UserDoc = await BackboneUser_1.BackboneUser.findOne({ UserId: Id }).lean();
        if (!UserDoc)
            continue;
        const Data = UserDoc.Tournaments.get
            ? UserDoc.Tournaments.get(TournamentId)
            : UserDoc.Tournaments[TournamentId];
        if (!Data)
            continue;
        if (!Data.UserMatches)
            Data.UserMatches = [];
        const Has = Data.UserMatches.some((M) => M.id === MatchCopy.id);
        if (!Has)
            Data.UserMatches.push(MatchCopy);
        Data.UserMatch = null;
        WinOps.push({
            updateOne: {
                filter: { UserId: Id },
                update: { $set: { [`Tournaments.${TournamentId}`]: Data } },
            },
        });
    }
    const LoseOps = [];
    for (const Id of LoseMembers) {
        const UserDoc = await BackboneUser_1.BackboneUser.findOne({ UserId: Id }).lean();
        if (!UserDoc)
            continue;
        const Data = UserDoc.Tournaments.get
            ? UserDoc.Tournaments.get(TournamentId)
            : UserDoc.Tournaments[TournamentId];
        if (!Data)
            continue;
        if (!Data.UserMatches)
            Data.UserMatches = [];
        const Has = Data.UserMatches.some((M) => M.id === MatchCopy.id);
        if (!Has)
            Data.UserMatches.push(MatchCopy);
        Data.UserMatch = null;
        LoseOps.push({
            updateOne: {
                filter: { UserId: Id },
                update: { $set: { [`Tournaments.${TournamentId}`]: Data } },
            },
        });
    }
    if (WinOps.length > 0)
        await BackboneUser_1.BackboneUser.bulkWrite(WinOps);
    if (LoseOps.length > 0)
        await BackboneUser_1.BackboneUser.bulkWrite(LoseOps);
    const IsFinalPhase = PhaseId === Tournament.Phases.length;
    if (IsFinalPhase && IsLast) {
        const AllDone = (await Matches_1.Match.countDocuments({
            tournamentid: TournamentId,
            phaseid: PhaseId,
            groupid: GroupId,
            roundid: RoundId,
            status: { $nin: [Config_1.TournamentMatchStatus.Closed, Config_1.TournamentMatchStatus.GameFinished] },
        })) === 0;
        if (AllDone) {
            await UpdatePositions(TournamentId, PhaseId, GroupId);
            const TopUsers = await BackboneUser_1.BackboneUser.find({
                [`Tournaments.${TournamentId}.SignedUp`]: true,
                [`Tournaments.${TournamentId}.UserPosition`]: { $elemMatch: { phaseid: PhaseId, groupid: GroupId } },
            }).lean();
            const TeamMap = new Map();
            const FinalRoundMatches = await Matches_1.Match.find({
                tournamentid: TournamentId,
                phaseid: PhaseId,
                groupid: GroupId,
                roundid: RoundId,
                status: { $in: [Config_1.TournamentMatchStatus.Closed, Config_1.TournamentMatchStatus.GameFinished] },
            }).lean();
            const TopUserMap = new Map(TopUsers.map((User) => [String(User.UserId), User]));
            for (const FinalMatch of FinalRoundMatches) {
                const Teams = new Map();
                for (const MatchUser of FinalMatch.users || []) {
                    const TeamId = String(MatchUser["@team-id"] || "");
                    const UserId = String(MatchUser["@user-id"] || "");
                    if (!TeamId || !UserId)
                        continue;
                    if (!Teams.has(TeamId))
                        Teams.set(TeamId, new Set());
                    Teams.get(TeamId).add(UserId);
                }
                for (const Members of Teams.values()) {
                    const MemberIds = Array.from(Members).sort();
                    if (!MemberIds.length)
                        continue;
                    const TeamKey = MemberIds.join("|");
                    if (TeamMap.has(TeamKey))
                        continue;
                    const Leader = MemberIds[0];
                    const LeaderUser = TopUserMap.get(Leader);
                    const Data = LeaderUser
                        ? LeaderUser.Tournaments?.get
                            ? LeaderUser.Tournaments.get(TournamentId)
                            : LeaderUser.Tournaments?.[TournamentId]
                        : null;
                    const Pos = Data?.UserPosition?.find((P) => P.phaseid === PhaseId && P.groupid === GroupId);
                    if (!Pos)
                        continue;
                    TeamMap.set(TeamKey, {
                        Leader,
                        Members,
                        Rank: Pos.rankposition || 9999,
                        Points: Pos.totalpoints || 0,
                        Loses: Pos.matchloses || 0,
                    });
                }
            }
            const Sorted = Array.from(TeamMap.values()).sort((A, B) => {
                if (A.Rank !== B.Rank)
                    return A.Rank - B.Rank;
                if (A.Points !== B.Points)
                    return B.Points - A.Points;
                return A.Loses - B.Loses;
            });
            if (Sorted.length > 0) {
                const WinTeam = Sorted[0];
                const TourWinners = [];
                for (const Mid of WinTeam.Members) {
                    const WinUser = await BackboneUser_1.BackboneUser.findOne({ UserId: Mid }).lean();
                    if (WinUser)
                        TourWinners.push({ nick: WinUser.Username, userId: Mid });
                }
                if (TourWinners.length > 0) {
                    await Tournament.updateOne({ TournamentId: Tournament.TournamentId, Status: { $ne: Config_1.TournamentStatus.Finished } }, {
                        $addToSet: { Winners: { $each: TourWinners } },
                        $set: { Status: Config_1.TournamentStatus.Finished, "Properties.FinishedAt": new Date() },
                    });
                }
            }
        }
    }
}
//# sourceMappingURL=Phase.js.map