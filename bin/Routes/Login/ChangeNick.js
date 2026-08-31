"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const joi_1 = tslib_1.__importDefault(require("joi"));
const Middleware_1 = require("../../Modules/Middleware");
const LPUser_1 = require("../../Models/LPUser");
const BackboneUser_1 = require("../../Models/BackboneUser");
const Logger_1 = require("../../Modules/Logger");
const App = (0, express_1.Router)();
const ChangeNickSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
})
    .unknown(true);
const ChangeNickBodySchema = joi_1.default
    .object({
    accessToken: joi_1.default.string().required(),
    nickName: joi_1.default.string().required(),
})
    .unknown(true);
App.post("/userChangeNick", (0, Middleware_1.ValidateHeaders)(ChangeNickSchema), (0, Middleware_1.ValidateBody)(ChangeNickBodySchema), async (req, res) => {
    const LoginProviderUser = await LPUser_1.LPUser.findOne({
        AccessToken: req.body.accessToken,
    });
    if (!LoginProviderUser) {
        return res.status(401).json({});
    }
    const DatabaseUser = await BackboneUser_1.BackboneUser.findOne({ UserId: LoginProviderUser.UserId });
    if (!DatabaseUser) {
        return res.status(401).json({});
    }
    if (req.body.nickName.toString().length > 32 && req.body.nickName.toString().includes("<size>")) {
        (0, Logger_1.msg)("[Tournament SDK AC Logs]: possible username spoof detected. username: " + req.body.nickName.toString());
        return res.status(401).json({});
    }
    if (LoginProviderUser.Nickname != req.body.nickName.toString()) {
        const newNickname = req.body.nickName.toString();
        const userId = DatabaseUser.UserId;
        LoginProviderUser.Nickname = newNickname;
        DatabaseUser.Username = newNickname;
        DatabaseUser.Tournaments.forEach((tournamentData) => {
            tournamentData.PartyMembers.forEach((member) => {
                if (member.UserId === userId) {
                    member.Username = newNickname;
                }
            });
        });
        await LoginProviderUser.save();
        await DatabaseUser.save();
        await BackboneUser_1.BackboneUser.updateMany({ [`Tournaments.$[].PartyMembers`]: { $elemMatch: { UserId: userId } } }, { $set: { "Tournaments.$[].PartyMembers.$[member].Username": newNickname } }, { arrayFilters: [{ "member.UserId": userId }] });
    }
    return res.status(200).json({
        nickName: req.body.nickName,
    });
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=ChangeNick.js.map