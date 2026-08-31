import e, { NextFunction, Request, Response } from "express";
import fs from "fs/promises";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import { BODY_SIZE_LIMIT, IS_DEBUG, PORT, PROJECT_NAME } from "../Modules/Constants";
import { msg, warn, toGradient } from "../Modules/Logger";
import { gray, italic, magenta, red } from "colorette";
import { E_NotFound, E_ServerError } from "../Modules/Errors";
import { Register } from "../Modules/Extensions";
import mongoose from "mongoose";
import { IS_MAINTENANCE } from "../Backbone/Config";
import { StartLoop } from "../Backbone/Logic/Internal/Resolving";
import { Bot, GetDiscordToken } from "./Bot";
import { EncryptResponse } from "../Modules/Middleware";
import { TournamentScheduler } from "./Scheduler";
import { TournamentCleaner } from "./Deleter";

const AllowedOrigins = new Set(
  String(process.env.BACKBONE_ALLOWED_ORIGINS || "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
);

export const App = e()
  .disable("etag")
  .disable("x-powered-by")
  .use(helmet())
  .use(e.json({ limit: BODY_SIZE_LIMIT }))
  .use(e.urlencoded({ limit: BODY_SIZE_LIMIT, extended: false }))
  .use(cors({
    origin(origin, callback) {
      if (!origin || AllowedOrigins.size === 0 && IS_DEBUG || (origin && AllowedOrigins.has(origin))) return callback(null, true);
      return callback(new Error("Origin not allowed"));
    },
  }));
// .use(EncryptResponse);

function createDate(year: number, month: number, day: number, hours: number, minutes: number = 0): Date {
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function MakeGradient(): [string, string] {
  const BaseHue = Math.floor(Math.random() * 360);
  const BaseSaturation = 70 + Math.random() * 20;
  const BaseLightness = 50 + Math.random() * 15;

  const EndHue = (BaseHue + 15 + Math.random() * 30) % 360;
  const EndSaturation = BaseSaturation + (Math.random() * 10 - 5);
  const EndLightness = BaseLightness + (Math.random() * 20 - 10);

  return [ConvertToHex(BaseHue, BaseSaturation, BaseLightness), ConvertToHex(EndHue, EndSaturation, EndLightness)];
}

function ConvertToHex(H: number, S: number, L: number): string {
  const Saturation = S / 100;
  const Lightness = L / 100;

  const C = (1 - Math.abs(2 * Lightness - 1)) * Saturation;
  const X = C * (1 - Math.abs(((H / 60) % 2) - 1));
  const M = Lightness - C / 2;

  let R = 0,
    G = 0,
    B = 0;

  if (H >= 0 && H < 60) {
    R = C;
    G = X;
    B = 0;
  } else if (H >= 60 && H < 120) {
    R = X;
    G = C;
    B = 0;
  } else if (H >= 120 && H < 180) {
    R = 0;
    G = C;
    B = X;
  } else if (H >= 180 && H < 240) {
    R = 0;
    G = X;
    B = C;
  } else if (H >= 240 && H < 300) {
    R = X;
    G = 0;
    B = C;
  } else {
    R = C;
    G = 0;
    B = X;
  }

  const ToHex = (V: number) =>
    Math.round((V + M) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${ToHex(R)}${ToHex(G)}${ToHex(B)}`;
}

async function LoadRoutes(
  Dir: string,
  Routes: Array<{ Path: string; Module: any }> = []
): Promise<Array<{ Path: string; Module: any }>> {
  const Entries = await fs.readdir(Dir, { withFileTypes: true });

  await Promise.all(
    Entries.map(async (Entry) => {
      const FullPath = path.join(Dir, Entry.name);

      if (Entry.isDirectory()) {
        await LoadRoutes(FullPath, Routes);
      } else if (Entry.isFile() && (Entry.name.endsWith(".ts") || Entry.name.endsWith(".js"))) {
        try {
          const Module = await import(path.resolve(FullPath));
          if (Module.default?.App) {
            Routes.push({ Path: Entry.name, Module: Module.default });
          }
        } catch (Err) {
          warn(`Failed loading ${italic(Entry.name)}: ${(Err as Error).message}`);
        }
      }
    })
  );

  return Routes;
}

async function Start() {
  const RoutesDir = path.join(".", Symbol.for("ts-node.register.instance") in process ? "Source" : "bin", "Routes");
  const DatabaseUri = String(process.env.DATABASE_URI || process.env.MONGODB_URI || process.env.mongoUri || "").trim();
  if (!DatabaseUri) {
    throw new Error("DATABASE_URI (ou MONGODB_URI) precisa ser configurado antes de iniciar o Backbone");
  }

  const [DbConnection, RoutesList] = await Promise.all([
    mongoose.connect(DatabaseUri, {
      tls: true,
      ...(process.env.MONGO_ALLOW_INVALID_TLS === "true" ? { tlsAllowInvalidCertificates: true, rejectUnauthorized: false } : {}),
      heartbeatFrequencyMS: 10000,
      family: 4,
    }),
    LoadRoutes(RoutesDir),
  ]);

  App.use((Req: Request, Res: Response, Next: NextFunction) => {
    if (IS_MAINTENANCE) {
      return Res.status(503).json({
        message: "Servers are currently on maintenance. Please try again later.",
      });
    }
    Next();
  });

  App.use(Register);

    for (const { Path, Module } of RoutesList) {
    const MountPath = Module.DefaultAPI || "/";
    App.use(MountPath, Module.App);
    const [Start, End] = MakeGradient();
    msg(`Loaded ${italic(toGradient(Path, Start, End))}`);
  }
  // Painel/site foi separado deste projeto — rotas /api/v1 e /api/v2 da Backbone já foram montadas acima.
  App.use((Req, Res) => Res.error(E_NotFound, Req.path));

  App.use((Err: Error, Req: Request, Res: Response, Next: NextFunction) => {
    console.error(Err);
    Res.error(E_ServerError);
  });

  msg(`Connected to ${gray(PROJECT_NAME)} database`);
  const DiscordToken = GetDiscordToken();
  if (!DiscordToken) {
    throw new Error("BOT_TOKEN (ou DISCORD_TOKEN) precisa ser configurado no Backbone");
  }
  await Bot.login(DiscordToken);
  App.listen(PORT, () => {
    const [Start, End] = MakeGradient();
    StartLoop();
    msg(
      `${toGradient(PROJECT_NAME, Start, End)} running on port ${magenta(PORT.toString())} ${
        IS_DEBUG ? red("(debug)") : ""
      }`
    );
  });

  // Auto-create on boot REMOVED — was flooding the list with duplicate
  // "(.gg/stumble) 1v1 Block Dash - SA" cards on every restart.
  // Create tournaments via bot / scheduler instead.

  TournamentScheduler.Start();
  TournamentCleaner.Start();
}

Start().catch((Err) => {
  console.error("Tournament-SDK initialization failed :( --> (cause):", Err);
  process.exit(1);
});

export { mongoose };
