"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const joi_1 = tslib_1.__importDefault(require("joi"));
const Service_1 = require("../../Modules/Service");
const LPUser_1 = require("../../Models/LPUser");
const Matches_1 = require("../../Models/Matches");
const MatchPresence_1 = require("../../Backbone/Logic/MatchPresence");
const Config_1 = require("../../Backbone/Config");
const App = (0, express_1.Router)();
App.use((0, Service_1.ForService)(Service_1.ServiceType.Public));
const HeartbeatSchema = joi_1.default
    .object({
    matchId: joi_1.default.alternatives().try(joi_1.default.string(), joi_1.default.number()).required(),
    accessToken: joi_1.default.string().required(),
})
    .unknown(true);
App.post("/gameSessionHeartbeat", async (req, res) => {
    try {
        const { matchId, accessToken } = req.body || {};
        const body = await HeartbeatSchema.validateAsync({ matchId, accessToken });
        const loginUser = await LPUser_1.LPUser.findOne({ AccessToken: body.accessToken }).lean();
        if (!loginUser)
            return res.status(401).json({});
        const userId = String(loginUser.UserId);
        const requestedMatchId = String(body.matchId).trim();
        let match = await Matches_1.Match.findOne({ id: requestedMatchId }).lean();
        if (!match) {
            // O client antigo às vezes envia `matchid` (número da partida na
            // rodada), que pode se repetir em várias rodadas. Nunca use esse valor
            // sem filtrar partidas terminais, senão o heartbeat renova a presença
            // da partida velha e a partida atual expira por falta de presença.
            const numericMatchId = Number(requestedMatchId);
            if (Number.isFinite(numericMatchId)) {
                match = await Matches_1.Match.findOne({
                    matchid: numericMatchId,
                    status: {
                        $nin: [
                            Config_1.TournamentMatchStatus.Closed,
                            Config_1.TournamentMatchStatus.GameFinished,
                            Config_1.TournamentMatchStatus.MatchFinished,
                        ],
                    },
                })
                    .sort({ roundid: -1, deadline: -1 })
                    .lean();
            }
        }
        if (!match || !match.users.some((user) => String(user["@user-id"]) === userId)) {
            return res.status(404).json({});
        }
        await (0, MatchPresence_1.TouchMatchPresence)(String(match.id), userId, true);
        return res.status(200).json({ ok: true, matchId: String(match.id), serverTime: new Date().toISOString() });
    }
    catch (error) {
        if (error?.isJoi)
            return res.status(400).json({});
        console.error("[gameSessionHeartbeat] failed:", error);
        return res.status(500).json({});
    }
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=SessionHeartbeat.js.map