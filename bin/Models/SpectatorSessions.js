"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpectatorSession = void 0;
const tslib_1 = require("tslib");
const mongoose_1 = tslib_1.__importStar(require("mongoose"));
const SpectatorSessionSchema = new mongoose_1.Schema({
    tokenHash: { type: String, required: true, unique: true, index: true },
    tournamentId: { type: String, required: true, index: true },
    matchId: { type: String, required: true, index: true },
    viewerUserId: { type: String, required: false },
    createdAt: { type: Date, required: true, default: Date.now },
    lastSeenAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
});
SpectatorSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
exports.SpectatorSession = mongoose_1.default.model("Tournament Spectator Session", SpectatorSessionSchema);
//# sourceMappingURL=SpectatorSessions.js.map