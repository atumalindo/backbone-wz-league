import { Router } from "express";
import j from "joi";
import { ValidateBody, ValidateHeaders } from "../../Modules/Middleware";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { randomBytes } from "crypto";
import { Types } from "mongoose";
import { MongoServerError } from "mongodb";

const App = Router();

const UserGetSchema = j
  .object({
    backbone_app_id: j.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": j.string().required(),
    access_token: j.string().required(),
  })
  .unknown(true);

const UserBodySchema = j
  .object({
    lastUpdate: j.date().required(),
    lastSync: j.date().required(),
    generateQuests: j.number().required(),
    getQuests: j.number().required(),
    getTiles: j.number().required(),
    getLayouts: j.number().required(),
    accessToken: j.string().required(),
  })
  .unknown(true);

App.post("/userGet", ValidateHeaders(UserGetSchema), ValidateBody(UserBodySchema), async (req, res) => {
  const User = await LPUser.findOne({ AccessToken: req.body.accessToken });
  if (!User) return res.status(401).json({ message: "unauthorized." });

  const DatabaseBackboneUser = await BackboneUser.findOne({ UserId: User.UserId });
  if (!DatabaseBackboneUser) {
    try {
      const NewUser = new BackboneUser({
        Username: User.Nickname,
        UserId: User.UserId,
        TournamentsWon: 0,
        Tournaments: {},
      });
      await NewUser.save();
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000)) {
        throw error;
      }
    }
  }
  if (DatabaseBackboneUser && DatabaseBackboneUser.Username != User.Nickname) {
    DatabaseBackboneUser.Username = User.Nickname;
    await DatabaseBackboneUser.save();
  }
  const ScheduleTime = new Date(Date.now() + 67 * 60 * 60 * 1000).toISOString();

  const Response = {
    ban: false,
    createdAt: (User._id as Types.ObjectId).getTimestamp().toISOString(),
    csseed: "0",
    psseed: "0",
    currencies: [],
    firstname: null,
    id: User.UserId.toString(),
    lastname: null,
    lastsync: req.body.lastSync || new Date().toISOString(),
    properties: [],
    logins: [
      {
        platformId: User.UserId.toString(),
        platformType: 7,
      },
    ],
    nick: User.Nickname || "",
    nickhashnumber: 1,
    ntfupdatedat: null,
    rank: 0,
    remainingReports: 4,
    reportsResetAt: ScheduleTime,
    season: 1,
    seasonday: 1,
    seasonid: null,
    seasonprogress: 0,
    seasonseedend: ScheduleTime,
    serverutc: new Date().toISOString(),
    tileWallLayouts: [],
    tiles: [],
    urpupdatedat: null,
    usersettingdata: {
      "user-data": {
        "@language": "en",
        properties: null,
      },
    },
    worldrank: 0,
  };

  return res.status(200).json(Response);
});

export default {
  App,
  DefaultAPI: "/api/v1",
};
