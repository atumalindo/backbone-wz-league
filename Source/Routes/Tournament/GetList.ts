import { Router } from "express";
import { GetTournamentList } from "../../Backbone/Logic/TournamentList";

const App = Router();

const TOURNAMENT_LIST_TIMEOUT_MS = 9000;

function dateOrNow(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function WithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tournament list timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function sendTournamentList(req: any, res: any) {
  try {
    const accessToken = String(
      req.body?.accessToken ??
        req.body?.access_token ??
        req.headers?.access_token ??
        ""
    );
    const data = await WithTimeout(
      GetTournamentList(
        20,
        1,
        accessToken,
        dateOrNow(req.body?.sinceDate ?? req.body?.since_date),
        dateOrNow(req.body?.untilDate ?? req.body?.until_date)
      ),
      TOURNAMENT_LIST_TIMEOUT_MS
    );

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    return res.status(200).json(data);
  } catch (error) {
    console.error("[GetListV1] error:", error);
    // A native client that receives a valid empty payload can leave the
    // loading state and show its normal "no tournaments" message. This is
    // safer than leaving the request pending when Mongo or a query stalls.
    return res.status(200).json({
      pagination: { currentPage: 1, maxResults: 20, totalResultCount: 0 },
      tournaments: [],
    });
  }
}

App.post("/tournamentGetList", sendTournamentList);
App.get("/tournamentGetList", sendTournamentList);

export default { App, DefaultAPI: "/api/v1" };
