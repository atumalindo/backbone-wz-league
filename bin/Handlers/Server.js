/**
 * Tournament site — público (Discord login) + /admin (senha)
 * Config persiste no MongoDB (não some em redeploy)
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const PORT = process.env.PORT || 3000;
const INTEGRATED_IN_BACKBONE = process.env.BACKBONE_INTEGRATED === "true";
// Em serverless (Netlify Functions roda sobre AWS Lambda) o diretório do
// projeto é somente leitura — só /tmp é gravável. No Render/local, __dirname
// funciona normalmente. Isso é só um cache local best-effort; a fonte da
// verdade é sempre o MongoDB (SiteSettings / Template).
const IS_SERVERLESS = !!process.env.LAMBDA_TASK_ROOT;
const WRITABLE_DIR = IS_SERVERLESS ? "/tmp" : __dirname;
const CONFIG_PATH = path.join(WRITABLE_DIR, "admin-config.json");
const TEMPLATES_PATH = path.join(WRITABLE_DIR, "templates.json");
const FINISHED_HIDE_MS = 5 * 60 * 1000; // 5 minutos
const TOURNAMENT_CREATION_COST = Math.max(0, parseInt(process.env.TOURNAMENT_CREATION_COST || "1", 10) || 0);

function splitEnvList(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function configuredAdminDiscordIds() {
  return new Set(splitEnvList(process.env.DISCORD_ADMIN_IDS));
}

function isConfiguredDiscordAdmin(id) {
  return Boolean(id && configuredAdminDiscordIds().has(String(id)));
}

let SharedTournamentRules = null;
try {
  SharedTournamentRules = require("./Logic/TournamentRules.js");
} catch (_) {
  // Sem o módulo: usa os fallbacks locais definidos mais abaixo neste arquivo.
}
let BackboneWoModules = null;
function loadBackboneWoModules() {
  if (BackboneWoModules) return BackboneWoModules;
  const configured = process.env.BACKBONE_BIN_PATH || path.resolve(__dirname, "../../backbone-sem-site/backbone/bin");
  const root = path.resolve(configured);
  const allowedRoot = path.resolve(process.env.BACKBONE_BIN_PATH || path.resolve(__dirname, "../../backbone-sem-site/backbone/bin"));
  if (root !== allowedRoot) throw new Error("BACKBONE_BIN_PATH inválido");
  const safeRequire = (relativePath) => require(path.join(root, relativePath));
  const matches = safeRequire("Models/Matches.js");
  const users = safeRequire("Models/BackboneUser.js");
  const tournament = safeRequire("Models/Tournament.js");
  const logic = safeRequire("Backbone/Logic/GetMatches.js");
  BackboneWoModules = { Match: matches.Match, BackboneUser: users.BackboneUser, BackboneTournament: tournament.Tournament, Qualify: logic.Qualify };
  if (!BackboneWoModules.Match || !BackboneWoModules.BackboneUser || !BackboneWoModules.BackboneTournament) throw new Error("Módulos do Backbone incompletos");
  return BackboneWoModules;
}
// Credenciais e URLs sensíveis (Mongo, login do admin, webhook, backbone,
// Discord client id/secret) vêm SEMPRE do .env — não ficam mais no painel
// nem gravadas em arquivo/Mongo. O que continua editável pelo /admin
// (redirect uri, guild id, ids permitidos, cargos, link da ferramenta de
// capas) continua sendo salvo/persistido normalmente.
function envConfig() {
  return {
    backboneUrl: process.env.BACKBONE_URL || "",
    databaseUri: process.env.DATABASE_URI || "",
    webhookUri: process.env.WEBHOOK_URI || "",
    discordClientId: process.env.DISCORD_CLIENT_ID || "",
    discordClientSecret: process.env.DISCORD_CLIENT_SECRET || "",
    economyApiUrl: process.env.ECONOMY_API_URL || process.env.GEMS_API_URL || process.env.BACKEND_URL || "",
    economyInternalSecret: process.env.ECONOMY_INTERNAL_SECRET || "",
  };
}

function loadConfigFile() {
  const defaults = {
    ...envConfig(),
    discordRedirectUri: process.env.DISCORD_REDIRECT_URI || "",
    discordGuildId: process.env.DISCORD_GUILD_ID || "",
    allowedDiscordIds: [], // compatibilidade: não controla mais o acesso ao painel
    requiredDiscordRoleIds: [], // precisa ter pelo menos um destes cargos
    sessionSecret: process.env.SESSION_SECRET || "",
    coverToolUrl: process.env.COVER_TOOL_URL || "",
  };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      // Nunca lê segredos do arquivo local: sessão e credenciais vêm somente do .env.
      const { sessionSecret: _storedSessionSecret, ...editableFile } = file || {};
      return { ...defaults, ...editableFile, ...envConfig(), sessionSecret: defaults.sessionSecret };
    }
  } catch (_) {}
  if (!defaults.sessionSecret) {
    defaults.sessionSecret = crypto.randomBytes(32).toString("hex");
  }
  return defaults;
}

function saveConfigFile(cfg) {
  // Só o que é editável pelo painel vai pro backup local — credenciais do
  // .env nunca são gravadas em disco.
  const toSave = {
    discordRedirectUri: cfg.discordRedirectUri || "",
    discordGuildId: cfg.discordGuildId || "",
    allowedDiscordIds: cfg.allowedDiscordIds || [],
    requiredDiscordRoleIds: cfg.requiredDiscordRoleIds || [],
    coverToolUrl: cfg.coverToolUrl || "",
  };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2));
  } catch (e) {
    console.warn("[config] não gravou arquivo (filesystem read-only?):", e.message);
  }
}

let config = loadConfigFile();
if (process.env.SESSION_SECRET) {
  config.sessionSecret = process.env.SESSION_SECRET;
}
let dbConnected = false;
let dbError = null;
let dbConnectPromise = null;

// Conecta ao Mongo sob demanda e reaproveita a conexão entre invocações da
// mesma function "quente" (Netlify Functions reaproveita o container quando
// possível). Evita reconectar (e estourar limite de conexões) a cada request.
function ensureDbConnected() {
  if (dbConnected) return Promise.resolve(true);
  if (dbConnectPromise) return dbConnectPromise;
  const envUri = process.env.DATABASE_URI || "";
  if (!(envUri && String(envUri).includes("mongodb"))) return Promise.resolve(false);
  config.databaseUri = String(envUri).trim();
  dbConnectPromise = connectDb(config.databaseUri).finally(() => {
    dbConnectPromise = null;
  });
  return dbConnectPromise;
}

// --- Auth tokens (admin + discord users) ---
// Tokens assinados (HMAC) — sobrevivem a redeploy/restart
const revokedTokens = new Set();

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getSessionSecret() {
  const secret = config.sessionSecret || process.env.SESSION_SECRET || "";
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET precisa ser configurado em produção");
  }
  return secret || "development-only-session-secret";
}

function issueToken(payload, days = 7) {
  const body = {
    ...payload,
    exp: Date.now() + days * 24 * 60 * 60 * 1000,
    iat: Date.now(),
  };
  const bodyPart = b64url(JSON.stringify(body));
  const sig = crypto
    .createHmac("sha256", getSessionSecret())
    .update(bodyPart)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return bodyPart + "." + sig;
}

function userFromToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const raw = m[1].trim();
  if (revokedTokens.has(raw)) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [bodyPart, sig] = parts;
  const expected = crypto
    .createHmac("sha256", getSessionSecret())
    .update(bodyPart)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const json = Buffer.from(bodyPart.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const row = JSON.parse(json);
    if (!row || !row.exp || row.exp < Date.now()) return null;
    return row;
  } catch {
    return null;
  }
}

function revokeToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) revokedTokens.add(m[1].trim());
}

function adminRequired(req, res, next) {
  const u = userFromToken(req);
  if (u && u.type === "discord" && isConfiguredDiscordAdmin(u.id)) {
    req.discordUser = { ...u, isAdmin: true };
    return next();
  }
  return res.status(403).json({ error: "Acesso restrito aos IDs Discord configurados", needDiscordAdmin: true });
}

function discordRequired(req, res, next) {
  const u = userFromToken(req);
  if (u && u.type === "discord") {
    req.discordUser = u;
    return next();
  }
  return res.status(401).json({ error: "Faça login com Discord", needLogin: true });
}

// --- Constants (Stumble) ---
const Regions = {
  Europe: "eu",
  "Middle East": "tr",
  "North America": "us",
  "Us West": "usw",
  "Central America": "ussc",
  "South America": "sa",
  Asia: "asia",
  India: "in",
};

const Scenes = {
  "Disco Drop": "level19_block",
  "Block Dash": "level19_block",
  "Block Dash Legendary": "eventlevel13_block_legendary",
  "Laser Dash": "level15_laser",
  "Laser Tracer": "StumblePrivTracer",
  "Honey Drop": "level8_honey",
  Bombardment: "level12_bomb",
  "Lava Land": "level11_lava",
  "Bot Bash": "level22_bot",
  "Rush Hour": "StumblePrivHour",
  "The Other Side": "level2_tile",
  "Acid Pool": "L_049_AcidPool",
  "Space Drop": "L_037_UFO2",
};

const EmoteNameToIds = {
  soco: [145, 146],
  punch: [145, 146],
  rasteira: [215, 247],
  slide: [215, 247],
  banana: [147, 148],
  coracao: [191, 192],
  coração: [191, 192],
  heart: [191, 192],
  maleta: [161],
  tetris: [218],
  espatula: [239],
  karate: [240],
  cuspe: [147],
  raio: [176],
  invisivel: [174],
  bola: [156],
  escudo: [254],
  "bola de neve": [234, 233],
  nenhum: [-3],
};

const INTERACTIVE_EMOTE_IDS = [
  145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 160,
  161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175,
  176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190,
  191, 192, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206,
  207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221,
  222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236,
  237, 238, 239, 240, 241, 242, 243, 244, 246, 247, 248, 249, 250, 251, 252,
  253, 254, 255,
];

const MAP_CHOICES = Object.keys(Scenes);
const EMOTE_CHOICES = [
  "soco", "rasteira", "banana", "coração", "maleta", "tetris", "espatula",
  "karate", "cuspe", "raio", "invisivel", "bola", "escudo", "bola de neve", "nenhum",
];
const PHASE_TYPES = [
  { value: "bracket", label: "Chaveamento (Bracket)", phaseType: 2 },
  { value: "roundrobin", label: "Todos contra todos (Round Robin)", phaseType: 3 },
  { value: "arena", label: "Arena", phaseType: 1 },
];

// --- Schemas ---
const TournamentSchema = new mongoose.Schema(
  {
    CurrentInvites: { type: Number, default: 0 },
    MaxInvites: { type: Number, required: true },
    MinPlayersPerMatch: { type: Number, default: 2 },
    MaxPlayersPerMatch: { type: Number, default: 2 },
    PlayersPerTeam: { type: Number },
    MaxTeamsPerMatch: { type: Number },
    MatchCapacity: { type: Number },
    TournamentId: { type: String, required: true, unique: true },
    TournamentName: { type: String, required: true },
    TournamentImage: { type: String },
    TournamentColor: { type: String },
    StartTime: { type: Date, required: true },
    SignupStart: { type: Date, required: true },
    EntryFee: { type: Number, default: 0 },
    PrizepoolId: { type: String },
    PartySize: { type: Number, required: true },
    Status: { type: Number, required: true },
    TournamentType: { type: Number, required: true },
    Phases: [{ type: mongoose.Schema.Types.Mixed }],
    Region: { type: String, required: true },
    RoundCount: { type: Number, required: true },
    CurrentPhaseId: { type: Number, default: 0 },
    WebhookMessageId: { type: String },
    Properties: { type: mongoose.Schema.Types.Mixed },
    Prizes: [{ type: mongoose.Schema.Types.Mixed }],
    Winners: [{ type: mongoose.Schema.Types.Mixed }],
    FinishedAt: { type: Date }, // quando virou 3 ou 4
    CreatedByDiscordId: { type: String },
    CreatedByDiscordTag: { type: String },
    PrizeMode: { type: String, enum: ["gems", "tag"], default: "gems" },
    PrizeTag: { type: String },
    PrizeTagDurationUnit: { type: String, enum: ["hours", "days", "months", "permanent"] },
    PrizeTagDurationValue: { type: Number },
    PrizeTagExpiresAt: { type: Date },
    PrizeDistributedAt: { type: Date },
  },
  { collection: "tournaments", strict: false }
);

const SiteSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: "main" },
    // Credenciais (Mongo, login do admin, webhook, backbone, Discord
    // client id/secret) não ficam aqui de propósito — vêm só do .env.
    discordRedirectUri: String,
    discordGuildId: String,
    allowedDiscordIds: [String],
    requiredDiscordRoleIds: [String],
    sessionSecret: String,
    coverToolUrl: String,
  },
  { collection: "site_settings" }
);

// --- Logs de login/acesso (fica salvo no Mongo -> sobrevive a redeploy) ---
const LoginLogSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["discord", "discord_blocked", "admin_success", "admin_fail"],
      required: true,
    },
    discordId: String,
    username: String,
    avatar: String,
    reason: String, // motivo quando bloqueado
    ip: String,
    userAgent: String,
    at: { type: Date, default: Date.now },
  },
  { collection: "login_logs" }
);

const AuditLogSchema = new mongoose.Schema(
  {
    actorType: { type: String, enum: ["discord", "admin", "system"], required: true },
    actorId: String,
    actorName: String,
    action: { type: String, required: true, index: true },
    route: String,
    method: String,
    resourceType: String,
    resourceId: String,
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: String,
    userAgent: String,
    at: { type: Date, default: Date.now, index: true },
  },
  { collection: "site_audit_logs" }
);
AuditLogSchema.index({ actorId: 1, at: -1 });
AuditLogSchema.index({ resourceId: 1, at: -1 });

const TournamentCreditLedgerSchema = new mongoose.Schema(
  {
    eventId: { type: String, unique: true, required: true },
    discordId: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    kind: { type: String, enum: ["debit", "grant", "refund"], required: true },
    balance: Number,
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now, index: true },
  },
  { collection: "tournament_credit_ledger" }
);

const TemplateSchema = new mongoose.Schema(
  {
    tid: { type: String, unique: true }, // mesmo id gerado antes (crypto.randomBytes)
    name: String,
    createdAt: String,
    data: mongoose.Schema.Types.Mixed,
  },
  { collection: "site_templates" }
);

let Tournament;
let SiteSettings;
let LoginLog;
let AuditLog;
let TournamentCreditLedger;
let TemplateModel;

async function connectDb(uri) {
  if (!uri || !String(uri).includes("mongodb")) {
    dbConnected = false;
    dbError = "URI do MongoDB não configurada";
    return false;
  }
  try {
    // Reutiliza a conexão aberta pela Backbone quando o painel está integrado.
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 12000 });
    }
    Tournament =
      mongoose.models.Tournament || mongoose.model("Tournament", TournamentSchema);
    SiteSettings =
      mongoose.models.SiteSettings || mongoose.model("SiteSettings", SiteSettingsSchema);
    LoginLog =
      mongoose.models.LoginLog || mongoose.model("LoginLog", LoginLogSchema);
    AuditLog =
      mongoose.models.AuditLog || mongoose.model("AuditLog", AuditLogSchema);
    TournamentCreditLedger =
      mongoose.models.TournamentCreditLedger || mongoose.model("TournamentCreditLedger", TournamentCreditLedgerSchema);
    TemplateModel =
      mongoose.models.Template || mongoose.model("Template", TemplateSchema);
    dbConnected = true;
    dbError = null;
    console.log("[site] MongoDB conectado");
    await loadConfigFromDb();
    return true;
  } catch (e) {
    dbConnected = false;
    dbError = e.message;
    console.error("[site] MongoDB falhou:", e.message);
    return false;
  }
}

async function loadConfigFromDb() {
  if (!SiteSettings) return;
  try {
    const doc = await SiteSettings.findOne({ key: "main" }).lean();
    if (doc) {
      const { _id, key, __v, ...rest } = doc;
      for (const [k, v] of Object.entries(rest)) {
        if (k === "sessionSecret" || k === "discordClientSecret" || k === "discordClientId" || k === "databaseUri" || k === "economyInternalSecret") continue;
        if (v === undefined || v === null) continue;
        if (typeof v === "string" && v.trim() === "" && config[k]) continue;
        if (Array.isArray(v) && v.length === 0 && Array.isArray(config[k]) && config[k].length) continue;
        config[k] = v;
      }
      if (rest.discordRedirectUri) config.discordRedirectUri = rest.discordRedirectUri;
      // Credenciais são sempre do .env — o Mongo nunca sobrescreve isso.
      Object.assign(config, envConfig());
      console.log("[site] Config carregada do MongoDB (persistente)");
      saveConfigFile(config);
    } else {
      await saveConfigToDb();
      console.log("[site] Config inicial gravada no MongoDB");
    }
  } catch (e) {
    console.warn("[site] loadConfigFromDb:", e.message);
  }
}

async function saveConfigToDb() {
  if (!SiteSettings || !dbConnected) {
    saveConfigFile(config);
    return;
  }
  try {
    await SiteSettings.findOneAndUpdate(
      { key: "main" },
      {
        $set: {
          discordRedirectUri: config.discordRedirectUri || "",
          discordGuildId: config.discordGuildId || "",
          allowedDiscordIds: config.allowedDiscordIds || [],
          requiredDiscordRoleIds: config.requiredDiscordRoleIds || [],
          coverToolUrl: config.coverToolUrl || "",
        },
      },
      { upsert: true }
    );
    saveConfigFile(config); // backup local se filesystem permitir
  } catch (e) {
    console.warn("[site] saveConfigToDb:", e.message);
    saveConfigFile(config);
  }
}

function requireDb(_req, res, next) {
  if (!dbConnected || !Tournament) {
    return res.status(503).json({
      error: "MongoDB não configurado. Acesse /admin e configure a URI.",
      needSetup: true,
    });
  }
  next();
}

function getIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || req.ip || "";
}

/** Grava eventos de login/acesso no Mongo (sobrevive a redeploy). Nunca derruba a request. */
async function logEvent(type, data, req) {
  if (!dbConnected || !LoginLog) return;
  try {
    await LoginLog.create({
      type,
      ip: req ? getIp(req) : undefined,
      userAgent: req ? req.headers["user-agent"] : undefined,
      ...data,
    });
  } catch (e) {
    console.warn("[loginlog]", e.message);
  }
}

