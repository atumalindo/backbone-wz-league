"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetScores = GetScores;
const BackboneUser_1 = require("../../Models/BackboneUser");
const Matches_1 = require("../../Models/Matches");
const Tournament_1 = require("../../Models/Tournament");
const Config_1 = require("../Config");
const TournamentRules_1 = require("./TournamentRules");
const GetMatches_1 = require("./GetMatches");
const TournamentEconomy_1 = require("./TournamentEconomy");
async function GetScores(TournamentId, PhaseId, GroupId, MaxResults, Page) {
    try {
        const Skip = (Page - 1) * MaxResults;
        const ActualPhaseId = PhaseId || 1;
        const TournamentIdStr = TournamentId.toString();
        const TournamentDoc = await Tournament_1.Tournament.findOne({ TournamentId: TournamentIdStr }).lean();
        if (!TournamentDoc) {
            // Não crasha o processo — retorna lista vazia (torneio já foi deletado)
            console.warn(`[GetScores] tournament not found: ${TournamentIdStr}`);
            return {
                pagination: {
                    totalResultCount: 0,
                    maxResults: MaxResults,
                    currentPage: Page,
                },
                scores: [],
            };
        }
        const IsFinalPhase = ActualPhaseId === TournamentDoc.Phases.length;
        const IsTournamentEnded = TournamentDoc.Status === Config_1.TournamentStatus.Finished;
        const PhaseConfig = TournamentDoc.Phases[ActualPhaseId - 1];
        const PhaseTypeNum = Number(PhaseConfig?.PhaseType) || Config_1.TournamentPhaseType.SingleEliminationBracket;
        const PhaseType = Config_1.TournamentPhaseType[PhaseTypeNum];
        const IsPointBasedPhase = PhaseType === "RoundRobin" || PhaseType === "Arena";
        const AllMatches = await Matches_1.Match.find({
            tournamentid: TournamentIdStr,
            phaseid: ActualPhaseId,
            groupid: GroupId,
        }).lean();
        const AllBackboneUsers = await BackboneUser_1.BackboneUser.find({
            [`Tournaments.${TournamentIdStr}`]: { $exists: true },
        })
            .select("UserId Username Tournaments TournamentsWon")
            .lean();
        const UserMap = new Map();
        for (const BBUser of AllBackboneUsers) {
            try {
                const TournamentData = BBUser.Tournaments.get
                    ? BBUser.Tournaments.get(TournamentIdStr)
                    : BBUser.Tournaments[TournamentIdStr];
                if (TournamentData) {
                    UserMap.set(BBUser.UserId, {
                        user: BBUser,
                        tournamentData: TournamentData,
                    });
                }
            }
            catch (err) {
                console.error(`error while getting ${BBUser.Username} data:`, err);
                continue;
            }
        }
        const TeamScoreMap = new Map();
        let LastRoundNumber = 0;
        for (const MatchDoc of AllMatches) {
            if (MatchDoc.roundid > LastRoundNumber) {
                LastRoundNumber = MatchDoc.roundid;
            }
        }
        const LastRoundMatches = AllMatches.filter((m) => m.roundid === LastRoundNumber);
        const AllLastRoundClosed = LastRoundMatches.every((m) => m.status === Config_1.TournamentMatchStatus.Closed || m.status === Config_1.TournamentMatchStatus.GameFinished);
        for (const MatchDoc of AllMatches) {
            if (!MatchDoc.users || MatchDoc.users.length === 0)
                continue;
            const TeamMap = new Map();
            for (const User of MatchDoc.users) {
                const TeamId = User["@team-id"];
                if (!TeamId)
                    continue;
                if (!TeamMap.has(TeamId)) {
                    TeamMap.set(TeamId, []);
                }
                TeamMap.get(TeamId).push(User);
            }
            for (const [TeamId, TeamUsers] of TeamMap.entries()) {
                if (TeamUsers.length === 0)
                    continue;
                const TeamUserIds = TeamUsers
                    .map((TeamUser) => String(TeamUser["@user-id"] || ""))
                    .filter(Boolean)
                    .sort();
                if (TeamUserIds.length === 0)
                    continue;
                const PartyLeaderUserId = TeamUserIds[0];
                // A equipe do torneio pode ser formada automaticamente por jogadores
                // avulsos de parties diferentes. A composição da match é a identidade
                // estável do grupo para o placar, não o InviteId de um único jogador.
                const PartyId = TeamUserIds.join("|");
                if (!TeamScoreMap.has(PartyId)) {
                    const SortedUsers = [...TeamUsers].sort((a, b) => {
                        const aUserId = a["@user-id"];
                        const bUserId = b["@user-id"];
                        const aIsLeader = aUserId === PartyLeaderUserId;
                        const bIsLeader = bUserId === PartyLeaderUserId;
                        if (aIsLeader !== bIsLeader) {
                            return aIsLeader ? -1 : 1;
                        }
                        return aUserId.localeCompare(bUserId);
                    });
                    TeamScoreMap.set(PartyId, {
                        partyid: PartyId,
                        phaseid: ActualPhaseId,
                        groupid: GroupId,
                        checkin: false,
                        position: 0,
                        totalpoints: 0,
                        matchwins: 0,
                        matchloses: 0,
                        gamewins: 0,
                        gameloses: 0,
                        stat1sum: 0,
                        stat2sum: 0,
                        loseweight: 0,
                        totalrounds: 0,
                        seed: 0,
                        users: SortedUsers.map((u) => ({
                            "@user-id": u["@user-id"],
                            "@status": "1",
                            "@checked-in": u["@checked-in"],
                            "@is-party-leader": u["@user-id"] === PartyLeaderUserId ? "1" : "0",
                            "@nick": u["@nick"],
                        })),
                    });
                }
                const ScoreEntry = TeamScoreMap.get(PartyId);
                const IsCheckedIn = TeamUsers.some((u) => u["@checked-in"] === "1");
                if (IsCheckedIn) {
                    ScoreEntry.checkin = true;
                }
                if (MatchDoc.status === Config_1.TournamentMatchStatus.Closed ||
                    MatchDoc.status === Config_1.TournamentMatchStatus.GameFinished) {
                    const IsWinner = TeamUsers.some((u) => u["@match-winner"] === "1");
                    if (IsWinner) {
                        ScoreEntry.checkin = true;
                    }
                    ScoreEntry.totalrounds += 1;
                    let IsWinnerFinal = TeamUsers.some((u) => u["@match-winner"] === "1");
                    if (!IsWinnerFinal) {
                        for (const TeamUser of TeamUsers) {
                            const UserId = TeamUser["@user-id"];
                            const UserData = UserMap.get(UserId);
                            if (UserData && UserData.tournamentData.UserMatches) {
                                const UserMatch = UserData.tournamentData.UserMatches.find((um) => um.id === MatchDoc.id);
                                if (UserMatch && UserMatch.users) {
                                    const MatchUser = UserMatch.users.find((u) => u["@user-id"] === UserId);
                                    if (MatchUser && MatchUser["@match-winner"] === "1") {
                                        IsWinnerFinal = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    const TeamScore = parseInt(TeamUsers[0]["@team-score"] || "0");
                    const UserScore = parseInt(TeamUsers[0]["@user-score"] || "0");
                    const ActualScore = Math.max(TeamScore, UserScore);
                    const MatchPoints = parseInt(TeamUsers[0]["@match-points"] || "0");
                    if (IsWinnerFinal) {
                        ScoreEntry.matchwins += 1;
                        ScoreEntry.totalpoints += MatchPoints > 0 ? MatchPoints : 1;
                        ScoreEntry.gamewins += ActualScore > 0 ? ActualScore : 1;
                    }
                    else {
                        ScoreEntry.matchloses += 1;
                        let OpponentScore = 0;
                        for (const [OtherTeamId, OtherTeamUsers] of TeamMap.entries()) {
                            if (OtherTeamId !== TeamId) {
                                const OtherIsWinner = OtherTeamUsers.some((u) => u["@match-winner"] === "1");
                                if (OtherIsWinner) {
                                    const OtherTeamScore = parseInt(OtherTeamUsers[0]["@team-score"] || "0");
                                    const OtherUserScore = parseInt(OtherTeamUsers[0]["@user-score"] || "0");
                                    OpponentScore = Math.max(OtherTeamScore, OtherUserScore);
                                    break;
                                }
                            }
                        }
                        ScoreEntry.gameloses += OpponentScore > 0 ? OpponentScore : 1;
                        ScoreEntry.loseweight += ScoreEntry.totalrounds;
                    }
                }
            }
        }
        // Mostra também inscritos que ainda não possuem partida fechada. Isso é
        // necessário para o grupo aparecer logo após a inscrição.
        for (const [UserId, UserData] of UserMap.entries()) {
            if (!UserData.tournamentData?.SignedUp)
                continue;
            const PartyId = UserData.tournamentData.InviteId?.toString() || UserId;
            if (TeamScoreMap.has(PartyId))
                continue;
            const members = Array.isArray(UserData.tournamentData.PartyMembers) && UserData.tournamentData.PartyMembers.length
                ? UserData.tournamentData.PartyMembers
                : [{ UserId, Username: UserData.user.Username, IsPartyLeader: true }];
            const leader = members.find((member) => member.IsPartyLeader)?.UserId || UserId;
            TeamScoreMap.set(PartyId, {
                partyid: PartyId,
                phaseid: ActualPhaseId,
                groupid: GroupId,
                checkin: false,
                position: 0,
                totalpoints: 0,
                matchwins: 0,
                matchloses: 0,
                gamewins: 0,
                gameloses: 0,
                stat1sum: 0,
                stat2sum: 0,
                loseweight: 0,
                totalrounds: 0,
                seed: 0,
                users: members.map((member) => ({
                    "@user-id": String(member.UserId),
                    "@status": "1",
                    "@checked-in": "0",
                    "@is-party-leader": String(member.UserId) === String(leader) ? "1" : "0",
                    "@nick": member.Username || member.Nickname || member.UserId,
                })),
            });
        }
        const Scores = Array.from(TeamScoreMap.values());
        Scores.sort((a, b) => {
            if (b.totalpoints !== a.totalpoints)
                return b.totalpoints - a.totalpoints;
            if (b.matchwins !== a.matchwins)
                return b.matchwins - a.matchwins;
            if (a.matchloses !== b.matchloses)
                return a.matchloses - b.matchloses;
            if (b.gamewins !== a.gamewins)
                return b.gamewins - a.gamewins;
            if (a.gameloses !== b.gameloses)
                return a.gameloses - b.gameloses;
            if (a.loseweight !== b.loseweight)
                return a.loseweight - b.loseweight;
            return 0;
        });
        for (let i = 0; i < Scores.length; i++) {
            Scores[i].position = i + 1;
        }
        if (IsFinalPhase && AllLastRoundClosed && LastRoundMatches.length > 0) {
            const TopScore = Scores[0];
            if (TopScore && TopScore.matchwins > 0) {
                const Winners = [];
                const WinnerUserIds = new Set();
                for (const User of TopScore.users) {
                    const UserId = User["@user-id"];
                    const UserData = UserMap.get(UserId);
                    if (UserData) {
                        const award = (0, TournamentEconomy_1.ResolveTournamentPrize)(TournamentDoc, 1);
                        Winners.push({ nick: User["@nick"], userId: UserId, rewardType: award.mode, rewardAmount: award.amount, rewardTag: award.tag, rewardExpiresAt: award.expiresAt ? new Date(award.expiresAt) : null });
                        WinnerUserIds.add(UserId);
                        if ((0, TournamentRules_1.GetTournamentFormat)(TournamentDoc).playersPerTeam > 1) {
                            const TournamentData = UserData.tournamentData;
                            if (TournamentData?.PartyMembers && Array.isArray(TournamentData.PartyMembers)) {
                                for (const Member of TournamentData.PartyMembers) {
                                    if (Member.UserId && Member.UserId !== UserId) {
                                        const MemberBBUser = AllBackboneUsers.find((u) => u.UserId === Member.UserId);
                                        if (MemberBBUser && !WinnerUserIds.has(Member.UserId)) {
                                            const memberAward = (0, TournamentEconomy_1.ResolveTournamentPrize)(TournamentDoc, 1);
                                            Winners.push({ nick: MemberBBUser.Username, userId: Member.UserId, rewardType: memberAward.mode, rewardAmount: memberAward.amount, rewardTag: memberAward.tag, rewardExpiresAt: memberAward.expiresAt ? new Date(memberAward.expiresAt) : null });
                                            WinnerUserIds.add(Member.UserId);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if (Winners.length > 0) {
                    try {
                        const FinishUpdate = await Tournament_1.Tournament.updateOne({
                            TournamentId: TournamentIdStr,
                            Status: { $ne: Config_1.TournamentStatus.Finished },
                        }, {
                            $set: {
                                Winners: Winners,
                                Status: Config_1.TournamentStatus.Finished,
                                "Properties.FinishedAt": new Date(),
                            },
                        });
                        if (FinishUpdate.modifiedCount > 0) {
                            const WinnerUpdatePromises = Array.from(WinnerUserIds).map(async (WinnerUserId) => {
                                const winner = AllBackboneUsers.find((u) => u.UserId === WinnerUserId);
                                const nick = String(winner?.Username || WinnerUserId);
                                await (0, TournamentEconomy_1.AwardTournamentPrize)(WinnerUserId, nick, TournamentDoc, 1);
                                await (0, GetMatches_1.AwardTournamentMedal)(WinnerUserId, nick, TournamentIdStr, Boolean(TournamentDoc.CountForLeaderboard ?? TournamentDoc.Properties?.CountForLeaderboard));
                            });
                            await Promise.all(WinnerUpdatePromises);
                        }
                    }
                    catch (err) {
                        console.error("error while setting tour winners:", err);
                    }
                }
            }
        }
        const UpdatePromises = [];
        const ProcessedParties = new Set();
        for (const Score of Scores) {
            if (ProcessedParties.has(Score.partyid))
                continue;
            ProcessedParties.add(Score.partyid);
            const PartyUserIds = new Set();
            for (const User of Score.users) {
                const UserId = User["@user-id"];
                if (!UserId)
                    continue;
                PartyUserIds.add(UserId);
                const UserData = UserMap.get(UserId);
                if (UserData && (0, TournamentRules_1.GetTournamentFormat)(TournamentDoc).playersPerTeam > 1) {
                    const TournamentData = UserData.tournamentData;
                    if (TournamentData?.PartyMembers && Array.isArray(TournamentData.PartyMembers)) {
                        for (const Member of TournamentData.PartyMembers) {
                            if (Member?.UserId) {
                                PartyUserIds.add(Member.UserId);
                            }
                        }
                    }
                }
            }
            for (const UserId of PartyUserIds) {
                UpdatePromises.push(BackboneUser_1.BackboneUser.updateOne({
                    UserId: UserId,
                    [`Tournaments.${TournamentIdStr}.UserPosition.phaseid`]: ActualPhaseId,
                }, {
                    $set: {
                        [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].rankposition`]: Score.position,
                        [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].sameposition`]: 0,
                        [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].totalpoints`]: Score.totalpoints,
                        [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].matchloses`]: Score.matchloses,
                        [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].totalrounds`]: Score.totalrounds,
                    },
                }, {
                    arrayFilters: [{ "pos.phaseid": ActualPhaseId, "pos.groupid": GroupId }],
                }).catch((err) => {
                    return null;
                }));
            }
        }
        if (IsFinalPhase && IsTournamentEnded) {
            const ProcessedFinalPlace = new Set();
            for (const Score of Scores) {
                for (const User of Score.users) {
                    const UserId = User["@user-id"];
                    if (!UserId || ProcessedFinalPlace.has(UserId))
                        continue;
                    const UserData = UserMap.get(UserId);
                    if (UserData) {
                        ProcessedFinalPlace.add(UserId);
                        UpdatePromises.push(BackboneUser_1.BackboneUser.updateOne({ UserId: UserId }, { $set: { [`Tournaments.${TournamentIdStr}.FinalPlace`]: Score.position } }).catch((err) => {
                            return null;
                        }));
                        if ((0, TournamentRules_1.GetTournamentFormat)(TournamentDoc).playersPerTeam > 1) {
                            const TournamentData = UserData.tournamentData;
                            if (TournamentData?.PartyMembers && Array.isArray(TournamentData.PartyMembers)) {
                                const IsLeader = TournamentData.PartyMembers.some((m) => m.IsPartyLeader && m.UserId === UserId);
                                if (IsLeader) {
                                    for (const Member of TournamentData.PartyMembers) {
                                        if (Member?.UserId && Member.UserId !== UserId && !ProcessedFinalPlace.has(Member.UserId)) {
                                            ProcessedFinalPlace.add(Member.UserId);
                                            UpdatePromises.push(BackboneUser_1.BackboneUser.updateOne({ UserId: Member.UserId }, { $set: { [`Tournaments.${TournamentIdStr}.FinalPlace`]: Score.position } }).catch((err) => {
                                                return null;
                                            }));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if (UpdatePromises.length > 0) {
            try {
                await Promise.all(UpdatePromises);
            }
            catch (err) { }
        }
        const TotalCount = Scores.length;
        const PaginatedScores = Scores.slice(Skip, Skip + MaxResults);
        return {
            pagination: {
                totalResultCount: TotalCount,
                maxResults: MaxResults,
                currentPage: Page,
            },
            scores: PaginatedScores,
        };
    }
    catch (err) {
        console.error("Hey, there was an error while fetching GetScores:", err);
        // Nunca deixa o erro derrubar o processo
        return {
            pagination: {
                totalResultCount: 0,
                maxResults: MaxResults,
                currentPage: Page,
            },
            scores: [],
        };
    }
}
//# sourceMappingURL=GetScores.js.map