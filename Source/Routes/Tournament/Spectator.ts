import { Router } from "express";
import crypto from "crypto";
import j from "joi";
import { ValidateBody, ValidateHeaders } from "../../Modules/Middleware";
import { Match } from "../../Models/Matches";
import { Tournament } from "../../Models/Tournament";
import { LPUser } from "../../Models/LPUser";
import { SpectatorSession } from "../../Models/SpectatorSessions";
import { TournamentMatchStatus, TournamentPhaseType } from "../../Backbone/Config";

const App = Router();
const PresenceFreshnessMs = 45_000;
const SpectatorSessionTtlMs = 15 * 60_000;

const SpectatorHeadersSchema = j
  .object({
    backbone_app_id: j.string().optional(),
    "x-unity-version": j.string().optional(),
    access_token: j.string().optional(),
  })
  .unknown(true);

const SpectatorBodySchema = j
  .object({
    tournamentId: j.alternatives().try(j.number(), j.string()).required(),
    phaseId: j.alternatives().try(j.number(), j.string()).optional(),
    roundId: j.alternatives().try(j.number(), j.string()).optional(),
    matchId: j.alternatives().try(j.number(), j.string()).required(),
    join: j.boolean().optional().default(false),
    accessToken: j.string().optional(),
  })
  .unknown(true);

const SpectatorHeartbeatSchema = j
  .object({
    watchToken: j.string().min(32).required(),
  })
  .unknown(true);

const SpectatorLeaveSchema = j
  .object({
    watchToken: j.string().min(32).required(),
  })
  .unknown(true);

function statusName(status: number): string {
  switch (status) {
    case TournamentMatchStatus.Created:
      return "created";
    case TournamentMatchStatus.WaitingForOpponent:
      return "waiting";
    case TournamentMatchStatus.GameReady:
      return "ready";
    case TournamentMatchStatus.GameInProgress:
      return "in_progress";
    case TournamentMatchStatus.GameFinished:
      return "finished";
    case TournamentMatchStatus.MatchFinished:
      return "finished";
    case TournamentMatchStatus.Closed:
      return "closed";
    default:
      return "unknown";
  }
}

function isFreshPresence(lastSeenAt: unknown): boolean {
  if (!lastSeenAt) return false;
  const timestamp = new Date(lastSeenAt as any).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= PresenceFreshnessMs;
}

function phaseTypeName(tournament: any, phaseId: number): string {
  const phase = tournament?.Phases?.[Math.max(0, phaseId - 1)];
  const value = Number(phase?.PhaseType);
  return TournamentPhaseType[value] || "SingleEliminationBracket";
}

function hashWatchToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newWatchToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

async function findMatch(body: any): Promise<any | null> {
  const tournamentId = String(body.tournamentId);
  const phaseId = Number(body.phaseId || 0);
  const roundId = Number(body.roundId || 0);
  const rawMatchId = String(body.matchId).trim();

  if (!rawMatchId) return null;

  const exact = await Match.findOne({
    id: rawMatchId,
    tournamentid: tournamentId,
    ...(phaseId > 0 ? { phaseid: phaseId } : {}),
    ...(roundId > 0 ? { roundid: roundId } : {}),
  }).lean();
  if (exact) return exact;

  const numericMatchId = Number(rawMatchId);
  if (!Number.isFinite(numericMatchId)) return null;

  return Match.findOne({
    tournamentid: tournamentId,
    ...(phaseId > 0 ? { phaseid: phaseId } : {}),
    ...(roundId > 0 ? { roundid: roundId } : {}),
    matchid: numericMatchId,
  })
    .sort({ roundid: -1, deadline: -1 })
    .lean();
}

