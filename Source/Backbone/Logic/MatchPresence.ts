import { Match } from "../../Models/Matches";

export const MATCH_PRESENCE_TTL_MS = 45_000;

export function IsFreshMatchPresence(presence: any, now = Date.now()): boolean {
  if (!presence?.connected || !presence.lastSeenAt) return false;
  const lastSeen = new Date(presence.lastSeenAt).getTime();
  return Number.isFinite(lastSeen) && now - lastSeen <= MATCH_PRESENCE_TTL_MS;
}

export async function TouchMatchPresence(
  matchId: string,
  userId: string,
  sessionStarted = false
): Promise<void> {
  const match = await Match.findOne({ id: String(matchId) });
  if (!match) return;

  const now = new Date();
  const presence = (match.presence || []).find((item: any) => String(item.userId) === String(userId));
  if (presence) {
    presence.lastSeenAt = now;
    presence.connected = true;
    if (sessionStarted && !presence.sessionStartedAt) presence.sessionStartedAt = now;
  } else {
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

export async function MarkMatchPresenceDisconnected(matchId: string, userId: string): Promise<void> {
  await Match.updateOne(
    { id: String(matchId), "presence.userId": String(userId) },
    { $set: { "presence.$.connected": false, "presence.$.lastSeenAt": new Date() } }
  );
}

export function GetFreshConnectedUserIds(match: any, now = Date.now()): Set<string> {
  const ids = new Set<string>();
  for (const presence of match?.presence || []) {
    if (IsFreshMatchPresence(presence, now)) ids.add(String(presence.userId));
  }
  return ids;
}

export function GetFreshConnectedTeamIds(match: any, now = Date.now()): Set<string> {
  const connectedUsers = GetFreshConnectedUserIds(match, now);
  const teams = new Set<string>();
  for (const user of match?.users || []) {
    if (connectedUsers.has(String(user["@user-id"]))) {
      teams.add(String(user["@team-id"]));
    }
  }
  return teams;
}

export function GetSessionStartedTeamIds(match: any): Set<string> {
  const startedUsers = new Set(
    (match?.presence || [])
      .filter((presence: any) => presence?.sessionStartedAt)
      .map((presence: any) => String(presence.userId))
  );
  const teams = new Set<string>();
  for (const user of match?.users || []) {
    if (startedUsers.has(String(user["@user-id"]))) teams.add(String(user["@team-id"]));
  }
  return teams;
}
