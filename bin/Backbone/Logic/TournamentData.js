"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TournamentGetData = TournamentGetData;
exports.StartTournamentActivationLoop = StartTournamentActivationLoop;
const BackboneUser_1 = require("../../Models/BackboneUser");
const LPUser_1 = require("../../Models/LPUser");
const Matches_1 = require("../../Models/Matches");
const Tournament_1 = require("../../Models/Tournament");
const TournamentEconomy_1 = require("./TournamentEconomy");
const Config_1 = require("../Config");
const Properties_1 = require("../Settings/Properties");
const Rules_1 = require("../Settings/Rules");
const GetMatches_1 = require("./GetMatches");
const MatchPresence_1 = require("./MatchPresence");
const TournamentRules_1 = require("./TournamentRules");
const MatchStateMachine_1 = require("./MatchStateMachine");
function ToJSON(Obj) {
    if (!Obj)
        return Obj;
    if (Array.isArray(Obj))
        return Obj.map(ToJSON);
    if (typeof Obj !== "object")
        return Obj;
    if (Obj.toJSON)
        return Obj.toJSON();
    if (Obj._doc)
        return ToJSON(Obj._doc);
    const Cleaned = {};
    for (const Key in Obj) {
        if (Key.startsWith("$") || Key.startsWith("_") || Key === "__v")
            continue;
        Cleaned[Key] = ToJSON(Obj[Key]);
    }
    return Cleaned;
}
function FormatMatchDeadline(MatchData) {
    if (!MatchData)
        return null;
    const Clean = ToJSON(MatchData);
    if (Clean.deadline instanceof Date) {
        Clean.deadline = Clean.deadline.toISOString();
    }
    // R1 bye / WO fechado: client mostra QUALIFICADO só com played>=1 + winner
    // Sem isso aparece "não jogada" mesmo com status Closed.
    const st = Clean.status;
    const users = Array.isArray(Clean.users) ? Clean.users : [];
    const teamIds = new Set(users.map((u) => u && u["@team-id"]).filter(Boolean));
    // O enum interno usa 3 para GameInProgress e 8 para Closed. A versão
    // anterior tratava 3 como encerrado, então o poll transformava uma partida
    // que estava começando em "já jogada" e o botão JOGAR oscilava.
    const numericStatus = Number(st);
    const isTerminalStatus = numericStatus === Config_1.TournamentMatchStatus.Closed ||
        numericStatus === Config_1.TournamentMatchStatus.GameFinished ||
        numericStatus === Config_1.TournamentMatchStatus.MatchFinished ||
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
    const hasWinner = users.some((u) => u && (u["@match-winner"] === "1" || u["@match-winner"] === 1));
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
                if (!u)
                    continue;
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
async function GetUserData(UserId, TournamentId) {
    const User = await BackboneUser_1.BackboneUser.findOne({ UserId }).lean();
    if (!User)
        return null;
    const Data = User.Tournaments.get
        ? User.Tournaments.get(TournamentId)
        : User.Tournaments[TournamentId];
    if (!Data)
        return null;
    return { ...Data, UserPosition: Data.UserPosition || [] };
}
async function TournamentGetData(TournamentId, GetAll, Ready, Token) {
    const [Tour, LPAccount] = await Promise.all([
        Tournament_1.Tournament.findOne({ TournamentId }),
        LPUser_1.LPUser.findOne({ AccessToken: Token }).lean(),
    ]);
    if (!Tour || !LPAccount)
        return { message: "" };
    const User = await BackboneUser_1.BackboneUser.findOne({ UserId: LPAccount.UserId });
    if (!User)
        return { message: "" };
    // Contagem estável de inscritos (string + number key) — NÃO decrementa no GetData
    const tidStr = String(TournamentId);
    const tidNum = Number(TournamentId);
    const signedQuery = [
        { [`Tournaments.${tidStr}.SignedUp`]: true },
    ];
    if (!isNaN(tidNum) && String(tidNum) === tidStr) {
        signedQuery.push({ [`Tournaments.${tidNum}.SignedUp`]: true });
    }
    const SignedCount = await BackboneUser_1.BackboneUser.countDocuments({ $or: signedQuery });
    // GetData NUNCA baixa CurrentInvites (só sobe se count real for maior).
    const safeInvites = typeof Tour.CurrentInvites === "number" ? Tour.CurrentInvites : 0;
    if (SignedCount > safeInvites) {
        console.log(`[TournamentData] CurrentInvites UP ${tidStr}: ${safeInvites} → ${SignedCount}`);
        Tour.CurrentInvites = SignedCount;
        await Tournament_1.Tournament.updateOne({ TournamentId: Tour.TournamentId }, { $set: { CurrentInvites: SignedCount } }).catch(() => { });
    }
    else {
        Tour.CurrentInvites = Math.max(safeInvites, SignedCount);
    }
    const Starts = new Date(Tour.StartTime);
    // Inscricao abre bem antes; FECHA no StartTime
    const Opens = Tour.SignupStart
        ? new Date(Tour.SignupStart)
        : new Date(Starts.getTime() - 24 * 60 * 60 * 1000);
    const Closes = new Date(Starts.getTime());
    const Now = new Date();
    let Status = Config_1.TournamentStatus.NotStarted;
    // Vencedor já gravado → Finished na hora
    if (Array.isArray(Tour.Winners) && Tour.Winners.length > 0) {
        Status = Config_1.TournamentStatus.Finished;
        if (Tour.Status !== Config_1.TournamentStatus.Finished) {
            if (!Tour.Properties)
                Tour.Properties = {};
            if (!Tour.Properties.FinishedAt)
                Tour.Properties.FinishedAt = new Date();
            await Tournament_1.Tournament.updateOne({ TournamentId: Tour.TournamentId, Status: { $ne: Config_1.TournamentStatus.Finished } }, { $set: { Status: Config_1.TournamentStatus.Finished, "Properties.FinishedAt": Tour.Properties.FinishedAt } }).catch(() => { });
            Tour.Status = Config_1.TournamentStatus.Finished;
        }
    }
    else if (Tour.Status !== Config_1.TournamentStatus.Canceled && Tour.Status !== Config_1.TournamentStatus.Finished) {
        if (Now < Opens) {
            Status = Config_1.TournamentStatus.NotStarted;
        }
        else if (Now < Starts) {
            Status = Config_1.TournamentStatus.InvitationOpen;
        }
        else {
            try {
                await (0, GetMatches_1.GenerateBracketMatches)(Tour);
            }
            catch (e) {
                console.error("[TournamentData] GenerateBracket on start:", e);
            }
            if (!Tour.CurrentPhaseStarted || Tour.Status !== Config_1.TournamentStatus.Running) {
                Tour.CurrentPhaseId = Tour.CurrentPhaseId || 1;
                Tour.CurrentPhaseStarted = new Date(Date.now() - 1000);
                Tour.NextPhaseStarted =
                    Tour.NextPhaseStarted ||
                        new Date(Date.now() + (await (0, Properties_1.GetNextPhaseStarted)(Tour)));
                const ActivationUpdate = await Tournament_1.Tournament.updateOne({ TournamentId: Tour.TournamentId, Status: { $nin: [Config_1.TournamentStatus.Finished, Config_1.TournamentStatus.Canceled] } }, {
                    $set: {
                        CurrentPhaseId: Tour.CurrentPhaseId,
                        CurrentPhaseStarted: Tour.CurrentPhaseStarted,
                        NextPhaseStarted: Tour.NextPhaseStarted,
                        Status: Config_1.TournamentStatus.Running,
                    },
                }).catch(() => ({ modifiedCount: 0 }));
                if (ActivationUpdate.modifiedCount > 0)
                    Tour.Status = Config_1.TournamentStatus.Running;
            }
            Status = Config_1.TournamentStatus.Running;
            const Phase = Tour.CurrentPhaseId || 1;
            const IsFinalPhase = Phase === Tour.Phases.length;
            if (IsFinalPhase) {
                const AllMatches = await Matches_1.Match.find({
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
                const AllLastRoundClosed = LastRoundMatches.length > 0 &&
                    LastRoundMatches.every((m) => m.status === Config_1.TournamentMatchStatus.Closed ||
                        m.status === Config_1.TournamentMatchStatus.GameFinished);
                if (AllLastRoundClosed) {
                    if (!Tour.Winners || Tour.Winners.length === 0) {
                        const finalMatch = LastRoundMatches[0];
                        if (finalMatch?.users?.length) {
                            const winnerIds = [
                                ...new Set(finalMatch.users
                                    .filter((u) => u["@match-winner"] === "1")
                                    .map((u) => String(u["@user-id"]))),
                            ];
                            const winners = [];
                            for (const id of winnerIds) {
                                const u = await BackboneUser_1.BackboneUser.findOne({ UserId: id }).lean();
                                winners.push({
                                    nick: u?.Username || id,
                                    userId: id,
                                });
                            }
                            if (winners.length > 0) {
                                const FinishUpdate = await Tournament_1.Tournament.updateOne({ TournamentId: Tour.TournamentId, Status: { $ne: Config_1.TournamentStatus.Finished } }, {
                                    $set: {
                                        Winners: winners,
                                        Status: Config_1.TournamentStatus.Finished,
                                        "Properties.FinishedAt": new Date(),
                                    },
                                }).catch(() => ({ modifiedCount: 0 }));
                                if (FinishUpdate.modifiedCount > 0) {
                                    Tour.Winners = winners;
                                    Tour.Status = Config_1.TournamentStatus.Finished;
                                    Status = Config_1.TournamentStatus.Finished;
                                }
                            }
                        }
                    }
                    if (Array.isArray(Tour.Winners) && Tour.Winners.length > 0) {
                        Tour.Status = Config_1.TournamentStatus.Finished;
                        Status = Config_1.TournamentStatus.Finished;
                    }
                }
            }
        }
    }
    else {
        Status = Tour.Status;
    }
    const Response = {
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
                partysize: (0, TournamentRules_1.GetTournamentFormat)(Tour).playersPerTeam,
                currentinvites: Tour.CurrentInvites,
                phasecount: Tour.Phases.length,
                roundcount: Tour.RoundCount,
                sponsorimage: "",
                sponsorname: "",
                currentphaseid: Status === Config_1.TournamentStatus.Running ? (Tour.CurrentPhaseId || 1) : (Tour.CurrentPhaseId || 0),
                currentphasestarted: Status === Config_1.TournamentStatus.Running
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
                        "rules-setting": [(0, Rules_1.GetRulesSettings)(Tour)],
                        "prize-setting": [
                            {
                                reward: (Tour.Prizes && Tour.Prizes.length > 0
                                    ? Tour.Prizes
                                    : (0, TournamentEconomy_1.BuildPrizeDistribution)(Tour.PrizePoolGems || 0, Tour.MaxInvites || 1, Tour)).length > 0
                                    ? (() => {
                                        const prizes = Tour.Prizes && Tour.Prizes.length > 0
                                            ? Tour.Prizes
                                            : (0, TournamentEconomy_1.BuildPrizeDistribution)(Tour.PrizePoolGems || 0, Tour.MaxInvites || 1, Tour);
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
                        "property-setting": (0, Properties_1.GetProperties)(Tour),
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
                        "winner-data": (Tour.Winners?.length ?? 0) > 0
                            ? [{ user: (Tour.Winners ?? []).map((W) => ({ "@user-id": W.userId, "@nick": W.nick })) }]
                            : undefined,
                    },
                },
                privateCode: null,
                inviteId: null,
                inviteAceptedAt: null,
                inviteDeclinedAt: null,
                inviteStatus: Config_1.TournamentUserStatus.Invited,
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
        Response.tournamentData[0].status = Config_1.TournamentStatus.Finished;
        const me = Tour.Winners.find((W) => String(W.userId) === String(User.UserId));
        if (me) {
            Response.tournamentData[0].userPlace = 1;
            Response.tournamentData[0].prizeDelivered = true;
        }
    }
    const Info = User.Tournaments?.get(TournamentId.toString());
    const IsAdmin = Tour.Properties.AdminIds.includes(User.UserId);
    const IsInviteOnly = Boolean(Tour.Properties?.IsInvitationOnly) && Array.isArray(Tour.Properties?.InvitedIds) && Tour.Properties.InvitedIds.length > 0;
    const IsInvited = IsInviteOnly && Tour.Properties?.InvitedIds?.includes(User.UserId);
    if (IsAdmin)
        Response.tournamentData[0].isAdministrator = true;
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
    if (!Info?.SignedUp)
        return Response;
    if (IsInviteOnly && !IsInvited && !IsAdmin) {
        Response.tournamentData[0].inviteStatus = Config_1.TournamentUserStatus.Invited;
        return Response;
    }
    Response.tournamentData[0].inviteId = Info.InviteId?.toString() || null;
    Response.tournamentData[0].invitePartyId = Info.InviteId?.toString() || null;
    if ((0, TournamentRules_1.GetTournamentFormat)(Tour).playersPerTeam > 1)
        Response.tournamentData[0].invitePartyCode = Info.PartyCode || null;
    Response.tournamentData[0].inviteStatus = Config_1.TournamentUserStatus.Confirmed;
    Response.tournamentData[0].inviteAceptedAt = Info.AcceptedAt
        ? new Date(Info.AcceptedAt).toISOString()
        : new Date().toISOString();
    Response.tournamentData[0].checkIn = true;
    if (Info.PartyMembers) {
        Response.party = Info.PartyMembers.map((PartyUser) => ({
            userId: PartyUser.UserId.toString(),
            status: PartyUser.Status,
            checkIn: true,
            isPartyLeader: PartyUser.IsPartyLeader,
            nick: PartyUser.Username,
        }));
        if (User.Username !== Response.party.find((p) => p.userId === User.UserId)?.nick) {
            const TeammatesUserIds = Info.PartyMembers.map((pm) => pm.UserId);
            const DatabaseTeammates = await BackboneUser_1.BackboneUser.find({ UserId: { $in: TeammatesUserIds } }).lean();
            Info.PartyMembers = Info.PartyMembers.map((pm) => {
                const fresh = DatabaseTeammates.find((u) => u.UserId === pm.UserId);
                return fresh ? { ...pm, Username: fresh.Username } : pm;
            });
            Response.party = Info.PartyMembers.map((PartyUser) => ({
                userId: PartyUser.UserId.toString(),
                status: PartyUser.Status,
                checkIn: true,
                isPartyLeader: PartyUser.IsPartyLeader,
                nick: PartyUser.Username,
            }));
            await User.save();
        }
        const CurrentUser = Info.PartyMembers.find((PartyUser) => PartyUser.UserId === User.UserId);
        if (CurrentUser) {
            Response.tournamentData[0].inviteIsPartyLeader = CurrentUser.IsPartyLeader;
            if (Info.PartyMembers.some((any) => any.IsKicked))
                Response.tournamentData[0].inviteStatus = Config_1.TournamentUserStatus.KickedOutByAdmin;
        }
    }
    if (Now < Starts) {
        await User.save().catch(() => { });
        return Response;
    }
    // Já começou: flags OBRIGATÓRIAS pro botão JOGAR
    if (!(Array.isArray(Tour.Winners) && Tour.Winners.length > 0) && Status !== Config_1.TournamentStatus.Finished) {
        Response.tournamentData[0].status = Config_1.TournamentStatus.Running;
        Status = Config_1.TournamentStatus.Running;
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
    Response.tournamentData[0].inviteStatus = Config_1.TournamentUserStatus.Confirmed;
    Response.tournamentData[0].phasecount = Math.max(1, Tour.Phases?.length || 1);
    if (Now < Starts &&
        User.Tournaments?.get(Tour.TournamentId.toString())?.PartyMembers?.length !== (0, TournamentRules_1.GetTournamentFormat)(Tour).playersPerTeam &&
        Info.PartyMembers) {
        Info.PartyMembers.forEach((PartyUser) => (PartyUser.Status = Config_1.TournamentUserStatus.PartyNotFull));
        Response.tournamentData[0].inviteStatus = Config_1.TournamentUserStatus.PartyNotFull;
    }
    const Phase = Tour.CurrentPhaseId || 1;
    const UserData = await GetUserData(User.UserId, TournamentId.toString());
    Response.userPosition = UserData ? UserData.UserPosition : [];
    if (GetAll === 0 && !Info?.SignedUp) {
        Response.party = [];
        Response.tournamentData = [];
    }
    let DatabaseMatch = await (0, GetMatches_1.GetUserMatch)(User, Tour);
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
            await (0, GetMatches_1.GenerateBracketMatches)(Tour);
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
                const FreshUser = await BackboneUser_1.BackboneUser.findOne({ UserId: User.UserId }).lean();
                const FreshInfo = FreshUser
                    ? FreshUser.Tournaments?.get
                        ? FreshUser.Tournaments.get(TournamentId.toString())
                        : FreshUser.Tournaments?.[TournamentId.toString()]
                    : null;
                if (FreshInfo?.UserPosition?.length) {
                    Info.UserPosition = FreshInfo.UserPosition;
                }
            }
            catch (refreshErr) {
                console.error("[TournamentData] Falha ao atualizar UserPosition em memória:", refreshErr);
            }
            await (0, GetMatches_1.AssignNextMatchIfNeeded)(User, Tour);
            DatabaseMatch = await (0, GetMatches_1.GetUserMatch)(User, Tour);
        }
        catch (e) {
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
    if (DatabaseMatch && Number(DatabaseMatch.status) === Config_1.TournamentMatchStatus.GameInProgress) {
        await (0, MatchPresence_1.TouchMatchPresence)(String(DatabaseMatch.id), String(User.UserId), true).catch((error) => {
            console.error("[TournamentData] Falha no heartbeat da match:", error);
        });
    }
    if (Info.UserMatch && Info.UserMatch.id) {
        const CachedMatchId = String(Info.UserMatch.id);
        const ValidateMatch = await Matches_1.Match.findOne({
            id: CachedMatchId,
            status: {
                $in: [
                    Config_1.TournamentMatchStatus.Closed,
                    Config_1.TournamentMatchStatus.GameFinished,
                    Config_1.TournamentMatchStatus.MatchFinished,
                ],
            },
        }).lean();
        if (ValidateMatch) {
            const LiveMatchId = DatabaseMatch?.id ? String(DatabaseMatch.id) : null;
            if (LiveMatchId && LiveMatchId !== CachedMatchId) {
                // O cache ainda aponta para a rodada anterior, mas GetUserMatch já
                // encontrou uma partida ativa. Não devolva null neste poll: isso fazia
                // o botão JOGAR piscar entre "jogar" e "cancelado".
                Info.UserMatch = Response.userMatch;
                await BackboneUser_1.BackboneUser.updateOne({ UserId: User.UserId }, { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: Response.userMatch } });
            }
            else {
                Info.UserMatch = null;
                await BackboneUser_1.BackboneUser.updateOne({ UserId: User.UserId }, { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: null } });
                Response.userMatch = null;
            }
        }
    }
    if (Info.UserMatches?.length > 0) {
        Response.userMatches = Info.UserMatches.map((OldMatches) => FormatMatchDeadline(OldMatches));
    }
    if (Ready === 0 && Response.userMatch) {
        const UpdatedMatch = await Matches_1.Match.findOne({ id: Response.userMatch.id }).lean();
        if (UpdatedMatch) {
            Response.userMatch = FormatMatchDeadline(UpdatedMatch);
            await BackboneUser_1.BackboneUser.findOneAndUpdate({ UserId: User.UserId }, { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: Response.userMatch } });
        }
    }
    if ((Ready === 1 || !Response.userMatch) && GetAll === 1) {
        const PhaseConfig = Tour.Phases[Phase - 1];
        const TypeNum = Number(PhaseConfig.PhaseType) || Config_1.TournamentPhaseType.SingleEliminationBracket;
        const PhaseType = Config_1.TournamentPhaseType[TypeNum];
        if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") {
            const Pos = Info.UserPosition?.find((Pos) => Pos.phaseid === Phase);
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
                await (0, GetMatches_1.AssignNextMatchIfNeeded)(User, Tour);
                const NewMatch = await (0, GetMatches_1.GetUserMatch)(User, Tour);
                if (NewMatch)
                    Response.userMatch = FormatMatchDeadline(NewMatch);
            }
            catch (e) {
                console.error("[TournamentData] Falha ao atribuir próxima partida (readyForNextMatch):", e);
            }
        }
    }
    if ((Ready === 1 || !Response.userMatch) && GetAll === 0 && Response.userMatch) {
        const PhaseConfig = Tour.Phases[Phase - 1];
        const TypeNum = Number(PhaseConfig.PhaseType) || Config_1.TournamentPhaseType.SingleEliminationBracket;
        const PhaseType = Config_1.TournamentPhaseType[TypeNum];
        if (PhaseType !== "RoundRobin" && PhaseType !== "Arena") {
            const Pos = Info.UserPosition?.find((Pos) => Pos.phaseid === Phase);
            if (Pos && Pos.matchloses > 0) {
                Info.KnockedOut = true;
            }
        }
        if (Info.KnockedOut) {
            Response.userMatch = null;
            if (Info.UserMatches?.length > 0) {
                Response.userMatches = Info.UserMatches.map((HistoryMatch) => FormatMatchDeadline(HistoryMatch));
            }
            const UserData = await GetUserData(User.UserId, TournamentId.toString());
            Response.userPosition = UserData ? UserData.UserPosition : [];
            await User.save();
            return ToJSON(Response);
        }
        const CurrentMatch = await Matches_1.Match.findOne({ id: Response.userMatch.id }).lean();
        if (!CurrentMatch) {
            Response.userMatch = null;
            await BackboneUser_1.BackboneUser.findOneAndUpdate({ UserId: User.UserId }, { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: null } });
            await User.save();
            return ToJSON(Response);
        }
        if (CurrentMatch.status === Config_1.TournamentMatchStatus.Closed ||
            CurrentMatch.status === Config_1.TournamentMatchStatus.GameFinished) {
            Response.userMatch = null;
            await BackboneUser_1.BackboneUser.findOneAndUpdate({ UserId: User.UserId }, { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: null } });
            await User.save();
            return ToJSON(Response);
        }
        const UserInMatch = CurrentMatch.users.find((MatchUser) => MatchUser["@user-id"] === User.UserId);
        if (!UserInMatch) {
            Response.userMatch = null;
            await BackboneUser_1.BackboneUser.findOneAndUpdate({ UserId: User.UserId }, { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: null } });
            await User.save();
            return ToJSON(Response);
        }
        const WinnerInMatch = CurrentMatch.users.find((MatchUser) => MatchUser["@match-winner"] === "1");
        if (WinnerInMatch) {
            const WinnerId = WinnerInMatch["@user-id"];
            const Winner = await BackboneUser_1.BackboneUser.findOne({ UserId: WinnerId });
            if (Winner) {
                await (0, GetMatches_1.Qualify)(Winner, Tour);
                if (WinnerId === User.UserId) {
                    Response.userMatch = null;
                    await BackboneUser_1.BackboneUser.findOneAndUpdate({ UserId: User.UserId }, { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: null } }).catch(() => { });
                    const UpdatedUser = await BackboneUser_1.BackboneUser.findOne({ UserId: User.UserId });
                    const UpdatedInfo = UpdatedUser?.Tournaments.get(Tour.TournamentId.toString());
                    const hist = UpdatedInfo?.UserMatches;
                    if (hist && hist.length > 0) {
                        Response.userMatches = hist.map((HistoryMatch) => FormatMatchDeadline(HistoryMatch));
                    }
                }
            }
            const FreshAfterQualify = await Tournament_1.Tournament.findOne({ TournamentId: Tour.TournamentId }).lean();
            if (FreshAfterQualify &&
                Array.isArray(FreshAfterQualify.Winners) &&
                FreshAfterQualify.Winners.length > 0) {
                const winners = FreshAfterQualify.Winners;
                Response.tournamentData[0].status = Config_1.TournamentStatus.Finished;
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
            await User.save().catch(() => { });
            return ToJSON(Response);
        }
        if (UserInMatch["@checked-in"] === "1") {
            const TournamentFormat = (0, TournamentRules_1.GetTournamentFormat)(Tour);
            if (CurrentMatch.status === Config_1.TournamentMatchStatus.GameInProgress) {
                const RefreshedInProgress = await Matches_1.Match.findOne({ id: Response.userMatch.id }).lean();
                Response.userMatch = FormatMatchDeadline(RefreshedInProgress || CurrentMatch);
                await User.save().catch(() => { });
                return ToJSON(Response);
            }
            const PartyIds = Info.PartyMembers?.map((PartyUser) => PartyUser.UserId.toString()) || [User.UserId];
            const CheckedInUsers = CurrentMatch.users.filter((MatchUser) => MatchUser["@checked-in"] === "1");
            const OtherTeamsCheckedIn = CurrentMatch.users.some((MatchUser) => !PartyIds.includes(MatchUser["@user-id"]) && MatchUser["@checked-in"] === "1");
            const UniqueTeams = new Set((CurrentMatch.users || []).map((u) => u["@team-id"]).filter(Boolean));
            if (OtherTeamsCheckedIn ||
                UniqueTeams.size >= TournamentFormat.maxTeamsPerMatch ||
                CurrentMatch.status === Config_1.TournamentMatchStatus.GameReady) {
                if (OtherTeamsCheckedIn || UniqueTeams.size >= TournamentFormat.maxTeamsPerMatch) {
                    const RefreshedFull = await Matches_1.Match.findOne({ id: Response.userMatch.id }).lean();
                    Response.userMatch = FormatMatchDeadline(RefreshedFull || CurrentMatch);
                    await User.save().catch(() => { });
                    return ToJSON(Response);
                }
            }
            const Configs = (0, Rules_1.GetRoundConfigs)(Tour);
            const Deadline = (0, GetMatches_1.GetMatchDeadline)(CurrentMatch, Tour, Configs);
            const CurrentPhaseConfig = Tour.Phases[(Tour.CurrentPhaseId || 1) - 1];
            const IsFinalBracketPhase = (Tour.CurrentPhaseId || 1) === (Tour.Phases?.length || 1) &&
                Number(CurrentPhaseConfig?.PhaseType) === Config_1.TournamentPhaseType.SingleEliminationBracket;
            const GracePeriod = Deadline;
            const IsPassed = IsFinalBracketPhase && Now >= GracePeriod;
            if (IsPassed) {
                const AllPartyCheckedIn = PartyIds.every((PartyId) => CheckedInUsers.some((CheckedUser) => CheckedUser["@user-id"] === PartyId));
                if (AllPartyCheckedIn &&
                    !OtherTeamsCheckedIn &&
                    UniqueTeams.size < TournamentFormat.maxTeamsPerMatch) {
                    const UpdatedUsers = CurrentMatch.users.map((MatchUser) => {
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
                    const Closed = await (0, MatchStateMachine_1.TransitionMatch)(Response.userMatch.id, [CurrentMatch.status], Config_1.TournamentMatchStatus.Closed, {
                        users: UpdatedUsers,
                        // SEMPRE >= 1 para o client mostrar QUALIFICADO e não "não jogada"
                        playedgamecount: Math.max(1, CurrentMatch.playedgamecount || 0, 1),
                    });
                    if (Closed) {
                        // O qualificador precisa receber o snapshot fechado, mas o claim
                        // permanece dentro de QualifyPhase/QualifyFromBracket para que o
                        // mesmo caminho funcione em RR, Arena e Bracket.
                        const UserInfoForQualification = User.Tournaments.get(Tour.TournamentId.toString());
                        if (UserInfoForQualification)
                            UserInfoForQualification.UserMatch = Closed;
                        await (0, GetMatches_1.Qualify)(User, Tour);
                    }
                    // Devolve a match fechada na história IMEDIATAMENTE (qualificado na hora)
                    const ClosedSnap = await Matches_1.Match.findOne({ id: Response.userMatch.id }).lean();
                    if (ClosedSnap) {
                        const Formatted = FormatMatchDeadline({
                            ...ClosedSnap,
                            status: Config_1.TournamentMatchStatus.Closed,
                            playedgamecount: Math.max(1, ClosedSnap.playedgamecount || 1),
                            users: UpdatedUsers,
                        });
                        Response.userMatches = [Formatted, ...(Response.userMatches || [])];
                        // opcional: ainda mostra a match atual como closed (alguns clients preferem)
                        Response.userMatch = Formatted;
                    }
                    else {
                        Response.userMatch = null;
                    }
                    // Mantém UserMatch = match Closed (qualificado) em vez de null
                    // (null faz o client piscar "não jogada")
                    await BackboneUser_1.BackboneUser.findOneAndUpdate({ UserId: User.UserId }, {
                        $set: {
                            [`Tournaments.${Tour.TournamentId}.UserMatch`]: Response.userMatch || null,
                        },
                    }).catch(() => { });
                    const UpdatedUser = await BackboneUser_1.BackboneUser.findOne({ UserId: User.UserId });
                    const UpdatedInfo = UpdatedUser?.Tournaments.get(Tour.TournamentId.toString());
                    const histWo = UpdatedInfo?.UserMatches;
                    if (histWo && histWo.length > 0) {
                        Response.userMatches = histWo.map((HistoryMatch) => FormatMatchDeadline(HistoryMatch));
                    }
                    const UserDataAfterWo = await GetUserData(User.UserId, TournamentId.toString());
                    Response.userPosition = UserDataAfterWo ? UserDataAfterWo.UserPosition : [];
                    await User.save().catch(() => { });
                    return ToJSON(Response);
                }
            }
            const RefreshedMatch = await Matches_1.Match.findOne({ id: Response.userMatch.id }).lean();
            Response.userMatch = FormatMatchDeadline(RefreshedMatch);
            await User.save().catch(() => { });
            return ToJSON(Response);
        }
        await Matches_1.Match.updateOne({
            id: Response.userMatch.id,
            status: {
                $nin: [
                    Config_1.TournamentMatchStatus.Closed,
                    Config_1.TournamentMatchStatus.GameFinished,
                ],
            },
        }, { $set: { "users.$[elem].@checked-in": "1" } }, { arrayFilters: [{ "elem.@user-id": User.UserId.toString() }] });
        const FreshMatch = await Matches_1.Match.findOne({ id: Response.userMatch.id }).lean();
        if (FreshMatch) {
            Response.userMatch = FormatMatchDeadline(FreshMatch);
            const AllIds = (FreshMatch.users || []).map((u) => u["@user-id"]).filter(Boolean);
            const MatchPayload = FormatMatchDeadline(FreshMatch);
            if (AllIds.length > 0) {
                await BackboneUser_1.BackboneUser.updateMany({ UserId: { $in: AllIds }, [`Tournaments.${Tour.TournamentId}`]: { $exists: true } }, { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: MatchPayload } });
            }
            else {
                await BackboneUser_1.BackboneUser.findOneAndUpdate({ UserId: User.UserId }, { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: MatchPayload } });
            }
            if (FreshMatch.status === Config_1.TournamentMatchStatus.WaitingForOpponent) {
                const UniqueTeams = new Set(FreshMatch.users.map((U) => U["@team-id"]).filter((T) => T));
                if (UniqueTeams.size === (0, TournamentRules_1.GetTournamentFormat)(Tour).maxTeamsPerMatch) {
                    const Configs = (0, Rules_1.GetRoundConfigs)(Tour);
                    const Config = Configs.get(FreshMatch.roundid);
                    let NewDeadline;
                    if (Config) {
                        const GameCount = Config.MaxGameCount;
                        const TotalMinutes = GameCount * Config.MinGameLength;
                        const AdjustedMinutes = TotalMinutes === Config.MaxLength ? TotalMinutes - 1 : TotalMinutes;
                        const SubtractedTime = AdjustedMinutes * 60 * 1000 + 15000;
                        const CheckInTime = 0;
                        NewDeadline = new Date(Date.now() + CheckInTime + SubtractedTime);
                    }
                    else {
                        NewDeadline = new Date(Date.now() + 2.5 * 60 * 1000);
                    }
                    await (0, MatchStateMachine_1.TransitionMatch)(FreshMatch.id, [Config_1.TournamentMatchStatus.WaitingForOpponent], Config_1.TournamentMatchStatus.GameReady, { deadline: NewDeadline });
                    const UpdatedFreshMatch = await Matches_1.Match.findOne({ id: FreshMatch.id }).lean();
                    if (UpdatedFreshMatch) {
                        Response.userMatch = FormatMatchDeadline(UpdatedFreshMatch);
                        await BackboneUser_1.BackboneUser.findOneAndUpdate({ UserId: User.UserId }, { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: FormatMatchDeadline(UpdatedFreshMatch) } });
                    }
                }
            }
        }
    }
    else if (Info.UserMatch && !Info.UserMatch.id) {
        const DatabaseMatch = await (0, GetMatches_1.GetUserMatch)(User, Tour);
        if (DatabaseMatch) {
            await BackboneUser_1.BackboneUser.findOneAndUpdate({ UserId: User.UserId }, { $set: { [`Tournaments.${Tour.TournamentId}.UserMatch`]: FormatMatchDeadline(DatabaseMatch) } });
        }
    }
    if (Info.KnockedOut || Info.PartyMembers.some((me) => me.UserId == User.UserId && me.IsKicked)) {
        Response.userMatch = null;
        if (Info.UserMatches?.length > 0) {
            Response.userMatches = Info.UserMatches.map((Match) => FormatMatchDeadline(Match));
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
        const FreshTour = await Tournament_1.Tournament.findOne({ TournamentId: Tour.TournamentId }).lean();
        if (FreshTour && Array.isArray(FreshTour.Winners) && FreshTour.Winners.length > 0) {
            const winners = FreshTour.Winners;
            Response.tournamentData[0].status = Config_1.TournamentStatus.Finished;
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
            if (FreshTour.Status !== Config_1.TournamentStatus.Finished) {
                await Tournament_1.Tournament.updateOne({ TournamentId: Tour.TournamentId }, {
                    $set: {
                        Status: Config_1.TournamentStatus.Finished,
                        "Properties.FinishedAt": new Date(),
                    },
                }).catch(() => { });
            }
        }
    }
    catch (e) {
        console.error("[TournamentData] winner refresh failed:", e);
    }
    await User.save().catch(() => { });
    return ToJSON(Response);
}
let TournamentActivationLoop = null;
let TournamentActivationRunning = false;
/** Mantém torneios cujo horário chegou em estado Running e garante a criação do bracket. */
function StartTournamentActivationLoop() {
    if (TournamentActivationLoop)
        return TournamentActivationLoop;
    const activate = async () => {
        if (TournamentActivationRunning)
            return;
        TournamentActivationRunning = true;
        try {
            const now = new Date();
            const tournaments = await Tournament_1.Tournament.find({
                Status: { $nin: [Config_1.TournamentStatus.Canceled, Config_1.TournamentStatus.Finished] },
                StartTime: { $lte: now },
            });
            for (const tournament of tournaments) {
                try {
                    await (0, GetMatches_1.GenerateBracketMatches)(tournament);
                    if (tournament.Status !== Config_1.TournamentStatus.Running) {
                        const currentPhaseId = tournament.CurrentPhaseId || 1;
                        const currentPhaseStarted = tournament.CurrentPhaseStarted || new Date(Date.now() - 1000);
                        const nextPhaseStarted = tournament.NextPhaseStarted || new Date(Date.now() + 60 * 60 * 1000);
                        await Tournament_1.Tournament.updateOne({
                            TournamentId: tournament.TournamentId,
                            Status: { $nin: [Config_1.TournamentStatus.Canceled, Config_1.TournamentStatus.Finished] },
                        }, {
                            $set: {
                                Status: Config_1.TournamentStatus.Running,
                                CurrentPhaseId: currentPhaseId,
                                CurrentPhaseStarted: currentPhaseStarted,
                                NextPhaseStarted: nextPhaseStarted,
                            },
                        });
                    }
                }
                catch (error) {
                    console.error(`[TournamentActivation] Falha no torneio ${tournament.TournamentId}:`, error);
                }
            }
        }
        catch (error) {
            console.error("[TournamentActivation] Falha no ciclo:", error);
        }
        finally {
            TournamentActivationRunning = false;
        }
    };
    void activate();
    TournamentActivationLoop = setInterval(() => void activate(), 5000);
    TournamentActivationLoop.unref?.();
    return TournamentActivationLoop;
}
//# sourceMappingURL=TournamentData.js.map