function formatMatch(match: any, tournament: any, session?: { watchToken: string; expiresAt: Date }) {
  const presenceByUser = new Map<string, any>();
  for (const presence of match.presence || []) {
    presenceByUser.set(String(presence.userId), presence);
  }

  const teams = new Map<string, any>();
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
  const watchable =
    status === TournamentMatchStatus.Created ||
    status === TournamentMatchStatus.WaitingForOpponent ||
    status === TournamentMatchStatus.GameReady ||
    status === TournamentMatchStatus.GameInProgress;

  const response: any = {
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
    isLive: status === TournamentMatchStatus.GameInProgress,
    isFinished: status === TournamentMatchStatus.GameFinished ||
      status === TournamentMatchStatus.MatchFinished ||
      status === TournamentMatchStatus.Closed,
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

async function resolveViewerId(req: any, body: any): Promise<string | undefined> {
  const accessToken = String(body.accessToken || req.headers.access_token || "").trim();
  if (!accessToken) return undefined;
  const account = await LPUser.findOne({ AccessToken: accessToken }).lean();
  if (!account) return undefined;
  return String(account.UserId);
}

App.post(
  "/tournamentSpectator",
  ValidateHeaders(SpectatorHeadersSchema),
  ValidateBody(SpectatorBodySchema),
  async (req, res) => {
    try {
      const tournament = await Tournament.findOne({ TournamentId: String(req.body.tournamentId) }).lean();
      if (!tournament) return res.status(404).json({ message: "tournament_not_found" });

      const match = await findMatch(req.body);
      if (!match) return res.status(404).json({ message: "match_not_found" });

      const join = Boolean(req.body.join);
      if (!join) {
        return res.status(200).json({ spectator: true, mode: "ghost", ...formatMatch(match, tournament) });
      }

      const currentStatus = Number(match.status);
      const watchable = [
        TournamentMatchStatus.Created,
        TournamentMatchStatus.WaitingForOpponent,
        TournamentMatchStatus.GameReady,
        TournamentMatchStatus.GameInProgress,
      ].includes(currentStatus);
      if (!watchable) return res.status(409).json({ message: "match_not_watchable", state: statusName(currentStatus) });

      const watchToken = newWatchToken();
      const expiresAt = new Date(Date.now() + SpectatorSessionTtlMs);
      const viewerUserId = await resolveViewerId(req, req.body);
      await SpectatorSession.create({
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
    } catch (error) {
      console.error("[spectator] failed:", error);
      return res.status(500).json({ message: "internal_error" });
    }
  }
);

App.post("/tournamentSpectatorHeartbeat", ValidateBody(SpectatorHeartbeatSchema), async (req, res) => {
  try {
    const tokenHash = hashWatchToken(String(req.body.watchToken));
    const now = new Date();
    const session = await SpectatorSession.findOne({ tokenHash, expiresAt: { $gt: now } }).lean();
    if (!session) return res.status(401).json({ message: "spectator_session_expired" });

    const match = await Match.findOne({ id: session.matchId, tournamentid: session.tournamentId }).lean();
    const tournament = await Tournament.findOne({ TournamentId: session.tournamentId }).lean();
    if (!match || !tournament) return res.status(404).json({ message: "match_not_found" });

    const expiresAt = new Date(Date.now() + SpectatorSessionTtlMs);
    await SpectatorSession.updateOne(
      { _id: session._id, expiresAt: { $gt: now } },
      { $set: { lastSeenAt: now, expiresAt } }
    );

    const watchToken = String(req.body.watchToken);
    return res.status(200).json({ spectator: true, mode: "ghost", ...formatMatch(match, tournament, { watchToken, expiresAt }) });
  } catch (error) {
    console.error("[spectator-heartbeat] failed:", error);
    return res.status(500).json({ message: "internal_error" });
  }
});

App.post("/tournamentSpectatorLeave", ValidateBody(SpectatorLeaveSchema), async (req, res) => {
  try {
    await SpectatorSession.deleteOne({ tokenHash: hashWatchToken(String(req.body.watchToken)) });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[spectator-leave] failed:", error);
    return res.status(500).json({ message: "internal_error" });
  }
});

export default {
  App,
  DefaultAPI: "/api/v1",
};
