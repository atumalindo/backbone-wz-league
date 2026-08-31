import { Router } from "express";
import { TournamentAcceptPartyStatus, TournamentUserStatus } from "../../Backbone/Config";
import j from "joi";
import { ValidateBody, ValidateHeaders } from "../../Modules/Middleware";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { Tournament } from "../../Models/Tournament";
import { GetTournamentFormat } from "../../Backbone/Logic/TournamentRules";

const App = Router();

const JoinCodeSchema = j
  .object({
    backbone_app_id: j.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const JoinBodySchema = j
  .object({
    tournamentId: j.number().required(),
    partyCode: j.string().required(),
    accessToken: j.string().required(),
  })
  .unknown(true);

App.post(
  "/tournamentPartyJoinByCode",
  ValidateHeaders(JoinCodeSchema),
  ValidateBody(JoinBodySchema),
  async (req, res) => {
    const TournamentId = req.body.tournamentId.toString();
    const PartyCode = req.body.partyCode.toString().toUpperCase();
    const AccessToken = req.body.accessToken;

    const [DatabaseTournament, LoginProviderUser] = await Promise.all([
      Tournament.findOne({ TournamentId }),
      LPUser.findOne({ AccessToken }),
    ]);

    if (!DatabaseTournament || !LoginProviderUser) {
      return res.status(200).json({
        status: TournamentAcceptPartyStatus.UserIsNotSignedUp,
        tournamentId: TournamentId,
      });
    }

    const [DatabaseUser, PartyLeader] = await Promise.all([
      BackboneUser.findOne({ UserId: LoginProviderUser.UserId }),
      BackboneUser.findOne({
        UserId: { $ne: LoginProviderUser.UserId },
        [`Tournaments.${TournamentId}.PartyCode`]: PartyCode,
        [`Tournaments.${TournamentId}.SignedUp`]: true,
      }),
    ]);

    if (!DatabaseUser || !DatabaseUser.Tournaments) {
      return res.status(200).json({
        status: TournamentAcceptPartyStatus.UserIsNotSignedUp,
        tournamentId: TournamentId,
      });
    }

    const UserTournamentData = DatabaseUser.Tournaments.get(TournamentId);

    if (!UserTournamentData || !UserTournamentData.SignedUp) {
      return res.status(200).json({
        status: TournamentAcceptPartyStatus.UserIsNotSignedUp,
        tournamentId: TournamentId,
      });
    }

    if (UserTournamentData.PartyCode && UserTournamentData.PartyCode !== "") {
      return res.status(200).json({
        status: TournamentAcceptPartyStatus.NotAttempted,
        tournamentId: TournamentId,
      });
    }

    if (!PartyLeader) {
      return res.status(200).json({
        status: TournamentAcceptPartyStatus.InviteNotExits,
        tournamentId: TournamentId,
      });
    }

    const PartyLeaderTournamentData = PartyLeader.Tournaments.get(TournamentId);

    if (!PartyLeaderTournamentData) {
      return res.status(200).json({
        status: TournamentAcceptPartyStatus.InviteNotExits,
        tournamentId: TournamentId,
      });
    }

    const HasPartyLeader = PartyLeaderTournamentData.PartyMembers.some((member) => member.IsPartyLeader);

    if (!HasPartyLeader) {
      return res.status(200).json({
        status: TournamentAcceptPartyStatus.PartyNoLongerExits,
        tournamentId: TournamentId,
      });
    }

    const IsAlreadyInParty =
      PartyLeaderTournamentData.PartyMembers.length > 1 &&
      PartyLeaderTournamentData.PartyMembers.some(
        (member) => member.UserId.toString() === DatabaseUser.UserId.toString()
      );

    if (IsAlreadyInParty) {
      return res.status(200).json({
        status: TournamentAcceptPartyStatus.Unknown,
        tournamentId: TournamentId,
      });
    }

    const CurrentPartySize = PartyLeaderTournamentData.PartyMembers.length;

    if (CurrentPartySize >= GetTournamentFormat(DatabaseTournament).playersPerTeam) {
      return res.status(200).json({
        status: TournamentAcceptPartyStatus.PartyIsFull,
        tournamentId: TournamentId,
      });
    }

    const NewMember = {
      UserId: DatabaseUser.UserId,
      Username: DatabaseUser.Username,
      Status: TournamentUserStatus.Confirmed,
      IsPartyLeader: false,
      IsKicked: false,
    };

    PartyLeaderTournamentData.PartyMembers.push(NewMember);
    PartyLeader.markModified(`Tournaments.${TournamentId}.PartyMembers`);
    UserTournamentData.PartyCode = PartyCode;
    UserTournamentData.PartyMembers = JSON.parse(JSON.stringify(PartyLeaderTournamentData.PartyMembers));
    DatabaseUser.markModified(`Tournaments.${TournamentId}.PartyMembers`);

    interface PartyMember {
      UserId: string;
      Username: string;
      Status: TournamentUserStatus;
      IsPartyLeader: boolean;
    }

    const UpdatedPartyMembers: PartyMember[] = JSON.parse(JSON.stringify(PartyLeaderTournamentData.PartyMembers));
    const AllPartyMemberIds: string[] = UpdatedPartyMembers.map((m: PartyMember) => m.UserId);

    await Promise.all([
      PartyLeader.save(),
      DatabaseUser.save(),
      BackboneUser.updateMany(
        {
          UserId: { $in: AllPartyMemberIds, $nin: [PartyLeader.UserId, DatabaseUser.UserId] },
          [`Tournaments.${TournamentId}`]: { $exists: true },
        },
        {
          $set: {
            [`Tournaments.${TournamentId}.PartyMembers`]: UpdatedPartyMembers,
          },
        }
      ),
    ]);

    return res.status(200).json({
      status: TournamentAcceptPartyStatus.Ok,
      tournamentId: TournamentId,
    });
  }
);

export default {
  App,
  DefaultAPI: "/api/v1",
};
