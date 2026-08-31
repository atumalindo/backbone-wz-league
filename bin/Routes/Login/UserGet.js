"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const joi_1 = tslib_1.__importDefault(require("joi"));
const Middleware_1 = require("../../Modules/Middleware");
const LPUser_1 = require("../../Models/LPUser");
const BackboneUser_1 = require("../../Models/BackboneUser");
const mongodb_1 = require("mongodb");
const App = (0, express_1.Router)();
const UserGetSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
    access_token: joi_1.default.string().required(),
})
    .unknown(true);
const UserBodySchema = joi_1.default
    .object({
    lastUpdate: joi_1.default.date().required(),
    lastSync: joi_1.default.date().required(),
    generateQuests: joi_1.default.number().required(),
    getQuests: joi_1.default.number().required(),
    getTiles: joi_1.default.number().required(),
    getLayouts: joi_1.default.number().required(),
    accessToken: joi_1.default.string().required(),
})
    .unknown(true);
App.post("/userGet", (0, Middleware_1.ValidateHeaders)(UserGetSchema), (0, Middleware_1.ValidateBody)(UserBodySchema), async (req, res) => {
    const User = await LPUser_1.LPUser.findOne({ AccessToken: req.body.accessToken });
    if (!User)
        return res.status(401).json({ message: "unauthorized." });
    const DatabaseBackboneUser = await BackboneUser_1.BackboneUser.findOne({ UserId: User.UserId });
    if (!DatabaseBackboneUser) {
        try {
            const NewUser = new BackboneUser_1.BackboneUser({
                Username: User.Nickname,
                UserId: User.UserId,
                TournamentsWon: 0,
                Tournaments: {},
            });
            await NewUser.save();
        }
        catch (error) {
            if (!(error instanceof mongodb_1.MongoServerError && error.code === 11000)) {
                throw error;
            }
        }
    }
    if (DatabaseBackboneUser && DatabaseBackboneUser.Username != User.Nickname) {
        DatabaseBackboneUser.Username = User.Nickname;
        await DatabaseBackboneUser.save();
    }
    const ScheduleTime = new Date(Date.now() + 67 * 60 * 60 * 1000).toISOString();
    const Response = {
        ban: false,
        createdAt: User._id.getTimestamp().toISOString(),
        csseed: "0",
        psseed: "0",
        currencies: [],
        firstname: null,
        id: User.UserId.toString(),
        lastname: null,
        lastsync: req.body.lastSync || new Date().toISOString(),
        properties: [],
        logins: [
            {
                platformId: User.UserId.toString(),
                platformType: 7,
            },
        ],
        nick: User.Nickname || "",
        nickhashnumber: 1,
        ntfupdatedat: null,
        rank: 0,
        remainingReports: 4,
        reportsResetAt: ScheduleTime,
        season: 1,
        seasonday: 1,
        seasonid: null,
        seasonprogress: 0,
        seasonseedend: ScheduleTime,
        serverutc: new Date().toISOString(),
        tileWallLayouts: [],
        tiles: [],
        urpupdatedat: null,
        usersettingdata: {
            "user-data": {
                "@language": "en",
                properties: null,
            },
        },
        worldrank: 0,
    };
    return res.status(200).json(Response);
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=UserGet.js.map