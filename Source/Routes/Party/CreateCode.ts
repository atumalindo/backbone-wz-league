import { Router } from "express";
import j from "joi";
import { ValidateBody, ValidateHeaders } from "../../Modules/Middleware";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { Tournament } from "../../Models/Tournament";

const App = Router();

const CreateCodeSchema = j
  .object({
    backbone_app_id: j.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const CreateBodySchema = j
  .object({
    tournamentId: j.number().required(),
    recreate: j.number().required().valid(0, 1),
    accessToken: j.string().required(),
  })
  .unknown(true);

const GeneratePartyCode = async (): Promise<string> => {
  const MaxAttempts = 10;

  const Users = await BackboneUser.find({}, { Tournaments: 1 }).lean();

  const ExistingCodes = new Set<string>();

  for (const User of Users) {
    if (!User.Tournaments) continue;

    for (const [_, Tournament] of Object.entries(User.Tournaments)) {
      if (Tournament && Tournament.PartyCode) {
        ExistingCodes.add(Tournament.PartyCode);
      }
    }
  }

  for (let Attempt = 0; Attempt < MaxAttempts; Attempt++) {
    const Code = Math.random().toString(36).substr(2, 6).toUpperCase();

    if (!ExistingCodes.has(Code)) {
      return Code;
    }
  }

  throw new Error("Failed to generate a unique party code after 10 attempts.");
};

enum TournamentCreatePartyCodeStatus {
  Unknown = -1,
  NotAttempted,
  Ok,
  InvalidTournamentId,
}
App.post(
  "/tournamentPartyCreateCode",
  ValidateHeaders(CreateCodeSchema),
  ValidateBody(CreateBodySchema),
  async (req, res) => {
    const TournamentId = req.body.tournamentId.toString();
    const AccessToken = req.body.accessToken;

    const DatabaseTournament = await Tournament.findOne({ TournamentId });
    const LoginProviderUser = await LPUser.findOne({ AccessToken });

    if (!DatabaseTournament || !LoginProviderUser) {
      return res.status(200).json({
        status: TournamentCreatePartyCodeStatus.InvalidTournamentId,
        partyCode: "",
        tournamentId: TournamentId,
      });
    }

    const DatabaseUser = await BackboneUser.findOne({ UserId: LoginProviderUser.UserId });

    if (!DatabaseUser || !DatabaseUser.Tournaments) {
      return res.status(200).json({
        status: TournamentCreatePartyCodeStatus.InvalidTournamentId,
        partyCode: "",
        tournamentId: TournamentId,
      });
    }

    const TournamentData = DatabaseUser.Tournaments.get(TournamentId);

    if (!TournamentData) {
      DatabaseUser.Tournaments.set(TournamentId, {
        SignedUp: false,
        InviteId: "",
        Status: 0,
        AcceptedAt: new Date(),
        PartyCode: "",
        PartyMembers: [],
        UserMatch: null,
        UserMatches: [],
        UserPosition: [
          {
            groupid: 0,
            matchloses: 0,
            phaseid: DatabaseTournament.CurrentPhaseId,
            rankposition: 0,
            sameposition: 0,
            totalpoints: 0,
            totalrounds: 0,
          },
        ],
        FinalPlace: 0,
      });
    }

    const TournamentObject = DatabaseUser.Tournaments.get(TournamentId)!;

    if (TournamentObject.PartyCode === "" || TournamentObject.PartyCode === undefined || req.body.recreate === 1) {
      TournamentObject.PartyCode = await GeneratePartyCode();
    }

    const AlreadyInParty = TournamentObject.PartyMembers.some((member) => member.UserId === DatabaseUser.UserId);

    if (!AlreadyInParty) {
      TournamentObject.PartyMembers.push({
        UserId: DatabaseUser.UserId,
        Username: DatabaseUser.Username,
        Status: 1,
        IsPartyLeader: true,
        IsKicked: false,
      });
    }

    await DatabaseUser.save();

    return res.status(200).json({
      status: TournamentCreatePartyCodeStatus.Ok,
      partyCode: TournamentObject.PartyCode,
      tournamentId: TournamentId,
    });
  }
);

export default {
  App,
  DefaultAPI: "/api/v1",
};
