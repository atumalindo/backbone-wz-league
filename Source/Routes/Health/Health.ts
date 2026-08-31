import rateLimit from "express-rate-limit";
import { mongoose } from "../../Handlers/Server";
import { Router } from "express";
const App = Router();

const RateLimiter = rateLimit({
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
    await mongoose.connection.db!.admin().ping();
    const DbEnd = process.hrtime.bigint();
    DbResponseTime = Number(DbEnd - DbStart) / 1_000_000;
    DbStatus = mongoose.connection.readyState === 1 ? "connected" : "degraded";
  } catch (Error) {
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
        readyState: mongoose.connection.readyState,
      },
    },
    uptime: process.uptime(),
    memory: {
      used: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`,
      total: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)}MB`,
    },
  });
});

export default {
  App,
  DefaultAPI: "/api",
};
