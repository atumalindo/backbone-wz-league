"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetTournamentList = GetTournamentList;
const BackboneUser_1 = require("../../Models/BackboneUser");
const LPUser_1 = require("../../Models/LPUser");
const Tournament_1 = require("../../Models/Tournament");
const Config_1 = require("../Config");
const TournamentEconomy_1 = require("./TournamentEconomy");
const TournamentRules_1 = require("./TournamentRules");
/**
 * Client da aba filtra forte:
 * - status !== 1 → some
 * - tournamenttime no passado / mudando a cada request → some / pisca
 * - type duplicado → só 1 card por type
 *
 * Regras desta lista:
 * 1) SEMPRE devolve todos os ativos com status=1
 * 2) tournamenttime ESTÁVEL (não muda a cada poll) — se real no passado, empurra +24h até futuro
 * 3) type ESTÁVEL por TournamentId, sem colisão nos 10 primeiros
 * 4) invitationcloses bem no futuro
 * 5) ordena pelo StartTime real (menor = principal = type preferencial 1)
 */
async function GetTournamentList(_MaxResults, _Page, AccessToken, _SinceDate, _UntilDate) {
    const limit = 20;
    try {
        const LoginProviderUser = AccessToken
            ? await LPUser_1.LPUser.findOne({ AccessToken }).lean()
            : null;
        const userId = LoginProviderUser?.UserId;
        const DatabaseUser = userId
            ? await BackboneUser_1.BackboneUser.findOne({ UserId: userId }).lean()
            : null;
        // Todos menos cancelados — NÃO filtra por status Running/Finished no query
        const FoundTournaments = await Tournament_1.Tournament.find({
            Status: { $ne: Config_1.TournamentStatus.Canceled },
        })
            .sort({ StartTime: 1, TournamentId: 1 })
            .limit(200)
            .lean()
            .exec();
        const now = Date.now();
        const active = [];
        const finished = [];
        for (const Tour of FoundTournaments) {
            const hasWinners = Array.isArray(Tour.Winners) && Tour.Winners.length > 0;
            // Status antigo pode ter sido persistido como Finished antes de Winners ser salvo.
            // Para não deixar a aba vazia, a conclusão real é confirmada pelos vencedores.
            if (hasWinners) {
                finished.push(Tour);
            }
            else {
                active.push(Tour);
            }
        }
        active.sort((a, b) => new Date(a.StartTime).getTime() - new Date(b.StartTime).getTime() ||
            Number(a.TournamentId) - Number(b.TournamentId));
        finished.sort((a, b) => new Date(b.StartTime).getTime() - new Date(a.StartTime).getTime());
        // O backend entrega até dez ativos com types 1..10. A view nativa pode
        // ainda ter uma limitação visual própria; este contrato não descarta dados.
        const MAX_SLOTS = 10;
        const activeTake = active.slice(0, MAX_SLOTS);
        // A aba deve mostrar ativos; torneios finalizados não ocupam vagas de cards ativos.
        const ordered = activeTake;
        // Types sequenciais 1..10 — sem hash, sem colisão, estável por ordem da lista
        function hashStr(s) {
            let h = 0;
            for (let i = 0; i < s.length; i++)
                h = (h * 31 + s.charCodeAt(i)) | 0;
            return Math.abs(h);
        }
        // Mapa id → type fixo nesta resposta (índice na lista ordered)
        // Evita type=0, que algumas versões do client ignoram; usa 1..10.
        const typeById = new Map();
        for (let si = 0; si < ordered.length; si++) {
            const id = String(ordered[si].TournamentId ?? "").trim();
            if (id)
                typeById.set(id, si + 1); // 1..10
        }
        const usedTypes = new Set();
        const opensPast = new Date(now - 2 * 60 * 60 * 1000).toISOString();
        // closes ESTÁVEL o bastante (meia-noite UTC + 2 dias) — não muda a cada segundo
        const closesFarDate = new Date(now);
        closesFarDate.setUTCHours(23, 59, 59, 0);
        closesFarDate.setTime(closesFarDate.getTime() + 2 * 24 * 60 * 60 * 1000);
        const closesFar = closesFarDate.toISOString();
        const Tournaments = [];
        for (let i = 0; i < ordered.length; i++) {
            const Tour = ordered[i];
            const tourId = String(Tour.TournamentId ?? "").trim();
            if (!tourId)
                continue;
            const realStartMs = new Date(Tour.StartTime || now).getTime();
            const hasWinners = Array.isArray(Tour.Winners) && Tour.Winners.length > 0;
            const isReallyFinished = hasWinners;
            const isReallyRunning = !isReallyFinished &&
                (Tour.Status === Config_1.TournamentStatus.Running || now >= realStartMs);
            // Usa exatamente o StartTime persistido, igual ao detalhe do torneio.
            const displayStartMs = realStartMs;
            const StartsIso = new Date(displayStartMs).toISOString();
            const name = String(Tour.TournamentName || `Tournament ${tourId}`).slice(0, 64);
            const region = String(Tour.Region || "sa").toLowerCase();
            const format = (0, TournamentRules_1.GetTournamentFormat)(Tour);
            let currentInvites = typeof Tour.CurrentInvites === "number" ? Tour.CurrentInvites : 0;
            try {
                const orQuery = [{ [`Tournaments.${tourId}.SignedUp`]: true }];
                if (!isNaN(Number(tourId))) {
                    orQuery.push({ [`Tournaments.${Number(tourId)}.SignedUp`]: true });
                }
                const signedCount = await BackboneUser_1.BackboneUser.countDocuments({ $or: orQuery });
                if (signedCount > currentInvites) {
                    currentInvites = signedCount;
                    Tournament_1.Tournament.updateOne({ TournamentId: Tour.TournamentId }, { $set: { CurrentInvites: currentInvites } }).catch(() => { });
                }
            }
            catch {
                /* keep */
            }
            // SEMPRE status 1 nos ativos (número literal — client filtra !== 1)
            const listStatus = isReallyFinished ? 3 : 1;
            // Type 1..10 (type 0 costuma ser ignorado pelo client)
            const typeForSlot = typeById.has(tourId)
                ? typeById.get(tourId)
                : (i % MAX_SLOTS) + 1;
            usedTypes.add(typeForSlot);
            // Persiste no DB pra próximas criações/debug
            if (Tour.TournamentType !== typeForSlot) {
                Tournament_1.Tournament.updateOne({ TournamentId: Tour.TournamentId }, { $set: { TournamentType: typeForSlot } }).catch(() => { });
            }
            let inviteStatus = 0;
            let inviteId = null;
            let checkIn = false;
            if (DatabaseUser && DatabaseUser.Tournaments) {
                const map = DatabaseUser.Tournaments;
                const Info = typeof map.get === "function" ? map.get(tourId) : map[tourId];
                if (Info?.SignedUp) {
                    inviteStatus = 1;
                    inviteId = Info.InviteId != null ? String(Info.InviteId) : null;
                    checkIn = true;
                }
            }
            Tournaments.push({
                id: tourId,
                type: typeForSlot,
                status: listStatus,
                tournamenttime: StartsIso,
                cashStatus: 0,
                cashTournament: false,
                season: i + 1,
                seasonpart: 1,
                invitationopens: Tour.SignupStart ? new Date(Tour.SignupStart).toISOString() : opensPast,
                invitationcloses: Tour.StartTime ? new Date(Tour.StartTime).toISOString() : closesFar,
                maxinvites: Tour.MaxInvites ?? 8,
                partysize: format.playersPerTeam,
                currentinvites: currentInvites,
                phasecount: Math.max(1, Tour.Phases?.length || 1),
                roundcount: Tour.RoundCount ?? 3,
                sponsorimage: "",
                sponsorname: "",
                currentphaseid: isReallyRunning
                    ? Math.max(1, Tour.CurrentPhaseId || 1)
                    : isReallyFinished
                        ? Math.max(1, Tour.CurrentPhaseId || 1)
                        : 0,
                currentphasestarted: isReallyRunning
                    ? Tour.CurrentPhaseStarted
                        ? new Date(Tour.CurrentPhaseStarted).toISOString()
                        : new Date(realStartMs).toISOString()
                    : null,
                nextphase: Tour.NextPhaseStarted
                    ? new Date(Tour.NextPhaseStarted).toISOString()
                    : null,
                name,
                image: null,
                icon: Tour.TournamentImage || null,
                "theme-color": Tour.TournamentColor || "#00ff00",
                data: {
                    "tournament-data": {
                        "invitation-setting": [
                            {
                                requirements: [
                                    {
                                        "custom-requirement": [
                                            { "@name": "server_region", "@value": region },
                                        ],
                                    },
                                ],
                                ...(Tour.EntryFee > 0 ? { "entry-fee": [{ item: [{ "@amount": String(Tour.EntryFee), "@type": "10", "@id": Tour.PrizepoolId || "null", "@external-id": "4" }] }] } : {}),
                            },
                        ],
                        "rules-setting": [
                            {
                                phase: [
                                    {
                                        "@id": "1",
                                        "@type": String(Tour.Phases?.[0]?.PhaseType || 2),
                                        "@max-players": String(Tour.MaxInvites ?? 8),
                                        "@min-teams-per-match": String(format.minTeamsPerMatch),
                                        "@max-teams-per-match": String(format.maxTeamsPerMatch),
                                        "@min-checkins-per-team": "1",
                                        "@allow-skip": "0",
                                        "@game-point-distribution": "1",
                                        "@match-point-distribution": "1",
                                        "@allow-tiebreakers": "0",
                                        "@max-loses": "1",
                                        round: [
                                            {
                                                "@id": "1",
                                                "@win-score": "1",
                                                "@max-game-count": "1",
                                                "@min-length": "6",
                                                "@max-length": "12",
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                        "prize-setting": [
                            {
                                reward: (0, TournamentEconomy_1.BuildPrizeDistribution)(Tour.PrizePoolGems || 0, Tour.MaxInvites || 1, Tour).map((prize) => ({
                                    "@position": String(prize.position),
                                    ...(prize.endPosition > prize.position ? { "@end-position": String(prize.endPosition) } : {}),
                                    item: [{ "@amount": String(prize.amount), "@type": "10", "@id": Tour.PrizepoolId || "1019395748292202883", "@external-id": "4" }],
                                })),
                            },
                        ],
                        "property-setting": [
                            {
                                properties: [
                                    {
                                        property: [{ "@name": "max_wait_time", "@value": "0" }],
                                    },
                                ],
                            },
                        ],
                        "description-data": [
                            {
                                language: [
                                    {
                                        "@code": "en",
                                        name: [{ "#text": [{ value: name }] }],
                                        policy: [{ "@url": "" }],
                                        general: [
                                            {
                                                "@main-icon": Tour.TournamentImage || "",
                                                "@theme-color": Tour.TournamentColor || "#00ff00",
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                        "sponsor-data": [{ "@name": "", "@image": "" }],
                        "stream-data": [{ "@stream-link": "" }],
                    },
                },
                privateCode: null,
                inviteId,
                inviteAceptedAt: null,
                inviteDeclinedAt: null,
                inviteStatus,
                invitePartyId: inviteId,
                inviteIsPartyLeader: false,
                invitePartyCode: null,
                checkIn,
                prizeDelivered: null,
                userPlace: 0,
                isAdministrator: false,
                openregistration: isReallyFinished ? 0 : 1,
                highlightsurl: null,
                streamurl: "",
            });
        }
        process.stdout.write(`[GetTournamentList] ${Tournaments.length} ids=${Tournaments.map((t) => t.id).join(",")} types=${Tournaments.map((t) => t.type).join(",")} times=${Tournaments.map((t) => t.tournamenttime).join(",")}\n`);
        return {
            pagination: {
                currentPage: 1,
                maxResults: limit,
                totalResultCount: Tournaments.length,
            },
            tournaments: Tournaments,
        };
    }
    catch (error) {
        process.stdout.write(`[GetTournamentList] Fatal: ${String(error)}\n`);
        console.error("[GetTournamentList] Fatal:", error);
        return {
            pagination: { currentPage: 1, maxResults: limit, totalResultCount: 0 },
            tournaments: [],
        };
    }
}
//# sourceMappingURL=TournamentList.js.map