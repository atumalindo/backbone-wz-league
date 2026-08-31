import { Router } from "express";
import { GetTournamentList } from "../../Backbone/Logic/TournamentList";

const App = Router();

function parseDate(value: any): Date {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (typeof value === "number" && !isNaN(value)) return new Date(value);
  if (typeof value === "string") {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

App.post("/tournamentGetList", async (req, res) => {
  try {
    const accessToken = String(
      req.body?.accessToken ??
        req.body?.access_token ??
        req.headers?.["access_token"] ??
        ""
    );
    const since = parseDate(req.body?.sinceDate ?? req.body?.since_date);
    const until = parseDate(req.body?.untilDate ?? req.body?.until_date);

    const Data = await GetTournamentList(20, 1, accessToken, since, until);
    console.log(
      `[GetList] OK ${(Data as any)?.tournaments?.length ?? 0} ids=${((Data as any)?.tournaments || []).map((t: any) => t.id).join(",")}`
    );
    // Headers anti-cache — client sempre pega a lista completa
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.status(200).json(Data);
  } catch (err) {
    console.error("[GetList] error:", err);
    res.status(200).json({
      pagination: { currentPage: 1, maxResults: 20, totalResultCount: 0 },
      tournaments: [],
    });
  }
});

App.get("/tournamentGetList", async (_req, res) => {
  try {
    const Data = await GetTournamentList(
      20,
      1,
      "",
      new Date(Date.now() - 7 * 86400000),
      new Date(Date.now() + 30 * 86400000)
    );
    res.status(200).json(Data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default { App, DefaultAPI: "/api/v2" };
