"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Tournament = void 0;
const tslib_1 = require("tslib");
const mongoose_1 = tslib_1.__importStar(require("mongoose"));
const TournamentSchema = new mongoose_1.Schema({
    CurrentInvites: { type: Number, required: true },
    MaxInvites: { type: Number, required: true },
    MinPlayersPerMatch: { type: Number, required: true },
    MaxPlayersPerMatch: { type: Number, required: true },
    PlayersPerTeam: { type: Number, required: false },
    MaxTeamsPerMatch: { type: Number, required: false },
    MatchCapacity: { type: Number, required: false },
    TournamentId: { type: String, required: true, unique: true },
    TournamentName: { type: String, required: true },
    TournamentImage: { type: String },
    TournamentColor: { type: String },
    StartTime: { type: Date, required: true },
    SignupStart: { type: Date, required: true },
    EntryFee: { type: Number, required: true },
    PrizepoolId: { type: String, required: false },
    PrizePoolGems: { type: Number, default: 0 },
    PrizeMode: { type: String, enum: ["gems", "tag"], default: "gems" },
    PrizeTag: { type: String },
    PrizeTagDurationUnit: { type: String, enum: ["hours", "days", "months", "permanent"] },
    PrizeTagDurationValue: { type: Number },
    PrizeTagExpiresAt: { type: Date },
    PrizeDistributedAt: { type: Date },
    PartySize: { type: Number, required: true },
    Status: { type: Number, required: true },
    TournamentType: { type: Number, required: true },
    Phases: [
        {
            Name: { type: String, required: false },
            PhaseType: { type: String, required: true },
            Maps: { type: [String], required: true },
            IsPhase: { type: Boolean, required: true },
            GroupCount: { type: Number, required: false },
            MaxLoses: { type: Number, required: false },
            RoundCount: { type: Number, required: true },
            MaxTeams: { type: Number, required: false },
            RoundEmotes: { type: [[String]], required: false, default: undefined },
        },
    ],
    Region: { type: String, required: true },
    RoundCount: { type: Number, required: true },
    CurrentPhaseId: { type: Number, required: true },
    CurrentPhaseStarted: { type: Date, default: null },
    NextPhaseStarted: { type: Date, default: null },
    CreatedAt: { type: Date, default: Date.now, index: true },
    CreatedByDiscordId: { type: String },
    CreatedByDiscordTag: { type: String },
    WebhookMessageId: { type: String, required: false },
    Properties: {
        type: {
            Mode: { type: String, enum: ["teams", "solo"], required: false },
            DisabledEmotes: { type: [Number], default: [] },
            SelectedEmotes: { type: [String], default: [] },
            WebhookMessageId: { type: String, required: false },
            IsInvitationOnly: { type: Boolean, required: true },
            InvitedIds: { type: [String], default: [] },
            AdminIds: { type: [String], default: [] },
            StreamURL: { type: String, required: false },
            HighlightsURL: { type: String, required: false },
            CountForLeaderboard: { type: Boolean, required: false },
        },
        required: true,
    },
    Prizes: [
        {
            position: { type: Number, required: true },
            endPosition: { type: Number, required: false },
            amount: { type: Number, required: true },
            label: { type: String, required: false },
        },
    ],
    Winners: [
        {
            nick: { type: String, required: true },
            userId: { type: String, required: true },
            rewardType: { type: String, enum: ["gems", "tag"] },
            rewardAmount: { type: Number },
            rewardTag: { type: String },
            rewardExpiresAt: { type: Date },
        },
    ],
});
exports.Tournament = mongoose_1.default.model("Tournament", TournamentSchema);
//# sourceMappingURL=Tournament.js.map