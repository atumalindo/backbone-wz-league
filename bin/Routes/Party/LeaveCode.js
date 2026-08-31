"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const Config_1 = require("../../Backbone/Config");
const joi_1 = tslib_1.__importDefault(require("joi"));
const Middleware_1 = require("../../Modules/Middleware");
const LPUser_1 = require("../../Models/LPUser");
const BackboneUser_1 = require("../../Models/BackboneUser");
const Tournament_1 = require("../../Models/Tournament");
const App = (0, express_1.Router)();
const LeaveCodeSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
    access_token: joi_1.default.string().required(),
})
    .unknown(true);
const LeaveBodySchema = joi_1.default
    .object({
    tournamentId: joi_1.default.number().required(),
    removeUserId: joi_1.default.string().required(),
    accessToken: joi_1.default.string().required(),
})
    .unknown(true);
App.post("/tournamentPartyRemoveUser", (0, Middleware_1.ValidateHeaders)(LeaveCodeSchema), (0, Middleware_1.ValidateBody)(LeaveBodySchema), async (req, res) => {
    try {
        const { accessToken, tournamentId, removeUserId } = req.body;
        const LoginProviderUser = await LPUser_1.LPUser.findOne({ AccessToken: accessToken });
        const DatabaseTournament = await Tournament_1.Tournament.findOne({ TournamentId: tournamentId });
        if (!LoginProviderUser || !DatabaseTournament) {
            return res.json({
                status: Config_1.TournamentAcceptPartyStatus.InviteNotExits,
                tournamentId,
            });
        }
        if (new Date() >= new Date(DatabaseTournament.StartTime)) {
            return res.json({
                status: Config_1.TournamentCreatePartyCodeStatus.NotAttempted,
                tournamentId,
            });
        }
        const DatabaseUser = await BackboneUser_1.BackboneUser.findOne({ UserId: LoginProviderUser.UserId });
        if (!DatabaseUser) {
            return res.json({
                status: Config_1.TournamentCreatePartyCodeStatus.Unknown,
                tournamentId,
            });
        }
        const TournamentInfo = await DatabaseUser.Tournaments.get(DatabaseTournament.TournamentId.toString());
        if (!TournamentInfo) {
            return res.json({
                status: Config_1.TournamentCreatePartyCodeStatus.Unknown,
                tournamentId,
            });
        }
        if (DatabaseUser.UserId == removeUserId.toString()) {
            const isLeader = TournamentInfo.PartyMembers.length > 0 &&
                TournamentInfo.PartyMembers.find((l) => l.IsPartyLeader === true)?.UserId === DatabaseUser.UserId;
            if (isLeader) {
                for (const Member of TournamentInfo.PartyMembers) {
                    const RefreshedUser = await BackboneUser_1.BackboneUser.findOne({ UserId: Member.UserId });
                    if (RefreshedUser) {
                        const RefreshedTournamentInfo = await RefreshedUser.Tournaments.get(DatabaseTournament.TournamentId.toString());
                        if (RefreshedTournamentInfo) {
                            RefreshedTournamentInfo.PartyCode = "";
                            RefreshedTournamentInfo.PartyMembers = [
                                {
                                    UserId: RefreshedUser.UserId,
                                    Username: RefreshedUser.Username,
                                    Status: 1,
                                    IsPartyLeader: true,
                                    IsKicked: false,
                                },
                            ];
                            await RefreshedUser.save();
                        }
                    }
                }
            }
            else {
                for (const Member of TournamentInfo.PartyMembers) {
                    const RefreshedUser = await BackboneUser_1.BackboneUser.findOne({ UserId: Member.UserId });
                    if (RefreshedUser) {
                        const RefreshedTournamentInfo = await RefreshedUser.Tournaments.get(DatabaseTournament.TournamentId.toString());
                        if (RefreshedTournamentInfo) {
                            RefreshedTournamentInfo.PartyMembers = RefreshedTournamentInfo.PartyMembers.filter((me) => me.UserId !== removeUserId);
                            if (RefreshedUser.UserId === removeUserId) {
                                RefreshedTournamentInfo.PartyCode = "";
                                RefreshedTournamentInfo.PartyMembers = [
                                    {
                                        UserId: RefreshedUser.UserId,
                                        Username: RefreshedUser.Username,
                                        Status: 1,
                                        IsPartyLeader: true,
                                        IsKicked: false,
                                    },
                                ];
                            }
                            await RefreshedUser.save();
                        }
                    }
                }
            }
            return res.json({
                status: Config_1.TournamentCreatePartyCodeStatus.Ok,
                tournamentId,
            });
        }
        else {
            const isLeader = TournamentInfo.PartyMembers.find((l) => l.IsPartyLeader === true)?.UserId === DatabaseUser.UserId;
            if (!isLeader) {
                return res.json({
                    status: Config_1.TournamentCreatePartyCodeStatus.Unknown,
                    tournamentId,
                });
            }
            for (const Member of TournamentInfo.PartyMembers) {
                const RefreshedUser = await BackboneUser_1.BackboneUser.findOne({ UserId: Member.UserId });
                if (RefreshedUser) {
                    const RefreshedTournamentInfo = await RefreshedUser.Tournaments.get(DatabaseTournament.TournamentId.toString());
                    if (RefreshedTournamentInfo) {
                        RefreshedTournamentInfo.PartyMembers = RefreshedTournamentInfo.PartyMembers.filter((me) => me.UserId !== removeUserId);
                        if (RefreshedUser.UserId === removeUserId) {
                            RefreshedTournamentInfo.PartyCode = "";
                            RefreshedTournamentInfo.PartyMembers = [
                                {
                                    UserId: RefreshedUser.UserId,
                                    Username: RefreshedUser.Username,
                                    Status: 1,
                                    IsPartyLeader: true,
                                    IsKicked: false,
                                },
                            ];
                        }
                        await RefreshedUser.save();
                    }
                }
            }
            return res.json({
                status: Config_1.TournamentCreatePartyCodeStatus.Ok,
                tournamentId,
            });
        }
    }
    catch {
        return res.json({
            status: Config_1.TournamentCreatePartyCodeStatus.Unknown,
            tournamentId: req.body?.tournamentId ?? "",
        });
    }
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=LeaveCode.js.map