import j from "joi";
import { Request, Response, Router } from "express";
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

function GetRefreshUserId(Token: string): string | null {
  try {
    const Payload = jwt.verify(Token, JWT_SECRET);
    if (!Payload || typeof Payload === "string" || Payload.userid == null) return null;
    return String(Payload.userid);
  } catch {
    return null;
  }
}

App.post(
  "/refreshAccessToken",
  ValidateHeaders(RefreshSchema),
  ValidateBody(RefreshBodySchema),
  async (req: Request, res: Response) => {
    try {
      const DeviceId = String(req.body.deviceId);
      const RefreshToken = String(req.body.refreshToken);
      const RefreshUserId = GetRefreshUserId(RefreshToken);

      if (!RefreshUserId) return res.status(401).json({});

      // O access token pode estar expirado justamente quando o client chama
      // refresh. A credencial que precisa ser conferida aqui é o refresh token
      // persistido para o mesmo dispositivo e usuário.
      const LoginProviderUser = await LPUser.findOne({
        DeviceIdentifier: DeviceId,
        RefreshToken,
      });

      if (!LoginProviderUser || String(LoginProviderUser.UserId) !== RefreshUserId) {
        return res.status(401).json({});
      }

      let DatabaseUser = await BackboneUser.findOne({ UserId: LoginProviderUser.UserId });
      if (!DatabaseUser) {
        const NewUser = new BackboneUser({
          Username: LoginProviderUser.Nickname,
          UserId: LoginProviderUser.UserId,
          Tournaments: {},
        });
        DatabaseUser = await NewUser.save();
      }

      const Now = Math.floor(Date.now() / 1000);
      const Payload = {
        userid: LoginProviderUser.UserId,
        iat: Now,
        exp: Now + 7 * 24 * 60 * 60,
      };
      const NewRefreshPayload = {
        userid: LoginProviderUser.UserId,
        iat: Now,
        exp: Now + 14 * 24 * 60 * 60,
      };

      LoginProviderUser.AccessToken = jwt.sign(Payload, JWT_SECRET);
      LoginProviderUser.ExpireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      LoginProviderUser.RefreshToken = jwt.sign(NewRefreshPayload, JWT_SECRET);
      await LoginProviderUser.save();

      return res.status(200).json({
        accessToken: LoginProviderUser.AccessToken.toString(),
        expireAt: LoginProviderUser.ExpireAt,
        refreshToken: LoginProviderUser.RefreshToken.toString(),
      });
    } catch (error) {
      console.error("[RefreshAccessToken] error:", error);
      return res.status(500).json({});
    }
  }
);

export default {
  App,
  DefaultAPI: "/api/v1",
};