function safeAuditMetadata(value) {
  const blocked = new Set(["authorization", "token", "accessToken", "password", "clientSecret", "secret", "watchToken"]);
  if (!value || typeof value !== "object") return {};
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (blocked.has(key) || /token|secret|password|authorization/i.test(key)) continue;
    if (raw === undefined || typeof raw === "function") continue;
    if (typeof raw === "string") output[key] = raw.slice(0, 500);
    else if (typeof raw === "number" || typeof raw === "boolean" || raw === null) output[key] = raw;
    else if (Array.isArray(raw)) output[key] = raw.slice(0, 30).map((item) => typeof item === "string" ? item.slice(0, 200) : item);
    else output[key] = JSON.parse(JSON.stringify(raw, (_k, item) => typeof item === "string" ? item.slice(0, 500) : item));
  }
  return output;
}

async function audit(req, action, data = {}) {
  if (!dbConnected || !AuditLog) return;
  const actor = req?.discordUser || userFromToken(req || { headers: {} }) || {};
  const actorType = actor.type === "admin" || actor.isAdmin ? "admin" : actor.type === "discord" ? "discord" : "system";
  try {
    await AuditLog.create({
      actorType,
      actorId: actor.id || actor.username || undefined,
      actorName: actor.username || undefined,
      action,
      route: req?.originalUrl || req?.path,
      method: req?.method,
      resourceType: data.resourceType,
      resourceId: data.resourceId ? String(data.resourceId) : undefined,
      metadata: safeAuditMetadata(data.metadata || {}),
      ip: req ? getIp(req) : undefined,
      userAgent: req ? req.headers["user-agent"] : undefined,
    });
  } catch (e) {
    console.warn("[audit]", e.message);
  }
}

async function getCreatorCreditBalance(discordId) {
  if (!dbConnected || !TournamentCreditLedger) return 0;
  const id = String(discordId || "");
  if (!id) return 0;
  const rows = await TournamentCreditLedger.find({ discordId: id }).sort({ at: 1 }).select("amount kind").lean();
  return rows.reduce((balance, row) => balance + (row.kind === "debit" ? -Math.abs(Number(row.amount) || 0) : Math.abs(Number(row.amount) || 0)), 0);
}

async function debitCreatorCredits(discordId, amount, eventId, metadata = {}) {
  const id = String(discordId || "");
  const units = Math.max(0, parseInt(amount, 10) || 0);
  const eid = String(eventId || "").trim().slice(0, 180);
  if (!id || !eid) return { ok: false, status: 400, error: "CREDIT_EVENT_REQUIRED" };
  if (!units) return { ok: true, charged: 0, balance: await getCreatorCreditBalance(id) };
  if (!dbConnected || !TournamentCreditLedger) return { ok: false, status: 503, error: "Banco de créditos indisponível" };
  try {
    await TournamentCreditLedger.create({ eventId: eid, discordId: id, amount: units, kind: "debit", metadata });
  } catch (error) {
    if (error?.code === 11000 || /duplicate key/i.test(String(error.message))) return { ok: true, duplicate: true, balance: await getCreatorCreditBalance(id) };
    throw error;
  }
  const balance = await getCreatorCreditBalance(id);
  if (balance < 0) {
    await TournamentCreditLedger.deleteOne({ eventId: eid });
    return { ok: false, status: 402, error: "Créditos insuficientes", balance: balance + units };
  }
  return { ok: true, charged: units, balance };
}

async function refundCreatorCredits(discordId, amount, eventId, metadata = {}) {
  const id = String(discordId || "");
  const units = Math.max(0, parseInt(amount, 10) || 0);
  const eid = String(eventId || "").trim().slice(0, 180);
  if (!id || !eid || !units || !dbConnected || !TournamentCreditLedger) return { ok: false };
  try {
    await TournamentCreditLedger.create({ eventId: eid, discordId: id, amount: units, kind: "refund", metadata });
  } catch (error) {
    if (error?.code === 11000 || /duplicate key/i.test(String(error.message))) return { ok: true, duplicate: true, balance: await getCreatorCreditBalance(id) };
    throw error;
  }
  return { ok: true, refunded: units, balance: await getCreatorCreditBalance(id) };
}

function internalSecretOk(req) {
  const expected = String(process.env.SITE_INTERNAL_SECRET || process.env.ECONOMY_INTERNAL_SECRET || "").trim();
  return Boolean(expected) && String(req.headers["x-site-internal-secret"] || req.headers["x-economy-secret"] || "") === expected;
}

function isTournamentAdmin(req) {
  return Boolean(req?.discordUser?.isAdmin || isConfiguredDiscordAdmin(req?.discordUser?.id));
}

function canUseTournamentCreationCredits(req) {
  return Boolean(req?.discordUser?.id);
}

function makeFormatInput(mode, party, maxTeamsPerMatch) {
  const normalizedMode = mode === "solo" ? "solo" : "teams";
  const playersPerTeam = normalizedMode === "solo" ? 1 : Math.max(1, Number(party) || 1);
  const maxTeams = normalizedMode === "solo" ? 4 : Math.max(2, Number(maxTeamsPerMatch) || 2);
  return {
    Properties: { Mode: normalizedMode },
    PartySize: playersPerTeam,
    PlayersPerTeam: playersPerTeam,
    MaxTeamsPerMatch: maxTeams,
    MatchCapacity: playersPerTeam * maxTeams,
  };
}

function getTournamentFormat(tournament) {
  if (!SharedTournamentRules?.GetTournamentFormat) {
    throw new Error("TournamentRules compilado não encontrado; execute npm run build antes de iniciar o WebAdmin");
  }
  return SharedTournamentRules.GetTournamentFormat(tournament);
}

function getFormatFields(tournament) {
  if (SharedTournamentRules?.BuildFormatFields) return SharedTournamentRules.BuildFormatFields(tournament);
  const format = getTournamentFormat(tournament);
  return {
    PlayersPerTeam: format.playersPerTeam,
    MaxTeamsPerMatch: format.maxTeamsPerMatch,
    MatchCapacity: format.matchPlayerCapacity,
  };
}

function calcRounds(players, partyOrFormat, typeStr, matchCapacity = 2) {
  const formatInput = typeof partyOrFormat === "object"
    ? partyOrFormat
    : makeFormatInput(Number(partyOrFormat) === 1 && matchCapacity > 2 ? "solo" : "teams", partyOrFormat, matchCapacity);
  if (SharedTournamentRules?.CalculateRoundCount) {
    return SharedTournamentRules.CalculateRoundCount(players, formatInput, typeStr);
  }
  const party = Math.max(1, Number(formatInput.PlayersPerTeam ?? formatInput.PartySize) || 1);
  const capacity = Math.max(2, Math.floor(Number(formatInput.MaxTeamsPerMatch) || matchCapacity || 2));
  const competitors = Math.max(1, Math.floor((Number(players) || 1) / party));
  if (typeStr === "roundrobin") return Math.max(1, Math.ceil((competitors - 1) / Math.max(1, capacity - 1)));
  let remaining = competitors;
  let rounds = 0;
  while (remaining > 1) {
    rounds++;
    const matches = Math.ceil(remaining / capacity);
    if (matches <= 1) break;
    remaining = matches * Math.max(1, Math.floor(capacity / 2));
  }
  return Math.max(1, rounds);
}
function buildPrizePool(totalGems, maxPlayers, tournamentOrParty) {
  if (!SharedTournamentRules?.BuildPrizeBands) {
    throw new Error("TournamentRules compilado não encontrado; execute npm run build antes de iniciar o WebAdmin");
  }
  return SharedTournamentRules.BuildPrizeBands(totalGems, maxPlayers, tournamentOrParty);
}

