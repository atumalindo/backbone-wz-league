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
const LoginSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
})
    .unknown(true);
const LoginBodySchema = joi_1.default
    .object({
    createNewUser: joi_1.default.number().required(),
    userId: joi_1.default.number().required(),
    deviceId: joi_1.default.string().required(),
    deviceName: joi_1.default.string().required(),
    devicePlatform: joi_1.default.number().required(),
    nickName: joi_1.default.string().required(),
    clientToken: joi_1.default.string().required(),
})
    .unknown(true);
App.post("/userLoginExternal", (0, Middleware_1.ValidateHeaders)(LoginSchema), (0, Middleware_1.ValidateBody)(LoginBodySchema), async (req, res) => {
    try {
        const Payload = {
            userid: req.body.userId,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        };
        const RefreshPayload = {
            userid: req.body.userId,
            iat: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
            exp: Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60,
        };
        const ExpireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const AccessToken = jsonwebtoken_1.default.sign(Payload, Config_1.JWT_SECRET);
        const RefreshToken = jsonwebtoken_1.default.sign(RefreshPayload, Config_1.JWT_SECRET);
        const ExistingUserByUserId = await LPUser_1.LPUser.findOne({ UserId: req.body.userId });
        const ExistingUserByDeviceId = await LPUser_1.LPUser.findOne({ DeviceIdentifier: req.body.deviceId });
        if (ExistingUserByUserId) {
            if (ExistingUserByUserId.DeviceIdentifier !== req.body.deviceId) {
                if (ExistingUserByDeviceId && ExistingUserByDeviceId.UserId !== req.body.userId) {
                    await LPUser_1.LPUser.deleteOne({ DeviceIdentifier: req.body.deviceId });
                }
            }
            ExistingUserByUserId.Nickname = req.body.nickName;
            ExistingUserByUserId.DeviceIdentifier = req.body.deviceId;
            ExistingUserByUserId.DeviceName = req.body.deviceName;
            ExistingUserByUserId.DevicePlatform = req.body.devicePlatform;
            ExistingUserByUserId.ClientToken = req.body.clientToken;
            ExistingUserByUserId.AccessToken = AccessToken;
            ExistingUserByUserId.ExpireAt = ExpireAt;
            ExistingUserByUserId.RefreshToken = RefreshToken;
            await ExistingUserByUserId.save();
            const DatabaseUser = await BackboneUser_1.BackboneUser.findOne({ UserId: ExistingUserByUserId.UserId });
            if (DatabaseUser) {
                DatabaseUser.Username = req.body.nickName;
                await DatabaseUser.save();
            }
            return res.status(200).json({
                accessToken: AccessToken,
                expireAt: ExpireAt,
                refreshToken: RefreshToken,
            });
        }
        if (ExistingUserByDeviceId) {
            ExistingUserByDeviceId.UserId = req.body.userId.toString();
            ExistingUserByDeviceId.Nickname = req.body.nickName;
            ExistingUserByDeviceId.DeviceName = req.body.deviceName;
            ExistingUserByDeviceId.DevicePlatform = req.body.devicePlatform;
            ExistingUserByDeviceId.ClientToken = req.body.clientToken;
            ExistingUserByDeviceId.AccessToken = AccessToken;
            ExistingUserByDeviceId.ExpireAt = ExpireAt;
            ExistingUserByDeviceId.RefreshToken = RefreshToken;
            await ExistingUserByDeviceId.save();
            return res.status(200).json({
                accessToken: AccessToken,
                expireAt: ExpireAt,
                refreshToken: RefreshToken,
            });
        }
        if (req.body.createNewUser) {
            const NewUser = new LPUser_1.LPUser({
                Nickname: req.body.nickName,
                UserId: req.body.userId.toString(),
                DeviceIdentifier: req.body.deviceId,
                DeviceName: req.body.deviceName,
                DevicePlatform: req.body.devicePlatform,
                ClientToken: req.body.clientToken,
                AccessToken: AccessToken,
                ExpireAt: ExpireAt,
                RefreshToken: RefreshToken,
            });
            await NewUser.save();
            return res.status(200).json({
                accessToken: AccessToken,
                expireAt: ExpireAt,
                refreshToken: RefreshToken,
            });
        }
        return res.status(401).json({});
    }
    catch (err) {
        return res.status(500).json({});
    }
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=UserLogin.js.map