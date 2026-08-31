import mongoose, { Schema, Document } from "mongoose";
import { TournamentInput } from "./Tournament";

export interface TimeOfDay {
  hours: number;
  minutes: number;
}

export interface IScheduledTournament extends Document {
  ScheduleId: string;
  TournamentTemplate: TournamentInput;
  ScheduleType: "once" | "recurring_weekly" | "recurring_daily" | "recurring_hourly";
  NextExecutionTime: Date;
  IsActive: boolean;
  CreatedAt: Date;
  DayOfWeek?: number;
  TimeOfDay: TimeOfDay;
  SignupStartMinutes?: number;
  TournamentStartMinutes?: number;
}

const ScheduledTournamentSchema = new Schema<IScheduledTournament>({
  ScheduleId: { type: String, required: true, unique: true },
  TournamentTemplate: { type: Schema.Types.Mixed, required: true },
  ScheduleType: {
    type: String,
    required: true,
    enum: ["once", "recurring_weekly", "recurring_daily", "recurring_hourly"],
  },
  NextExecutionTime: { type: Date, required: true },
  IsActive: { type: Boolean, required: true, default: true },
  CreatedAt: { type: Date, required: true, default: Date.now },
  DayOfWeek: { type: Number, min: 0, max: 6 },
  TimeOfDay: {
    hours: { type: Number, required: true, min: 0, max: 23 },
    minutes: { type: Number, required: true, min: 0, max: 59 },
  },
  SignupStartMinutes: { type: Number, default: 0 },
  TournamentStartMinutes: { type: Number, default: 45 },
});

export const ScheduledTournament = mongoose.model<IScheduledTournament>(
  "ScheduledTournament",
  ScheduledTournamentSchema
);