function resolveEmoteIds(name) {
  if (!name) return [];
  const key = name.trim().toLowerCase();
  return EmoteNameToIds[key] || EmoteNameToIds[key.replace("ç", "c")] || [];
}

function buildDisabledEmotes(selectedNames) {
  const names = (selectedNames || []).filter(Boolean);
  if (names.length === 0) return [];
  if (names.some((n) => ["nenhum", "none", "no emotes"].includes(n.toLowerCase()))) {
    return [...INTERACTIVE_EMOTE_IDS];
  }
  const allowed = new Set();
  for (const n of names) {
    for (const id of resolveEmoteIds(n)) if (id > 0) allowed.add(id);
  }
  return INTERACTIVE_EMOTE_IDS.filter((id) => !allowed.has(id));
}

function resolveMaps(input) {
  if (!input) return [Scenes["Block Dash"]];
  const parts = Array.isArray(input) ? input : String(input).split(",");
  return parts
    .map((m) => {
      const t = String(m).trim();
      return Scenes[t] || t;
    })
    .filter(Boolean);
}

async function generateTournamentId() {
  const rows = await Tournament.find({}, { TournamentId: 1 }).lean();
  const used = new Set(rows.map((row) => Number(row.TournamentId)).filter((id) => Number.isInteger(id) && id > 0));
  let id = 1;
  while (used.has(id)) id++;
  return String(id);
}

function generatePrizepoolId() {
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

async function callEconomy(pathname, body) {
  const base = String(config.economyApiUrl || "").replace(/\/$/, "");
  if (!base) return { ok: false, status: 503, error: "ECONOMY_API_URL não configurada" };
  try {
    const response = await fetch(base + pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.economyInternalSecret ? { "X-Economy-Secret": config.economyInternalSecret } : {}) },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    return { ok: response.ok && result.ok !== false && result.success !== false, status: response.status, ...result };
  } catch (error) {
    return { ok: false, status: 503, error: "Serviço de economia indisponível" };
  }
}

async function notifyBackbone(tournament) {
  const base = (config.backboneUrl || "").replace(/\/$/, "");
  if (!base) return;
  const paths = [
    "/api/tournaments/notify",
    "/api/tournament/created",
    "/tournament/webhook",
    "/api/webhook/tournament",
  ];
  const body = {
    event: "tournament_created",
    tournament: {
      TournamentId: tournament.TournamentId,
      TournamentName: tournament.TournamentName,
      Region: tournament.Region,
      StartTime: tournament.StartTime,
      MaxInvites: tournament.MaxInvites,
      PartySize: tournament.PartySize,
      EntryFee: tournament.EntryFee,
      Status: tournament.Status,
      TournamentColor: tournament.TournamentColor,
      TournamentImage: tournament.TournamentImage,
      CreatedByDiscordId: tournament.CreatedByDiscordId,
      CreatedByDiscordTag: tournament.CreatedByDiscordTag,
    },
  };
  for (const p of paths) {
    try {
      const res = await fetch(base + p, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Source": "tournament-site" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        console.log("[backbone] notify ok", p);
        return true;
      }
    } catch (e) {
      /* tenta próximo */
    }
  }
  console.log("[backbone] nenhum endpoint de notify respondeu (ok se Backbone só lê Mongo)");
  return false;
}

// --- Webhook igual à Backbone (Components V2 + emojis custom) ---
const DEFAULT_WEBHOOK_URI = process.env.WEBHOOK_URI || "";

const PING_ROLE_ID = process.env.PING_ROLE_ID || "";

const EMOJI = {
  trophy: "<:trophy:1533204329052508170>",
  trophy2: "<:trophy2:1533204357368250590>",
  region: "<:region:1533204293040209960>",
  signed: "<:signed:1533204398648463430>",
  clock: "<:clock:1533204440298029197>",
  info: "<:info:1533204571705577512>",
  phases: "<:phases:1533204531943440474>",
  punch: "<:emote_punch:1533216063901139076>",
  punch_fire: "<:emote_punch_fire:1533204727385423963>",
  banana: "<:emote_banana:1533220317093171280>",
  banana_gold: "<:emote_banana_gold:1533220020807798924>",
  slide: "<:emote_slide:1533219295322968376>",
  slide_water: "<:emote_slide_water:1533220751619129355>",
  karate: "<:emote_karate:1533219678426763374>",
  invisible: "<:emote_invisible:1533219525728927805>",
  briefcase: "<:emote_briefcase:1533219591134904451>",
  lightning: "<:emote_lightning:1533219381113258124>",
  ball: "<:emote_ball:1533220927674781869>",
  ball_snow: "<:emote_ball_snow:1533219335827624046>",
  spit: "<:emote_spit:1533204186697568357>",
  heart: "<:emote_heart:1533219642955530452>",
  heart_charged: "<:emote_charged:1533221809686577343>",
  spatula: "<:emote_spatula:1533222766634078521>",
  tetris: "<:emote_tetris:1533204106511126579>",
  emotes_none: "<:emotes_none:1533204609294667928>",
};

const EMOTE_DISPLAY = {
  soco: `${EMOJI.punch_fire} ${EMOJI.punch}`,
  punch: `${EMOJI.punch_fire} ${EMOJI.punch}`,
  banana: `${EMOJI.banana} ${EMOJI.banana_gold}`,
  rasteira: `${EMOJI.slide} ${EMOJI.slide_water}`,
  slide: `${EMOJI.slide} ${EMOJI.slide_water}`,
  coracao: `${EMOJI.heart} ${EMOJI.heart_charged}`,
  coração: `${EMOJI.heart} ${EMOJI.heart_charged}`,
  heart: `${EMOJI.heart} ${EMOJI.heart_charged}`,
  karate: EMOJI.karate,
  invisivel: EMOJI.invisible,
  invisível: EMOJI.invisible,
  invisible: EMOJI.invisible,
  maleta: EMOJI.briefcase,
  briefcase: EMOJI.briefcase,
  raio: EMOJI.lightning,
  lightning: EMOJI.lightning,
  bola: EMOJI.ball,
  ball: EMOJI.ball,
  "bola de neve": EMOJI.ball_snow,
  boladeneve: EMOJI.ball_snow,
  ballsnow: EMOJI.ball_snow,
  cuspe: EMOJI.spit,
  spit: EMOJI.spit,
  espatula: EMOJI.spatula,
  espátula: EMOJI.spatula,
  spatula: EMOJI.spatula,
  tetris: EMOJI.tetris,
  escudo: EMOJI.briefcase,
  shield: EMOJI.briefcase,
  nenhum: EMOJI.emotes_none,
  none: EMOJI.emotes_none,
};

function getMapFriendlyName(sceneId) {
  const mapName = Object.keys(Scenes).find((key) => Scenes[key] === sceneId);
  if (!mapName) return String(sceneId || "");
  return mapName.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
}

function getPhaseTypeName(phaseType) {
  switch (Number(phaseType)) {
    case 3:
      return "Round Robin";
    case 1:
      return "Arena";
    case 2:
      return "Bracket (Single Elimination)";
    default:
      return "Phase";
  }
}

function buildEmotesText(tournament) {
  let selected = [];
  const raw =
    tournament.SelectedEmotes ||
    tournament.Properties?.SelectedEmotes ||
    tournament.Properties?.selectedEmotes;
  if (Array.isArray(raw)) {
    selected = raw.map((s) => String(s)).filter(Boolean);
  } else if (typeof raw === "string" && raw.length) {
    selected = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (selected.length > 0) {
    const parts = selected
      .map((name) => EMOTE_DISPLAY[name.toLowerCase().trim()] || null)
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }
  const disabledEmotes = tournament.Properties?.DisabledEmotes || [];
  if (!disabledEmotes.length) return "All Emotes";
  if (disabledEmotes.length === 1 && disabledEmotes[0] < 0) {
    if (disabledEmotes[0] === -2) return `${EMOJI.punch_fire} ${EMOJI.punch}`;
    if (disabledEmotes[0] === -1) return "Special Emotes Disabled";
    if (disabledEmotes[0] === -3) return EMOJI.emotes_none;
    return `Preset ${disabledEmotes[0]}`;
  }
  // whitelist invertida grande → "nenhum" se blacklist quase total
  if (disabledEmotes.length >= 50) return EMOJI.emotes_none;
  return "All Emotes";
}

/**
 * Texto de "Emotes" no topo da embed. Se os rounds tiverem combinações
 * diferentes de emotes entre si, mostra "Variado" em vez de listar um só
 * conjunto (que não representaria o torneio inteiro).
 */
function buildHeaderEmotesText(tournament) {
  const phases = Array.isArray(tournament.Phases) ? tournament.Phases : [];
  const lastIndex = phases.length - 1;
  const baseRoundEmotes = tournament.Properties?.RoundEmotes || tournament.RoundEmotes || [];
  const lastRoundEmotes = lastIndex >= 0 && Array.isArray(phases[lastIndex].RoundEmotes) && phases[lastIndex].RoundEmotes.length
    ? phases[lastIndex].RoundEmotes
    : (lastIndex === 0 ? baseRoundEmotes : []);
  if (Array.isArray(lastRoundEmotes) && lastRoundEmotes.length > 1) {
    const normalized = lastRoundEmotes.map((arr) =>
      (Array.isArray(arr) ? arr : [])
        .map((s) => String(s).toLowerCase().trim())
        .filter(Boolean)
        .sort()
        .join("+")
    );
    if (new Set(normalized).size > 1) return "Custom";
    const stable = (Array.isArray(lastRoundEmotes[0]) ? lastRoundEmotes[0] : [])
      .map((name) => EMOTE_DISPLAY[String(name).toLowerCase().trim()] || null)
      .filter(Boolean)
      .join(" ");
    if (stable) return stable;
  }
  return buildEmotesText(tournament);
}

function buildBackboneWebhookPayload(tournament) {
  const decimalColor = 0xff4444;
  const format = getTournamentFormat(tournament);
  const modeText = format.mode === "solo"
    ? Array(format.maxTeamsPerMatch).fill("1").join("v")
    : `${format.playersPerTeam}v${format.playersPerTeam}`;
  const emotesText = buildHeaderEmotesText(tournament);
  const startTimestamp = Math.floor(new Date(tournament.StartTime).getTime() / 1000);
  const currentSigned = tournament.CurrentInvites || 0;
  const maxPlayers = tournament.MaxInvites || format.matchPlayerCapacity * 100;
  const showTeams = format.mode === "teams";
  const maxTeams = showTeams ? Math.floor(maxPlayers / format.playersPerTeam) : 0;
  const currentTeams = showTeams ? Math.floor(currentSigned / format.playersPerTeam) : 0;
  const countForLeaderboard =
    tournament.CountForLeaderboard ??
    tournament.Properties?.CountForLeaderboard ??
    false;
  const leaderboardText = countForLeaderboard ? "Yes" : "No";
  const signedUpsValue = showTeams
    ? `**${currentSigned}/${maxPlayers} - (${currentTeams}/${maxTeams} Teams)**`
    : `**${currentSigned}/${maxPlayers}**`;

  const titleLine = `## ${EMOJI.trophy} ${tournament.TournamentName}`;
  const region = String(tournament.Region || "").toUpperCase();
  const streamUrl = tournament.Properties?.StreamURL || tournament.StreamURL || "";

  const contentComponents = [
    { type: 10, content: titleLine },
    {
      type: 10,
      content: `${EMOJI.region} Region: **${region}**\n${EMOJI.region} Emotes: **${emotesText}**`,
    },
    { type: 14, divider: true },
    {
      type: 10,
      content: `${EMOJI.trophy2} **Count for leaderboard**\n${EMOJI.region} **${leaderboardText}**`,
    },
    { type: 14, divider: true },
    {
      type: 10,
      content: `${EMOJI.signed} **Signed-Ups**\n${EMOJI.region} ${signedUpsValue}`,
    },
    {
      type: 10,
      content:       `${EMOJI.clock} **Start Time**\n${EMOJI.region} **<t:${startTimestamp}:R> (<t:${startTimestamp}:f>)**`,
    },
    ...(streamUrl ? [{ type: 10, content: `${EMOJI.info} **Steam URL**\n${EMOJI.region} ${streamUrl}` }] : []),
    { type: 14, divider: true },

    {
      type: 10,
      content: `${EMOJI.info} **Tournament Infos**\n${EMOJI.region} **Mode:** ${modeText}\n${EMOJI.region} **Phases:** ${tournament.Phases?.length || 0} phase${(tournament.Phases?.length || 0) > 1 ? "s" : ""}`,
    },
    { type: 14, divider: true },
  ];

  if (tournament.Phases && tournament.Phases.length > 0) {
    let phasesContent = `${EMOJI.phases} **Phases**\n`;
    const roundEmotesAll =
      tournament.Properties?.RoundEmotes ||
      tournament.RoundEmotes ||
      [];
    const roundMapsAll = tournament.Properties?.RoundMaps || tournament.RoundMaps || [];
    tournament.Phases.forEach((phase, index) => {
      const phaseLabel = phase.Name || phase.name || `Phase ${index + 1}`;
      phasesContent += `${EMOJI.region} **${phaseLabel}:**\n`;
      const maps = index === 0 && roundMapsAll.length ? roundMapsAll : (phase.Maps || []);
      const phaseEmotes = Array.isArray(phase.RoundEmotes) && phase.RoundEmotes.length ? phase.RoundEmotes : (index === 0 ? roundEmotesAll : []);
      const roundCount = phase.RoundCount || maps.length || phaseEmotes.length || 0;
      const limit = Math.max(roundCount, maps.length || 0, 1);

      const lines = [];
      for (let r = 0; r < limit; r++) {
        const mapId = maps.length ? maps[Math.min(r, maps.length - 1)] : null;
        const mapName = mapId ? getMapFriendlyName(mapId) : "Block Dash";
        const ems = Array.isArray(phaseEmotes[r]) ? phaseEmotes[r] : [];
        const emoteText = ems
          .map((name) => EMOTE_DISPLAY[String(name).toLowerCase().trim()] || null)
          .filter(Boolean)
          .join(" ");
        lines.push({ mapName, emoteText, r: r + 1 });
      }
      const isLastPhase = index === tournament.Phases.length - 1;
      const customEmotes = isLastPhase && lines.length > 1 && new Set(lines.map((line) => line.emoteText)).size > 1;
      let i = 0;
      while (i < lines.length) {
        let j = i;
        while (
          j + 1 < lines.length &&
          lines[j + 1].mapName === lines[i].mapName &&
          (!customEmotes || lines[j + 1].emoteText === lines[i].emoteText)
        ) {
          j++;
        }
        const label = i === j ? `Round ${lines[i].r}` : `Round ${lines[i].r}-${lines[j].r}`;
        const prefix = customEmotes && lines[i].emoteText ? `${lines[i].emoteText} ` : "";
        phasesContent += `${EMOJI.region} **${label}:** ${prefix}${lines[i].mapName}\n`;
        i = j + 1;
      }
    });
    contentComponents.push({ type: 10, content: phasesContent.trim() });
  }

  contentComponents.push({
    type: 10,
    content: `<@&${PING_ROLE_ID}>`,
  });

  const containerComponents = [];
  if (tournament.TournamentImage) {
    containerComponents.push({
      type: 9,
      components: [
        {
          type: 10,
          content: `${titleLine}\n${EMOJI.region} Region: **${region}**\n${EMOJI.region} Emotes: **${emotesText}**`,
        },
      ],
      accessory: {
        type: 11,
        media: { url: tournament.TournamentImage },
      },
    });
    containerComponents.push(...contentComponents.slice(2));
  } else {
    containerComponents.push(...contentComponents);
  }

  return {
    flags: 32768,
    allowed_mentions: { parse: [], roles: [PING_ROLE_ID] },
    components: [
      {
        type: 17,
        components: containerComponents,
        accent_color: decimalColor,
      },
    ],
  };
}

function getWebhookBase() {
  const uri = (config.webhookUri || DEFAULT_WEBHOOK_URI || "").trim();
  if (!uri || !uri.includes("discord.com/api/webhooks")) return null;
  return uri
    .replace("https://discord.com/api/webhooks/", "https://discord.com/api/v10/webhooks/")
    .split("?")[0];
}

async function sendDiscordEmbed(tournament) {
  const base = getWebhookBase();
  if (!base) {
    console.log("[webhook] URI não configurada — pulei");
    return null;
  }
  try {
    const payload = buildBackboneWebhookPayload(tournament);
    const webhookUrl = `${base}?wait=true&with_components=true`;
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("[webhook] fail", res.status, t);
      return null;
    }
    const data = await res.json();
    console.log("[webhook] sent (components)", data.id);
    return data.id || null;
  } catch (e) {
    console.error("[webhook] error", e.message);
    return null;
  }
}

