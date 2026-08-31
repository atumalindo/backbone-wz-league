import { Router } from "express";
import { ForService, ServiceType } from "../Modules/Service";

const App = Router();

App.use(ForService(ServiceType.Public));

App.get("/", (_, res) => {
  // O site (painel público + /admin) virou um projeto separado.
  res.json({ ok: true, service: "Tournament-SDK backend" });
});

App.post("/", (_, res) => res.send("Tournament-SDK | Made by nxz9"));

export default {
  App,
  DefaultAPI: "/",
};
