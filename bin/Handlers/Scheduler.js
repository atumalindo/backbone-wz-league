"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TournamentScheduler = exports.DayOfWeek = exports.ScheduleType = void 0;
const ScheduledTournament_1 = require("../Models/ScheduledTournament");
const Database_1 = require("./Database");
var ScheduleType;
(function (ScheduleType) {
    ScheduleType["Once"] = "once";
    ScheduleType["RecurringWeekly"] = "recurring_weekly";
    ScheduleType["RecurringDaily"] = "recurring_daily";
    ScheduleType["RecurringHourly"] = "recurring_hourly";
})(ScheduleType || (exports.ScheduleType = ScheduleType = {}));
var DayOfWeek;
(function (DayOfWeek) {
    DayOfWeek[DayOfWeek["Sunday"] = 0] = "Sunday";
    DayOfWeek[DayOfWeek["Monday"] = 1] = "Monday";
    DayOfWeek[DayOfWeek["Tuesday"] = 2] = "Tuesday";
    DayOfWeek[DayOfWeek["Wednesday"] = 3] = "Wednesday";
    DayOfWeek[DayOfWeek["Thursday"] = 4] = "Thursday";
    DayOfWeek[DayOfWeek["Friday"] = 5] = "Friday";
    DayOfWeek[DayOfWeek["Saturday"] = 6] = "Saturday";
})(DayOfWeek || (exports.DayOfWeek = DayOfWeek = {}));
class TournamentScheduler {
    static IsRunning = false;
    static async ScheduleTournament(template, type, when, timing = { signupStartMinutes: 0, tournamentStartMinutes: 45 }, day) {
        const id = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const scheduled = new ScheduledTournament_1.ScheduledTournament({
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
    static async ScheduleOnce(template, when, timing = { signupStartMinutes: 0, tournamentStartMinutes: 45 }) {
        return this.ScheduleTournament(template, ScheduleType.Once, when, timing);
    }
    static async ScheduleWeekly(template, day, time, timing = { signupStartMinutes: 0, tournamentStartMinutes: 45 }) {
        const next = this.GetNextWeekly(day, time);
        return this.ScheduleTournament(template, ScheduleType.RecurringWeekly, next, timing, day);
    }
    static async ScheduleDaily(template, time, timing = { signupStartMinutes: 0, tournamentStartMinutes: 45 }) {
        const next = this.GetNextDaily(time);
        return this.ScheduleTournament(template, ScheduleType.RecurringDaily, next, timing);
    }
    static async ScheduleHourly(template, timing = { signupStartMinutes: 0, tournamentStartMinutes: 45 }) {
        const next = this.GetNextHourly();
        return this.ScheduleTournament(template, ScheduleType.RecurringHourly, next, timing);
    }
    static GetNextWeekly(day, time) {
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hours, time.minutes, 0, 0);
        const today = now.getDay();
        let diff = day - today;
        if (diff < 0)
            diff += 7;
        else if (diff === 0 && now >= target)
            diff = 7;
        target.setDate(target.getDate() + diff);
        return target;
    }
    static GetNextDaily(time) {
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hours, time.minutes, 0, 0);
        if (now >= target)
            target.setDate(target.getDate() + 1);
        return target;
    }
    static GetNextHourly() {
        const now = new Date();
        const target = new Date(now);
        target.setHours(target.getHours() + 1, 0, 0, 0);
        return target;
    }
    static async RunScheduled() {
        const now = new Date();
        const pending = await ScheduledTournament_1.ScheduledTournament.find({
            IsActive: true,
            NextExecutionTime: { $lte: now },
        });
        for (const s of pending) {
            try {
                const creationTime = s.NextExecutionTime;
                const signupStartTime = new Date(creationTime.getTime() + (s.SignupStartMinutes || 0) * 60000);
                const tournamentStartTime = new Date(creationTime.getTime() + (s.TournamentStartMinutes || 45) * 60000);
                await (0, Database_1.CreateTournament)({
                    ...s.TournamentTemplate,
                    TournamentId: String(100000 + Math.floor(Math.random() * 1999900000)),
                    SignupStart: signupStartTime,
                    StartTime: tournamentStartTime,
                });
                if (s.ScheduleType === ScheduleType.RecurringWeekly && s.DayOfWeek !== undefined) {
                    const next = this.GetNextWeekly(s.DayOfWeek, s.TimeOfDay);
                    await ScheduledTournament_1.ScheduledTournament.updateOne({ ScheduleId: s.ScheduleId }, { NextExecutionTime: next });
                }
                else if (s.ScheduleType === ScheduleType.RecurringDaily) {
                    const next = this.GetNextDaily(s.TimeOfDay);
                    await ScheduledTournament_1.ScheduledTournament.updateOne({ ScheduleId: s.ScheduleId }, { NextExecutionTime: next });
                }
                else if (s.ScheduleType === ScheduleType.RecurringHourly) {
                    const next = this.GetNextHourly();
                    await ScheduledTournament_1.ScheduledTournament.updateOne({ ScheduleId: s.ScheduleId }, { NextExecutionTime: next });
                }
                else {
                    await ScheduledTournament_1.ScheduledTournament.updateOne({ ScheduleId: s.ScheduleId }, { IsActive: false });
                }
            }
            catch (err) {
                console.error(`scheduler error for ${s.ScheduleId}:`, err);
            }
        }
    }
    static async Start() {
        if (this.IsRunning)
            return;
        this.IsRunning = true;
        while (this.IsRunning) {
            try {
                await this.RunScheduled();
            }
            catch (err) {
                console.error("scheduler error:", err);
            }
            await new Promise((r) => setTimeout(r, 60000));
        }
    }
    static Stop() {
        this.IsRunning = false;
    }
    static async Delete(id) {
        try {
            const result = await ScheduledTournament_1.ScheduledTournament.deleteOne({ ScheduleId: id });
            return result.deletedCount > 0;
        }
        catch {
            return false;
        }
    }
    static async Disable(id) {
        try {
            const result = await ScheduledTournament_1.ScheduledTournament.updateOne({ ScheduleId: id }, { IsActive: false });
            return result.modifiedCount > 0;
        }
        catch {
            return false;
        }
    }
    static async Enable(id) {
        try {
            const result = await ScheduledTournament_1.ScheduledTournament.updateOne({ ScheduleId: id }, { IsActive: true });
            return result.modifiedCount > 0;
        }
        catch {
            return false;
        }
    }
    static async GetAll() {
        return await ScheduledTournament_1.ScheduledTournament.find({}).lean();
    }
    static async GetActive() {
        return await ScheduledTournament_1.ScheduledTournament.find({ IsActive: true }).lean();
    }
}
exports.TournamentScheduler = TournamentScheduler;
//# sourceMappingURL=Scheduler.js.map