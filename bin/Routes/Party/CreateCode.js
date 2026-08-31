"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const joi_1 = tslib_1.__importDefault(require("joi"));
const Middleware_1 = require("../../Modules/Middleware");
const LPUser_1 = require("../../Models/LPUser");
const BackboneUser_1 = require("../../Models/BackboneUser");
const Tournament_1 = require("../../Models/Tournament");
const App = (0, express_1.Router)();
const CreateCodeSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
    access_token: joi_1.default.string().required(),
})
    .unknown(true);
const CreateBodySchema = joi_1.default
    .object({
    tournamentId: joi_1.default.number().required(),
    recreate: joi_1.default.number().required().valid(0, 1),
    accessToken: joi_1.default.string().required(),
})
    .unknown(true);
const GeneratePartyCode = async () => {
    const MaxAttempts = 10;
    const Users = await BackboneUser_1.BackboneUser.find({}, { Tournaments: 1 }).lean();
    const ExistingCodes = new Set();
    for (const User of Users) {
        if (!User.Tournaments)
            continue;
        for (const [_, Tournament] of Object.entries(User.Tournaments)) {
            if (Tournament && Tournament.PartyCode) {
                ExistingCodes.add(Tournament.PartyCode);
            }
        }
    }
    for (let Attempt = 0; Attempt < MaxAttempts; Attempt++) {
        const Code = Math.random().toString(36).substr(2, 6).toUpperCase();
        if (!ExistingCodes.has(Code)) {
            return Code;
        }
    }
    throw new Error("Failed to generate a unique party code after 10 attempts.");
};
var TournamentCreatePartyCodeStatus;
(function (TournamentCreatePartyCodeStatus) {
    TournamentCreatePartyCodeStatus[TournamentCreatePartyCodeStatus["Unknown"] = -1] = "Unknown";
    TournamentCreatePartyCodeStatus[TournamentCreatePartyCodeStatus["NotAttempted"] = 0] = "NotAttempted";
    TournamentCreatePartyCodeStatus[TournamentCreatePartyCodeStatus["Ok"] = 1] = "Ok";
    TournamentCreatePartyCodeStatus[TournamentCreatePartyCodeStatus["InvalidTournamentId"] = 2] = "InvalidTournamentId";
})(TournamentCreatePartyCodeStatus || (TournamentCreatePartyCodeStatus = {}));
App.post("/tournamentPartyCreateCode", (0, Middleware_1.ValidateHeaders)(CreateCodeSchema), (0, Middleware_1.ValidateBody)(CreateBodySchema), async (req, res) => {
    const TournamentId = req.body.tournamentId.toString();
    const AccessToken = req.body.accessToken;
    const DatabaseTournament = await Tournament_1.Tournament.findOne({ TournamentId });
    const LoginProviderUser = await LPUser_1.LPUser.findOne({ AccessToken });
    if (!DatabaseTournament || !LoginProviderUser) {
        return res.status(200).json({
            status: TournamentCreatePartyCodeStatus.InvalidTournamentId,
            partyCode: "",
            tournamentId: TournamentId,
        });
    }
    const DatabaseUser = await BackboneUser_1.BackboneUser.findOne({ UserId: LoginProviderUser.UserId });
    if (!DatabaseUser || !DatabaseUser.Tournaments) {
        return res.status(200).json({
            status: TournamentCreatePartyCodeStatus.InvalidTournamentId,
            partyCode: "",
            tournamentId: TournamentId,
        });
    }
    const TournamentData = DatabaseUser.Tournaments.get(TournamentId);
    if (!TournamentData) {
        DatabaseUser.Tournaments.set(TournamentId, {
            SignedUp: false,
            InviteId: "",
            Status: 0,
            AcceptedAt: new Date(),
            PartyCode: "",
            PartyMembers: [],
            UserMatch: null,
            UserMatches: [],
            UserPosition: [
                {
                    groupid: 0,
                    matchloses: 0,
                    phaseid: DatabaseTournament.CurrentPhaseId,
                    rankposition: 0,
                    sameposition: 0,
                    totalpoints: 0,
                    totalrounds: 0,
                },
            ],
            FinalPlace: 0,
        });
    }
    const TournamentObject = DatabaseUser.Tournaments.get(TournamentId);
    if (TournamentObject.PartyCode === "" || TournamentObject.PartyCode === undefined || req.body.recreate === 1) {
        TournamentObject.PartyCode = await GeneratePartyCode();
    }
    const AlreadyInParty = TournamentObject.PartyMembers.some((member) => member.UserId === DatabaseUser.UserId);
    if (!AlreadyInParty) {
        TournamentObject.PartyMembers.push({
            UserId: DatabaseUser.UserId,
            Username: DatabaseUser.Username,
            Status: 1,
            IsPartyLeader: true,
            IsKicked: false,
        });
    }
    await DatabaseUser.save();
    return res.status(200).json({
        status: TournamentCreatePartyCodeStatus.Ok,
        partyCode: TournamentObject.PartyCode,
        tournamentId: TournamentId,
    });
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=CreateCode.js.map