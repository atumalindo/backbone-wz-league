"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const express_rate_limit_1 = tslib_1.__importDefault(require("express-rate-limit"));
const Server_1 = require("../../Handlers/Server");
const express_1 = require("express");
const App = (0, express_1.Router)();
const RateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
});
App.get("/health/check", RateLimiter, async (_Req, Res) => {
    const Start = process.hrtime.bigint();
    let DbStatus = "unknown";
    let DbResponseTime = 0;
    try {
        const DbStart = process.hrtime.bigint();
        await Server_1.mongoose.connection.db.admin().ping();
        const DbEnd = process.hrtime.bigint();
        DbResponseTime = Number(DbEnd - DbStart) / 1_000_000;
        DbStatus = Server_1.mongoose.connection.readyState === 1 ? "connected" : "degraded";
    }
    catch (Error) {
        DbStatus = "down";
    }
    const End = process.hrtime.bigint();
    const TotalResponseTime = Number(End - Start) / 1_000_000;
    const Status = DbStatus === "connected" ? "healthy" : DbStatus === "degraded" ? "degraded" : "unhealthy";
    Res.status(Status === "healthy" ? 200 : Status === "degraded" ? 200 : 503).json({
        status: Status,
        timestamp: new Date().toISOString(),
        responseTime: `${TotalResponseTime.toFixed(2)}ms`,
        services: {
            database: {
                status: DbStatus,
                responseTime: `${DbResponseTime.toFixed(2)}ms`,
                readyState: Server_1.mongoose.connection.readyState,
            },
        },
        uptime: process.uptime(),
        memory: {
            used: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`,
            total: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)}MB`,
        },
    });
});
exports.default = {
    App,
    DefaultAPI: "/api",
};
//# sourceMappingURL=Health.js.map