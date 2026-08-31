import { Router } from "express";
import j from "joi";
import { ValidateBody, ValidateHeaders } from "../../Modules/Middleware";
import { GetScores } from "../../Backbone/Logic/GetScores";

const App = Router();
const GetScoresSchema = j
  .object({
    backbone_app_id: j.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const GetScoresBodySchema = j
  .object({
    tournamentId: j.number().required(),
    phaseId: j.number().required(),
    groupId: j.number().required(),
    maxResults: j.number().required(),
    page: j.number().required(),
    accessToken: j.string().required(),
  })
  .unknown(true);

App.post(
  "/tournamentGetScores",
  ValidateHeaders(GetScoresSchema),
  ValidateBody(GetScoresBodySchema),
  async (req, res) => {
    const Data = await GetScores(
      req.body.tournamentId.toString(),
      req.body.phaseId,
      req.body.groupId,
      req.body.maxResults,
      req.body.page
    );

    res.json(Data).status(200);
  }
);
export default {
  App,
  DefaultAPI: "/api/v1",
};
