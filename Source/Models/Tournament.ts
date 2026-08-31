import mongoose, { Schema, Document } from "mongoose";
import { TournamentPhaseType } from "../Backbone/Config";

interface Prize {
  position: number;
  endPosition?: number;
  amount: number;
  label?: string;
}

interface Winner {
  nick: string;
  userId: string;
  rewardType?: "gems" | "tag";
  rewardAmount?: number;
  rewardTag?: string;
  rewardExpiresAt?: Date | null;
}

interface Properties {
  Mode?: "teams" | "solo";
  DisabledEmotes: number[];
  SelectedEmotes?: string[];
  WebhookMessageId?: string;
  IsInvitationOnly: boolean;
  InvitedIds: string[];
  AdminIds: string[];
  StreamURL: string;
  HighlightsURL?: string;
  CountForLeaderboard?: boolean;
  [key: string]: any;
}

interface Phase {
  Name?: string;
  PhaseType: TournamentPhaseType;
  Maps: string[];
  IsPhase: boolean;
  GroupCount?: number;
  MaxLoses?: number;
  MaxTeams?: number;
  RoundCount: number;
  /** Emotes liberados por round (opcional). Cada índice = 1 round; cada
   * round pode ter vários nomes de emote. Usado pra embed mostrar
   * "Round X-Y: Mapa (emotes)" quando os rounds variam entre si. */
  RoundEmotes?: string[][];
}

export interface ITournament extends Document {
  CurrentInvites: number;
  MaxInvites: number;
  MinPlayersPerMatch: number;
  MaxPlayersPerMatch: number;
  PlayersPerTeam?: number;
  MaxTeamsPerMatch?: number;
  MatchCapacity?: number;
  TournamentId: string;
  TournamentName: string;
  TournamentImage?: string;
  TournamentColor?: string;
  StartTime: Date;
  SignupStart: Date;
  EntryFee: number;
  PrizepoolId?: string;
  PrizePoolGems?: number;
  PrizeMode?: "gems" | "tag";
  PrizeTag?: string;
  PrizeTagDurationUnit?: "hours" | "days" | "months" | "permanent";
  PrizeTagDurationValue?: number;
  PrizeTagExpiresAt?: Date;
  PrizeDistributedAt?: Date;
  PartySize: number;
  Status: number;
  TournamentType: number;
  Phases: Phase[];
  Region: string;
  RoundCount: number;
  CurrentPhaseId: number;
  CurrentPhaseStarted?: Date;
  NextPhaseStarted: Date;
  CreatedAt?: Date;
  CreatedByDiscordId?: string;
  CreatedByDiscordTag?: string;
  Properties: Properties;
  WebhookMessageId?: string;
  Prizes?: Prize[];
  Winners?: Winner[];
}

const TournamentSchema = new Schema<ITournament>({
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

export type TournamentInput = {
  CreatedByDiscordId?: string;
  CreatedByDiscordTag?: string;
  CurrentInvites: number;
  MaxInvites: number;
  MinPlayersPerMatch: number;
  MaxPlayersPerMatch: number;
  PlayersPerTeam?: number;
  MaxTeamsPerMatch?: number;
  MatchCapacity?: number;
  TournamentId: string;
  TournamentName: string;
  TournamentImage?: string;
  TournamentColor?: string;
  StartTime: Date;
  SignupStart: Date;
  EntryFee: number;
  PrizepoolId: string;
  PrizePoolGems?: number;
  PrizeMode?: "gems" | "tag";
  PrizeTag?: string;
  PrizeTagDurationUnit?: "hours" | "days" | "months" | "permanent";
  PrizeTagDurationValue?: number;
  PrizeTagExpiresAt?: Date;
  PrizeDistributedAt?: Date;
  PartySize: number;
  Status: number;
  TournamentType: number;
  Phases: Phase[];
  Region: string;
  RoundCount: number;
  Prizes?: Prize[];
  Winners?: Winner[];
  CurrentPhaseId: number;
  Properties: Properties;
  WebhookMessageId?: string;
};

export const Tournament = mongoose.model<ITournament>(
  "Tournament",
  TournamentSchema
);
