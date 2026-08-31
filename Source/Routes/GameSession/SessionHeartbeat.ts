import { Router } from "express";
import j from "joi";
import { ForService, ServiceType } from "../../Modules/Service";
import { LPUser } from "../../Models/LPUser";
import { Match } from "../../Models/Matches";
import { TouchMatchPresence } from "../../Backbone/Logic/MatchPresence";
import { TournamentMatchStatus } from "../../Backbone/Config";

const App = Router();
App.use(ForService(ServiceType.Public));

const HeartbeatSchema = j
  .object({
    matchId: j.alternatives().try(j.string(), j.number()).required(),
    accessToken: j.string().required(),
  })
  .unknown(true);

App.post("/gameSessionHeartbeat", async (req, res) => {
  try {
    const { matchId, accessToken } = req.body || {};
    const body = await HeartbeatSchema.validateAsync({ matchId, accessToken });
    const loginUser = await LPUser.findOne({ AccessToken: body.accessToken }).lean();
    if (!loginUser) return res.status(401).json({});

    const userId = String(loginUser.UserId);
    const requestedMatchId = String(body.matchId).trim();
    let match = await Match.findOne({ id: requestedMatchId }).lean();

    if (!match) {
      // O client antigo às vezes envia `matchid` (número da partida na
      // rodada), que pode se repetir em várias rodadas. Nunca use esse valor
      // sem filtrar partidas terminais, senão o heartbeat renova a presença
      // da partida velha e a partida atual expira por falta de presença.
      const numericMatchId = Number(requestedMatchId);
      if (Number.isFinite(numericMatchId)) {
        match = await Match.findOne({
          matchid: numericMatchId,
          status: {
            $nin: [
              TournamentMatchStatus.Closed,
              TournamentMatchStatus.GameFinished,
              TournamentMatchStatus.MatchFinished,
            ],
          },
        })
          .sort({ roundid: -1, deadline: -1 })
          .lean();
      }
    }

    if (!match || !match.users.some((user: any) => String(user["@user-id"]) === userId)) {
      return res.status(404).json({});
    }

    await TouchMatchPresence(String(match.id), userId, true);
    return res.status(200).json({ ok: true, matchId: String(match.id), serverTime: new Date().toISOString() });
  } catch (error) {
    if ((error as any)?.isJoi) return res.status(400).json({});
    console.error("[gameSessionHeartbeat] failed:", error);
    return res.status(500).json({});
  }
});

export default {
  App,
  DefaultAPI: "/api/v1",
};
