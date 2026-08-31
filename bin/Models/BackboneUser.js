"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackboneUser = void 0;
const tslib_1 = require("tslib");
const mongoose_1 = tslib_1.__importStar(require("mongoose"));
const PartyMemberSchema = new mongoose_1.Schema({
    UserId: {
        type: String,
        required: true,
    },
    Username: {
        type: String,
        required: true,
    },
    Status: {
        type: Number,
        required: true,
    },
    IsPartyLeader: {
        type: Boolean,
        required: true,
        default: false,
    },
    IsKicked: {
        type: Boolean,
        required: true,
        default: false,
    },
}, { _id: false });
const MatchUserSchema = new mongoose_1.Schema({
    "@user-id": {
        type: String,
        required: true,
    },
    "@team-id": {
        type: String,
        required: true,
    },
    "@checked-in": {
        type: String,
        required: true,
    },
    "@user-score": {
        type: String,
        required: true,
    },
    "@team-score": {
        type: String,
        required: true,
    },
    "@user-points": {
        type: String,
        required: true,
    },
    "@team-points": {
        type: String,
        required: true,
    },
    "@match-points": {
        type: String,
        required: true,
    },
    "@match-winner": {
        type: String,
        required: true,
    },
    "@nick": {
        type: String,
        required: true,
    },
}, { _id: false });
const UserMatchSchema = new mongoose_1.Schema({
    id: {
        type: String,
        required: true,
    },
    secret: {
        type: String,
        required: true,
    },
    deadline: {
        type: Date,
        required: true,
    },
    matchid: {
        type: Number,
        required: true,
    },
    phaseid: {
        type: Number,
        required: true,
    },
    groupid: {
        type: Number,
        required: true,
    },
    roundid: {
        type: Number,
        required: true,
    },
    playedgamecount: {
        type: Number,
        required: true,
        default: 0,
    },
    status: {
        type: Number,
        required: true,
    },
    users: {
        type: [MatchUserSchema],
        required: true,
        default: [],
    },
    tournamentid: {
        type: String,
        required: true,
    },
}, { _id: false });
const UserPositionSchema = new mongoose_1.Schema({
    groupid: {
        type: Number,
        required: true,
        default: 0,
    },
    matchloses: {
        type: Number,
        required: true,
        default: 0,
    },
    phaseid: {
        type: Number,
        required: true,
    },
    rankposition: {
        type: Number,
        required: true,
        default: 0,
    },
    sameposition: {
        type: Number,
        required: true,
        default: 0,
    },
    totalpoints: {
        type: Number,
        required: true,
        default: 0,
    },
    totalrounds: {
        type: Number,
        required: true,
        default: 0,
    },
}, { _id: false });
const BackboneUserSchema = new mongoose_1.Schema({
    Username: {
        type: String,
        required: true,
        unique: false,
    },
    UserId: {
        type: String,
        required: true,
        unique: true,
    },
    TournamentsWon: {
        type: Number,
        required: true,
        unique: false,
        default: 0,
    },
    Tournaments: {
        type: Map,
        of: new mongoose_1.Schema({
            SignedUp: {
                type: Boolean,
                required: true,
                default: false,
            },
            InviteId: {
                type: String,
                required: true,
            },
            Status: {
                type: Number,
                required: true,
            },
            AcceptedAt: {
                type: Date,
                required: true,
            },
            PartyCode: {
                type: String,
                required: false,
                default: "",
            },
            KnockedOut: {
                type: Boolean,
                required: false,
                default: false,
            },
            PartyMembers: {
                type: [PartyMemberSchema],
                default: [],
            },
            UserMatch: {
                type: UserMatchSchema,
                default: null,
                required: false,
            },
            UserMatches: {
                type: [UserMatchSchema],
                default: [],
            },
            UserPosition: {
                type: [UserPositionSchema],
                default: [],
            },
            FinalPlace: {
                type: Number,
                required: false,
                default: 0,
            },
        }, { _id: false }),
        default: {},
    },
});
exports.BackboneUser = mongoose_1.default.model("BackboneUser", BackboneUserSchema);
//# sourceMappingURL=BackboneUser.js.map