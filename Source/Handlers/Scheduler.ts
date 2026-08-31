import { ScheduledTournament } from "../Models/ScheduledTournament";
import { TournamentInput } from "../Models/Tournament";
import { msg, warn } from "../Modules/Logger";
import { CreateTournament } from "./Database";

export enum ScheduleType {
  Once = "once",
  RecurringWeekly = "recurring_weekly",
  RecurringDaily = "recurring_daily",
  RecurringHourly = "recurring_hourly",
}

export enum DayOfWeek {
  Sunday = 0,
  Monday = 1,
  Tuesday = 2,
  Wednesday = 3,
  Thursday = 4,
  Friday = 5,
  Saturday = 6,
}

export interface TimeOfDay {
  hours: number;
  minutes: number;
}

export interface TournamentTiming {
  signupStartMinutes: number;
  tournamentStartMinutes: number;
}

export class TournamentScheduler {
  private static IsRunning = false;

  public static async ScheduleTournament(
    template: TournamentInput,
    type: ScheduleType,
    when: Date,
    timing: TournamentTiming = { signupStartMinutes: 0, tournamentStartMinutes: 45 },
    day?: DayOfWeek
  ): Promise<string> {
    const id = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const scheduled = new ScheduledTournament({
      ScheduleId: id,
      TournamentTemplate: template,
      ScheduleType: type,
      NextExecutionTime: when,
      IsActive: true,
      CreatedAt: new Date(),
      DayOfWeek: day,
      TimeOfDay: { hours: when.getHours(), minutes: when.getMinutes() },
      SignupStartMinutes: timing.signupStartMinutes,
      TournamentStartMinutes: timing.tournamentStartMinutes,
    });

    await scheduled.save();
    return id;
  }

  public static async ScheduleOnce(
    template: TournamentInput,
    when: Date,
    timing: TournamentTiming = { signupStartMinutes: 0, tournamentStartMinutes: 45 }
  ): Promise<string> {
    return this.ScheduleTournament(template, ScheduleType.Once, when, timing);
  }

  public static async ScheduleWeekly(
    template: TournamentInput,
    day: DayOfWeek,
    time: TimeOfDay,
    timing: TournamentTiming = { signupStartMinutes: 0, tournamentStartMinutes: 45 }
  ): Promise<string> {
    const next = this.GetNextWeekly(day, time);
    return this.ScheduleTournament(template, ScheduleType.RecurringWeekly, next, timing, day);
  }

  public static async ScheduleDaily(
    template: TournamentInput,
    time: TimeOfDay,
    timing: TournamentTiming = { signupStartMinutes: 0, tournamentStartMinutes: 45 }
  ): Promise<string> {
    const next = this.GetNextDaily(time);
    return this.ScheduleTournament(template, ScheduleType.RecurringDaily, next, timing);
  }

  public static async ScheduleHourly(
    template: TournamentInput,
    timing: TournamentTiming = { signupStartMinutes: 0, tournamentStartMinutes: 45 }
  ): Promise<string> {
    const next = this.GetNextHourly();
    return this.ScheduleTournament(template, ScheduleType.RecurringHourly, next, timing);
  }

  private static GetNextWeekly(day: DayOfWeek, time: TimeOfDay): Date {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hours, time.minutes, 0, 0);
    const today = now.getDay();

    let diff = day - today;
    if (diff < 0) diff += 7;
    else if (diff === 0 && now >= target) diff = 7;

    target.setDate(target.getDate() + diff);
    return target;
  }

  private static GetNextDaily(time: TimeOfDay): Date {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hours, time.minutes, 0, 0);

    if (now >= target) target.setDate(target.getDate() + 1);

    return target;
  }

  private static GetNextHourly(): Date {
    const now = new Date();
    const target = new Date(now);
    target.setHours(target.getHours() + 1, 0, 0, 0);
    return target;
  }

  private static async RunScheduled(): Promise<void> {
    const now = new Date();
    const pending = await ScheduledTournament.find({
      IsActive: true,
      NextExecutionTime: { $lte: now },
    });

    for (const s of pending) {
      try {
        const creationTime = s.NextExecutionTime;
        const signupStartTime = new Date(creationTime.getTime() + (s.SignupStartMinutes || 0) * 60000);
        const tournamentStartTime = new Date(creationTime.getTime() + (s.TournamentStartMinutes || 45) * 60000);

        await CreateTournament({
          ...s.TournamentTemplate,
          TournamentId: String(100000 + Math.floor(Math.random() * 1999900000)),
          SignupStart: signupStartTime,
          StartTime: tournamentStartTime,
        });

        if (s.ScheduleType === ScheduleType.RecurringWeekly && s.DayOfWeek !== undefined) {
          const next = this.GetNextWeekly(s.DayOfWeek, s.TimeOfDay);
          await ScheduledTournament.updateOne({ ScheduleId: s.ScheduleId }, { NextExecutionTime: next });
        } else if (s.ScheduleType === ScheduleType.RecurringDaily) {
          const next = this.GetNextDaily(s.TimeOfDay);
          await ScheduledTournament.updateOne({ ScheduleId: s.ScheduleId }, { NextExecutionTime: next });
        } else if (s.ScheduleType === ScheduleType.RecurringHourly) {
          const next = this.GetNextHourly();
          await ScheduledTournament.updateOne({ ScheduleId: s.ScheduleId }, { NextExecutionTime: next });
        } else {
          await ScheduledTournament.updateOne({ ScheduleId: s.ScheduleId }, { IsActive: false });
        }
      } catch (err) {
        console.error(`scheduler error for ${s.ScheduleId}:`, err);
      }
    }
  }

  public static async Start(): Promise<void> {
    if (this.IsRunning) return;

    this.IsRunning = true;

    while (this.IsRunning) {
      try {
        await this.RunScheduled();
      } catch (err) {
        console.error("scheduler error:", err);
      }

      await new Promise((r) => setTimeout(r, 60000));
    }
  }

  public static Stop(): void {
    this.IsRunning = false;
  }

  public static async Delete(id: string): Promise<boolean> {
    try {
      const result = await ScheduledTournament.deleteOne({ ScheduleId: id });
      return result.deletedCount > 0;
    } catch {
      return false;
    }
  }

  public static async Disable(id: string): Promise<boolean> {
    try {
      const result = await ScheduledTournament.updateOne({ ScheduleId: id }, { IsActive: false });
      return result.modifiedCount > 0;
    } catch {
      return false;
    }
  }

  public static async Enable(id: string): Promise<boolean> {
    try {
      const result = await ScheduledTournament.updateOne({ ScheduleId: id }, { IsActive: true });
      return result.modifiedCount > 0;
    } catch {
      return false;
    }
  }

  public static async GetAll(): Promise<any[]> {
    return await ScheduledTournament.find({}).lean();
  }

  public static async GetActive(): Promise<any[]> {
    return await ScheduledTournament.find({ IsActive: true }).lean();
  }
}
