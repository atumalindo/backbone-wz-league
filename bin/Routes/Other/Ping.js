"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const joi_1 = tslib_1.__importDefault(require("joi"));
const Middleware_1 = require("../../Modules/Middleware");
const App = (0, express_1.Router)();
const PingSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
})
    .unknown(true);
App.get("/ping", (0, Middleware_1.ValidateHeaders)(PingSchema), async (req, res) => {
    return res.json({ message: "pong" }).status(200);
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=Ping.js.map