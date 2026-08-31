"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Match = void 0;
const tslib_1 = require("tslib");
const mongoose_1 = tslib_1.__importStar(require("mongoose"));
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
        default: "0",
    },
    "@user-score": {
        type: String,
        required: true,
        default: "0",
    },
    "@team-score": {
        type: String,
        required: true,
        default: "0",
    },
    "@user-points": {
        type: String,
        required: true,
        default: "0",
    },
    "@team-points": {
        type: String,
        required: true,
        default: "0",
    },
    "@match-points": {
        type: String,
        required: true,
        default: "0",
    },
    "@match-winner": {
        type: String,
        required: true,
        default: "0",
    },
    "@nick": {
        type: String,
        required: true,
    },
}, { _id: false });
const MatchPresenceSchema = new mongoose_1.Schema({
    userId: { type: String, required: true },
    lastSeenAt: { type: Date, required: true },
    sessionStartedAt: { type: Date, required: false },
    connected: { type: Boolean, default: true },
}, { _id: false });
const MatchSchema = new mongoose_1.Schema({
    id: {
        type: String,
        required: true,
        unique: true,
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
        index: true,
    },
    presence: {
        type: [MatchPresenceSchema],
        required: false,
        default: undefined,
    },
    noPlayAfter: {
        type: Date,
        required: false,
    },
    stateVersion: {
        type: Number,
        required: true,
        default: 0,
    },
    qualificationApplied: {
        type: Boolean,
        required: true,
        default: false,
    },
    qualificationClaimedAt: {
        type: Date,
        required: false,
    },
    closedAt: {
        type: Date,
        required: false,
    },
});
MatchSchema.index({ tournamentid: 1, phaseid: 1, groupid: 1, roundid: 1 });
MatchSchema.index({ "users.@user-id": 1, tournamentid: 1, phaseid: 1 });
MatchSchema.index({ tournamentid: 1, phaseid: 1, status: 1 });
exports.Match = mongoose_1.default.model("Bracket Matches", MatchSchema);
MatchSchema.index({ tournamentid: 1, phaseid: 1, roundid: 1 });
MatchSchema.index({ "users.@user-id": 1 });
MatchSchema.index({ status: 1, deadline: 1 });
//# sourceMappingURL=Matches.js.map