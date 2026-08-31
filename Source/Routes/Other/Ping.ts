import { Router } from "express";
import j from "joi";
import { ValidateHeaders } from "../../Modules/Middleware";

const App = Router();
const PingSchema = j
  .object({
    backbone_app_id: j.string().required().valid("8561191D-03B7-423E-B779-D2F6E77A3A45"),
    "x-unity-version": j.string().required(),
  })
  .unknown(true);

App.get("/ping", ValidateHeaders(PingSchema), async (req, res) => {
  return res.json({ message: "pong" }).status(200);
});
export default {
  App,
  DefaultAPI: "/api/v1",
};
