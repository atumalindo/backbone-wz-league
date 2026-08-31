"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const Service_1 = require("../Modules/Service");
const App = (0, express_1.Router)();
App.use((0, Service_1.ForService)(Service_1.ServiceType.Public));
App.get("/", (_, res) => {
    // O site (painel público + /admin) virou um projeto separado.
    res.json({ ok: true, service: "Tournament-SDK backend" });
});
App.post("/", (_, res) => res.send("Tournament-SDK | Made by nxz9"));
exports.default = {
    App,
    DefaultAPI: "/",
};
//# sourceMappingURL=Root.js.map