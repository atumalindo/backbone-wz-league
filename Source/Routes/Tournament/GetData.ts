import { Router } from "express";
import j from "joi";
import { ValidateBody, ValidateHeaders } from "../../Modules/Middleware";
import { TournamentGetData } from "../../Backbone/Logic/TournamentData";

const App = Router();
const TOURNAMENT_DATA_TIMEOUT_MS = 15000;

function WithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tournament data timed out after ${timeoutMs}ms`));
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

const TournamentDataSchema = j
  .object({
    backbone_app_id: j.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const GetDataBodySchema = j
  .object({
    tournamentId: j.number().required(),
    getAllData: j.number().required().valid(0, 1),
    readyForNextMatch: j.number().required().valid(0, 1),
    accessToken: j.string().required(),
  })
  .unknown(true);

App.post(
  "/tournamentGetData",
  ValidateHeaders(TournamentDataSchema),
  ValidateBody(GetDataBodySchema),
  async (req, res) => {
    try {
      const Data = await WithTimeout(
        TournamentGetData(
          req.body.tournamentId as number,
          req.body.getAllData as number,
          req.body.readyForNextMatch as number,
          req.body.accessToken as string
        ),
        TOURNAMENT_DATA_TIMEOUT_MS
      );
      res.status(200).json(Data);
    } catch (error) {
      // Sem isso, qualquer erro dentro de TournamentGetData (ex: durante a
      // criação da primeira partida do torneio) deixava a requisição do
      // client SEM RESPOSTA — a tela de "carregando próxima partida" ficava
      // presa para sempre, pois o Express 4 não captura rejeições de
      // handlers async automaticamente. O timeout acima cobre também uma
      // operação de banco que fica pendente sem rejeitar a Promise.
      console.error("Error fetching tournament data :( || ", error);
      res.status(500).json({ message: "" });
    }
  }
);
export default {
  App,
  DefaultAPI: "/api/v2",
};
