import { Router } from "express";
import j from "joi";
import { ValidateBody, ValidateHeaders } from "../../Modules/Middleware";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { msg } from "../../Modules/Logger";

const App = Router();

const ChangeNickSchema = j
  .object({
    backbone_app_id: j.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": j.string().required(),
  })
  .unknown(true);

const ChangeNickBodySchema = j
  .object({
    accessToken: j.string().required(),
    nickName: j.string().required(),
  })
  .unknown(true);

App.post("/userChangeNick", ValidateHeaders(ChangeNickSchema), ValidateBody(ChangeNickBodySchema), async (req, res) => {
  const LoginProviderUser = await LPUser.findOne({
    AccessToken: req.body.accessToken,
  });

  if (!LoginProviderUser) {
    return res.status(401).json({});
  }

  const DatabaseUser = await BackboneUser.findOne({ UserId: LoginProviderUser.UserId });
  if (!DatabaseUser) {
    return res.status(401).json({});
  }

  if (req.body.nickName.toString().length > 32 && req.body.nickName.toString().includes("<size>")) {
    msg("[Tournament SDK AC Logs]: possible username spoof detected. username: " + req.body.nickName.toString());
    return res.status(401).json({});
  }

  if (LoginProviderUser.Nickname != req.body.nickName.toString()) {
    const newNickname = req.body.nickName.toString();
    const userId = DatabaseUser.UserId;

    LoginProviderUser.Nickname = newNickname;
    DatabaseUser.Username = newNickname;

    DatabaseUser.Tournaments.forEach((tournamentData) => {
      tournamentData.PartyMembers.forEach((member) => {
        if (member.UserId === userId) {
          member.Username = newNickname;
        }
      });
    });

    await LoginProviderUser.save();
    await DatabaseUser.save();
    await BackboneUser.updateMany(
      { [`Tournaments.$[].PartyMembers`]: { $elemMatch: { UserId: userId } } },
      { $set: { "Tournaments.$[].PartyMembers.$[member].Username": newNickname } },
      { arrayFilters: [{ "member.UserId": userId }] }
    );
  }

  return res.status(200).json({
    nickName: req.body.nickName,
  });
});

export default {
  App,
  DefaultAPI: "/api/v1",
};
