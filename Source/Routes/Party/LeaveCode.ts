import { Router } from "express";
import { TournamentAcceptPartyStatus, TournamentCreatePartyCodeStatus } from "../../Backbone/Config";
import j from "joi";
import { ValidateBody, ValidateHeaders } from "../../Modules/Middleware";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { Tournament } from "../../Models/Tournament";

const App = Router();

const LeaveCodeSchema = j
  .object({
    backbone_app_id: j.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const LeaveBodySchema = j
  .object({
    tournamentId: j.number().required(),
    removeUserId: j.string().required(),
    accessToken: j.string().required(),
  })
  .unknown(true);

App.post(
  "/tournamentPartyRemoveUser",
  ValidateHeaders(LeaveCodeSchema),
  ValidateBody(LeaveBodySchema),
  async (req, res) => {
    try {
      const { accessToken, tournamentId, removeUserId } = req.body;

      const LoginProviderUser = await LPUser.findOne({ AccessToken: accessToken });
      const DatabaseTournament = await Tournament.findOne({ TournamentId: tournamentId });

      if (!LoginProviderUser || !DatabaseTournament) {
        return res.json({
          status: TournamentAcceptPartyStatus.InviteNotExits,
          tournamentId,
        });
      }

      if (new Date() >= new Date(DatabaseTournament.StartTime)) {
        return res.json({
          status: TournamentCreatePartyCodeStatus.NotAttempted,
          tournamentId,
        });
      }

      const DatabaseUser = await BackboneUser.findOne({ UserId: LoginProviderUser.UserId });
      if (!DatabaseUser) {
        return res.json({
          status: TournamentCreatePartyCodeStatus.Unknown,
          tournamentId,
        });
      }

      const TournamentInfo = await DatabaseUser.Tournaments.get(DatabaseTournament.TournamentId.toString());
      if (!TournamentInfo) {
        return res.json({
          status: TournamentCreatePartyCodeStatus.Unknown,
          tournamentId,
        });
      }

      if (DatabaseUser.UserId == removeUserId.toString()) {
        const isLeader =
          TournamentInfo.PartyMembers.length > 0 &&
          TournamentInfo.PartyMembers.find((l) => l.IsPartyLeader === true)?.UserId === DatabaseUser.UserId;

        if (isLeader) {
          for (const Member of TournamentInfo.PartyMembers) {
            const RefreshedUser = await BackboneUser.findOne({ UserId: Member.UserId });
            if (RefreshedUser) {
              const RefreshedTournamentInfo = await RefreshedUser.Tournaments.get(
                DatabaseTournament.TournamentId.toString()
              );
              if (RefreshedTournamentInfo) {
                RefreshedTournamentInfo.PartyCode = "";
                RefreshedTournamentInfo.PartyMembers = [
                  {
                    UserId: RefreshedUser.UserId,
                    Username: RefreshedUser.Username,
                    Status: 1,
                    IsPartyLeader: true,
                    IsKicked: false,
                  },
                ];
                await RefreshedUser.save();
              }
            }
          }
        } else {
          for (const Member of TournamentInfo.PartyMembers) {
            const RefreshedUser = await BackboneUser.findOne({ UserId: Member.UserId });
            if (RefreshedUser) {
              const RefreshedTournamentInfo = await RefreshedUser.Tournaments.get(
                DatabaseTournament.TournamentId.toString()
              );
              if (RefreshedTournamentInfo) {
                RefreshedTournamentInfo.PartyMembers = RefreshedTournamentInfo.PartyMembers.filter(
                  (me) => me.UserId !== removeUserId
                );
                if (RefreshedUser.UserId === removeUserId) {
                  RefreshedTournamentInfo.PartyCode = "";
                  RefreshedTournamentInfo.PartyMembers = [
                    {
                      UserId: RefreshedUser.UserId,
                      Username: RefreshedUser.Username,
                      Status: 1,
                      IsPartyLeader: true,
                      IsKicked: false,
                    },
                  ];
                }
                await RefreshedUser.save();
              }
            }
          }
        }

        return res.json({
          status: TournamentCreatePartyCodeStatus.Ok,
          tournamentId,
        });
      } else {
        const isLeader =
          TournamentInfo.PartyMembers.find((l) => l.IsPartyLeader === true)?.UserId === DatabaseUser.UserId;

        if (!isLeader) {
          return res.json({
            status: TournamentCreatePartyCodeStatus.Unknown,
            tournamentId,
          });
        }

        for (const Member of TournamentInfo.PartyMembers) {
          const RefreshedUser = await BackboneUser.findOne({ UserId: Member.UserId });
          if (RefreshedUser) {
            const RefreshedTournamentInfo = await RefreshedUser.Tournaments.get(
              DatabaseTournament.TournamentId.toString()
            );
            if (RefreshedTournamentInfo) {
              RefreshedTournamentInfo.PartyMembers = RefreshedTournamentInfo.PartyMembers.filter(
                (me) => me.UserId !== removeUserId
              );
              if (RefreshedUser.UserId === removeUserId) {
                RefreshedTournamentInfo.PartyCode = "";
                RefreshedTournamentInfo.PartyMembers = [
                  {
                    UserId: RefreshedUser.UserId,
                    Username: RefreshedUser.Username,
                    Status: 1,
                    IsPartyLeader: true,
                    IsKicked: false,
                  },
                ];
              }
              await RefreshedUser.save();
            }
          }
        }

        return res.json({
          status: TournamentCreatePartyCodeStatus.Ok,
          tournamentId,
        });
      }
    } catch {
      return res.json({
        status: TournamentCreatePartyCodeStatus.Unknown,
        tournamentId: req.body?.tournamentId ?? "",
      });
    }
  }
);

export default {
  App,
  DefaultAPI: "/api/v1",
};
