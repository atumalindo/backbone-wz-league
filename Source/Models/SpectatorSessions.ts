import mongoose, { Document, Schema } from "mongoose";

export interface ISpectatorSession extends Document {
  tokenHash: string;
  tournamentId: string;
  matchId: string;
  viewerUserId?: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

const SpectatorSessionSchema = new Schema<ISpectatorSession>({
  tokenHash: { type: String, required: true, unique: true, index: true },
  tournamentId: { type: String, required: true, index: true },
  matchId: { type: String, required: true, index: true },
  viewerUserId: { type: String, required: false },
  createdAt: { type: Date, required: true, default: Date.now },
  lastSeenAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
});

SpectatorSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SpectatorSession = mongoose.model<ISpectatorSession>(
  "Tournament Spectator Session",
  SpectatorSessionSchema
);
