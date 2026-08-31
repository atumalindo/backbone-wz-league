"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const joi_1 = tslib_1.__importDefault(require("joi"));
const Middleware_1 = require("../../Modules/Middleware");
const TournamentData_1 = require("../../Backbone/Logic/TournamentData");
const App = (0, express_1.Router)();
const TournamentDataSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
    access_token: joi_1.default.string().required(),
})
    .unknown(true);
const GetDataBodySchema = joi_1.default
    .object({
    tournamentId: joi_1.default.number().required(),
    getAllData: joi_1.default.number().required().valid(0, 1),
    readyForNextMatch: joi_1.default.number().required().valid(0, 1),
    accessToken: joi_1.default.string().required(),
})
    .unknown(true);
App.post("/tournamentGetData", (0, Middleware_1.ValidateHeaders)(TournamentDataSchema), (0, Middleware_1.ValidateBody)(GetDataBodySchema), async (req, res) => {
    try {
        const Data = await (0, TournamentData_1.TournamentGetData)(req.body.tournamentId, req.body.getAllData, req.body.readyForNextMatch, req.body.accessToken);
        res.status(200).json(Data);
    }
    catch (error) {
        // Sem isso, qualquer erro dentro de TournamentGetData (ex: durante a
        // criação da primeira partida do torneio) deixava a requisição do
        // client SEM RESPOSTA — a tela de "carregando próxima partida" ficava
        // presa para sempre, pois o Express 4 não captura rejeições de
        // handlers async automaticamente.
        console.error("Error fetching tournament data :( || ", error);
        res.status(500).json({ message: "" });
    }
});
exports.default = {
    App,
    DefaultAPI: "/api/v2",
};
//# sourceMappingURL=GetData.js.map