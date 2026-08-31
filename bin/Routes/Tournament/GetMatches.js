"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const joi_1 = tslib_1.__importDefault(require("joi"));
const Middleware_1 = require("../../Modules/Middleware");
const GetMatches_1 = require("../../Backbone/Logic/GetMatches");
const Tournament_1 = require("../../Models/Tournament");
const App = (0, express_1.Router)();
const GetMatchesListSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
    access_token: joi_1.default.string().required(),
})
    .unknown(true);
const GetMatchesBodySchema = joi_1.default
    .object({
    tournamentId: joi_1.default.number().required(),
    phaseId: joi_1.default.number().required(),
    groupId: joi_1.default.number().required(),
    fromRoundId: joi_1.default.number().required(),
    toRoundId: joi_1.default.number().required(),
    maxResults: joi_1.default.number().required(),
    page: joi_1.default.number().required(),
    onlyInProgress: joi_1.default.number().required().valid(0, 1),
    accessToken: joi_1.default.string().required(),
})
    .unknown(true);
App.post("/tournamentGetMatches", (0, Middleware_1.ValidateHeaders)(GetMatchesListSchema), (0, Middleware_1.ValidateBody)(GetMatchesBodySchema), async (req, res) => {
    const { tournamentId, groupId, fromRoundId, toRoundId, maxResults, page } = req.body;
    try {
        const DatabaseTournament = await Tournament_1.Tournament.findOne({ TournamentId: tournamentId });
        if (!DatabaseTournament)
            return res.status(404).json({ message: "" });
        await (0, GetMatches_1.GenerateBracketMatches)(DatabaseTournament);
        const Data = await (0, GetMatches_1.GetTournamentMatches)(DatabaseTournament.TournamentId.toString(), DatabaseTournament.CurrentPhaseId, groupId, fromRoundId, toRoundId, maxResults, page);
        res.status(200).json(Data);
    }
    catch (error) {
        console.error("Error fetching matches :( || ", error);
        res.status(500).json({ message: "" });
    }
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=GetMatches.js.map