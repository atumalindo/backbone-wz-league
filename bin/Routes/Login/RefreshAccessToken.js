"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const joi_1 = tslib_1.__importDefault(require("joi"));
const Middleware_1 = require("../../Modules/Middleware");
const LPUser_1 = require("../../Models/LPUser");
const BackboneUser_1 = require("../../Models/BackboneUser");
const Config_1 = require("../../Backbone/Config");
const jsonwebtoken_1 = tslib_1.__importDefault(require("jsonwebtoken"));
const App = (0, express_1.Router)();
const RefreshSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
})
    .unknown(true);
const RefreshBodySchema = joi_1.default
    .object({
    accessToken: joi_1.default.string().required(),
    refreshToken: joi_1.default.string().required(),
    deviceId: joi_1.default.string().required(),
})
    .unknown(true);
App.post("/refreshAccessToken", (0, Middleware_1.ValidateHeaders)(RefreshSchema), (0, Middleware_1.ValidateBody)(RefreshBodySchema), async (req, res) => {
    const LoginProviderUser = await LPUser_1.LPUser.findOne({
        DeviceIdentifier: req.body.deviceId,
        AccessToken: req.body.accessToken,
    });
    if (!LoginProviderUser) {
        return res.status(401).json({});
    }
    const DatabaseUser = await BackboneUser_1.BackboneUser.findOne({ UserId: LoginProviderUser.UserId });
    if (!DatabaseUser) {
        const NewUser = new BackboneUser_1.BackboneUser({
            Username: LoginProviderUser.Nickname,
            UserId: LoginProviderUser.UserId,
            Tournaments: {},
        });
        await NewUser.save();
    }
    const Payload = {
        userid: LoginProviderUser.UserId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    };
    const RefreshPayload = {
        userid: LoginProviderUser.UserId,
        iat: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        exp: Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60,
    };
    LoginProviderUser.AccessToken = jsonwebtoken_1.default.sign(Payload, Config_1.JWT_SECRET);
    LoginProviderUser.ExpireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    LoginProviderUser.RefreshToken = jsonwebtoken_1.default.sign(RefreshPayload, Config_1.JWT_SECRET);
    await LoginProviderUser.save();
    return res.status(200).json({
        accessToken: LoginProviderUser.AccessToken.toString(),
        expireAt: LoginProviderUser.ExpireAt,
        refreshToken: LoginProviderUser.RefreshToken.toString(),
    });
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=RefreshAccessToken.js.map