"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const crypto_1 = tslib_1.__importDefault(require("crypto"));
const joi_1 = tslib_1.__importDefault(require("joi"));
const Middleware_1 = require("../../Modules/Middleware");
const Matches_1 = require("../../Models/Matches");
const Tournament_1 = require("../../Models/Tournament");
const LPUser_1 = require("../../Models/LPUser");
const SpectatorSessions_1 = require("../../Models/SpectatorSessions");
const Config_1 = require("../../Backbone/Config");
const App = (0, express_1.Router)();
const PresenceFreshnessMs = 45_000;
const SpectatorSessionTtlMs = 15 * 60_000;
const SpectatorHeadersSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().optional(),
    "x-unity-version": joi_1.default.string().optional(),
    access_token: joi_1.default.string().optional(),
})
    .unknown(true);
const SpectatorBodySchema = joi_1.default
    .object({
    tournamentId: joi_1.default.alternatives().try(joi_1.default.number(), joi_1.default.string()).required(),
    phaseId: joi_1.default.alternatives().try(joi_1.default.number(), joi_1.default.string()).optional(),
    roundId: joi_1.default.alternatives().try(joi_1.default.number(), joi_1.default.string()).optional(),
    matchId: joi_1.default.alternatives().try(joi_1.default.number(), joi_1.default.string()).required(),
    join: joi_1.default.boolean().optional().default(false),
    accessToken: joi_1.default.string().optional(),
})
    .unknown(true);
const SpectatorHeartbeatSchema = joi_1.default
    .object({
    watchToken: joi_1.default.string().min(32).required(),
})
    .unknown(true);
const SpectatorLeaveSchema = joi_1.default
    .object({
    watchToken: joi_1.default.string().min(32).required(),
})
    .unknown(true);
