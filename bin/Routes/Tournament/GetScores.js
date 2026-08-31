"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const joi_1 = tslib_1.__importDefault(require("joi"));
const Middleware_1 = require("../../Modules/Middleware");
const GetScores_1 = require("../../Backbone/Logic/GetScores");
const App = (0, express_1.Router)();
const GetScoresSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
    access_token: joi_1.default.string().required(),
})
    .unknown(true);
const GetScoresBodySchema = joi_1.default
    .object({
    tournamentId: joi_1.default.number().required(),
    phaseId: joi_1.default.number().required(),
    groupId: joi_1.default.number().required(),
    maxResults: joi_1.default.number().required(),
    page: joi_1.default.number().required(),
    accessToken: joi_1.default.string().required(),
})
    .unknown(true);
App.post("/tournamentGetScores", (0, Middleware_1.ValidateHeaders)(GetScoresSchema), (0, Middleware_1.ValidateBody)(GetScoresBodySchema), async (req, res) => {
    const Data = await (0, GetScores_1.GetScores)(req.body.tournamentId.toString(), req.body.phaseId, req.body.groupId, req.body.maxResults, req.body.page);
    res.json(Data).status(200);
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=GetScores.js.map