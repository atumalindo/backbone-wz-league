"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScheduledTournament = void 0;
const tslib_1 = require("tslib");
const mongoose_1 = tslib_1.__importStar(require("mongoose"));
const ScheduledTournamentSchema = new mongoose_1.Schema({
    ScheduleId: { type: String, required: true, unique: true },
    TournamentTemplate: { type: mongoose_1.Schema.Types.Mixed, required: true },
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
exports.ScheduledTournament = mongoose_1.default.model("ScheduledTournament", ScheduledTournamentSchema);
//# sourceMappingURL=ScheduledTournament.js.map