function statusName(status) {
    switch (status) {
        case Config_1.TournamentMatchStatus.Created:
            return "created";
        case Config_1.TournamentMatchStatus.WaitingForOpponent:
            return "waiting";
        case Config_1.TournamentMatchStatus.GameReady:
            return "ready";
        case Config_1.TournamentMatchStatus.GameInProgress:
            return "in_progress";
        case Config_1.TournamentMatchStatus.GameFinished:
            return "finished";
        case Config_1.TournamentMatchStatus.MatchFinished:
            return "finished";
        case Config_1.TournamentMatchStatus.Closed:
            return "closed";
        default:
            return "unknown";
    }
}
function isFreshPresence(lastSeenAt) {
    if (!lastSeenAt)
        return false;
    const timestamp = new Date(lastSeenAt).getTime();
    return Number.isFinite(timestamp) && Date.now() - timestamp <= PresenceFreshnessMs;
}
function phaseTypeName(tournament, phaseId) {
    const phase = tournament?.Phases?.[Math.max(0, phaseId - 1)];
    const value = Number(phase?.PhaseType);
    return Config_1.TournamentPhaseType[value] || "SingleEliminationBracket";
}
function hashWatchToken(token) {
    return crypto_1.default.createHash("sha256").update(token).digest("hex");
}
function newWatchToken() {
    return crypto_1.default.randomBytes(32).toString("base64url");
}
async function findMatch(body) {
    const tournamentId = String(body.tournamentId);
    const phaseId = Number(body.phaseId || 0);
    const roundId = Number(body.roundId || 0);
    const rawMatchId = String(body.matchId).trim();
    if (!rawMatchId)
        return null;
    const exact = await Matches_1.Match.findOne({
        id: rawMatchId,
        tournamentid: tournamentId,
        ...(phaseId > 0 ? { phaseid: phaseId } : {}),
        ...(roundId > 0 ? { roundid: roundId } : {}),
    }).lean();
    if (exact)
        return exact;
    const numericMatchId = Number(rawMatchId);
    if (!Number.isFinite(numericMatchId))
        return null;
    return Matches_1.Match.findOne({
        tournamentid: tournamentId,
        ...(phaseId > 0 ? { phaseid: phaseId } : {}),
        ...(roundId > 0 ? { roundid: roundId } : {}),
        matchid: numericMatchId,
    })
        .sort({ roundid: -1, deadline: -1 })
        .lean();
}
function formatMatch(match, tournament, session) {
    const presenceByUser = new Map();
    for (const presence of match.presence || []) {
        presenceByUser.set(String(presence.userId), presence);
    }
    const teams = new Map();
    for (const user of match.users || []) {
        const teamId = String(user["@team-id"] || "?");
        if (!teams.has(teamId)) {
            teams.set(teamId, {
                teamId,
                checkedIn: false,
                connected: false,
                players: [],
            });
        }
        const team = teams.get(teamId);
        const presence = presenceByUser.get(String(user["@user-id"]));
        const connected = Boolean(presence?.connected && isFreshPresence(presence.lastSeenAt));
        team.checkedIn = team.checkedIn || user["@checked-in"] === "1";
        team.connected = team.connected || connected;
        team.players.push({
            userId: String(user["@user-id"]),
            nick: String(user["@nick"] || user["@user-id"]),
            checkedIn: user["@checked-in"] === "1",
            connected,
            winner: user["@match-winner"] === "1",
            score: Number(user["@team-score"] || 0),
        });
    }
    const status = Number(match.status);
    const state = statusName(status);
    const watchable = status === Config_1.TournamentMatchStatus.Created ||
        status === Config_1.TournamentMatchStatus.WaitingForOpponent ||
        status === Config_1.TournamentMatchStatus.GameReady ||
        status === Config_1.TournamentMatchStatus.GameInProgress;
    const response = {
        id: String(match.id),
        tournamentId: String(match.tournamentid),
        phaseId: Number(match.phaseid),
        phaseType: phaseTypeName(tournament, Number(match.phaseid)),
        groupId: Number(match.groupid),
        roundId: Number(match.roundid),
        matchId: Number(match.matchid),
        status,
        state,
        deadline: new Date(match.deadline).toISOString(),
        playedGameCount: Number(match.playedgamecount || 0),
        canWatch: watchable,
        isLive: status === Config_1.TournamentMatchStatus.GameInProgress,
        isFinished: status === Config_1.TournamentMatchStatus.GameFinished ||
            status === Config_1.TournamentMatchStatus.MatchFinished ||
            status === Config_1.TournamentMatchStatus.Closed,
        teams: Array.from(teams.values()),
        freshConnectedTeams: Array.from(teams.values()).filter((team) => team.connected).map((team) => team.teamId),
        checkedInTeams: Array.from(teams.values()).filter((team) => team.checkedIn).map((team) => team.teamId),
        spectatorRules: {
            isGhost: true,
            countsAsPlayer: false,
            canSubmitResult: false,
            canCheckIn: false,
            canChangeMatch: false,
            appearsEliminatedLocally: true,
        },
    };
    if (session) {
        response.spectatorSession = {
            tournamentMatchId: String(match.id),
            spectator: true,
            localPlayerEliminated: true,
            submitResult: false,
            watchToken: session.watchToken,
            expiresAt: session.expiresAt.toISOString(),
        };
    }
    return response;
}
async function resolveViewerId(req, body) {
    const accessToken = String(body.accessToken || req.headers.access_token || "").trim();
    if (!accessToken)
        return undefined;
    const account = await LPUser_1.LPUser.findOne({ AccessToken: accessToken }).lean();
    if (!account)
        return undefined;
    return String(account.UserId);
}
App.post("/tournamentSpectator", (0, Middleware_1.ValidateHeaders)(SpectatorHeadersSchema), (0, Middleware_1.ValidateBody)(SpectatorBodySchema), async (req, res) => {
    try {
        const tournament = await Tournament_1.Tournament.findOne({ TournamentId: String(req.body.tournamentId) }).lean();
        if (!tournament)
            return res.status(404).json({ message: "tournament_not_found" });
        const match = await findMatch(req.body);
        if (!match)
            return res.status(404).json({ message: "match_not_found" });
        const join = Boolean(req.body.join);
        if (!join) {
            return res.status(200).json({ spectator: true, mode: "ghost", ...formatMatch(match, tournament) });
        }
        const currentStatus = Number(match.status);
        const watchable = [
            Config_1.TournamentMatchStatus.Created,
            Config_1.TournamentMatchStatus.WaitingForOpponent,
            Config_1.TournamentMatchStatus.GameReady,
            Config_1.TournamentMatchStatus.GameInProgress,
        ].includes(currentStatus);
        if (!watchable)
            return res.status(409).json({ message: "match_not_watchable", state: statusName(currentStatus) });
        const watchToken = newWatchToken();
        const expiresAt = new Date(Date.now() + SpectatorSessionTtlMs);
        const viewerUserId = await resolveViewerId(req, req.body);
        await SpectatorSessions_1.SpectatorSession.create({
            tokenHash: hashWatchToken(watchToken),
            tournamentId: String(match.tournamentid),
            matchId: String(match.id),
            ...(viewerUserId ? { viewerUserId } : {}),
            lastSeenAt: new Date(),
            expiresAt,
        });
        return res.status(200).json({
            spectator: true,
            mode: "ghost",
            ...formatMatch(match, tournament, { watchToken, expiresAt }),
        });
    }
    catch (error) {
        console.error("[spectator] failed:", error);
        return res.status(500).json({ message: "internal_error" });
    }
});
App.post("/tournamentSpectatorHeartbeat", (0, Middleware_1.ValidateBody)(SpectatorHeartbeatSchema), async (req, res) => {
    try {
        const tokenHash = hashWatchToken(String(req.body.watchToken));
        const now = new Date();
        const session = await SpectatorSessions_1.SpectatorSession.findOne({ tokenHash, expiresAt: { $gt: now } }).lean();
        if (!session)
            return res.status(401).json({ message: "spectator_session_expired" });
        const match = await Matches_1.Match.findOne({ id: session.matchId, tournamentid: session.tournamentId }).lean();
        const tournament = await Tournament_1.Tournament.findOne({ TournamentId: session.tournamentId }).lean();
        if (!match || !tournament)
            return res.status(404).json({ message: "match_not_found" });
        const expiresAt = new Date(Date.now() + SpectatorSessionTtlMs);
        await SpectatorSessions_1.SpectatorSession.updateOne({ _id: session._id, expiresAt: { $gt: now } }, { $set: { lastSeenAt: now, expiresAt } });
        const watchToken = String(req.body.watchToken);
        return res.status(200).json({ spectator: true, mode: "ghost", ...formatMatch(match, tournament, { watchToken, expiresAt }) });
    }
    catch (error) {
        console.error("[spectator-heartbeat] failed:", error);
        return res.status(500).json({ message: "internal_error" });
    }
});
App.post("/tournamentSpectatorLeave", (0, Middleware_1.ValidateBody)(SpectatorLeaveSchema), async (req, res) => {
    try {
        await SpectatorSessions_1.SpectatorSession.deleteOne({ tokenHash: hashWatchToken(String(req.body.watchToken)) });
        return res.status(200).json({ ok: true });
    }
    catch (error) {
        console.error("[spectator-leave] failed:", error);
        return res.status(500).json({ message: "internal_error" });
    }
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=Spectator.js.map