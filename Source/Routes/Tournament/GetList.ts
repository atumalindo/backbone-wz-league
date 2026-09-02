import { Router } from "express";
import { GetTournamentList } from "../../Backbone/Logic/TournamentList";

const App = Router();

function dateOrNow(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

async function sendTournamentList(req: any, res: any) {
  try {
    const accessToken = String(
      req.body?.accessToken ??
        req.body?.access_token ??
        req.headers?.access_token ??
        ""
    );
    const data = await GetTournamentList(
      20,
      1,
      accessToken,
      dateOrNow(req.body?.sinceDate ?? req.body?.since_date),
      dateOrNow(req.body?.untilDate ?? req.body?.until_date)
    );

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    return res.status(200).json(data);
  } catch (error) {
    console.error("[GetListV1] error:", error);
    // Always finish the request with the shape expected by the native client.
    return res.status(200).json({
      pagination: { currentPage: 1, maxResults: 20, totalResultCount: 0 },
      tournaments: [],
    });
  }
}

App.post("/tournamentGetList", sendTournamentList);
App.get("/tournamentGetList", sendTournamentList);

export default { App, DefaultAPI: "/api/v1" };
