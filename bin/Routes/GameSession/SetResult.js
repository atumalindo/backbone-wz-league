"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const Service_1 = require("../../Modules/Service");
const BackboneUser_1 = require("../../Models/BackboneUser");
const fast_xml_parser_1 = require("fast-xml-parser");
const Tournament_1 = require("../../Models/Tournament");
const Config_1 = require("../../Backbone/Config");
const Matches_1 = require("../../Models/Matches");
const GetMatches_1 = require("../../Backbone/Logic/GetMatches");
const TournamentRules_1 = require("../../Backbone/Logic/TournamentRules");
const GetMatches_2 = require("../../Backbone/Logic/GetMatches");
const TournamentEconomy_1 = require("../../Backbone/Logic/TournamentEconomy");
const App = (0, express_1.Router)();
App.use((0, Service_1.ForService)(Service_1.ServiceType.Public));
App.post("/gameSessionSetResult", async (Req, Res) => {
    try {
        const { gameSessionId, gameSessionData, accessToken } = Req.body;
        if (!gameSessionId || !accessToken || !gameSessionData) {
            return Res.status(400).json({});
        }
        let DecodedXML;
        try {
            DecodedXML = Buffer.from(gameSessionData, "base64").toString("utf-8");
            if (!DecodedXML.trim().startsWith("<")) {
                DecodedXML = decodeURIComponent(gameSessionData);
            }
        }
        catch {
            return Res.status(400).json({});
        }
        const Parser = new fast_xml_parser_1.XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "",
            parseAttributeValue: true,
        });
        const ParsedXML = Parser.parse(DecodedXML);
        if (!ParsedXML?.data?.["game-session"]) {
            return Res.status(400).json({});
        }
        const ResultData = Array.isArray(ParsedXML.data["game-session"])
            ? ParsedXML.data["game-session"][0]
            : ParsedXML.data["game-session"];
        let Users = ResultData.user || [];
        if (!Array.isArray(Users)) {
            Users = [Users];
        }
        const RawMatchId = ResultData["tournament-match-id"];
        const MatchId = String(RawMatchId && typeof RawMatchId === "object"
            ? RawMatchId["#text"] ?? RawMatchId.value ?? RawMatchId.id ?? RawMatchId["@id"] ?? ""
            : RawMatchId ?? "").trim();
        const NumericMatchId = Number(MatchId);
        let FoundMatch = await Matches_1.Match.findOne({ id: MatchId });
        if (!FoundMatch && Number.isFinite(NumericMatchId)) {
            // Mesmo problema do gameSessionCreate: "matchid" reinicia a cada rodada,
            // então não pode ser usado sozinho pra achar a partida — senão o
            // resultado de uma partida podia acabar sendo gravado na partida ERRADA
            // (ex: uma antiga já fechada, ou de outra rodada com o mesmo número).
            FoundMatch = await Matches_1.Match.findOne({
                matchid: NumericMatchId,
                status: {
                    $nin: [
                        Config_1.TournamentMatchStatus.Closed,
                        Config_1.TournamentMatchStatus.GameFinished,
                        Config_1.TournamentMatchStatus.MatchFinished,
                    ],
                },
            }).sort({ roundid: -1, deadline: -1 });
        }
        if (!FoundMatch) {
            return Res.status(404).json({});
        }
        const PersistedMatchId = String(FoundMatch.id);
        if (FoundMatch.status !== Config_1.TournamentMatchStatus.GameInProgress) {
            return Res.status(200).json({});
        }
        const DatabaseTournament = await Tournament_1.Tournament.findOne({
            TournamentId: FoundMatch.tournamentid,
        });
        if (!DatabaseTournament) {
            return Res.status(404).json({});
        }
        const UserResults = [];
        for (let I = 0; I < Users.length; I++) {
            const User = Users[I];
            const UserId = User["user-id"].toString();
            const Place = User.place ? User.place.toString() : (I + 1).toString();
            const TeamId = User["team-id"].toString();
            UserResults.push({
                UserId: UserId,
                TeamId: TeamId,
                Place: Place,
            });
        }
        const InvalidUsers = UserResults.filter((Result) => !FoundMatch.users.some((MatchUser) => MatchUser["@user-id"].toString() === Result.UserId));
        if (InvalidUsers.length > 0) {
            return Res.status(400).json({});
        }
        const TeamPlacements = new Map();
        for (const Result of UserResults) {
            const CurrentPlace = TeamPlacements.get(Result.TeamId);
            const Place = parseInt(Result.Place);
            if (!CurrentPlace || Place < CurrentPlace) {
                TeamPlacements.set(Result.TeamId, Place);
            }
        }
        const SortedTeams = Array.from(TeamPlacements.entries())
            .sort((A, B) => A[1] - B[1])
            .map(([TeamId, Place]) => ({ TeamId, Place }));
        const NumTeams = SortedTeams.length;
        const NextRoundMatches = await Matches_1.Match.find({
            tournamentid: FoundMatch.tournamentid,
            phaseid: FoundMatch.phaseid,
            roundid: FoundMatch.roundid + 1,
            groupid: FoundMatch.groupid,
        });
        const IsLastRound = NextRoundMatches.length === 0;
        const TeamsPerMatch = (0, TournamentRules_1.GetTournamentFormat)(DatabaseTournament).maxTeamsPerMatch;
        const QualifyingTeamCount = (0, TournamentRules_1.GetQualificationCount)(DatabaseTournament, IsLastRound);
        const WinningTeamIds = new Set(SortedTeams.slice(0, QualifyingTeamCount).map((T) => T.TeamId));
        const TeamPoints = new Map();
        for (let I = 0; I < SortedTeams.length; I++) {
            const Team = SortedTeams[I];
            const Points = NumTeams - I;
            TeamPoints.set(Team.TeamId, Points);
        }
        for (const MatchUser of FoundMatch.users) {
            const TeamId = MatchUser["@team-id"];
            const IsWinner = WinningTeamIds.has(TeamId);
            const TeamPoint = TeamPoints.get(TeamId) || 0;
            MatchUser["@match-winner"] = IsWinner ? "1" : "0";
            MatchUser["@match-points"] = IsWinner ? "1" : "0";
            MatchUser["@team-score"] = TeamPoint.toString();
        }
        const UpdateResult = await Matches_1.Match.updateOne({ id: PersistedMatchId, status: Config_1.TournamentMatchStatus.GameInProgress }, { $set: { status: Config_1.TournamentMatchStatus.GameFinished, users: FoundMatch.users }, $inc: { stateVersion: 1 } });
        if (UpdateResult.modifiedCount === 0) {
            // Outra requisição já fechou a match; ela ou o worker de resolução é o
            // responsável por concluir a qualificação. Não reprocessa o resultado.
            return Res.status(200).json({});
        }
        const AllMatchUserIds = FoundMatch.users.map((U) => U["@user-id"]);
        const AllMatchUsers = await BackboneUser_1.BackboneUser.find({ UserId: { $in: AllMatchUserIds } });
        const WinningUserIds = FoundMatch.users.filter((U) => WinningTeamIds.has(U["@team-id"])).map((U) => U["@user-id"]);
        const WinningUsers = AllMatchUsers.filter((U) => WinningUserIds.includes(U.UserId));
        if (WinningUsers.length > 0) {
            for (const Winner of WinningUsers) {
                await (0, GetMatches_1.Qualify)(Winner, DatabaseTournament);
            }
        }
        // Se era a última rodada da última fase, garante Finished + Winners agora
        if (IsLastRound) {
            try {
                const phaseId = FoundMatch.phaseid || 1;
                const isLastPhase = phaseId >= (DatabaseTournament.Phases?.length || 1);
                if (isLastPhase) {
                    const winnerPayload = WinningUsers.map((U) => {
                        const nick = String(U.Username || U.Nickname || U.UserId);
                        const award = (0, TournamentEconomy_1.ResolveTournamentPrize)(DatabaseTournament, 1);
                        return { nick, userId: String(U.UserId), rewardType: award.mode, rewardAmount: award.amount, rewardTag: award.tag, rewardExpiresAt: award.expiresAt ? new Date(award.expiresAt) : null };
                    });
                    if (winnerPayload.length > 0) {
                        const tid = DatabaseTournament.TournamentId;
                        await Tournament_1.Tournament.updateOne({ TournamentId: String(tid), Status: { $ne: Config_1.TournamentStatus.Finished } }, {
                            $set: {
                                Winners: winnerPayload,
                                Status: Config_1.TournamentStatus.Finished,
                                "Properties.FinishedAt": new Date(),
                            },
                        });
                        await Promise.all(WinningUsers.map(async (winner) => {
                            const nick = String(winner.Username || winner.Nickname || winner.UserId);
                            await (0, TournamentEconomy_1.AwardTournamentPrize)(String(winner.UserId), nick, DatabaseTournament, 1);
                            await (0, GetMatches_2.AwardTournamentMedal)(String(winner.UserId), nick, String(tid), Boolean(DatabaseTournament.CountForLeaderboard ?? DatabaseTournament.Properties?.CountForLeaderboard));
                        }));
                        console.log(`[SetResult] FORCE FINISH tournament=${tid} winners=${winnerPayload.map((w) => w.nick).join(",")}`);
                    }
                }
            }
            catch (e) {
                console.error("[SetResult] force finish failed:", e);
            }
        }
        return Res.status(200).json({});
    }
    catch (Err) {
        console.log(Err);
        return Res.status(500).json({});
    }
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=SetResult.js.map