async function updateDiscordWebhook(tournament) {
  const base = getWebhookBase();
  const messageId =
    tournament.WebhookMessageId || tournament.Properties?.WebhookMessageId;
  if (!base || !messageId) return false;
  try {
    const payload = buildBackboneWebhookPayload(tournament);
    const url = `${base}/messages/${messageId}?with_components=true`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("[webhook] update fail", res.status, await res.text());
      return false;
    }
    console.log("[webhook] updated", tournament.TournamentId, messageId);
    return true;
  } catch (e) {
    console.error("[webhook] update error", e.message);
    return false;
  }
}


/** Marca FinishedAt quando status vira 3/4; esconde após 5 min */
async function markFinishedIfNeeded(docs) {
  if (!Array.isArray(docs) || !docs.length) return docs;
  const now = new Date();
  const toMark = [];
  for (const d of docs) {
    if ((d.Status === 3 || d.Status === 4) && !d.FinishedAt) {
      toMark.push(d.TournamentId);
      d.FinishedAt = now;
    }
  }
  if (toMark.length && Tournament) {
    await Tournament.updateMany(
      { TournamentId: { $in: toMark }, FinishedAt: { $exists: false } },
      { $set: { FinishedAt: now } }
    ).catch(() => {});
  }
  return docs;
}

function isStillVisibleFinished(doc) {
  if (doc.Status !== 3 && doc.Status !== 4) return true;
  const t = doc.FinishedAt ? new Date(doc.FinishedAt).getTime() : Date.now();
  return Date.now() - t < FINISHED_HIDE_MS;
}

// --- Templates: Mongo é a fonte de verdade (obrigatório em serverless, onde
// o arquivo local não sobrevive entre invocações); arquivo local é só cache. ---
function loadTemplatesFile() {
  try {
    if (fs.existsSync(TEMPLATES_PATH)) {
      return JSON.parse(fs.readFileSync(TEMPLATES_PATH, "utf8"));
    }
  } catch (_) {}
  return [];
}

function saveTemplatesFile(list) {
  try {
    fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(list, null, 2));
  } catch (e) {
    console.warn("[templates] write fail (ok se filesystem read-only):", e.message);
  }
}

async function loadTemplates() {
  if (dbConnected && TemplateModel) {
    try {
      const docs = await TemplateModel.find({}).sort({ createdAt: -1 }).limit(50).lean();
      return docs.map((d) => ({ id: d.tid, name: d.name, createdAt: d.createdAt, data: d.data }));
    } catch (e) {
      console.warn("[templates] load do Mongo falhou, usando arquivo local:", e.message);
    }
  }
  return loadTemplatesFile();
}

async function saveTemplate(item) {
  if (dbConnected && TemplateModel) {
    try {
      await TemplateModel.create({
        tid: item.id,
        name: item.name,
        createdAt: item.createdAt,
        data: item.data,
      });
      return;
    } catch (e) {
      console.warn("[templates] save no Mongo falhou, usando arquivo local:", e.message);
    }
  }
  const list = loadTemplatesFile();
  list.unshift(item);
  saveTemplatesFile(list.slice(0, 50));
}

async function deleteTemplate(id) {
  if (dbConnected && TemplateModel) {
    try {
      await TemplateModel.deleteOne({ tid: id });
      return;
    } catch (e) {
      console.warn("[templates] delete no Mongo falhou:", e.message);
    }
  }
  saveTemplatesFile(loadTemplatesFile().filter((t) => t.id !== id));
}

// --- App ---
const app = express();
app.set("trust proxy", 1);
const allowedOrigins = new Set(splitEnvList(process.env.ALLOWED_ORIGINS || process.env.SITE_ORIGIN));
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://cdn.discordapp.com", "https://i.postimg.cc", "https://i.imgur.com"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", "https://discord.com"],
    },
  },
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || process.env.NODE_ENV !== "production" && allowedOrigins.size === 0) return callback(null, true);
    return callback(new Error("Origin not allowed"));
  },
  credentials: true,
}));
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "256kb" }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const mutationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

app.use(async (_req, _res, next) => {
  try {
    await ensureDbConnected();
  } catch (_) {}
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    dbConnected,
    uptime: process.uptime(),
    discordConfigured: !!(config.discordClientId && config.discordClientSecret),
  });
});

// ========== ADMIN AUTH ==========
// Usuário e senha do /admin vêm do .env (ADMIN_USER / ADMIN_PASSWORD) —
// não existe mais tela pra trocar isso pelo painel.
app.post("/api/admin/login", authLimiter, async (req, res) => {
  await audit(req, "admin.login.legacy_denied", { metadata: { reason: "discord_oauth_required" } });
  return res.status(403).json({ error: "O /admin usa login do Discord e exige DISCORD_ADMIN_IDS", needDiscordAdmin: true });
});

