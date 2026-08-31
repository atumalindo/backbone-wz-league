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
const TournamentRules_1 = require("../../Backbone/Logic/TournamentRules");
const App = (0, express_1.Router)();
const JoinCodeSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
    access_token: joi_1.default.string().required(),
})
    .unknown(true);
const JoinBodySchema = joi_1.default
    .object({
    tournamentId: joi_1.default.number().required(),
    partyCode: joi_1.default.string().required(),
    accessToken: joi_1.default.string().required(),
})
    .unknown(true);
App.post("/tournamentPartyJoinByCode", (0, Middleware_1.ValidateHeaders)(JoinCodeSchema), (0, Middleware_1.ValidateBody)(JoinBodySchema), async (req, res) => {
    const TournamentId = req.body.tournamentId.toString();
    const PartyCode = req.body.partyCode.toString().toUpperCase();
    const AccessToken = req.body.accessToken;
    const [DatabaseTournament, LoginProviderUser] = await Promise.all([
        Tournament_1.Tournament.findOne({ TournamentId }),
        LPUser_1.LPUser.findOne({ AccessToken }),
    ]);
    if (!DatabaseTournament || !LoginProviderUser) {
        return res.status(200).json({
            status: Config_1.TournamentAcceptPartyStatus.UserIsNotSignedUp,
            tournamentId: TournamentId,
        });
    }
    const [DatabaseUser, PartyLeader] = await Promise.all([
        BackboneUser_1.BackboneUser.findOne({ UserId: LoginProviderUser.UserId }),
        BackboneUser_1.BackboneUser.findOne({
            UserId: { $ne: LoginProviderUser.UserId },
            [`Tournaments.${TournamentId}.PartyCode`]: PartyCode,
            [`Tournaments.${TournamentId}.SignedUp`]: true,
        }),
    ]);
    if (!DatabaseUser || !DatabaseUser.Tournaments) {
        return res.status(200).json({
            status: Config_1.TournamentAcceptPartyStatus.UserIsNotSignedUp,
            tournamentId: TournamentId,
        });
    }
    const UserTournamentData = DatabaseUser.Tournaments.get(TournamentId);
    if (!UserTournamentData || !UserTournamentData.SignedUp) {
        return res.status(200).json({
            status: Config_1.TournamentAcceptPartyStatus.UserIsNotSignedUp,
            tournamentId: TournamentId,
        });
    }
    if (UserTournamentData.PartyCode && UserTournamentData.PartyCode !== "") {
        return res.status(200).json({
            status: Config_1.TournamentAcceptPartyStatus.NotAttempted,
            tournamentId: TournamentId,
        });
    }
    if (!PartyLeader) {
        return res.status(200).json({
            status: Config_1.TournamentAcceptPartyStatus.InviteNotExits,
            tournamentId: TournamentId,
        });
    }
    const PartyLeaderTournamentData = PartyLeader.Tournaments.get(TournamentId);
    if (!PartyLeaderTournamentData) {
        return res.status(200).json({
            status: Config_1.TournamentAcceptPartyStatus.InviteNotExits,
            tournamentId: TournamentId,
        });
    }
    const HasPartyLeader = PartyLeaderTournamentData.PartyMembers.some((member) => member.IsPartyLeader);
    if (!HasPartyLeader) {
        return res.status(200).json({
            status: Config_1.TournamentAcceptPartyStatus.PartyNoLongerExits,
            tournamentId: TournamentId,
        });
    }
    const IsAlreadyInParty = PartyLeaderTournamentData.PartyMembers.length > 1 &&
        PartyLeaderTournamentData.PartyMembers.some((member) => member.UserId.toString() === DatabaseUser.UserId.toString());
    if (IsAlreadyInParty) {
        return res.status(200).json({
            status: Config_1.TournamentAcceptPartyStatus.Unknown,
            tournamentId: TournamentId,
        });
    }
    const CurrentPartySize = PartyLeaderTournamentData.PartyMembers.length;
    if (CurrentPartySize >= (0, TournamentRules_1.GetTournamentFormat)(DatabaseTournament).playersPerTeam) {
        return res.status(200).json({
            status: Config_1.TournamentAcceptPartyStatus.PartyIsFull,
            tournamentId: TournamentId,
        });
    }
    const NewMember = {
        UserId: DatabaseUser.UserId,
        Username: DatabaseUser.Username,
        Status: Config_1.TournamentUserStatus.Confirmed,
        IsPartyLeader: false,
        IsKicked: false,
    };
    PartyLeaderTournamentData.PartyMembers.push(NewMember);
    PartyLeader.markModified(`Tournaments.${TournamentId}.PartyMembers`);
    UserTournamentData.PartyCode = PartyCode;
    UserTournamentData.PartyMembers = JSON.parse(JSON.stringify(PartyLeaderTournamentData.PartyMembers));
    DatabaseUser.markModified(`Tournaments.${TournamentId}.PartyMembers`);
    const UpdatedPartyMembers = JSON.parse(JSON.stringify(PartyLeaderTournamentData.PartyMembers));
    const AllPartyMemberIds = UpdatedPartyMembers.map((m) => m.UserId);
    await Promise.all([
        PartyLeader.save(),
        DatabaseUser.save(),
        BackboneUser_1.BackboneUser.updateMany({
            UserId: { $in: AllPartyMemberIds, $nin: [PartyLeader.UserId, DatabaseUser.UserId] },
            [`Tournaments.${TournamentId}`]: { $exists: true },
        }, {
            $set: {
                [`Tournaments.${TournamentId}.PartyMembers`]: UpdatedPartyMembers,
            },
        }),
    ]);
    return res.status(200).json({
        status: Config_1.TournamentAcceptPartyStatus.Ok,
        tournamentId: TournamentId,
    });
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=JoinCode.js.map