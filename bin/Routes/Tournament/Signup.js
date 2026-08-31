"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_1 = require("express");
const joi_1 = tslib_1.__importDefault(require("joi"));
const Middleware_1 = require("../../Modules/Middleware");
const Extensions_1 = require("../../Modules/Extensions");
const Tournament_1 = require("../../Models/Tournament");
const LPUser_1 = require("../../Models/LPUser");
const BackboneUser_1 = require("../../Models/BackboneUser");
const Database_1 = require("../../Handlers/Database");
const TournamentEconomy_1 = require("../../Backbone/Logic/TournamentEconomy");
const App = (0, express_1.Router)();
const TournamentSignupSchema = joi_1.default
    .object({
    backbone_app_id: joi_1.default
        .string()
        .required()
        .valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": joi_1.default.string().required(),
    access_token: joi_1.default.string().required(),
})
    .unknown(true);
const SignupBodySchema = joi_1.default
    .object({
    tournamentId: joi_1.default.number().required(),
    accessToken: joi_1.default.string().required(),
})
    .unknown(true);
var TournamentUserStatus;
(function (TournamentUserStatus) {
    TournamentUserStatus[TournamentUserStatus["Unkown"] = -1] = "Unkown";
    TournamentUserStatus[TournamentUserStatus["Invited"] = 0] = "Invited";
    TournamentUserStatus[TournamentUserStatus["Confirmed"] = 1] = "Confirmed";
    TournamentUserStatus[TournamentUserStatus["Declined"] = 2] = "Declined";
    TournamentUserStatus[TournamentUserStatus["PartyNotFull"] = 3] = "PartyNotFull";
    TournamentUserStatus[TournamentUserStatus["ProcessingSignup"] = 4] = "ProcessingSignup";
    TournamentUserStatus[TournamentUserStatus["ProcessingSignupFail"] = 5] = "ProcessingSignupFail";
    TournamentUserStatus[TournamentUserStatus["ProcessingSignout"] = 6] = "ProcessingSignout";
    TournamentUserStatus[TournamentUserStatus["ProcessingSignoutFail"] = 7] = "ProcessingSignoutFail";
    TournamentUserStatus[TournamentUserStatus["KickedOutByAdmin"] = 8] = "KickedOutByAdmin";
})(TournamentUserStatus || (TournamentUserStatus = {}));
var TournamentSignUpStatus;
(function (TournamentSignUpStatus) {
    TournamentSignUpStatus[TournamentSignUpStatus["NotSigned"] = 0] = "NotSigned";
    TournamentSignUpStatus[TournamentSignUpStatus["Ok"] = 1] = "Ok";
    TournamentSignUpStatus[TournamentSignUpStatus["InvalidTournamentIdOrData"] = 2] = "InvalidTournamentIdOrData";
    TournamentSignUpStatus[TournamentSignUpStatus["RequirementsNotMet"] = 3] = "RequirementsNotMet";
    TournamentSignUpStatus[TournamentSignUpStatus["NotEnoughtForEntry"] = 4] = "NotEnoughtForEntry";
    TournamentSignUpStatus[TournamentSignUpStatus["NotOpenedForSignUp"] = 5] = "NotOpenedForSignUp";
    TournamentSignUpStatus[TournamentSignUpStatus["TournamentIsFull"] = 6] = "TournamentIsFull";
    TournamentSignUpStatus[TournamentSignUpStatus["DatabaseError"] = 7] = "DatabaseError";
})(TournamentSignUpStatus || (TournamentSignUpStatus = {}));
async function tryUpdateWebhook(tournamentId) {
    try {
        // tenta string e number
        let tour = (await Tournament_1.Tournament.findOne({ TournamentId: tournamentId })) ||
            (await Tournament_1.Tournament.findOne({ TournamentId: Number(tournamentId) }));
        if (!tour) {
            console.error(`[signup] Torneio ${tournamentId} não encontrado para embed`);
            return;
        }
        const anyTour = tour;
        const msgId = anyTour.WebhookMessageId || anyTour.Properties?.WebhookMessageId;
        console.log(`[signup] update embed id=${tournamentId} invites=${tour.CurrentInvites}/${tour.MaxInvites} msgId=${msgId || "NONE"}`);
        if (!msgId) {
            console.error(`[signup] Sem WebhookMessageId no torneio ${tournamentId}. A embed do Discord não foi salva no /create. Crie um torneio NOVO.`);
            return;
        }
        await (0, Database_1.UpdateTournamentWebhook)(tour);
    }
    catch (err) {
        console.error(`[signup] Falha ao atualizar embed:`, err?.message || err);
    }
}
App.post("/tournamentSignup", (0, Middleware_1.ValidateHeaders)(TournamentSignupSchema), (0, Middleware_1.ValidateBody)(SignupBodySchema), async (req, res) => {
    const TournamentId = req.body.tournamentId.toString();
    const AccessToken = req.body.accessToken.toString();
    const [LoginProviderUser, CheckTournament] = await Promise.all([
        LPUser_1.LPUser.findOne({ AccessToken: AccessToken }).lean(),
        Tournament_1.Tournament.findOne({ TournamentId: req.body.tournamentId }).lean(),
    ]);
    if (!LoginProviderUser)
        return res.status(401).json({ message: "Unauthorized" });
    if (!CheckTournament) {
        return res.status(200).json({
            status: TournamentSignUpStatus.InvalidTournamentIdOrData,
            inviteId: null,
            inviteStatus: TournamentUserStatus.Invited,
            tournamentId: TournamentId,
        });
    }
    const Now = new Date();
    const StartTime = new Date(CheckTournament.StartTime);
    // Inscrição OBRIGATORIAMENTE só na última 1 hora antes do start
    const SignupOpensAt = new Date(StartTime.getTime() - 60 * 60 * 1000);
    if (Now < SignupOpensAt) {
        console.log(`[signup] BLOCKED too early tournament=${TournamentId} now=${Now.toISOString()} opens=${SignupOpensAt.toISOString()} start=${StartTime.toISOString()}`);
        return res.status(200).json({
            status: TournamentSignUpStatus.NotOpenedForSignUp,
            inviteId: null,
            inviteStatus: TournamentUserStatus.Invited,
            tournamentId: TournamentId,
        });
    }
    // Também respeita SignupStart do DB se for mais tarde que (start - 1h)
    const DbSignupStart = CheckTournament.SignupStart
        ? new Date(CheckTournament.SignupStart)
        : SignupOpensAt;
    if (Now < DbSignupStart) {
        return res.status(200).json({
            status: TournamentSignUpStatus.NotOpenedForSignUp,
            inviteId: null,
            inviteStatus: TournamentUserStatus.Invited,
            tournamentId: TournamentId,
        });
    }
    if (Now > StartTime) {
        return res.status(200).json({
            status: TournamentSignUpStatus.InvalidTournamentIdOrData,
            inviteId: null,
            inviteStatus: TournamentUserStatus.Invited,
            tournamentId: TournamentId,
        });
    }
    if (CheckTournament.CurrentInvites >= CheckTournament.MaxInvites) {
        return res.status(200).json({
            status: TournamentSignUpStatus.TournamentIsFull,
            inviteId: null,
            inviteStatus: TournamentUserStatus.Invited,
            tournamentId: TournamentId,
        });
    }
    const DatabaseUser = await BackboneUser_1.BackboneUser.findOne({
        UserId: LoginProviderUser.UserId,
    });
    if (!DatabaseUser) {
        return res.status(200).json({
            status: TournamentSignUpStatus.DatabaseError,
            inviteId: null,
            inviteStatus: TournamentUserStatus.Invited,
            tournamentId: TournamentId,
        });
    }
    const ExistingTournamentInfo = DatabaseUser.Tournaments.get(TournamentId);
    if (ExistingTournamentInfo?.SignedUp) {
        // já inscrito — ainda tenta atualizar embed
        res.status(200).json({
            status: TournamentSignUpStatus.Ok,
            inviteId: ExistingTournamentInfo.InviteId.toString(),
            inviteStatus: TournamentUserStatus.Confirmed,
            tournamentId: TournamentId,
        });
        setImmediate(() => {
            tryUpdateWebhook(TournamentId).catch(() => { });
        });
        return;
    }
    const EntryCharge = await (0, TournamentEconomy_1.ChargeTournamentEntry)(DatabaseUser.UserId, TournamentId, CheckTournament.EntryFee || 0, `signup:${TournamentId}:${DatabaseUser.UserId}`);
    if (!EntryCharge.ok) {
        return res.status(200).json({
            status: TournamentSignUpStatus.NotEnoughtForEntry,
            inviteId: null,
            inviteStatus: TournamentUserStatus.Invited,
            tournamentId: TournamentId,
        });
    }
    const MaxRetries = 5;
    let DatabaseTournament = null;
    for (let Retry = 0; Retry < MaxRetries; Retry++) {
        DatabaseTournament = await Tournament_1.Tournament.findOneAndUpdate({
            TournamentId: req.body.tournamentId,
            $expr: { $lt: ["$CurrentInvites", "$MaxInvites"] },
        }, {
            $inc: { CurrentInvites: 1 },
        }, {
            new: true,
        });
        if (DatabaseTournament)
            break;
        if (Retry < MaxRetries - 1) {
            await new Promise((Resolve) => setTimeout(Resolve, 50 + Math.random() * 50));
        }
    }
    if (!DatabaseTournament) {
        await (0, TournamentEconomy_1.RefundTournamentEntry)(DatabaseUser.UserId, TournamentId, CheckTournament.EntryFee || 0, `refund:signup:${TournamentId}:${DatabaseUser.UserId}`);
        return res.status(200).json({
            status: TournamentSignUpStatus.TournamentIsFull,
            inviteId: null,
            inviteStatus: TournamentUserStatus.Invited,
            tournamentId: TournamentId,
        });
    }
    const InviteId = (0, Extensions_1.GenerateInviteId)();
    DatabaseUser.Tournaments.set(TournamentId, {
        SignedUp: true,
        InviteId: InviteId.toString(),
        Status: TournamentUserStatus.Confirmed,
        AcceptedAt: Now,
        PartyMembers: [
            {
                UserId: DatabaseUser.UserId,
                Username: DatabaseUser.Username,
                Status: 1,
                IsPartyLeader: true,
                IsKicked: false,
            },
        ],
        PartyCode: "",
        UserMatch: null,
        UserMatches: [],
        UserPosition: [
            {
                groupid: 0,
                matchloses: 0,
                phaseid: Math.max(1, Number(DatabaseTournament.CurrentPhaseId) || 1),
                rankposition: 0,
                sameposition: 0,
                totalpoints: 0,
                totalrounds: 0,
            },
        ],
        FinalPlace: 0,
    });
    try {
        await DatabaseUser.save();
    }
    catch (Error) {
        await (0, TournamentEconomy_1.RefundTournamentEntry)(DatabaseUser.UserId, TournamentId, CheckTournament.EntryFee || 0);
        await Tournament_1.Tournament.updateOne({ TournamentId: req.body.tournamentId }, { $inc: { CurrentInvites: -1 } });
        return res.status(200).json({
            status: TournamentSignUpStatus.DatabaseError,
            inviteId: null,
            inviteStatus: TournamentUserStatus.Invited,
            tournamentId: TournamentId,
        });
    }
    res.status(200).json({
        status: TournamentSignUpStatus.Ok,
        inviteId: InviteId.toString(),
        inviteStatus: TournamentUserStatus.Confirmed,
        tournamentId: TournamentId,
    });
    console.log(`[signup] OK player=${DatabaseUser.UserId} tournament=${TournamentId} invites=${DatabaseTournament.CurrentInvites}`);
    setImmediate(() => {
        tryUpdateWebhook(TournamentId).catch((err) => console.error("[signup] webhook background error:", err));
    });
});
exports.default = {
    App,
    DefaultAPI: "/api/v1",
};
//# sourceMappingURL=Signup.js.map