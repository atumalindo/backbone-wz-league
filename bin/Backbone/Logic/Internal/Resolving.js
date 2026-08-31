"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResolveMatches = ResolveMatches;
exports.StartLoop = StartLoop;
const tslib_1 = require("tslib");
const crypto = tslib_1.__importStar(require("crypto"));
const BackboneUser_1 = require("../../../Models/BackboneUser");
const Config_1 = require("../../Config");
const Matches_1 = require("../../../Models/Matches");
const Phase_1 = require("./Phase");
const TournamentRules_1 = require("../TournamentRules");
const MatchStateMachine_1 = require("../MatchStateMachine");
const Rules_1 = require("../../Settings/Rules");
const GetMatches_1 = require("../GetMatches");
const Phase_2 = require("./Phase");
const Tournament_1 = require("../../../Models/Tournament");
const MatchPresence_1 = require("../MatchPresence");
async function GetExpectedRoundCount(Tournament, PhaseId, GroupId) {
    const PhaseConfig = Tournament.Phases[PhaseId - 1];
    if (!PhaseConfig)
        return 0;
    const TypeNum = Number(PhaseConfig.PhaseType) || Config_1.TournamentPhaseType.SingleEliminationBracket;
    const PhaseType = Config_1.TournamentPhaseType[TypeNum];
    if (PhaseType === "RoundRobin" || PhaseType === "Arena") {
        return PhaseConfig.RoundCount || Tournament.RoundCount;
    }
    const AllMatches = await Matches_1.Match.find({
        tournamentid: Tournament.TournamentId.toString(),
        phaseid: PhaseId,
        groupid: GroupId,
    })
        .select("roundid")
        .lean();
    if (AllMatches.length === 0)
        return 0;
    return Math.max(...AllMatches.map((M) => M.roundid));
}
async function CreateNotPlayedMatch(UserId, Tournament, PhaseId, GroupId, RoundId) {
    const TournamentId = Tournament.TournamentId.toString();
    const User = await BackboneUser_1.BackboneUser.findOne({ UserId }).lean();
    if (!User)
        return;
    const UserInfo = User.Tournaments.get
        ? User.Tournaments.get(TournamentId)
        : User.Tournaments[TournamentId];
    if (!UserInfo)
        return;
    const ExistingMatch = await Matches_1.Match.findOne({
        tournamentid: TournamentId,
        phaseid: PhaseId,
        groupid: GroupId,
        roundid: RoundId,
        "users.@user-id": UserId,
    }).lean();
    if (ExistingMatch)
        return;
    const AlreadyInHistory = UserInfo.UserMatches?.some((M) => M.phaseid === PhaseId && M.groupid === GroupId && M.roundid === RoundId);
    if (AlreadyInHistory)
        return;
    const PartyIds = new Set([UserId]);
    if (UserInfo.PartyMembers) {
        for (const Member of UserInfo.PartyMembers) {
            if (Member?.UserId)
                PartyIds.add(Member.UserId);
        }
    }
    const PhaseConfig = Tournament.Phases[PhaseId - 1];
    const TypeNum = Number(PhaseConfig.PhaseType) || Config_1.TournamentPhaseType.SingleEliminationBracket;
    const PhaseType = Config_1.TournamentPhaseType[TypeNum];
    const ExistingRound = await Matches_1.Match.find({
        tournamentid: TournamentId,
        phaseid: PhaseId,
        groupid: GroupId,
        roundid: RoundId,
    })
        .select("matchid")
        .sort({ matchid: -1 })
        .limit(1)
        .lean();
    const NextMatchId = ExistingRound.length > 0 ? ExistingRound[0].matchid + 1 : 1;
    let MatchIdString = `${Tournament.TournamentId}${PhaseId}${RoundId}`;
    if (PhaseType === "RoundRobin" || PhaseType === "Arena") {
        MatchIdString += `${GroupId || 0}${NextMatchId}`;
    }
    else {
        MatchIdString += `0${NextMatchId}`;
    }
    const Users = Array.from(PartyIds).map((Id) => {
        const UserData = Id === UserId ? User : UserInfo.PartyMembers?.find((M) => M.UserId === Id);
        return {
            "@user-id": Id,
            "@team-id": "1",
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
    const Secret = crypto.randomBytes(32).toString("hex");
    const Deadline = new Date();
    try {
        const NewMatch = await Matches_1.Match.create({
            id: MatchIdString,
            matchid: NextMatchId,
            secret: Secret,
            deadline: Deadline,
            phaseid: PhaseId,
            groupid: GroupId,
            roundid: RoundId,
            playedgamecount: 0,
            status: Config_1.TournamentMatchStatus.Closed,
            tournamentid: TournamentId,
            users: Users,
        });
        const MatchCopy = {
            id: NewMatch.id,
            secret: NewMatch.secret,
            deadline: NewMatch.deadline,
            matchid: NewMatch.matchid,
            phaseid: NewMatch.phaseid,
            groupid: NewMatch.groupid,
            roundid: NewMatch.roundid,
            playedgamecount: NewMatch.playedgamecount,
            status: NewMatch.status,
            tournamentid: NewMatch.tournamentid,
            users: NewMatch.users,
        };
        const AllPartyMembers = await (0, Phase_1.GetAllPartyMembers)(UserId, TournamentId);
        const UpdateOps = Array.from(AllPartyMembers).map((Id) => ({
            updateOne: {
                filter: { UserId: Id, [`Tournaments.${TournamentId}`]: { $exists: true } },
                update: {
                    $push: { [`Tournaments.${TournamentId}.UserMatches`]: MatchCopy },
                },
            },
        }));
        if (UpdateOps.length > 0) {
            await BackboneUser_1.BackboneUser.bulkWrite(UpdateOps, { ordered: false });
        }
    }
    catch (Err) {
        if (Err.code !== 11000) {
            console.error("Error creating not played match:", Err);
        }
    }
}
async function ProcessExpiredMatch(ExpiredMatch, Tournament, PhaseType) {
    const PhaseConfig = Tournament.Phases[ExpiredMatch.phaseid - 1];
    if (!PhaseConfig)
        return;
    const Configs = (0, Rules_1.GetRoundConfigs)(Tournament);
    const Config = Configs.get(ExpiredMatch.roundid);
    if (!Config)
        return;
    const Deadline = new Date(ExpiredMatch.deadline);
    let MatchStartDeadline;
    if (ExpiredMatch.status === Config_1.TournamentMatchStatus.WaitingForOpponent ||
        ExpiredMatch.status === Config_1.TournamentMatchStatus.GameReady) {
        // Nos estados de lobby o deadline já é o fim da janela de GO/WO. Não
        // subtraia o tempo de jogo aqui, senão a rotina resolve a partida antes de
        // o contador visual chegar a 00.
        MatchStartDeadline = Deadline;
    }
    else {
        const TotalGameTime = Config.MaxGameCount * Config.MinGameLength;
        const AdjustedTime = TotalGameTime === Config.MaxLength ? TotalGameTime - 1 : TotalGameTime;
        MatchStartDeadline = new Date(Deadline.getTime() - AdjustedTime * 60 * 1000 - 15000);
    }
    const GracePeriod = new Date(MatchStartDeadline.getTime() + 5000);
    const Now = new Date();
    if (Now < GracePeriod)
        return;
    const CheckedInTeams = new Map();
    for (const MatchUser of ExpiredMatch.users) {
        const TeamId = MatchUser["@team-id"];
        if (!TeamId)
            continue;
        if (!CheckedInTeams.has(TeamId)) {
            CheckedInTeams.set(TeamId, false);
        }
        if (MatchUser["@checked-in"] === "1") {
            CheckedInTeams.set(TeamId, true);
        }
    }
    const FullyCheckedInTeams = [];
    const NotCheckedInTeams = [];
    for (const [TeamId, IsCheckedIn] of CheckedInTeams.entries()) {
        const TeamUsers = ExpiredMatch.users.filter((U) => U["@team-id"] === TeamId);
        const AllCheckedIn = TeamUsers.every((U) => U["@checked-in"] === "1");
        if (AllCheckedIn && TeamUsers.length > 0) {
            FullyCheckedInTeams.push(TeamId);
        }
        else if (!IsCheckedIn) {
            NotCheckedInTeams.push(TeamId);
        }
    }
    const UniqueTeams = new Set(ExpiredMatch.users.map((U) => U["@team-id"]).filter((T) => T)).size;
    const MaxTeams = (0, TournamentRules_1.GetTournamentFormat)(Tournament).maxTeamsPerMatch;
    const FreshConnectedTeamIds = (0, MatchPresence_1.GetFreshConnectedTeamIds)(ExpiredMatch, Now.getTime());
    const SessionStartedTeamIds = (0, MatchPresence_1.GetSessionStartedTeamIds)(ExpiredMatch);
    // A presença é independente do check-in antigo enviado pelo cliente. Isso
    // cobre o caso em que alguém entrou, cancelou/fechou o jogo e deixou o outro
    // participante aguardando: se só um lado continua conectado, esse lado recebe
    // WO. Se ninguém está conectado, não resolvemos imediatamente porque os dois
    // podem ter caído juntos; primeiro abrimos uma janela adicional de 1 minuto.
    if (UniqueTeams >= 2 && FreshConnectedTeamIds.size === 0 && SessionStartedTeamIds.size !== 1) {
        const NoPlayAfter = ExpiredMatch.noPlayAfter
            ? new Date(ExpiredMatch.noPlayAfter)
            : new Date(Now.getTime() + 60 * 1000);
        if (Now < NoPlayAfter) {
            await Matches_1.Match.updateOne({ id: ExpiredMatch.id, status: { $in: [Config_1.TournamentMatchStatus.GameReady, Config_1.TournamentMatchStatus.WaitingForOpponent] } }, { $set: { deadline: NoPlayAfter, noPlayAfter: NoPlayAfter } });
            console.log(`[NO-PLAY] aguardando 1 minuto match=${ExpiredMatch.id} until=${NoPlayAfter.toISOString()}`);
            return;
        }
        // O minuto acabou sem uma presença fresca: não deixe o check-in antigo
        // transformar esse caso em WO para um dos lados.
        FullyCheckedInTeams.length = 0;
        NotCheckedInTeams.length = 0;
    }
    // Se apenas um time ainda tem uma presença fresca, ele vence mesmo que o
    // adversário tenha feito check-in antes de cair. O restante do fluxo mantém a
    // qualificação e o histórico já existentes.
    if (UniqueTeams >= 2 &&
        (FreshConnectedTeamIds.size === 1 || (FreshConnectedTeamIds.size === 0 && SessionStartedTeamIds.size === 1))) {
        const ActiveTeamIds = FreshConnectedTeamIds.size === 1 ? FreshConnectedTeamIds : SessionStartedTeamIds;
        FullyCheckedInTeams.length = 0;
        FullyCheckedInTeams.push(...Array.from(ActiveTeamIds));
        NotCheckedInTeams.length = 0;
        for (const TeamId of CheckedInTeams.keys()) {
            if (!ActiveTeamIds.has(TeamId))
                NotCheckedInTeams.push(TeamId);
        }
    }
    // BUGFIX: as checagens de WO abaixo (sozinho na partida / não deu
    // check-in) antes só rodavam em roundid===1. Fazia sentido pra bracket
    // eliminatória: lá, rodada 2+ nasce VAZIA e só é preenchida aos poucos
    // conforme os vencedores da rodada anterior avançam — "só 1 time na
    // partida" é um estado normal e temporário, não um no-show. Só que em
    // fases RoundRobin/Arena o calendário agora é pré-gerado inteiro (todas
    // as rodadas já nascem com o roster completo, igual a rodada 1 sempre
    // foi) — então "sozinho"/"não chegou a tempo" em rodada 2+ dessas fases
    // já é sim um no-show de verdade, e precisa dar WO na hora igual
    // rodada 1 dá. Sem isso, quem não aparece numa rodada 2+ nunca leva WO.
    const WoAppliesThisRound = ExpiredMatch.roundid === 1 || PhaseType === "RoundRobin" || PhaseType === "Arena";
    // WO por tempo: sozinho na partida — round 1 (bracket) ou qualquer
    // rodada de RoundRobin/Arena (calendário pré-gerado)
    if (WoAppliesThisRound &&
        ExpiredMatch.status === Config_1.TournamentMatchStatus.WaitingForOpponent &&
        UniqueTeams === 1 &&
        UniqueTeams < MaxTeams &&
        ExpiredMatch.users.length > 0) {
        const SoloTeamId = String(ExpiredMatch.users[0]["@team-id"] || "1");
        const UpdatedUsers = ExpiredMatch.users.map((U) => ({
            ...U,
            "@match-winner": "1",
            "@match-points": "1",
            "@team-score": "1",
            "@user-score": "1",
            "@checked-in": "1",
            "@team-id": U["@team-id"] || SoloTeamId,
        }));
        const Closed = await (0, MatchStateMachine_1.TransitionMatch)(ExpiredMatch.id, [ExpiredMatch.status], Config_1.TournamentMatchStatus.Closed, { users: UpdatedUsers });
        if (!Closed)
            return;
        const WinnerUserIds = UpdatedUsers.map((U) => U["@user-id"]);
        console.log(`[WO] match=${ExpiredMatch.id} round=${ExpiredMatch.roundid} solo → advance users=${WinnerUserIds.join(",")}`);
        if (WinnerUserIds.length > 0) {
            const WinnerUser = await BackboneUser_1.BackboneUser.findOne({ UserId: WinnerUserIds[0] });
            if (WinnerUser) {
                // BUGFIX: Qualify()/QualifyPhase() abortam em silencio se o
                // UserMatch em cache do vencedor nao apontar pra ESTA partida (ou
                // estiver com o status antigo, pre-fechamento). Isso deixava quem
                // ganhava por W.O. PRESO na rodada atual (nunca avancava), porque o
                // fluxo daqui (resolucao automatica por tempo) nunca atualizava esse
                // cache antes de chamar Qualify/QualifyPhase -- so o fluxo de
                // check-in manual fazia isso. Sincroniza aqui tambem, usando a
                // partida ja fechada (Closed) retornada pelo TransitionMatch acima.
                const WinnerTournamentData = WinnerUser.Tournaments.get(Tournament.TournamentId.toString());
                if (WinnerTournamentData)
                    WinnerTournamentData.UserMatch = Closed;
                if (PhaseType === "RoundRobin" || PhaseType === "Arena") {
                    await (0, Phase_1.QualifyPhase)(WinnerUser, Tournament);
                }
                else {
                    await (0, GetMatches_1.Qualify)(WinnerUser, Tournament);
                }
            }
        }
        return;
    }
    if (WoAppliesThisRound &&
        ExpiredMatch.status === Config_1.TournamentMatchStatus.WaitingForOpponent &&
        FullyCheckedInTeams.length === 1 &&
        UniqueTeams < MaxTeams) {
        const UpdatedUsers = ExpiredMatch.users.map((U) => {
            if (FullyCheckedInTeams.includes(U["@team-id"])) {
                return {
                    ...U,
                    "@match-winner": "1",
                    "@match-points": "1",
                    "@team-score": "1",
                };
            }
            else {
                return {
                    ...U,
                    "@match-winner": "0",
                    "@match-points": "0",
                    "@team-score": "0",
                };
            }
        });
        const Closed = await (0, MatchStateMachine_1.TransitionMatch)(ExpiredMatch.id, [ExpiredMatch.status], Config_1.TournamentMatchStatus.Closed, { users: UpdatedUsers });
        if (!Closed)
            return;
        const WinnerUserIds = UpdatedUsers.filter((U) => U["@match-winner"] === "1").map((U) => U["@user-id"]);
        if (WinnerUserIds.length > 0) {
            const WinnerUser = await BackboneUser_1.BackboneUser.findOne({ UserId: WinnerUserIds[0] });
            if (WinnerUser) {
                // BUGFIX: Qualify()/QualifyPhase() abortam em silencio se o
                // UserMatch em cache do vencedor nao apontar pra ESTA partida (ou
                // estiver com o status antigo, pre-fechamento). Isso deixava quem
                // ganhava por W.O. PRESO na rodada atual (nunca avancava), porque o
                // fluxo daqui (resolucao automatica por tempo) nunca atualizava esse
                // cache antes de chamar Qualify/QualifyPhase -- so o fluxo de
                // check-in manual fazia isso. Sincroniza aqui tambem, usando a
                // partida ja fechada (Closed) retornada pelo TransitionMatch acima.
                const WinnerTournamentData = WinnerUser.Tournaments.get(Tournament.TournamentId.toString());
                if (WinnerTournamentData)
                    WinnerTournamentData.UserMatch = Closed;
                if (PhaseType === "RoundRobin" || PhaseType === "Arena") {
                    await (0, Phase_1.QualifyPhase)(WinnerUser, Tournament);
                }
                else {
                    await (0, GetMatches_1.Qualify)(WinnerUser, Tournament);
                }
            }
        }
        return;
    }
    if (WoAppliesThisRound &&
        (FullyCheckedInTeams.length === 0 || (UniqueTeams >= 2 && FreshConnectedTeamIds.size === 0 && SessionStartedTeamIds.size !== 1))) {
        const UpdatedUsers = ExpiredMatch.users.map((U) => ({
            ...U,
            "@match-winner": "0",
            "@match-points": "0",
            "@team-score": "0",
        }));
        const Closed = await (0, MatchStateMachine_1.TransitionMatch)(ExpiredMatch.id, [ExpiredMatch.status], Config_1.TournamentMatchStatus.Closed, { users: UpdatedUsers, playedgamecount: 0 }, { noPlayAfter: "" });
        if (!Closed)
            return;
        const MatchCopy = {
            id: ExpiredMatch.id,
            secret: ExpiredMatch.secret,
            deadline: ExpiredMatch.deadline,
            matchid: ExpiredMatch.matchid,
            phaseid: ExpiredMatch.phaseid,
            groupid: ExpiredMatch.groupid,
            roundid: ExpiredMatch.roundid,
            playedgamecount: ExpiredMatch.playedgamecount,
            status: Config_1.TournamentMatchStatus.Closed,
            tournamentid: ExpiredMatch.tournamentid,
            users: UpdatedUsers,
        };
        // A partida pode conter uma equipe automática formada por jogadores de
        // parties diferentes. Atualize somente os usuários realmente presentes
        // nela, sem expandir a party persistida de cada jogador.
        const AllUserIds = new Set(ExpiredMatch.users.map((U) => String(U["@user-id"])).filter(Boolean));
        const UpdateOps = Array.from(AllUserIds).map((Id) => ({
            updateOne: {
                filter: { UserId: Id, [`Tournaments.${ExpiredMatch.tournamentid}`]: { $exists: true } },
                update: {
                    $set: { [`Tournaments.${ExpiredMatch.tournamentid}.UserMatch`]: null },
                    $push: { [`Tournaments.${ExpiredMatch.tournamentid}.UserMatches`]: MatchCopy },
                },
            },
        }));
        if (UpdateOps.length > 0) {
            await BackboneUser_1.BackboneUser.bulkWrite(UpdateOps, { ordered: false });
        }
        return;
    }
    if (FullyCheckedInTeams.length > 0 && NotCheckedInTeams.length > 0) {
        const UpdatedUsers = ExpiredMatch.users.map((U) => {
            if (FullyCheckedInTeams.includes(U["@team-id"])) {
                return {
                    ...U,
                    "@match-winner": "1",
                    "@match-points": "1",
                    "@team-score": "1",
                };
            }
            else {
                return {
                    ...U,
                    "@match-winner": "0",
                    "@match-points": "0",
                    "@team-score": "0",
                };
            }
        });
        const Closed = await (0, MatchStateMachine_1.TransitionMatch)(ExpiredMatch.id, [ExpiredMatch.status], Config_1.TournamentMatchStatus.Closed, { users: UpdatedUsers });
        if (!Closed)
            return;
        const WinnerUserIds = UpdatedUsers.filter((U) => U["@match-winner"] === "1").map((U) => U["@user-id"]);
        if (WinnerUserIds.length > 0) {
            const WinnerUser = await BackboneUser_1.BackboneUser.findOne({ UserId: WinnerUserIds[0] });
            if (WinnerUser) {
                // BUGFIX: Qualify()/QualifyPhase() abortam em silencio se o
                // UserMatch em cache do vencedor nao apontar pra ESTA partida (ou
                // estiver com o status antigo, pre-fechamento). Isso deixava quem
                // ganhava por W.O. PRESO na rodada atual (nunca avancava), porque o
                // fluxo daqui (resolucao automatica por tempo) nunca atualizava esse
                // cache antes de chamar Qualify/QualifyPhase -- so o fluxo de
                // check-in manual fazia isso. Sincroniza aqui tambem, usando a
                // partida ja fechada (Closed) retornada pelo TransitionMatch acima.
                const WinnerTournamentData = WinnerUser.Tournaments.get(Tournament.TournamentId.toString());
                if (WinnerTournamentData)
                    WinnerTournamentData.UserMatch = Closed;
                if (PhaseType === "RoundRobin" || PhaseType === "Arena") {
                    await (0, Phase_1.QualifyPhase)(WinnerUser, Tournament);
                }
                else {
                    await (0, GetMatches_1.Qualify)(WinnerUser, Tournament);
                }
            }
        }
    }
}
async function HandleNotPlayedMatches(Tournament, PhaseId, PhaseType) {
    if (PhaseType !== "RoundRobin" && PhaseType !== "Arena")
        return;
    const Now = new Date();
    const TournamentId = Tournament.TournamentId.toString();
    const SignedUpUsers = await BackboneUser_1.BackboneUser.find({
        [`Tournaments.${TournamentId}.SignedUp`]: true,
        $or: [
            { [`Tournaments.${TournamentId}.KnockedOut`]: { $exists: false } },
            { [`Tournaments.${TournamentId}.KnockedOut`]: false },
        ],
    }).lean();
    const ProcessedLeaders = new Set();
    for (const User of SignedUpUsers) {
        const UserInfo = User.Tournaments.get
            ? User.Tournaments.get(TournamentId)
            : User.Tournaments[TournamentId];
        if (!UserInfo)
            continue;
        let LeaderId = User.UserId;
        if (UserInfo.PartyMembers && (0, TournamentRules_1.GetTournamentFormat)(Tournament).playersPerTeam > 1) {
            const Leader = UserInfo.PartyMembers.find((M) => M.IsPartyLeader);
            if (Leader)
                LeaderId = Leader.UserId;
        }
        if (ProcessedLeaders.has(LeaderId))
            continue;
        ProcessedLeaders.add(LeaderId);
        const UserPosition = UserInfo.UserPosition?.find((P) => P.phaseid === PhaseId);
        const GroupId = UserPosition?.groupid || 0;
        const HasActiveMatch = await Matches_1.Match.exists({
            tournamentid: TournamentId,
            phaseid: PhaseId,
            groupid: GroupId,
            "users.@user-id": User.UserId,
            status: {
                $in: [
                    Config_1.TournamentMatchStatus.GameInProgress,
                    Config_1.TournamentMatchStatus.GameReady,
                    Config_1.TournamentMatchStatus.WaitingForOpponent,
                ],
            },
        });
        if (HasActiveMatch)
            continue;
        const AllUserMatches = await Matches_1.Match.find({
            tournamentid: TournamentId,
            phaseid: PhaseId,
            groupid: GroupId,
            "users.@user-id": User.UserId,
        })
            .select("roundid status")
            .lean();
        const PlayedRounds = new Set(AllUserMatches.filter((M) => M.status === Config_1.TournamentMatchStatus.Closed || M.status === Config_1.TournamentMatchStatus.GameFinished).map((M) => M.roundid));
        const ExpectedRounds = await GetExpectedRoundCount(Tournament, PhaseId, GroupId);
        const NextPhaseStart = Tournament.NextPhaseStarted || new Date(Date.now() + 24 * 60 * 60 * 1000);
        const PhaseStart = Tournament.CurrentPhaseStarted || new Date(Tournament.StartTime);
        const PhaseElapsed = Now.getTime() - PhaseStart.getTime();
        const TotalPhaseDuration = NextPhaseStart.getTime() - PhaseStart.getTime();
        let ExpectedCompletedRounds = 0;
        if (TotalPhaseDuration > 0) {
            const ProgressRatio = Math.min(1, PhaseElapsed / TotalPhaseDuration);
            ExpectedCompletedRounds = Math.floor(ExpectedRounds * ProgressRatio);
        }
        for (let RoundId = 2; RoundId <= ExpectedCompletedRounds; RoundId++) {
            if (!PlayedRounds.has(RoundId)) {
                await CreateNotPlayedMatch(LeaderId, Tournament, PhaseId, GroupId, RoundId);
            }
        }
    }
}
async function ResolveMatches(Tournament) {
    const Now = new Date();
    const PhaseId = Tournament.CurrentPhaseId || 1;
    const TournamentId = Tournament.TournamentId.toString();
    const PhaseConfig = Tournament.Phases[PhaseId - 1];
    if (!PhaseConfig)
        return;
    const TypeNum = Number(PhaseConfig.PhaseType) || Config_1.TournamentPhaseType.SingleEliminationBracket;
    const PhaseType = Config_1.TournamentPhaseType[TypeNum];
    const AllExpiredMatches = await Matches_1.Match.find({
        tournamentid: TournamentId,
        phaseid: PhaseId,
        deadline: { $lt: Now },
        status: { $in: [Config_1.TournamentMatchStatus.GameReady, Config_1.TournamentMatchStatus.WaitingForOpponent] },
    }).lean();
    // BUGFIX: antes só processava partidas expiradas (fechar com WO/derrota)
    // quando IsFinalBracket=true — ou seja, só na última fase (bracket). Isso
    // significava que numa fase RoundRobin/Arena que não é a última (típica
    // fase 1 de torneios de 2+ fases), uma partida "WaitingForOpponent" (ex:
    // jogador sozinho esperando WO) NUNCA era resolvida — o prazo vencia e
    // nada acontecia, o jogador ficava preso esperando pra sempre. Só a fase
    // final se recuperava sozinha. ProcessExpiredMatch já trata RoundRobin/
    // Arena corretamente (chama QualifyPhase pro vencedor nesses casos, ver
    // final da função) — só faltava deixar rodar pra qualquer fase, não só a
    // última.
    for (const ExpiredMatch of AllExpiredMatches) {
        await ProcessExpiredMatch(ExpiredMatch, Tournament, PhaseType);
    }
    await HandleNotPlayedMatches(Tournament, PhaseId, PhaseType);
}
let IsLoopRunning = false;
async function StartLoop() {
    if (IsLoopRunning)
        return;
    IsLoopRunning = true;
    setInterval(async () => {
        try {
            // BUGFIX: antes o .limit(10) fazia esse loop só processar os 10
            // primeiros torneios "Running" (ordem indefinida do Mongo) a cada
            // tick. Com mais de 10 torneios rodando ao mesmo tempo, os que
            // ficavam de fora NUNCA tinham suas partidas resolvidas — o
            // cronômetro do jogador chegava em 00 e nada dava W.O., porque esse
            // torneio simplesmente não era mais buscado pelo loop. Agora
            // processa TODOS os torneios "Running", em lotes, sem deixar nenhum
            // de fora.
            const BATCH_SIZE = 25;
            let LastId = null;
            for (;;) {
                const Query = { Status: Config_1.TournamentStatus.Running };
                if (LastId)
                    Query._id = { $gt: LastId };
                const Batch = await Tournament_1.Tournament.find(Query).sort({ _id: 1 }).limit(BATCH_SIZE);
                if (Batch.length === 0)
                    break;
                for (const Tour of Batch) {
                    try {
                        await ResolveMatches(Tour);
                        await (0, Phase_2.CheckPhases)(Tour);
                    }
                    catch (Err) {
                        console.error(`Error resolving tournament ${Tour.TournamentId}:`, Err);
                    }
                }
                LastId = Batch[Batch.length - 1]._id;
                if (Batch.length < BATCH_SIZE)
                    break;
            }
        }
        catch (Err) {
            console.error("Error in resolution loop:", Err);
        }
    }, 2000); // 2s — WO/final resolve mais rápido
}
//# sourceMappingURL=Resolving.js.map