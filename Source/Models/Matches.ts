import mongoose, { Schema, Document } from "mongoose";

export interface IMatchUser {
  "@user-id": string;
  "@team-id": string;
  "@checked-in": string;
  "@user-score": string;
  "@team-score": string;
  "@user-points": string;
  "@team-points": string;
  "@match-points": string;
  "@match-winner": string;
  "@nick": string;
}

export interface IMatchPresence {
  userId: string;
  lastSeenAt: Date;
  sessionStartedAt?: Date;
  connected: boolean;
}

export interface IMatch extends Document {
  id: string;
  secret: string;
  deadline: Date;
  matchid: number;
  phaseid: number;
  groupid: number;
  roundid: number;
  playedgamecount: number;
  status: number;
  users: IMatchUser[];
  tournamentid: string;
  presence?: IMatchPresence[];
  noPlayAfter?: Date;
  stateVersion: number;
  qualificationApplied?: boolean;
  qualificationClaimedAt?: Date;
  closedAt?: Date;
}

const MatchUserSchema = new Schema<IMatchUser>(
  {
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
  },
  { _id: false }
);

const MatchPresenceSchema = new Schema<IMatchPresence>(
  {
    userId: { type: String, required: true },
    lastSeenAt: { type: Date, required: true },
    sessionStartedAt: { type: Date, required: false },
    connected: { type: Boolean, default: true },
  },
  { _id: false }
);

const MatchSchema = new Schema<IMatch>({
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

export const Match = mongoose.model<IMatch>("Bracket Matches", MatchSchema);

MatchSchema.index({ tournamentid: 1, phaseid: 1, roundid: 1 });
MatchSchema.index({ "users.@user-id": 1 });
MatchSchema.index({ status: 1, deadline: 1 });
