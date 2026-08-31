"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MATCH_PRESENCE_TTL_MS = void 0;
exports.IsFreshMatchPresence = IsFreshMatchPresence;
exports.TouchMatchPresence = TouchMatchPresence;
exports.MarkMatchPresenceDisconnected = MarkMatchPresenceDisconnected;
exports.GetFreshConnectedUserIds = GetFreshConnectedUserIds;
exports.GetFreshConnectedTeamIds = GetFreshConnectedTeamIds;
exports.GetSessionStartedTeamIds = GetSessionStartedTeamIds;
const Matches_1 = require("../../Models/Matches");
exports.MATCH_PRESENCE_TTL_MS = 45_000;
function IsFreshMatchPresence(presence, now = Date.now()) {
    if (!presence?.connected || !presence.lastSeenAt)
        return false;
    const lastSeen = new Date(presence.lastSeenAt).getTime();
    return Number.isFinite(lastSeen) && now - lastSeen <= exports.MATCH_PRESENCE_TTL_MS;
}
async function TouchMatchPresence(matchId, userId, sessionStarted = false) {
    const match = await Matches_1.Match.findOne({ id: String(matchId) });
    if (!match)
        return;
    const now = new Date();
    const presence = (match.presence || []).find((item) => String(item.userId) === String(userId));
    if (presence) {
        presence.lastSeenAt = now;
        presence.connected = true;
        if (sessionStarted && !presence.sessionStartedAt)
            presence.sessionStartedAt = now;
    }
    else {
        match.presence = [
            ...(match.presence || []),
            {
                userId: String(userId),
                lastSeenAt: now,
                connected: true,
                ...(sessionStarted ? { sessionStartedAt: now } : {}),
            },
        ];
    }
    await match.save();
}
async function MarkMatchPresenceDisconnected(matchId, userId) {
    await Matches_1.Match.updateOne({ id: String(matchId), "presence.userId": String(userId) }, { $set: { "presence.$.connected": false, "presence.$.lastSeenAt": new Date() } });
}
function GetFreshConnectedUserIds(match, now = Date.now()) {
    const ids = new Set();
    for (const presence of match?.presence || []) {
        if (IsFreshMatchPresence(presence, now))
            ids.add(String(presence.userId));
    }
    return ids;
}
function GetFreshConnectedTeamIds(match, now = Date.now()) {
    const connectedUsers = GetFreshConnectedUserIds(match, now);
    const teams = new Set();
    for (const user of match?.users || []) {
        if (connectedUsers.has(String(user["@user-id"]))) {
            teams.add(String(user["@team-id"]));
        }
    }
    return teams;
}
function GetSessionStartedTeamIds(match) {
    const startedUsers = new Set((match?.presence || [])
        .filter((presence) => presence?.sessionStartedAt)
        .map((presence) => String(presence.userId)));
    const teams = new Set();
    for (const user of match?.users || []) {
        if (startedUsers.has(String(user["@user-id"])))
            teams.add(String(user["@team-id"]));
    }
    return teams;
}
//# sourceMappingURL=MatchPresence.js.map