app.post("/api/admin/logout", (req, res) => {
  revokeToken(req);
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => {
  const u = userFromToken(req);
  const authenticated = Boolean(u && u.type === "discord" && isConfiguredDiscordAdmin(u.id));
  res.json({
    authenticated,
    username: authenticated ? u.username : null,
    id: authenticated ? u.id : null,
    isAdmin: authenticated,
    dbConnected,
    dbError: dbConnected ? null : dbError,
  });
});

// Só o que continua editável pelo painel (o resto é .env).
app.get("/api/admin/settings", adminRequired, (req, res) => {
  res.json({
    dbConnected,
    dbError: dbConnected ? null : dbError,
    discordRedirectUri: config.discordRedirectUri || "",
    discordGuildId: config.discordGuildId || "",
    allowedDiscordIds: (config.allowedDiscordIds || []).join(", "),
    adminDiscordIdsConfigured: configuredAdminDiscordIds().size,
    requiredDiscordRoleIds: (config.requiredDiscordRoleIds || []).join(", "),
    discordConfigured: !!(config.discordClientId && config.discordClientSecret),
    coverToolUrl: config.coverToolUrl || "",
  });
});

app.put("/api/admin/settings", adminRequired, async (req, res) => {
  const b = req.body || {};
  if (b.discordRedirectUri !== undefined) {
    config.discordRedirectUri = String(b.discordRedirectUri || "").trim();
  }
  if (b.discordGuildId !== undefined) {
    config.discordGuildId = String(b.discordGuildId || "").trim();
  }
  if (b.allowedDiscordIds !== undefined) {
    const raw = String(b.allowedDiscordIds || "");
    config.allowedDiscordIds = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (b.requiredDiscordRoleIds !== undefined) {
    const raw = String(b.requiredDiscordRoleIds || "");
    config.requiredDiscordRoleIds = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (b.allowedDiscordIds !== undefined) {
    return res.status(400).json({ error: "DISCORD_ADMIN_IDS é somente leitura e deve ser alterado no ambiente" });
  }
  if (b.coverToolUrl !== undefined) {
    config.coverToolUrl = String(b.coverToolUrl || "").trim();
  }
  await saveConfigToDb();
  res.json({
    ok: true,
    dbConnected,
    message: dbConnected ? "Salvo (Mongo + backup local)" : "Salvo",
  });
});

// ========== ADMIN · VISÃO GERAL / LOGINS ==========
app.get("/api/admin/overview", adminRequired, async (_req, res) => {
  try {
    const [totalTournaments, activeTournaments, creatorsAgg, recentDiscordLogins, recentAdminLogins, recentBlocked, auditCount] =
      await Promise.all([
        dbConnected && Tournament ? Tournament.countDocuments({}) : 0,
        dbConnected && Tournament ? Tournament.countDocuments({ Status: { $in: [0, 1, 2, 5] } }) : 0,
        dbConnected && Tournament ? Tournament.distinct("CreatedByDiscordId") : [],
        dbConnected && LoginLog ? LoginLog.find({ type: "discord" }).sort({ at: -1 }).limit(25).lean() : [],
        dbConnected && LoginLog
          ? LoginLog.find({ type: { $in: ["admin_success", "admin_fail"] } }).sort({ at: -1 }).limit(25).lean()
          : [],
        dbConnected && LoginLog ? LoginLog.find({ type: "discord_blocked" }).sort({ at: -1 }).limit(25).lean() : [],
        dbConnected && AuditLog ? AuditLog.countDocuments({}) : 0,
      ]);
    res.json({
      dbConnected,
      uptimeSeconds: Math.floor(process.uptime()),
      totalTournaments,
      activeTournaments,
      uniqueCreators: (creatorsAgg || []).filter(Boolean).length,
      discordConfigured: !!(config.discordClientId && config.discordClientSecret),
      webhookConfigured: !!getWebhookBase(),
      recentDiscordLogins,
      recentAdminLogins,
      recentBlocked,
      auditCount,
      adminDiscordIdsConfigured: configuredAdminDiscordIds().size,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/logins", adminRequired, async (req, res) => {
  try {
    if (!dbConnected || !LoginLog) return res.json([]);
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
    const list = await LoginLog.find({ type: { $in: ["discord", "discord_blocked"] } })
      .sort({ at: -1 })
      .limit(limit)
      .lean();
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/audit", adminRequired, async (req, res) => {
  try {
    if (!dbConnected || !AuditLog) return res.json({ items: [], total: 0 });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = String(req.query.action || "").trim();
    const query = filter ? { action: filter } : {};
    const [items, total] = await Promise.all([
      AuditLog.find(query).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(query),
    ]);
    res.json({ items, total, page, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/admin-logins", adminRequired, async (req, res) => {
  try {
    if (!dbConnected || !LoginLog) return res.json([]);
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
    const list = await LoginLog.find({ type: { $in: ["admin_success", "admin_fail"] } })
      .sort({ at: -1 })
      .limit(limit)
      .lean();
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/creators", adminRequired, async (_req, res) => {
  try {
    if (!dbConnected || !Tournament) return res.json([]);
    const agg = await Tournament.aggregate([
      { $match: { CreatedByDiscordId: { $exists: true, $ne: null, $ne: "" } } },
      {
        $group: {
          _id: "$CreatedByDiscordId",
          tag: { $last: "$CreatedByDiscordTag" },
          tournaments: { $sum: 1 },
          lastCreated: { $max: "$StartTime" },
        },
      },
      { $sort: { tournaments: -1 } },
      { $limit: 100 },
    ]);
    res.json(
      agg.map((a) => ({
        discordId: a._id,
        tag: a.tag,
        tournaments: a.tournaments,
        lastCreated: a.lastCreated,
      }))
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== DISCORD OAUTH ==========
function getDiscordRedirectUri(req) {
  let uri = (config.discordRedirectUri || "").trim();
  if (uri) {
    // normaliza: sem espaço, sem barra final no path (exceto root)
    uri = uri.replace(/\s+/g, "");
    return uri;
  }
  const proto = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const host = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}/api/auth/discord/callback`;
}

function discordScopes() {
  const scopes = ["identify"];
  if (config.discordGuildId) scopes.push("guilds");
  // guilds.members.read só se precisar checar cargo (scope sensível)
  if ((config.requiredDiscordRoleIds || []).length) scopes.push("guilds.members.read");
  return scopes.join(" ");
}

app.get("/api/auth/discord/status", (_req, res) => {
  res.json({
    configured: !!(config.discordClientId && config.discordClientSecret),
    hasClientId: !!config.discordClientId,
    hasClientSecret: !!config.discordClientSecret,
    redirectUri: config.discordRedirectUri || "(auto pelo host)",
    guildId: config.discordGuildId || null,
    requiredRoles: config.requiredDiscordRoleIds || [],
    allowedIds: (config.allowedDiscordIds || []).length,
    scopes: discordScopes(),
  });
});

app.get("/api/auth/discord", authLimiter, (req, res) => {
  if (!config.discordClientId) {
    return res.status(400).send(
      "Discord OAuth não configurado. Em /admin cole Client ID, Client Secret e Redirect URI."
    );
  }
  if (!config.discordClientSecret) {
    return res.status(400).send(
      "Client Secret do Discord não está salvo. Abra /admin, cole o Secret e Salvar."
    );
  }
  const redirectUri = getDiscordRedirectUri(req);
  const state = crypto.randomBytes(16).toString("hex");
  const nextPath = String(req.query.next || "/");
  const safeNext = nextPath === "/admin" ? "/admin" : "/";
  res.cookie("oauth_state", state, {
    httpOnly: true,
    maxAge: 600000,
    sameSite: "lax",
    secure: req.secure || req.get("x-forwarded-proto") === "https",
    path: "/",
  });
  res.cookie("oauth_next", safeNext, {
    httpOnly: true,
    maxAge: 600000,
    sameSite: "lax",
    secure: req.secure || req.get("x-forwarded-proto") === "https",
    path: "/",
  });
  console.log("[discord] authorize request", { redirectUri, scopes: discordScopes(), next: safeNext });
  const params = new URLSearchParams({
    client_id: config.discordClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: discordScopes(),
    state,
    prompt: "consent",
  });
  res.redirect("https://discord.com/api/oauth2/authorize?" + params.toString());
});

app.get("/api/auth/discord/callback", async (req, res) => {
  try {
    const { code, error, error_description, state } = req.query;
        const rawCookie = String(req.headers.cookie || "");
    const cookieMap = {};
    rawCookie.split(";").forEach((part) => { const [key, ...value] = part.trim().split("="); if (key) cookieMap[key] = decodeURIComponent(value.join("=") || ""); });
    const expectedState = req.cookies?.oauth_state || cookieMap.oauth_state;

    if (!state || !expectedState || String(state) !== String(expectedState)) {
      return res.redirect("/?discord_error=invalid_state");
    }
        const nextPath = (req.cookies?.oauth_next || cookieMap.oauth_next) === "/admin" ? "/admin" : "/";

    if (error) {
      console.error("[discord] oauth error", error, error_description);
      return res.redirect(
        "/?discord_error=" +
          encodeURIComponent(String(error)) +
          "&discord_error_detail=" +
          encodeURIComponent(String(error_description || ""))
      );
    }
    if (!code) return res.redirect("/?discord_error=no_code");

    const redirectUri = getDiscordRedirectUri(req);
    console.log("[discord] token exchange redirect_uri=", redirectUri);

    if (!config.discordClientSecret) {
      return res.redirect("/?discord_error=no_secret");
    }

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      console.error("[discord] token fail", tokenRes.status, t);
      let detail = "token";
      try {
        const j = JSON.parse(t);
        detail = j.error || j.message || t.slice(0, 120);
      } catch {
        detail = t.slice(0, 120);
      }
      return res.redirect(
        "/?discord_error=token&discord_error_detail=" + encodeURIComponent(String(detail))
      );
    }
    const tokenData = await tokenRes.json();
    const access = tokenData.access_token;

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: "Bearer " + access },
    });
    if (!userRes.ok) return res.redirect("/?discord_error=user");
    const user = await userRes.json();

    let memberRoles = [];
    if (config.discordGuildId) {
      try {
        const gRes = await fetch("https://discord.com/api/users/@me/guilds", {
          headers: { Authorization: "Bearer " + access },
        });
        if (gRes.ok) {
          const guilds = await gRes.json();
          const inGuild =
            Array.isArray(guilds) && guilds.some((g) => String(g.id) === String(config.discordGuildId));
          if (!inGuild) {
            await logEvent(
              "discord_blocked",
              { discordId: String(user.id), username: user.username, reason: "not_in_server" },
              req
            );
            return res.redirect("/?discord_error=not_in_server");
          }
        }
        // só tenta cargos se o scope foi pedido
        if ((config.requiredDiscordRoleIds || []).length) {
          const mRes = await fetch(
            "https://discord.com/api/users/@me/guilds/" + config.discordGuildId + "/member",
            { headers: { Authorization: "Bearer " + access } }
          );
          if (mRes.ok) {
            const member = await mRes.json();
            memberRoles = Array.isArray(member.roles) ? member.roles.map(String) : [];
          } else {
            console.warn("[discord] member roles fail", mRes.status, await mRes.text());
            // se roles obrigatórios e não conseguiu ler → bloqueia
            return res.redirect("/?discord_error=roles_unreadable");
          }
        }
      } catch (e) {
        console.warn("[discord] guild check", e.message);
      }
    }

    const requiredRoles = config.requiredDiscordRoleIds || [];
    if (requiredRoles.length) {
      const hasRole = requiredRoles.some((r) => memberRoles.includes(String(r)));
      if (!hasRole) {
        await logEvent(
          "discord_blocked",
          { discordId: String(user.id), username: user.username, reason: "missing_role" },
          req
        );
        return res.redirect("/?discord_error=missing_role");
      }
    }

    const allowed = config.allowedDiscordIds || [];
    if (allowed.length && !allowed.includes(String(user.id))) {
      await logEvent(
        "discord_blocked",
        { discordId: String(user.id), username: user.username, reason: "not_allowed" },
        req
      );
      return res.redirect("/?discord_error=not_allowed");
    }

    const tag =
      user.discriminator && user.discriminator !== "0"
        ? `${user.username}#${user.discriminator}`
        : user.global_name || user.username;

    const isAdmin = isConfiguredDiscordAdmin(String(user.id));
    const token = issueToken({
      type: "discord",
      id: String(user.id),
      username: tag,
      avatar: user.avatar,
      roles: memberRoles,
      isAdmin,
    });

    await logEvent(
      "discord",
      { discordId: String(user.id), username: tag, avatar: user.avatar || "" },
      req
    );

    res.redirect(nextPath + "?discord_token=" + encodeURIComponent(token));
  } catch (e) {
    console.error("[discord] callback", e);
    res.redirect(
      "/?discord_error=server&discord_error_detail=" + encodeURIComponent(e.message || "error")
    );
  }
});

app.get("/api/auth/me", async (req, res) => {
  const u = userFromToken(req);
  if (!u || u.type !== "discord") {
    return res.json({ authenticated: false });
  }
  const isAdmin = isConfiguredDiscordAdmin(u.id);
  const credits = isAdmin ? null : await getCreatorCreditBalance(u.id);
  res.json({
    authenticated: true,
    id: u.id,
    username: u.username,
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
      : null,
    isAdmin,
    canCreateUnlimited: isAdmin,
    creationCost: TOURNAMENT_CREATION_COST,
    tournamentCredits: credits,
  });
});

app.post("/api/auth/logout", (req, res) => {
  revokeToken(req);
  res.json({ ok: true });
});

// Cookie parser mínimo para oauth_state
app.use((req, _res, next) => {
  const raw = req.headers.cookie || "";
  req.cookies = {};
  raw.split(";").forEach((p) => {
    const [k, ...v] = p.trim().split("=");
    if (k) req.cookies[k] = decodeURIComponent(v.join("=") || "");
  });
  next();
});

// Auditoria global: registra a ação e o resultado, nunca credenciais ou corpo da requisição.
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") || req.path === "/api/admin/audit" || req.path === "/api/health") return next();
  res.on("finish", () => {
    audit(req, `http.${String(req.method || "GET").toLowerCase()}`, { metadata: { statusCode: res.statusCode } }).catch(() => {});
  });
  next();
});

// ========== META ==========
app.get("/api/meta", (_req, res) => {
  res.json({
    regions: Object.entries(Regions).map(([name, value]) => ({ name, value })),
    maps: MAP_CHOICES,
    emotes: EMOTE_CHOICES,
    phaseTypes: PHASE_TYPES,
    dbConnected,
    needSetup: !dbConnected,
    discordConfigured: !!(config.discordClientId && config.discordClientSecret),
    coverToolUrl: config.coverToolUrl || "",
    statusLabels: {
      [-1]: "Desconhecido",
      0: "Não iniciado",
      1: "Inscrições abertas",
      2: "Inscrições fechadas",
      3: "Finalizado",
      4: "Cancelado",
      5: "Em andamento",
    },
  });
});

// ========== TOURNAMENTS ==========
app.get("/api/tournaments", requireDb, discordRequired, async (req, res) => {
  try {
    const filter = (req.query.filter || "active").toString();
    let q = {};
    if (filter === "active") q = { Status: { $in: [0, 1, 2, 5] } };
    else if (filter === "history") q = { Status: { $in: [3, 4] } };
    else if (filter === "finished") q = { Status: 3 };
    else if (filter === "all") q = {};

    let list = await Tournament.find(q).sort({ StartTime: -1 }).limit(300).lean();
    list = await markFinishedIfNeeded(list);

    // Esconde finalizados/cancelados com mais de 5 min
    if (filter === "history" || filter === "finished") {
      list = list.filter(isStillVisibleFinished);
    } else if (filter === "active") {
      // já filtrado por status ativos
    } else {
      list = list.filter((d) => {
        if (d.Status === 3 || d.Status === 4) return isStillVisibleFinished(d);
        return true;
      });
    }

    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/tournaments/:id", requireDb, discordRequired, async (req, res) => {
  try {
    const t = await Tournament.findOne({ TournamentId: req.params.id }).lean();
    if (!t) return res.status(404).json({ error: "Torneio não encontrado" });
    const [marked] = await markFinishedIfNeeded([t]);
    res.json(marked);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/tournaments", requireDb, mutationLimiter, discordRequired, async (req, res) => {
  let creationCreditEvent = null;
  try {
    const b = req.body || {};
    const name = (b.name || "").trim();
    const max = parseInt(b.maxPlayers, 10);
    const startMinutes = parseInt(b.startInMinutes, 10);
    const region = b.region;
    const typeStr = b.type || "";
    const mode = b.mode === "solo" ? "solo" : "teams";
    const isSolo = mode === "solo";
    const party = isSolo ? 1 : Math.max(1, parseInt(b.party, 10) || 1);
    const matchCapacity = isSolo ? 4 : 2;
    const formatInput = { Properties: { Mode: mode }, PartySize: party, PlayersPerTeam: party, MaxTeamsPerMatch: matchCapacity };
    const formatFields = SharedTournamentRules?.BuildFormatFields
      ? SharedTournamentRules.BuildFormatFields(formatInput)
      : { PlayersPerTeam: party, MaxTeamsPerMatch: matchCapacity, MatchCapacity: party * matchCapacity };
    const fee = parseInt(b.fee, 10) || 0;
    const maxTeamsInput =
      b.maxTeams != null && b.maxTeams !== "" ? parseInt(b.maxTeams, 10) : null;
    const mapsInput = b.maps || "";
    const roundsInput = Array.isArray(b.rounds) ? b.rounds : [];
    const emote1 = b.emote1 || null;
    const emote2 = b.emote2 || null;
    const img = (b.image || "").trim() || "";
    const color = (b.color || "").trim() || "#daef20";
    const inviteOnly = b.inviteOnly === true || b.inviteOnly === "true";
    const prizes = Array.isArray(b.prizes) ? b.prizes : [];
    const prizeMode = b.prizeMode === "tag" ? "tag" : "gems";
    const prizePoolGems = prizeMode === "gems" ? Math.max(0, parseInt(b.prizePoolGems, 10) || 0) : 0;
    const prizeTag = prizeMode === "tag" ? String(b.prizeTag || "").trim().slice(0, 32) : "";
    const prizeTagDurationUnit = ["hours", "days", "months", "permanent"].includes(String(b.prizeTagDurationUnit)) ? String(b.prizeTagDurationUnit) : "permanent";
    const prizeTagDurationValue = prizeTagDurationUnit === "permanent" ? null : Math.max(1, parseInt(b.prizeTagDurationValue, 10) || 1);
    const computedPrizes = prizePoolGems > 0 ? buildPrizePool(prizePoolGems, max, formatInput) : [];
    const countForLeaderboard = !!b.countForLeaderboard;
    const streamUrl = b.streamUrl || "";

    if (!name || !max || Number.isNaN(startMinutes) || !region || !typeStr) {
      return res.status(400).json({
        error: "Preencha: nome, jogadores, início (minutos), região e tipo",
      });
    }

    if (prizeMode === "tag" && !prizeTag) {
      return res.status(400).json({ error: "Informe a tag da premiação" });
    }

    // Rounds explícitos (mapa + emotes por rodada) têm prioridade
    const normalizedRounds = roundsInput
      .map((r, i) => ({
        round: i + 1,
        map: String((r && r.map) || "").trim(),
        emotes: Array.isArray(r && r.emotes) ? r.emotes : [(r && r.emote1) || "", (r && r.emote2) || ""].filter(Boolean),
        emote1: (r && r.emote1) || (Array.isArray(r && r.emotes) ? r.emotes[0] : "") || "",
        emote2: (r && r.emote2) || (Array.isArray(r && r.emotes) ? r.emotes[1] : "") || "",
      }))
      .filter((r) => r.map);

    // Mapas e emotes são configurados por fase/round no editor. Não obrigue
    // campos globais; use um mapa interno somente como fallback do protocolo.

    const phaseType =
      typeStr === "arena" ? 1 : typeStr === "bracket" ? 2 : 3;

    let maps;
    let roundCount;
    let roundEmotes = []; // por round: array de nomes de emote

    if (normalizedRounds.length) {
      maps = normalizedRounds.map((r) => Scenes[r.map] || r.map).filter(Boolean);
      roundCount = normalizedRounds.length;
      roundEmotes = normalizedRounds.map((r) => [...new Set((r.emotes || [r.emote1, r.emote2]).filter(Boolean))]);
    } else {
      maps = resolveMaps(mapsInput);
      if (!maps.length) maps = [Scenes["Block Dash"] || "Block Dash"];
      roundCount = calcRounds(max, formatInput, typeStr, matchCapacity);
      // se só 1 mapa, repete mentalmente no webhook; array fica com 1
    }

    // emotes globais: campos globais OU união dos emotes dos rounds
    let selectedEmoteNames = Array.isArray(b.emotes) ? b.emotes.filter(Boolean) : [emote1, emote2].filter(Boolean);
    if (!selectedEmoteNames.length && roundEmotes.length) {
      const set = new Set();
      for (const arr of roundEmotes) for (const e of arr) set.add(e);
      selectedEmoteNames = [...set];
    }
    if (b.mapMode === "random" && maps.length) {
      const availableMaps = [...maps];
      maps = Array.from({ length: roundCount }, (_, index) => availableMaps[Math.floor(Math.random() * availableMaps.length)] || availableMaps[index % availableMaps.length]);
    }
    if (b.emoteMode === "random" && selectedEmoteNames.length) {
      const availableEmotes = selectedEmoteNames.includes("none") ? ["none"] : [...selectedEmoteNames];
      roundEmotes = Array.from({ length: roundCount }, () => [availableEmotes[Math.floor(Math.random() * availableEmotes.length)]]);
    }
    const disabledEmotes = buildDisabledEmotes(selectedEmoteNames);
    const correctMaxTeams = party >= 2 ? Math.floor(max / party) : max;
    const finalMaxTeams =
      maxTeamsInput != null && !Number.isNaN(maxTeamsInput)
        ? Math.min(maxTeamsInput, correctMaxTeams)
        : correctMaxTeams;

    const phases = [
      {
        PhaseType: phaseType,
        IsPhase: phaseType === 3,
        RoundCount: roundCount,
        MaxTeams: finalMaxTeams,
        GroupCount: 1,
        Maps: maps,
      },
    ];

    // Fases opcionais no formato tipo,rounds,maxTimes; no máximo três.
    const requestedPhases = Array.isArray(b.phases) ? b.phases : [];
    if (requestedPhases.length > 0) {
      const parsedPhases = requestedPhases.slice(0, 3).map((raw, index) => {
        const phase = raw && typeof raw === "object" ? raw : { name: String(raw).split(",")[0] };
        const phaseName = String(phase.name || phase.Name || `Phase ${index + 1}`).trim();
        const isFinalBracket = index === Math.min(requestedPhases.length, 3) - 1;
        const phaseTypeValue = isFinalBracket ? 2 : 3;
        const configuredRounds = Array.isArray(phase.rounds) ? phase.rounds : [];
        const phaseRounds = isFinalBracket
          ? Math.max(1, Math.min(32, calcRounds(max, formatInput, "bracket", matchCapacity)))
          : Math.max(1, Math.min(32, parseInt(phase.rounds, 10) || calcRounds(max, formatInput, "roundrobin", matchCapacity)));
        const phaseMaps = isFinalBracket
          ? configuredRounds.map((r) => resolveMaps([r && r.map]).filter(Boolean)[0] || maps[0]).slice(0, phaseRounds)
          : (Array.isArray(phase.maps) && phase.maps.length ? resolveMaps([phase.maps[0]]) : maps.slice(0, 1));
        const phaseEmotes = isFinalBracket
          ? configuredRounds.slice(0, phaseRounds).map((r) => Array.isArray(r && r.emotes) ? [...new Set(r.emotes.filter(Boolean))] : [])
          : (Array.isArray(phase.emotes) ? [[...new Set(phase.emotes.filter(Boolean))]] : []);
        while (phaseMaps.length < phaseRounds) phaseMaps.push(phaseMaps[phaseMaps.length - 1] || maps[0]);
        while (phaseEmotes.length < phaseRounds) phaseEmotes.push(phaseEmotes[phaseEmotes.length - 1] || []);
        const phaseMaxTeams = Math.max(1, Math.min(finalMaxTeams, correctMaxTeams));
        return { Name: phaseName, PhaseType: phaseTypeValue, IsPhase: phaseTypeValue === 3, RoundCount: phaseRounds, MaxTeams: phaseMaxTeams, GroupCount: Math.max(1, Math.ceil(correctMaxTeams / Math.max(1, phaseMaxTeams))), Maps: phaseMaps, RoundEmotes: phaseEmotes, _index: index };
      });
      if (parsedPhases.length > 0) {
        parsedPhases[parsedPhases.length - 1].PhaseType = 2;
        parsedPhases[parsedPhases.length - 1].Name = parsedPhases[parsedPhases.length - 1].Name || `Phase ${parsedPhases.length}`;
        parsedPhases[parsedPhases.length - 1].IsPhase = false;
        phases.splice(0, phases.length, ...parsedPhases.map(({ _index, ...phase }) => phase));
        roundCount = phases.reduce((total, phase) => total + Math.max(1, Number(phase.RoundCount) || 1), 0);
      }
    }

    const id = b.tournamentId || (await generateTournamentId());
    if (!isTournamentAdmin(req) && TOURNAMENT_CREATION_COST > 0) {
      creationCreditEvent = `tournament:create:${req.discordUser.id}:${id}`;
      const charged = await debitCreatorCredits(req.discordUser.id, TOURNAMENT_CREATION_COST, creationCreditEvent, { tournamentId: id, source: "site" });
      if (!charged.ok) return res.status(charged.status || 402).json({ error: charged.error || "Créditos insuficientes para criar torneio", balance: charged.balance });
    }

    const startTime = new Date(Date.now() + startMinutes * 60 * 1000);
    const signupStart = new Date(startTime.getTime() - 60 * 60 * 1000);
    const existingCount = await Tournament.countDocuments({ Status: { $ne: 4 } });
    const tournamentType = existingCount % 10;

    const doc = {
      CurrentInvites: 0,
      MaxInvites: max,
      MinPlayersPerMatch: 2,
      MaxPlayersPerMatch: matchCapacity,
      ...formatFields,
      TournamentId: id,
      TournamentName: name,
      TournamentImage: img || undefined,
      TournamentColor: color,
      StartTime: startTime,
      SignupStart: signupStart,
      EntryFee: fee,
      PrizepoolId: generatePrizepoolId(),
      PartySize: party,
      Status: 1,
      TournamentType: tournamentType,
      Phases: phases,
      Region: region,
      RoundCount: roundCount,
      CurrentPhaseId: 0,
      Properties: {
        Mode: mode,
        IsInvitationOnly: inviteOnly,
        InvitedIds: [],
        DisabledEmotes: disabledEmotes,
        SelectedEmotes: selectedEmoteNames,
        RoundEmotes: roundEmotes,
        RoundMaps: (normalizedRounds || []).map((r) => r.map),
        MapMode: b.mapMode === "random" ? "random" : "fixed",
        EmoteMode: b.emoteMode === "random" ? "random" : "fixed",
        AdminIds: [],
        StreamURL: streamUrl,
        CountForLeaderboard: countForLeaderboard,
      },
      PrizePoolGems: prizePoolGems,
      PrizeMode: prizeMode,
      PrizeTag: prizeTag || undefined,
      PrizeTagDurationUnit: prizeMode === "tag" ? prizeTagDurationUnit : undefined,
      PrizeTagDurationValue: prizeMode === "tag" ? prizeTagDurationValue : undefined,
      Prizes: (computedPrizes.length ? computedPrizes : prizes)
        .filter((p) => p && p.position != null)
        .map((p) => ({ position: Number(p.position), endPosition: Number(p.endPosition || p.position), amount: Number(p.amount) || 0, label: p.label || "" })),
      Winners: [],
      CreatedByDiscordId: req.discordUser.id,
      CreatedByDiscordTag: req.discordUser.username,
    };

    // IDs podem ser reutilizados: remove dados de inscrição antigos antes de criar o novo torneio.
    try {
      const { BackboneUser } = loadBackboneWoModules();
      await BackboneUser.updateMany({}, { $unset: { [`Tournaments.${id}`]: "" } });
    } catch (cleanupError) {
      console.warn("[tournament] não foi possível limpar inscrições antigas do ID", id, cleanupError.message);
    }
    const saved = await Tournament.create(doc);
    await audit(req, "tournament.create", { resourceType: "tournament", resourceId: id, metadata: { name, prizeMode, entryFee: fee, maxPlayers: max } });

    try {
      const obj = saved.toObject ? saved.toObject() : saved;
      const messageId = await sendDiscordEmbed(obj);
      if (messageId) {
        await Tournament.updateOne(
          { TournamentId: id },
          {
            $set: {
              WebhookMessageId: messageId,
              "Properties.WebhookMessageId": messageId,
            },
          }
        );
      }
      // Avisa a Backbone (usa o webhook/config dela se expuser endpoint; senão só Mongo)
      await notifyBackbone(obj);
    } catch (whErr) {
      console.error("[webhook] create side-effect", whErr.message);
    }

    const fresh = await Tournament.findOne({ TournamentId: id }).lean();
    res.status(201).json(fresh);
  } catch (e) {
    if (creationCreditEvent && !isTournamentAdmin(req)) {
      await refundCreatorCredits(req.discordUser.id, TOURNAMENT_CREATION_COST, `refund:${creationCreditEvent}`, { reason: "tournament_create_failed" }).catch(() => {});
    }
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/tournaments/:id", requireDb, mutationLimiter, discordRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    const update = {};
    const existingForEdit = await Tournament.findOne({ TournamentId: req.params.id }).lean();
    if (!existingForEdit) return res.status(404).json({ error: "Torneio não encontrado" });
    if (!isTournamentAdmin(req) && String(existingForEdit.CreatedByDiscordId || "") !== String(req.discordUser.id)) return res.status(403).json({ error: "Somente o administrador ou criador pode editar este torneio" });
    const existingMode = existingForEdit?.Properties?.Mode ||
      (getTournamentFormat(existingForEdit).mode === "solo" ? "solo" : "teams");
    if (b.name != null) update.TournamentName = String(b.name).trim();
    const editMode = b.mode != null ? (b.mode === "solo" ? "solo" : "teams") : (existingMode === "solo" ? "solo" : "teams");
    const editCapacity = editMode === "solo" ? 4 : 2;
    const editParty = editMode === "solo" ? 1 : Math.max(1, parseInt(b.party ?? existingForEdit?.PlayersPerTeam ?? existingForEdit?.PartySize, 10) || 1);
    const editFormatInput = makeFormatInput(editMode, editParty, editCapacity);
    const editFormatFields = getFormatFields(editFormatInput);
    update["Properties.Mode"] = editMode;
    Object.assign(update, editFormatFields);
    if (b.maxPlayers != null) {
      const editedMax = Math.max(1, parseInt(b.maxPlayers, 10) || 1);
      update.MaxInvites = editedMax;
      update.MaxPlayersPerMatch = editCapacity;
      update.PartySize = editParty;
    } else if (b.mode != null) {
      update.MaxPlayersPerMatch = editCapacity;
      if (b.party == null) update.PartySize = editParty;
    }
    if (b.fee != null) update.EntryFee = Math.max(0, parseInt(b.fee, 10) || 0);
    if (b.startInMinutes != null && Number.isFinite(Number(b.startInMinutes))) {
      const editedStart = new Date(Date.now() + Math.max(0, Number(b.startInMinutes)) * 60 * 1000);
      update.StartTime = editedStart;
      update.SignupStart = new Date(editedStart.getTime() - 60 * 60 * 1000);
    }
    if (b.image != null) update.TournamentImage = b.image;
    if (b.color != null) update.TournamentColor = b.color;
    if (b.status != null) {
      const st = parseInt(b.status, 10);
      update.Status = st;
      if (st === 3 || st === 4) update.FinishedAt = new Date();
    }
    if (b.region != null) update.Region = b.region;
    if (b.party != null) {
      update.PartySize = editParty;
      update.MaxPlayersPerMatch = editCapacity;
    }
    if (b.streamUrl != null) update["Properties.StreamURL"] = b.streamUrl;
    if (b.mapMode != null) update["Properties.MapMode"] = b.mapMode === "random" ? "random" : "fixed";
    if (b.emoteMode != null) update["Properties.EmoteMode"] = b.emoteMode === "random" ? "random" : "fixed";
    if (Array.isArray(b.rounds) && b.rounds.length) {
      const editedRounds = b.rounds.map((r, index) => ({
        round: index + 1,
        map: String(r?.map || "").trim(),
        emotes: [...new Set((Array.isArray(r?.emotes) ? r.emotes : [r?.emote1, r?.emote2]).filter(Boolean))],
      })).filter((r) => r.map);
      update["Properties.RoundMaps"] = editedRounds.map((r) => r.map);
      update["Properties.RoundEmotes"] = editedRounds.map((r) => r.emotes);
      update.RoundCount = editedRounds.length;
    }
    if (Array.isArray(b.phases) && b.phases.length) {
      const phaseInputs = b.phases.slice(0, 3).map((phase, index) => phase && typeof phase === "object" ? phase : { name: String(phase).split(",")[0] });
      const names = phaseInputs.map((phase, index) => String(phase.name || phase.Name || `Phase ${index + 1}`).trim());
      const max = Number(b.maxPlayers || 1);
      const party = editParty;
      const normalRounds = calcRounds(max, editFormatInput, "roundrobin", editCapacity);
      const bracketRounds = calcRounds(max, editFormatInput, "bracket", editCapacity);
      update.Phases = phaseInputs.map((phase, index) => {
        const isBracket = index === names.length - 1;
        const configuredRounds = Array.isArray(phase.rounds) ? phase.rounds : [];
        const roundCount = isBracket ? bracketRounds : Math.max(1, Math.min(32, Number(phase.rounds) || normalRounds));
        const mapsForPhase = isBracket
          ? configuredRounds.map((r) => resolveMaps([r && r.map]).filter(Boolean)[0]).slice(0, roundCount)
          : (Array.isArray(phase.maps) && phase.maps.length ? resolveMaps([phase.maps[0]]) : []);
        const emotesForPhase = isBracket
          ? configuredRounds.slice(0, roundCount).map((r) => Array.isArray(r && r.emotes) ? [...new Set(r.emotes.filter(Boolean))] : [])
          : (Array.isArray(phase.emotes) ? [[...new Set(phase.emotes.filter(Boolean))]] : []);
        while (mapsForPhase.length < roundCount) mapsForPhase.push(mapsForPhase[mapsForPhase.length - 1] || "");
        while (emotesForPhase.length < roundCount) emotesForPhase.push(emotesForPhase[emotesForPhase.length - 1] || []);
        return { Name: names[index], PhaseType: isBracket ? 2 : 3, IsPhase: !isBracket, RoundCount: roundCount, MaxTeams: Math.max(1, Math.floor(max / party)), GroupCount: 1, Maps: mapsForPhase, RoundEmotes: emotesForPhase };
      });
    }
    if (b.inviteOnly != null) update["Properties.IsInvitationOnly"] = !!b.inviteOnly;
    if (b.countForLeaderboard != null)
      update["Properties.CountForLeaderboard"] = !!b.countForLeaderboard;
    if (b.emotes != null || b.emote1 != null || b.emote2 != null) {
      const selected = Array.isArray(b.emotes) ? b.emotes.filter(Boolean) : [b.emote1, b.emote2].filter(Boolean);
      update["Properties.SelectedEmotes"] = selected.includes("none") ? ["none"] : [...new Set(selected)];
      update["Properties.DisabledEmotes"] = buildDisabledEmotes(update["Properties.SelectedEmotes"]);
    }
    if (b.prizeMode != null) update.PrizeMode = b.prizeMode === "tag" ? "tag" : "gems";
    if (b.prizeTag != null) update.PrizeTag = String(b.prizeTag || "").trim().slice(0, 32);
    if (b.prizeTagDurationUnit != null) update.PrizeTagDurationUnit = ["hours", "days", "months", "permanent"].includes(String(b.prizeTagDurationUnit)) ? String(b.prizeTagDurationUnit) : "permanent";
    if (b.prizeTagDurationValue != null) update.PrizeTagDurationValue = Math.max(1, parseInt(b.prizeTagDurationValue, 10) || 1);
    if (b.prizeMode === "tag" && !String(b.prizeTag || existingForEdit?.PrizeTag || "").trim()) return res.status(400).json({ error: "Informe a tag da premiação" });
    if (b.prizePoolGems != null) {
      const pool = Math.max(0, parseInt(b.prizePoolGems, 10) || 0);
      update.PrizePoolGems = pool;
      const prizeMaxPlayers = Number(b.maxPlayers || existingForEdit?.MaxInvites || 1);
      update.Prizes = buildPrizePool(pool, prizeMaxPlayers, editFormatInput);
    } else if (Array.isArray(b.prizes)) {
      update.Prizes = b.prizes
        .filter((p) => p && p.position != null)
        .map((p) => ({
          position: Number(p.position),
          endPosition: Number(p.endPosition || p.position),
          amount: Number(p.amount) || 0,
          label: p.label || "",
        }));
    }
    if (!Object.keys(update).length) {
      return res.status(400).json({ error: "Nada para atualizar" });
    }
    const result = await Tournament.updateOne({ TournamentId: id }, { $set: update });
    await audit(req, "tournament.update", { resourceType: "tournament", resourceId: id, metadata: { fields: Object.keys(update) } });
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Torneio não encontrado" });
    }
    const updated = await Tournament.findOne({ TournamentId: id }).lean();
    if (updated) {
      await updateDiscordWebhook(updated);
      await notifyBackbone(updated);
    }
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/tournaments/:id", requireDb, mutationLimiter, discordRequired, async (req, res) => {
  try {
    const current = await Tournament.findOne({ TournamentId: req.params.id }).lean();
    if (!current) return res.status(404).json({ error: "Não encontrado" });
    if (!isTournamentAdmin(req) && String(current.CreatedByDiscordId || "") !== String(req.discordUser.id)) return res.status(403).json({ error: "Somente o administrador ou criador pode cancelar este torneio" });
    const soft = req.query.soft !== "0"; // default soft
    if (soft) {
      const r = await Tournament.updateOne(
        { TournamentId: req.params.id },
        { $set: { Status: 4, FinishedAt: new Date() } }
      );
      if (r.matchedCount === 0) return res.status(404).json({ error: "Não encontrado" });
      await audit(req, "tournament.cancel", { resourceType: "tournament", resourceId: req.params.id });
      return res.json({ ok: true, canceled: true });
    }
    const r = await Tournament.deleteOne({ TournamentId: req.params.id });
    if (r.deletedCount === 0) return res.status(404).json({ error: "Não encontrado" });
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Duplicação foi removida do produto. Mantemos uma resposta explícita para clientes antigos.
app.post("/api/tournaments/:id/duplicate", discordRequired, async (req, res) => {
  await audit(req, "tournament.duplicate.denied", { resourceType: "tournament", resourceId: req.params.id });
  return res.status(410).json({ error: "A duplicação de torneios foi removida; use Ver bracket ou crie um novo torneio" });
});

// ========== CRÉDITOS DE CRIAÇÃO ==========
app.post("/api/internal/tournament-credits/charge", mutationLimiter, async (req, res) => {
  if (!internalSecretOk(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  try {
    const result = await debitCreatorCredits(req.body?.discordId || req.body?.userId, req.body?.amount, req.body?.eventId, { source: "bot" });
    res.status(result.status || (result.ok ? 200 : 402)).json(result);
  } catch (e) { res.status(500).json({ ok: false, error: "CREDIT_CHARGE_FAILED" }); }
});
app.post("/api/internal/tournament-credits/refund", mutationLimiter, async (req, res) => {
  if (!internalSecretOk(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  try {
    const result = await refundCreatorCredits(req.body?.discordId || req.body?.userId, req.body?.amount, req.body?.eventId, { source: "bot" });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) { res.status(500).json({ ok: false, error: "CREDIT_REFUND_FAILED" }); }
});

app.get("/api/credits/me", requireDb, discordRequired, async (req, res) => {
  const isAdmin = isTournamentAdmin(req);
  res.json({ discordId: req.discordUser.id, isAdmin, unlimited: isAdmin, cost: TOURNAMENT_CREATION_COST, balance: isAdmin ? null : await getCreatorCreditBalance(req.discordUser.id) });
});

app.post("/api/admin/credits/:discordId/grant", adminRequired, mutationLimiter, async (req, res) => {
  const amount = Math.max(0, parseInt(req.body?.amount, 10) || 0);
  if (!amount) return res.status(400).json({ error: "Informe uma quantidade positiva" });
  const eventId = `credit:grant:${req.params.discordId}:${String(req.body?.reference || crypto.randomBytes(8).toString("hex"))}`;
  try {
    if (!dbConnected || !TournamentCreditLedger) return res.status(503).json({ error: "Banco indisponível" });
    await TournamentCreditLedger.create({ eventId, discordId: String(req.params.discordId), amount, kind: "grant", metadata: { by: req.discordUser.id } });
    const balance = await getCreatorCreditBalance(req.params.discordId);
    await audit(req, "credit.grant", { resourceType: "discord_account", resourceId: req.params.discordId, metadata: { amount, balance } });
    res.json({ ok: true, balance });
  } catch (e) { if (e?.code === 11000) return res.json({ ok: true, duplicate: true, balance: await getCreatorCreditBalance(req.params.discordId) }); res.status(500).json({ error: "CREDIT_GRANT_FAILED" }); }
});

// ========== BRACKET, MATCHES E ESPECTADOR ==========
function sanitizeMatch(match, tournament, viewerPlayerId = "") {
  const status = Number(match.status);
  const watchable = status === 4;
  const viewerIsPlayer = Boolean(viewerPlayerId) && (match.users || []).some((user) => String(user["@user-id"] || "") === String(viewerPlayerId));
  const players = (match.users || []).map((user) => ({
    id: String(user["@user-id"] || ""),
    nick: String(user["@nick"] || user["@username"] || user["@user-id"] || ""),
    team: String(user["@team-id"] || ""),
    checkedIn: user["@checked-in"] === "1",
    winner: user["@match-winner"] === "1",
  }));
  return {
    id: String(match.id), tournamentId: String(match.tournamentid), tournamentName: tournament?.TournamentName || String(match.tournamentid),
    phase: Number(match.phaseid), phaseLabel: [2, 4].includes(Number(tournament?.Phases?.[Math.max(0, Number(match.phaseid) - 1)]?.PhaseType)) ? "Bracket" : "Grupo", round: Number(match.roundid), matchNumber: Number(match.matchid),
    status, statusLabel: status === 4 ? "Em andamento" : status === 3 ? "Pronta" : status === 2 ? "Aguardando" : status === 1 ? "Criada" : "Finalizada",
    isLive: status === 4, isFinished: [5, 6, 7, 8].includes(status), canWatch: watchable && !viewerIsPlayer, viewerIsPlayer, players,
  };
}

app.get("/api/tournaments/:id/bracket", requireDb, discordRequired, async (req, res) => {
  try {
    const tournament = await Tournament.findOne({ TournamentId: req.params.id }).lean();
    if (!tournament) return res.status(404).json({ error: "Torneio não encontrado" });
    const { Match } = loadBackboneWoModules();
    const matches = await Match.find({ tournamentid: String(req.params.id) }).sort({ phaseid: 1, roundid: 1, matchid: 1 }).limit(500).lean();
    await audit(req, "bracket.view", { resourceType: "tournament", resourceId: req.params.id });
    res.json({ tournament: { id: tournament.TournamentId, name: tournament.TournamentName, prizeMode: tournament.PrizeMode || "gems", prizeTag: tournament.PrizeTag || "", prizePoolGems: Number(tournament.PrizePoolGems || 0), winners: tournament.Winners || [] }, matches: matches.map((match) => sanitizeMatch(match, tournament, req.discordUser.id)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/matches/:matchId/spectate", requireDb, discordRequired, async (req, res) => {
  try {
    const { Match } = loadBackboneWoModules();
    const match = await Match.findOne({ id: String(req.params.matchId) }).lean();
    if (!match) return res.status(404).json({ error: "Partida não encontrada" });
    const tournament = await Tournament.findOne({ TournamentId: String(match.tournamentid) }).lean();
    if (!tournament) return res.status(404).json({ error: "Torneio não encontrado" });
    const viewerIsPlayer = (match.users || []).some((user) => String(user["@user-id"]) === String(req.discordUser.id));
    if (viewerIsPlayer) return res.status(403).json({ error: "Jogadores da partida não podem entrar como espectadores" });
    const view = sanitizeMatch(match, tournament, req.discordUser.id);
    if (!view.canWatch || view.isFinished) return res.status(409).json({ error: "Partida não está disponível para espectadores" });
    await audit(req, "match.spectate", { resourceType: "match", resourceId: match.id, metadata: { tournamentId: match.tournamentid, phase: match.phaseid, round: match.roundid, ghost: true } });
    res.json({ ...view, spectator: true, spectatorRules: { isGhost: true, countsAsPlayer: false, canSubmitResult: false, canCheckIn: false, canChangeMatch: false, appearsEliminatedLocally: true } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/wo/:matchId", requireDb, mutationLimiter, adminRequired, async (req, res) => {
  try {
    const { Match, BackboneUser, BackboneTournament, Qualify } = loadBackboneWoModules();
    const match = await Match.findOne({ id: String(req.params.matchId) });
    if (!match || [5, 7, 8].includes(Number(match.status))) return res.status(404).json({ error: "Partida indisponível" });
    const playerId = String(req.body?.playerId || "");
    const selected = match.users.find((user) => String(user["@user-id"]) === playerId);
    if (!selected) return res.status(400).json({ error: "Jogador não está nessa partida" });
    const winningTeam = selected["@team-id"];
    const winners = [], losers = [];
    for (const user of match.users) { const winner = user["@team-id"] === winningTeam; user["@match-winner"] = winner ? "1" : "0"; user["@match-points"] = winner ? "1" : "0"; user["@team-score"] = winner ? "1" : "0"; user["@user-score"] = winner ? "1" : "0"; user["@checked-in"] = "1"; (winner ? winners : losers).push(String(user["@user-id"])); }
    match.status = 5;
    await match.save();
    const payload = { id: match.id, secret: match.secret, deadline: match.deadline, matchid: match.matchid, phaseid: match.phaseid, groupid: match.groupid, roundid: match.roundid, playedgamecount: match.playedgamecount, status: match.status, tournamentid: match.tournamentid, users: match.users };
    await BackboneUser.updateMany({ UserId: { $in: [...winners, ...losers] } }, { $set: { [`Tournaments.${match.tournamentid}.UserMatch`]: payload } });
    const tournament = await BackboneTournament.findOne({ TournamentId: String(match.tournamentid) });
    const winnerUser = await BackboneUser.findOne({ UserId: winners[0] });
    if (tournament && winnerUser && typeof Qualify === "function") await Qualify(winnerUser, tournament);
    await audit(req, "match.wo.apply", { resourceType: "match", resourceId: match.id, metadata: { tournamentId: match.tournamentid, playerId, winners, losers } });
    res.json({ ok: true, matchId: match.id, tournamentId: match.tournamentid, winners, losers });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ========== TEMPLATES ==========
app.get("/api/templates", discordRequired, async (_req, res) => {
  res.json(await loadTemplates());
});

app.post("/api/templates", mutationLimiter, discordRequired, async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: "Nome do template obrigatório" });
  const item = {
    id: crypto.randomBytes(8).toString("hex"),
    name: String(b.name).trim(),
    createdAt: new Date().toISOString(),
    data: b.data || b,
  };
  await saveTemplate(item);
  await audit(req, "template.create", { resourceType: "template", resourceId: item.id, metadata: { name: item.name } });
  res.status(201).json(item);
});

app.delete("/api/templates/:id", discordRequired, async (req, res) => {
  await deleteTemplate(req.params.id);
  res.json({ ok: true });
});

app.post("/api/preview", discordRequired, (req, res) => {
  const b = req.body || {};
  const max = parseInt(b.maxPlayers, 10) || 0;
  const mode = b.mode === "solo" ? "solo" : "teams";
  const party = mode === "solo" ? 1 : Math.max(1, parseInt(b.party, 10) || 1);
  const formatInput = makeFormatInput(mode, party, mode === "solo" ? 4 : 2);
  const format = getTournamentFormat(formatInput);
  const typeStr = b.type || "bracket";
  const rounds = max ? calcRounds(max, formatInput, typeStr) : 0;
  res.json({
    TournamentName: b.name || "",
    MaxInvites: max,
    PartySize: format.playersPerTeam,
    PlayersPerTeam: format.playersPerTeam,
    MaxTeamsPerMatch: format.maxTeamsPerMatch,
    MatchCapacity: format.matchPlayerCapacity,
    Properties: { Mode: format.mode },
    Region: b.region || "",
    EntryFee: parseInt(b.fee, 10) || 0,
    RoundCount: rounds,
    Type: typeStr,
    SelectedEmotes: [b.emote1, b.emote2].filter(Boolean),
    Color: b.color || "",
    Image: b.image || "",
  });
});

// Calendário — torneios dos próximos N dias
app.get("/api/calendar", requireDb, discordRequired, async (req, res) => {
  try {
    const days = Math.min(31, Math.max(1, parseInt(req.query.days, 10) || 7));
    const now = new Date();
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const list = await Tournament.find({
      Status: { $in: [0, 1, 2, 5] },
      StartTime: { $gte: now, $lte: end },
    })
      .sort({ StartTime: 1 })
      .limit(200)
      .lean();
    // agrupa por dia YYYY-MM-DD
    const byDay = {};
    for (const t of list) {
      const key = new Date(t.StartTime).toISOString().slice(0, 10);
      if (!byDay[key]) byDay[key] = [];
      byDay[key].push({
        TournamentId: t.TournamentId,
        TournamentName: t.TournamentName,
        TournamentColor: t.TournamentColor,
        StartTime: t.StartTime,
        Region: t.Region,
        MaxInvites: t.MaxInvites,
        CurrentInvites: t.CurrentInvites,
        Status: t.Status,
        PartySize: getTournamentFormat(t).playersPerTeam,
        PlayersPerTeam: getTournamentFormat(t).playersPerTeam,
        MaxTeamsPerMatch: getTournamentFormat(t).maxTeamsPerMatch,
        MatchCapacity: getTournamentFormat(t).matchPlayerCapacity,
        Mode: getTournamentFormat(t).mode,
        CreatedByDiscordId: t.CreatedByDiscordId,
        CreatedByDiscordTag: t.CreatedByDiscordTag,
      });
    }
    res.json({ days, from: now.toISOString(), to: end.toISOString(), byDay });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Leaderboard — ranking por vitórias nos Winners
app.get("/api/leaderboard", requireDb, discordRequired, async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const finished = await Tournament.find({ Status: 3, Winners: { $exists: true, $ne: [] } })
      .select("TournamentId TournamentName Winners StartTime Region")
      .sort({ StartTime: -1 })
      .limit(300)
      .lean();
    const map = new Map();
    for (const t of finished) {
      for (const w of t.Winners || []) {
        const id = String(w.PlayerId || w.userId || w.id || w.DiscordId || w.Name || "");
        if (!id) continue;
        const name = w.Name || w.DisplayName || w.username || id;
        if (!map.has(id)) {
          map.set(id, { id, name, wins: 0, podiums: 0, tournaments: 0, lastWin: null });
        }
        const row = map.get(id);
        row.tournaments += 1;
        const pos = Number(w.Position ?? w.position ?? w.Place ?? 99);
        if (pos === 1) {
          row.wins += 1;
          row.lastWin = t.StartTime;
        }
        if (pos >= 1 && pos <= 3) row.podiums += 1;
        if (w.Name || w.DisplayName) row.name = w.Name || w.DisplayName;
      }
    }
    const ranking = [...map.values()]
      .sort((a, b) => b.wins - a.wins || b.podiums - a.podiums || b.tournaments - a.tournaments)
      .slice(0, limit)
      .map((r, i) => ({ rank: i + 1, ...r }));
    res.json({ ranking, sourceTournaments: finished.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stats rápidas
app.get("/api/stats", requireDb, discordRequired, async (_req, res) => {
  try {
    const [open, running, finishedRecent, total] = await Promise.all([
      Tournament.countDocuments({ Status: 1 }),
      Tournament.countDocuments({ Status: 5 }),
      Tournament.countDocuments({ Status: { $in: [3, 4] } }),
      Tournament.countDocuments({}),
    ]);
    res.json({ open, running, finishedRecent, total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== STATIC + ROUTES ==========
// Em teoria __dirname já resolve certo independente de onde o Render põe o
// projeto — mas se a pasta public/ não foi enviada pro repo (ou está num
// lugar inesperado), procura em alguns candidatos e loga bem claro o que
// encontrou, pra facilitar diagnosticar isso pelo log do Render.
function resolvePublicDir() {
  const candidates = [
    path.join(__dirname, "public"),
    path.join(process.cwd(), "public"),
    path.join(__dirname, "..", "public"),
    path.join(__dirname, "src", "public"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) {
      console.log("[static] usando public em:", c);
      return c;
    }
  }
  console.error("[static] NÃO achei public/index.html em nenhum destes caminhos:");
  candidates.forEach((c) => console.error("  - " + c + (fs.existsSync(c) ? " (pasta existe, mas sem index.html)" : " (não existe)")));
  try {
    console.error("[static] conteúdo de __dirname (" + __dirname + "):", fs.readdirSync(__dirname));
  } catch (e) {
    console.error("[static] não consegui listar __dirname:", e.message);
  }
  return candidates[0]; // segue com o padrão, mas já logamos o motivo do 404
}

const PUBLIC_DIR = resolvePublicDir();

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      if (/\.(js|css|html)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Job: marca FinishedAt em docs antigos que o jogo já finalizou/cancelou.
// Só roda em processo persistente (Render/local com `node server.js`).
// Em serverless (Netlify) não existe processo contínuo para um setInterval;
// a marcação acontece de qualquer forma a cada listagem (markFinishedIfNeeded
// já é chamado nas rotas de leitura), e opcionalmente por uma Netlify
// Scheduled Function separada (netlify/functions/cleanup-finished.js).
function startCleanupJob() {
  setInterval(async () => {
    if (!dbConnected || !Tournament) return;
    try {
      const candidates = await Tournament.find({
        Status: { $in: [3, 4] },
        FinishedAt: { $exists: false },
      })
        .limit(50)
        .lean();
      if (candidates.length) {
        await markFinishedIfNeeded(candidates);
      }
    } catch (_) {}
  }, 60 * 1000);
}

async function start() {
  await ensureDbConnected();
  if (!dbConnected) {
    console.log("[site] Mongo ainda não configurado.");
    console.log("[site] IMPORTANTE no Render: defina DATABASE_URI nas Environment Variables");
    console.log("[site] sem isso a config do /admin some a cada deploy (disco efêmero).");
  }
  startCleanupJob();
  app.listen(PORT, () => {
    console.log("[site] http://localhost:" + PORT);
    console.log("[site] Admin: http://localhost:" + PORT + "/admin  (OAuth Discord + DISCORD_ADMIN_IDS)");
    console.log("[site] DB: " + (dbConnected ? "ok" : "pendente"));
    console.log("[site] Discord OAuth: " + (config.discordClientId ? "configurado" : "não configurado"));
    console.log("[site] sessionSecret: " + (process.env.SESSION_SECRET ? "env" : "ausente — obrigatório em produção"));
  });
}

// Só sobe um servidor HTTP contínuo quando rodado diretamente (Render/local:
// `node server.js` / `npm start`). Em serverless (Netlify Functions), este
// arquivo é apenas `require`ado pela function, que chama o `app` do Express
// diretamente a cada requisição — sem app.listen.
if (require.main === module && !INTEGRATED_IN_BACKBONE) {
  start();
}

module.exports = { app, ensureDbConnected, markFinishedIfNeeded, getModels: () => ({ Tournament, SiteSettings, LoginLog, AuditLog, TournamentCreditLedger }) };
