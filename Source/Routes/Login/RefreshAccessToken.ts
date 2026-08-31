import { Router } from "express";
import j from "joi";
import { ValidateBody, ValidateHeaders } from "../../Modules/Middleware";
import { LPUser } from "../../Models/LPUser";
import { BackboneUser } from "../../Models/BackboneUser";
import { JWT_SECRET } from "../../Backbone/Config";
import jwt from "jsonwebtoken";

const App = Router();

const RefreshSchema = j
  .object({
    backbone_app_id: j.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": j.string().required(),
  })
  .unknown(true);

const RefreshBodySchema = j
  .object({
    accessToken: j.string().required(),
    refreshToken: j.string().required(),
    deviceId: j.string().required(),
  })
  .unknown(true);

App.post("/refreshAccessToken", ValidateHeaders(RefreshSchema), ValidateBody(RefreshBodySchema), async (req, res) => {
  const LoginProviderUser = await LPUser.findOne({
    DeviceIdentifier: req.body.deviceId,
    AccessToken: req.body.accessToken,
  });

  if (!LoginProviderUser) {
    return res.status(401).json({});
  }

  const DatabaseUser = await BackboneUser.findOne({ UserId: LoginProviderUser.UserId });
  if (!DatabaseUser) {
    const NewUser = new BackboneUser({
      Username: LoginProviderUser.Nickname,
      UserId: LoginProviderUser.UserId,
      Tournaments: {},
    });
    await NewUser.save();
  }

  const Payload = {
    userid: LoginProviderUser.UserId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  };
  const RefreshPayload = {
    userid: LoginProviderUser.UserId,
    iat: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    exp: Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60,
  };

  LoginProviderUser.AccessToken = jwt.sign(Payload, JWT_SECRET);
  LoginProviderUser.ExpireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  LoginProviderUser.RefreshToken = jwt.sign(RefreshPayload, JWT_SECRET);
  await LoginProviderUser.save();

  return res.status(200).json({
    accessToken: LoginProviderUser.AccessToken.toString(),
    expireAt: LoginProviderUser.ExpireAt,
    refreshToken: LoginProviderUser.RefreshToken.toString(),
  });
});

export default {
  App,
  DefaultAPI: "/api/v1",
};
