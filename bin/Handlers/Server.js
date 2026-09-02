"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mongoose = exports.App = void 0;
const tslib_1 = require("tslib");
const express_1 = tslib_1.__importDefault(require("express"));
const promises_1 = tslib_1.__importDefault(require("fs/promises"));
const path_1 = tslib_1.__importDefault(require("path"));
const cors_1 = tslib_1.__importDefault(require("cors"));
const helmet_1 = tslib_1.__importDefault(require("helmet"));
const Constants_1 = require("../Modules/Constants");
const Logger_1 = require("../Modules/Logger");
const colorette_1 = require("colorette");
const Errors_1 = require("../Modules/Errors");
const Extensions_1 = require("../Modules/Extensions");
const mongoose_1 = tslib_1.__importDefault(require("mongoose"));
exports.mongoose = mongoose_1.default;
const Config_1 = require("../Backbone/Config");
const Resolving_1 = require("../Backbone/Logic/Internal/Resolving");
const Bot_1 = require("./Bot");
const Scheduler_1 = require("./Scheduler");
const Deleter_1 = require("./Deleter");
const AllowedOrigins = new Set(String(process.env.BACKBONE_ALLOWED_ORIGINS || "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean));
exports.App = (0, express_1.default)()
    .disable("etag")
    .disable("x-powered-by")
    .use((0, helmet_1.default)())
    .use(express_1.default.json({ limit: Constants_1.BODY_SIZE_LIMIT }))
    .use(express_1.default.urlencoded({ limit: Constants_1.BODY_SIZE_LIMIT, extended: false }))
    .use((0, cors_1.default)({
    origin(origin, callback) {
        if (!origin || AllowedOrigins.size === 0 && Constants_1.IS_DEBUG || (origin && AllowedOrigins.has(origin)))
            return callback(null, true);
        return callback(new Error("Origin not allowed"));
    },
}));
// .use(EncryptResponse);
function createDate(year, month, day, hours, minutes = 0) {
    return new Date(year, month - 1, day, hours, minutes, 0, 0);
}
function MakeGradient() {
    const BaseHue = Math.floor(Math.random() * 360);
    const BaseSaturation = 70 + Math.random() * 20;
    const BaseLightness = 50 + Math.random() * 15;
    const EndHue = (BaseHue + 15 + Math.random() * 30) % 360;
    const EndSaturation = BaseSaturation + (Math.random() * 10 - 5);
    const EndLightness = BaseLightness + (Math.random() * 20 - 10);
    return [ConvertToHex(BaseHue, BaseSaturation, BaseLightness), ConvertToHex(EndHue, EndSaturation, EndLightness)];
}
function ConvertToHex(H, S, L) {
    const Saturation = S / 100;
    const Lightness = L / 100;
    const C = (1 - Math.abs(2 * Lightness - 1)) * Saturation;
    const X = C * (1 - Math.abs(((H / 60) % 2) - 1));
    const M = Lightness - C / 2;
    let R = 0, G = 0, B = 0;
    if (H >= 0 && H < 60) {
        R = C;
        G = X;
        B = 0;
    }
    else if (H >= 60 && H < 120) {
        R = X;
        G = C;
        B = 0;
    }
    else if (H >= 120 && H < 180) {
        R = 0;
        G = C;
        B = X;
    }
    else if (H >= 180 && H < 240) {
        R = 0;
        G = X;
        B = C;
    }
    else if (H >= 240 && H < 300) {
        R = X;
        G = 0;
        B = C;
    }
    else {
        R = C;
        G = 0;
        B = X;
    }
    const ToHex = (V) => Math.round((V + M) * 255)
        .toString(16)
        .padStart(2, "0");
    return `#${ToHex(R)}${ToHex(G)}${ToHex(B)}`;
}
async function LoadRoutes(Dir, Routes = []) {
    const Entries = await promises_1.default.readdir(Dir, { withFileTypes: true });
    await Promise.all(Entries.map(async (Entry) => {
        const FullPath = path_1.default.join(Dir, Entry.name);
        if (Entry.isDirectory()) {
            await LoadRoutes(FullPath, Routes);
        }
        else if (Entry.isFile() && (Entry.name.endsWith(".ts") || Entry.name.endsWith(".js"))) {
            try {
                const Module = await Promise.resolve(`${path_1.default.resolve(FullPath)}`).then(s => tslib_1.__importStar(require(s)));
                if (Module.default?.App) {
                    Routes.push({ Path: Entry.name, Module: Module.default });
                }
            }
            catch (Err) {
                (0, Logger_1.warn)(`Failed loading ${(0, colorette_1.italic)(FullPath)}: ${Err.message}`);
            }
        }
    }));
    return Routes;
}
async function Start() {
    // Resolve a partir do servidor executado, não do current working directory.
    // Isso evita que Render/Discloud procure as rotas em uma pasta errada.
    const RoutesDir = path_1.default.resolve(__dirname, "..", "Routes");
    console.log(`[Server] Loading routes from ${RoutesDir}`);
    const DatabaseUri = String(process.env.DATABASE_URI || process.env.MONGODB_URI || process.env.mongoUri || "").trim();
    if (!DatabaseUri) {
        throw new Error("DATABASE_URI (ou MONGODB_URI) precisa ser configurado antes de iniciar o Backbone");
    }
    const [DbConnection, RoutesList] = await Promise.all([
        mongoose_1.default.connect(DatabaseUri, {
            tls: true,
            ...(process.env.MONGO_ALLOW_INVALID_TLS === "true" ? { tlsAllowInvalidCertificates: true, rejectUnauthorized: false } : {}),
            heartbeatFrequencyMS: 10000,
            family: 4,
        }),
        LoadRoutes(RoutesDir),
    ]);
    exports.App.use((Req, Res, Next) => {
        if (Config_1.IS_MAINTENANCE) {
            return Res.status(503).json({
                message: "Servers are currently on maintenance. Please try again later.",
            });
        }
        Next();
    });
    exports.App.use(Extensions_1.Register);
    for (const { Path, Module } of RoutesList) {
        const MountPath = Module.DefaultAPI || "/";
        exports.App.use(MountPath, Module.App);
        const [Start, End] = MakeGradient();
        (0, Logger_1.msg)(`Loaded ${(0, colorette_1.italic)((0, Logger_1.toGradient)(Path, Start, End))}`);
    }
    // Painel/site foi separado deste projeto — rotas /api/v1 e /api/v2 da Backbone já foram montadas acima.
    exports.App.use((Req, Res) => Res.error(Errors_1.E_NotFound, Req.path));
    exports.App.use((Err, Req, Res, Next) => {
        console.error(Err);
        Res.error(Errors_1.E_ServerError);
    });
    (0, Logger_1.msg)(`Connected to ${(0, colorette_1.gray)(Constants_1.PROJECT_NAME)} database`);
    const DiscordToken = (0, Bot_1.GetDiscordToken)();
    if (!DiscordToken) {
        throw new Error("BOT_TOKEN (ou DISCORD_TOKEN) precisa ser configurado no Backbone");
    }
    await Bot_1.Bot.login(DiscordToken);
    exports.App.listen(Constants_1.PORT, () => {
        const [Start, End] = MakeGradient();
        (0, Resolving_1.StartLoop)();
        (0, Logger_1.msg)(`${(0, Logger_1.toGradient)(Constants_1.PROJECT_NAME, Start, End)} running on port ${(0, colorette_1.magenta)(Constants_1.PORT.toString())} ${Constants_1.IS_DEBUG ? (0, colorette_1.red)("(debug)") : ""}`);
    });
    // Auto-create on boot REMOVED — was flooding the list with duplicate
    // "(.gg/stumble) 1v1 Block Dash - SA" cards on every restart.
    // Create tournaments via bot / scheduler instead.
    Scheduler_1.TournamentScheduler.Start();
    Deleter_1.TournamentCleaner.Start();
}
Start().catch((Err) => {
    console.error("Tournament-SDK initialization failed :( --> (cause):", Err);
    process.exit(1);
});
//# sourceMappingURL=Server.js.map
