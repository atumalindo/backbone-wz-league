import { Router } from "express";
import j from "joi";
import { ValidateBody, ValidateHeaders } from "../../Modules/Middleware";
import { GetTournamentMatches, GenerateBracketMatches } from "../../Backbone/Logic/GetMatches";
import { ITournament, Tournament } from "../../Models/Tournament";

const App = Router();

const GetMatchesListSchema = j
  .object({
    backbone_app_id: j.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const GetMatchesBodySchema = j
  .object({
    tournamentId: j.number().required(),
    phaseId: j.number().required(),
    groupId: j.number().required(),
    fromRoundId: j.number().required(),
    toRoundId: j.number().required(),
    maxResults: j.number().required(),
    page: j.number().required(),
    onlyInProgress: j.number().required().valid(0, 1),
    accessToken: j.string().required(),
  })
  .unknown(true);

App.post(
  "/tournamentGetMatches",
  ValidateHeaders(GetMatchesListSchema),
  ValidateBody(GetMatchesBodySchema),
  async (req, res) => {
    const { tournamentId, groupId, fromRoundId, toRoundId, maxResults, page } = req.body;

    try {
      const DatabaseTournament = await Tournament.findOne({ TournamentId: tournamentId });
      if (!DatabaseTournament) return res.status(404).json({ message: "" });

      await GenerateBracketMatches(DatabaseTournament as ITournament);

      const Data = await GetTournamentMatches(
        DatabaseTournament.TournamentId.toString(),
        DatabaseTournament.CurrentPhaseId,
        groupId,
        fromRoundId,
        toRoundId,
        maxResults,
        page
      );

      res.status(200).json(Data);
    } catch (error) {
      console.error("Error fetching matches :( || ", error);
      res.status(500).json({ message: "" });
    }
  }
);

export default {
  App,
  DefaultAPI: "/api/v1",
};
