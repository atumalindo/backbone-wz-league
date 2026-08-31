import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} from "discord.js";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { CreateTournament, GetSmallestAvailableTournamentId } from "./Database";
import { Emotes, Scenes, Regions, IsDiscordEnvironmentAdmin } from "../Backbone/Config";
import { GeneratePrizepoolId } from "../Modules/Extensions";
import { Tournament } from "../Models/Tournament";
import { BuildPrizeDistribution } from "../Backbone/Logic/TournamentEconomy";
import { BuildFormatFields, CalculateRoundCount } from "../Backbone/Logic/TournamentRules";
import { BackboneUser } from "../Models/BackboneUser";
import { Match } from "../Models/Matches";
import { SpectatorSession } from "../Models/SpectatorSessions";
import { Qualify } from "../Backbone/Logic/GetMatches";
import { TournamentMatchStatus } from "../Backbone/Config";
import { TransitionMatch } from "../Backbone/Logic/MatchStateMachine";
import { msg } from "../Modules/Logger";

export const Bot = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const Rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN || "");

const mapChoices = [
  { name: "Disco Drop ", value: "Disco Drop" },
  { name: "Block Dash", value: "Block Dash" },
  { name: "Block Dash Legendary", value: "Block Dash Legendary" },
  { name: "Laser Dash", value: "Laser Dash" },
  { name: "Laser Tracer", value: "Laser Tracer" },
  { name: "Honey Drop", value: "Honey Drop" },
  { name: "Bombardment", value: "Bombardment" },
  { name: "Lava Land", value: "Lava Land" },
  { name: "Bot Bash", value: "Bot Bash" },
  { name: "Rush Hour", value: "Rush Hour" },
  { name: "The Other Side", value: "The Other Side" },
  { name: "Acid Pool", value: "Acid Pool" },
  { name: "Space Drop", value: "Space Drop" },
];

const regionChoices = Object.keys(Regions).map((name) => ({
  name,
  value: Regions[name as keyof typeof Regions],
}));

const emoteChoices = [
  { name: "soco", value: "soco" },
  { name: "rasteira", value: "rasteira" },
  { name: "banana", value: "banana" },
  { name: "coração", value: "coracao" },
  { name: "maleta", value: "maleta" },
  { name: "tetris", value: "tetris" },
  { name: "espatula", value: "espatula" },
  { name: "karate", value: "karate" },
  { name: "cuspe", value: "cuspe" },
  { name: "raio", value: "raio" },
  { name: "invisivel", value: "invisivel" },
  { name: "bola", value: "bola" },
  { name: "escudo", value: "escudo" },
  { name: "bola de neve", value: "bola de neve" },
  { name: "nenhum", value: "nenhum" },
];

/**
 * Resolve um nome de emote (PT) → lista de IDs do enum Emotes (Config).
 * Pares (soco, banana, rasteira, coração) retornam os DOIS IDs do jogo.
 */
function resolveEmoteToIds(name: string): number[] {
  const lower = name.trim().toLowerCase();
  const E = Emotes as unknown as Record<string, number>;

  const pick = (...keys: string[]): number[] => {
    const ids: number[] = [];
    for (const k of keys) {
      if (E[k] !== undefined) ids.push(E[k]);
    }
    return ids;
  };

  const firstNonEmpty = (...lists: number[][]): number[] => {
    for (const list of lists) {
      if (list.length > 0) return list;
    }
    return [];
  };

  switch (lower) {
    case "soco":
    case "punch":
      // IDs positivos do Config: Punch + Fire Punch
      return firstNonEmpty(pick("Punch", "Fire Punch"), pick("Punch"));
    case "banana":
      return firstNonEmpty(pick("Banana", "Golden Banana"), pick("Banana"));
    case "rasteira":
    case "slide":
    case "kick":
      return firstNonEmpty(pick("Kick", "Wet Kick"), pick("Kick"));
    case "coracao":
    case "coração":
    case "heart":
    case "hug":
      return firstNonEmpty(pick("Hug", "Charged Hug"), pick("Hug"));
    case "maleta":
    case "briefcase":
      return firstNonEmpty(
        pick("MrBeast Case", "Money Case", "MrBeast Case Legendary"),
        pick("MrBeast Case")
      );
    case "tetris":
      // Tetris Tumble é cena, não emote. Emote de bloco = Toss a Block (218)
      return firstNonEmpty(pick("Toss a Block"), pick("Tetris Tumble"), pick("Tetris"));
    case "espatula":
    case "espátula":
    case "spatula":
      return pick("Spatula Slap");
    case "karate":
      return pick("Karate Chop");
    case "cuspe":
    case "spit":
      return firstNonEmpty(pick("Raspberries", "Barf"), pick("Raspberries"));
    case "raio":
    case "lightning":
      return firstNonEmpty(
        pick("Beast Lightning", "Zeus' Lightning"),
        pick("Beast Lightning")
      );
    case "invisivel":
    case "invisível":
    case "invisible":
      return pick("Invisibility");
    case "bola":
    case "ball":
      return pick("Ball");
    case "bola de neve":
    case "boladeneve":
    case "ballsnow":
      return firstNonEmpty(pick("Snowball Throw", "Flying Snowball"), pick("Snowball Throw"));
    case "escudo":
    case "shield":
      return pick("Force Shield");
    case "nenhum":
    case "none":
    case "no emotes":
      // 0 = GetProperties desliga TODOS (1..255)
      return [0];
    default: {
      if (E[name] !== undefined) return [E[name]];
      if (E[name.charAt(0).toUpperCase() + name.slice(1)] !== undefined) {
        return [E[name.charAt(0).toUpperCase() + name.slice(1)]];
      }
      const n = parseInt(name);
      return isNaN(n) ? [] : [n];
    }
  }
}

/**
 * Parseia emotes por round pro campo de exibição na embed (Database.ts lê
 * isso em `phase.RoundEmotes`). Formato: rounds separados por ";" e, dentro
 * de um round, múltiplos emotes separados por "+".
 * Ex: "soco;soco+banana;nenhum" → [["soco"], ["soco","banana"], ["nenhum"]]
 * Rounds vazios (ex: ";;soco") ficam como [] (sem emote específico nesse round).
 */
function parseRoundEmotesInput(input: string | null | undefined): string[][] {
  if (!input) return [];
  return input.split(";").map((group) =>
    group
      .split("+")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parseEmotes(...inputs: (string | null | undefined)[]): number[] {
  const ids: number[] = [];
  for (const input of inputs) {
    if (!input) continue;
    // pode vir "soco,banana" ou só "soco"
    for (const part of input.split(",")) {
      const resolved = resolveEmoteToIds(part.trim());
      for (const id of resolved) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}

/** Todos os IDs positivos de emotes do enum (para montar a blacklist) */
function getAllEmoteIds(): number[] {
  return Object.values(Emotes as unknown as Record<string, number>).filter(
    (v) => typeof v === "number" && v >= 0
  );
}

/**
 * Converte os emotes SELECIONADOS no array DisabledEmotes (blacklist).
 *
 * Regra:
 * - Bloqueia TODOS os emotes INTERATIVOS (soco, banana, tetris, etc.)
 *   que NÃO foram escolhidos no /create.
 * - Emotes "brecks"/normais (Happy, Cry, GG, dança...) continuam liberados.
 * - "nenhum" → bloqueia todos os interativos.
 * - Nada selecionado → [] (tudo liberado).
 */
function getInteractiveEmoteIds(): number[] {
  // Todos os emotes do menu /create + variantes
  const menuNames = emoteChoices.map((c) => c.value).filter((v) => v !== "nenhum");
  const ids = new Set<number>();
  for (const name of menuNames) {
    for (const id of resolveEmoteToIds(name)) {
      if (id > 0) ids.add(id);
    }
  }
  // Extras interativos que às vezes ficam de fora do resolve
  const E = Emotes as unknown as Record<string, number>;
  const extraKeys = [
    "Punch", "Fire Punch", "Kick", "Wet Kick", "Hug", "Charged Hug",
    "Banana", "Golden Banana", "MrBeast Case", "Money Case", "MrBeast Case Legendary",
    "Spatula Slap", "Karate Chop", "Raspberries", "Barf",
    "Beast Lightning", "Zeus' Lightning", "Invisibility", "Ball",
    "Force Shield", "Snowball Throw", "Flying Snowball", "Toss a Block",
    "Ban Hammer", "Nunchucks", "Shocker", "Crane Kick", "Shadow Boxing",
  ];
  for (const k of extraKeys) {
    if (typeof E[k] === "number" && E[k] > 0) ids.add(E[k]);
  }
  return Array.from(ids);
}

function buildDisabledEmotes(
  allowedIds: number[],
  selectedNames: string[]
): number[] {
  const isNone =
    allowedIds.includes(0) ||
    allowedIds.includes(-3) ||
    selectedNames.some((n) =>
      ["nenhum", "none", "no emotes"].includes(n.toLowerCase().trim())
    );

  const interactiveIds = getInteractiveEmoteIds();

  // "nenhum" = bloqueia todos os interativos; brecks liberados
  if (isNone) {
    return interactiveIds;
  }

  // Nada selecionado → não restringe
  if (allowedIds.length === 0 && selectedNames.length === 0) {
    return [];
  }

  const allowed = new Set(allowedIds.filter((id) => id > 0));
  // Bloqueia interativos NÃO escolhidos
  const disabled = interactiveIds.filter((id) => !allowed.has(id));
  console.log(
    `[emotes] allowed=${Array.from(allowed).join(",")} disabled_count=${disabled.length}`
  );
  return disabled;
}

function getEmoteNames(emoteIds: number[]): string {
  return emoteIds
    .map((id) => {
      if (id === -2) return "Soco";
      if (id === -1) return "Special Emotes";
      if (id === -3) return "Nenhum";
      const name = Object.keys(Emotes).find(
        (key) => Emotes[key as keyof typeof Emotes] === id
      );
      return name || `ID:${id}`;
    })
    .join(", ");
}


function isEnvironmentAdmin(interaction: any): boolean {
  return IsDiscordEnvironmentAdmin(interaction.user?.id);
}

function hasPermission(interaction: any): boolean {
  return isEnvironmentAdmin(interaction);
}

async function chargeTournamentCreationCredit(discordId: string, tournamentId: string): Promise<{ ok: boolean; balance?: number; error?: string }> {
  if (IsDiscordEnvironmentAdmin(discordId)) return { ok: true };
  const cost = Math.max(0, parseInt(process.env.TOURNAMENT_CREATION_COST || "1", 10) || 0);
  if (!cost) return { ok: true };
  const base = String(process.env.TOURNAMENT_SITE_URL || "").replace(/\/$/, "");
  const secret = String(process.env.SITE_INTERNAL_SECRET || process.env.ECONOMY_INTERNAL_SECRET || "");
  if (!base || !secret) return { ok: false, error: "Créditos indisponíveis: configure TOURNAMENT_SITE_URL e SITE_INTERNAL_SECRET" };
  try {
    const response = await axios.post(`${base}/api/internal/tournament-credits/charge`, { discordId, amount: cost, eventId: `tournament:create:${discordId}:${tournamentId}` }, { timeout: 10000, headers: { "Content-Type": "application/json", "X-Site-Internal-Secret": secret } });
    const data = response.data || {};
    return { ok: response.status >= 200 && response.status < 300 && data.ok !== false, balance: data.balance, error: data.error };
  } catch (error: any) {
    return { ok: false, error: error?.response?.data?.error || "Não foi possível validar seus créditos" };
  }
}

async function safeReply(interaction: any, options: any) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(options);
    }
    return await interaction.reply(options);
  } catch (e) {
    console.error("[bot] safeReply failed:", e);
  }
}

async function safeDefer(interaction: any, ephemeral = false) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral });
    }
  } catch (e) {
    console.error("[bot] safeDefer failed:", e);
  }
}



const LIST_BOARD_PATH = path.join(process.cwd(), ".listboard.json");

type ListBoard = { channelId: string; messageId: string };

function loadListBoard(): ListBoard | null {
  try {
    if (!fs.existsSync(LIST_BOARD_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(LIST_BOARD_PATH, "utf8"));
    if (raw?.channelId && raw?.messageId) return raw as ListBoard;
  } catch (e) {
    console.error("[listboard] load failed:", e);
  }
  return null;
}

function saveListBoard(board: ListBoard): void {
  try {
    fs.writeFileSync(LIST_BOARD_PATH, JSON.stringify(board, null, 2), "utf8");
  } catch (e) {
    console.error("[listboard] save failed:", e);
  }
}

function statusLabel(tour: any, now = Date.now()): string {
  const start = new Date(tour.StartTime).getTime();
  const signup = tour.SignupStart
    ? new Date(tour.SignupStart).getTime()
    : start - 60 * 60 * 1000;
  const hasWinners = Array.isArray(tour.Winners) && tour.Winners.length > 0;
  if (hasWinners || tour.Status === 3) return "🏁 Finalizado";
  if (tour.Status === 4) return "⛔ Cancelado";
  if (tour.Status === 5 || now >= start) return "▶️ Em andamento";
  if (now >= signup) return "📝 Inscrição aberta";
  return "⏳ Aguardando inscrição";
}

function statusColor(tour: any, now = Date.now()): number {
  const start = new Date(tour.StartTime).getTime();
  const hasWinners = Array.isArray(tour.Winners) && tour.Winners.length > 0;
  if (hasWinners || tour.Status === 3) return 0x747f8d;
  if (tour.Status === 4) return 0xed4245;
  if (tour.Status === 5 || now >= start) return 0x57f287;
  return 0x5865f2;
}

async function resetAllTournamentState(actorId: string): Promise<{ tournaments: number; matches: number; users: number; spectators: number }> {
  const startedAt = new Date().toISOString();
  console.warn(`[AUDIT] reset tours requested by=${actorId} at=${startedAt}`);

  const tournamentResult = await Tournament.deleteMany({});
  const matchResult = await Match.deleteMany({});
  const spectatorResult = await SpectatorSession.deleteMany({});
  const userResult = await BackboneUser.updateMany(
    {},
    { $set: { TournamentsWon: 0 }, $unset: { Tournaments: "" } }
  );

  const result = {
    tournaments: tournamentResult.deletedCount || 0,
    matches: matchResult.deletedCount || 0,
    users: userResult.modifiedCount || 0,
    spectators: spectatorResult.deletedCount || 0,
  };
  console.warn(`[AUDIT] reset tours completed by=${actorId} result=${JSON.stringify(result)}`);
  return result;
}

async function deleteTournamentById(id: string): Promise<{ ok: boolean; matchCount: number }> {
  const res = await Tournament.deleteOne({ TournamentId: id });
  let matchCount = 0;
  try {
    const mres = await Match.deleteMany({ tournamentid: id });
    matchCount = mres.deletedCount || 0;
  } catch (e) {
    console.error("delete matches:", e);
  }
  try {
    await BackboneUser.updateMany(
      { [`Tournaments.${id}`]: { $exists: true } },
      { $unset: { [`Tournaments.${id}`]: "" } }
    );
  } catch (e) {
    console.error("delete user refs:", e);
  }
  return { ok: (res.deletedCount || 0) > 0, matchCount };
}

async function buildListBoardComponents() {
  const tours = await Tournament.find({
    Status: { $ne: 4 },
  })
    .sort({ StartTime: 1, TournamentId: 1 })
    .limit(12)
    .lean();

  const now = Date.now();
  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 📋 Torneios ativos\nAtualizado <t:${Math.floor(now / 1000)}:R> · total **${tours.length}**`
    )
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
  );

  if (!tours.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("_Nenhum torneio no momento._")
    );
    return [container];
  }

  for (const t of tours) {
    const ts = Math.floor(new Date(t.StartTime).getTime() / 1000);
    const st = statusLabel(t, now);
    const line =
      `**${String(t.TournamentName).slice(0, 80)}**\n` +
      `\`${t.TournamentId}\` · ${st}\n` +
      `👥 ${t.CurrentInvites}/${t.MaxInvites} · 🌍 ${String(t.Region).toUpperCase()} · ⏱ <t:${ts}:R>`;

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(line))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`tour_del:${t.TournamentId}`)
            .setLabel("Excluir")
            .setStyle(ButtonStyle.Danger)
            .setEmoji("🗑️")
        )
    );
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
  }

  if (tours[0]) {
    try {
      const hex = String((tours[0] as any).TournamentColor || "#5865f2").replace("#", "");
      const n = parseInt(hex.slice(0, 6), 16);
      if (!isNaN(n)) container.setAccentColor(n);
    } catch {
      /* */
    }
  }

  return [container];
}

async function refreshListBoard(reason = "update"): Promise<void> {
  const board = loadListBoard();
  if (!board) {
    console.log(`[listboard] skip refresh (${reason}): no board saved — use /list once`);
    return;
  }
  try {
    const channel = await Bot.channels.fetch(board.channelId).catch(() => null);
    if (!channel || !("messages" in channel)) {
      console.error("[listboard] channel missing");
      return;
    }
    const components = await buildListBoardComponents();
    const msgRef = await (channel as any).messages.fetch(board.messageId).catch(() => null);
    if (!msgRef) {
      console.error("[listboard] message missing — run /list again");
      return;
    }
    await msgRef.edit({
      components,
      flags: MessageFlags.IsComponentsV2,
    });
    console.log(`[listboard] refreshed (${reason})`);
  } catch (e) {
    console.error("[listboard] refresh failed:", e);
  }
}


const Commands = [
  new SlashCommandBuilder()
    .setName("create")
    .setDescription("Criar um torneio")
    .addStringOption((opt) =>
      opt.setName("nome").setDescription("Nome do torneio").setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("jogadores")
        .setDescription("Quantidade máxima de jogadores")
        .setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("inicio")
        .setDescription("Começa em quantos minutos")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("regiao")
        .setDescription("Região do torneio")
        .setRequired(true)
        .addChoices(...regionChoices)
    )
    .addStringOption((opt) =>
      opt
        .setName("tipo")
        .setDescription("Tipo da fase")
        .setRequired(true)
        .addChoices(
          { name: "Chaveamento (Bracket)", value: "bracket" },
          { name: "Todos contra todos (Round Robin)", value: "roundrobin" },
          { name: "Arena", value: "arena" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("modo")
        .setDescription("Modo da match")
        .setRequired(false)
        .addChoices(
          { name: "Times", value: "teams" },
          { name: "Solo (1v1v1v1)", value: "solo" }
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName("party")
        .setDescription("Tamanho da party (2 = 2v2, 3 = 3v3, etc). Ignorado no modo solo")
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("taxa")
        .setDescription("Taxa de inscrição (entry fee). Padrão: 0")
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("premios")
        .setDescription("Total de gemas do prêmio; dividido automaticamente entre os colocados")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("premiomodo")
        .setDescription("Tipo de premiação")
        .setRequired(false)
        .addChoices({ name: "Gemas", value: "gems" }, { name: "Tag", value: "tag" })
    )
    .addStringOption((opt) =>
      opt.setName("tag").setDescription("Texto da tag do vencedor").setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt.setName("tagduracao").setDescription("Duração da tag; ignorada se permanente").setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("tagunidade")
        .setDescription("Unidade da duração da tag")
        .setRequired(false)
        .addChoices(
          { name: "Horas", value: "hours" },
          { name: "Dias", value: "days" },
          { name: "Meses", value: "months" },
          { name: "Permanente", value: "permanent" }
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName("maxtimes")
        .setDescription("Máximo de times por fase (opcional)")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("mapas")
        .setDescription("Mapa do torneio")
        .setRequired(false)
        .addChoices(...mapChoices)
    )
    .addStringOption((opt) =>
      opt
        .setName("fases")
        .setDescription("Fases extras: tipo,rounds,maxtimes,mapas,emotesporround|tipo,rounds...")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("emotesporround")
        .setDescription("Emotes variando por round (fase única). Ex: soco;soco+banana;nenhum")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("emote")
        .setDescription("Emote liberado 1 (opcional)")
        .setRequired(false)
        .addChoices(...emoteChoices)
    )
    .addStringOption((opt) =>
      opt
        .setName("emote2")
        .setDescription("Emote liberado 2 (opcional)")
        .setRequired(false)
        .addChoices(...emoteChoices)
    )
    .addStringOption((opt) =>
      opt.setName("imagem").setDescription("URL da imagem do torneio").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("cor").setDescription("Cor em hexadecimal (ex: #daef20)").setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("convite")
        .setDescription("Somente por convite?")
        .setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("list")
    .setDescription("Listar torneios")
    .addStringOption((opt) =>
      opt
        .setName("regiao")
        .setDescription("Filtrar por região")
        .setRequired(false)
        .addChoices(...regionChoices)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("status")
        .setDescription("Filtrar por status")
        .setRequired(false)
        .addChoices(
          { name: "não iniciado", value: 0 },
          { name: "aberto", value: 1 },
          { name: "fechado", value: 2 },
          { name: "finalizado", value: 3 },
          { name: "cancelado", value: 4 },
          { name: "em andamento", value: 5 }
        )
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("delete")
    .setDescription("Deletar um torneio")
    .addStringOption((opt) =>
      opt.setName("id").setDescription("ID do torneio").setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("deleteall")
    .setDescription("Deletar TODOS os torneios")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Resetar dados globais de torneios")
    .addSubcommand((sub) =>
      sub
        .setName("tours")
        .setDescription("Limpar torneios, partidas e inscrições de todos")
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("edit")
    .setDescription("Editar um torneio")
    .addStringOption((opt) =>
      opt.setName("id").setDescription("ID do torneio").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("nome").setDescription("Novo nome").setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt.setName("jogadores").setDescription("Novo máximo de jogadores").setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt.setName("taxa").setDescription("Nova taxa de inscrição").setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("emote")
        .setDescription("Emote liberado 1 (opcional)")
        .setRequired(false)
        .addChoices(...emoteChoices)
    )
    .addStringOption((opt) =>
      opt
        .setName("emote2")
        .setDescription("Emote liberado 2 (opcional)")
        .setRequired(false)
        .addChoices(...emoteChoices)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("wo")
    .setDescription("Dar WO (walkover / vitória automática) para um jogador")
    .addStringOption((opt) =>
      opt.setName("torneio").setDescription("ID do torneio").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("jogador")
        .setDescription("ID do jogador que recebe o WO (vitória)")
        .setRequired(true)
    )
    .toJSON(),
];

async function setup() {
  try {
    // CLIENT_ID pode faltar no env — o ID do bot logado serve
    const clientId =
      process.env.CLIENT_ID ||
      process.env.DISCORD_CLIENT_ID ||
      process.env.APPLICATION_ID ||
      Bot.user?.id;

    const guildId =
      process.env.GUILD_ID ||
      process.env.DISCORD_GUILD_ID ||
      process.env.SERVER_ID;

    if (!clientId) {
      console.error(
        "setup failed: CLIENT_ID ausente e bot ainda sem user.id"
      );
      return;
    }
    if (!guildId) {
      console.error(
        "setup failed: GUILD_ID ausente. Defina GUILD_ID (ID do servidor Discord) nas Environment Variables do Render."
      );
      return;
    }

    console.log(`[bot] registrando comandos — clientId=${clientId} guildId=${guildId}`);
    await Rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: Commands,
    });
    msg("commands ready");
  } catch (e) {
    console.error("setup failed:", e);
  }
}

Bot.once("clientReady", async () => {
  msg(`logged in as ${Bot.user?.tag}`);
  await setup();
});

// fallback se a lib usar o evento antigo
Bot.once("ready", async () => {
  if (!Bot.user) return;
  // clientReady já cuida; só roda setup se commands ainda não foram
});

Bot.on("interactionCreate", async (interaction) => {
  try {
  if (interaction.isChatInputCommand()) {
    const cmd = interaction.commandName;

    if (cmd === "create") {
      if (!interaction.guild) {
        await interaction.reply({ content: "❌ Crie torneios dentro do servidor Discord.", ephemeral: true });
        return;
      }

      try {
        await interaction.deferReply();

        const name = interaction.options.getString("nome", true);
        const max = interaction.options.getInteger("jogadores", true);
        const start = interaction.options.getInteger("inicio", true);
        const region = interaction.options.getString("regiao", true);
        const typeStr = interaction.options.getString("tipo", true);
        const mode = interaction.options.getString("modo") === "solo" ? "solo" : "teams";
        const isSolo = mode === "solo";
        const party = isSolo ? 1 : Math.max(1, interaction.options.getInteger("party") || 1);
        const matchCapacity = isSolo ? 4 : 2;
        const formatInput = { Properties: { Mode: mode }, PartySize: party, MaxTeamsPerMatch: matchCapacity };
        const formatFields = BuildFormatFields(formatInput);
        const fee = Math.max(0, interaction.options.getInteger("taxa") || 0);
        const prizeMode = interaction.options.getString("premiomodo") === "tag" ? "tag" : "gems";
        const prizePoolGems = prizeMode === "gems" ? Math.max(0, interaction.options.getInteger("premios") || 0) : 0;
        const prizeTag = prizeMode === "tag" ? String(interaction.options.getString("tag") || "").trim().slice(0, 32) : "";
        const prizeTagDurationUnit: "hours" | "days" | "months" | "permanent" = (["hours", "days", "months", "permanent"].includes(interaction.options.getString("tagunidade") || "") ? interaction.options.getString("tagunidade") : "permanent") as "hours" | "days" | "months" | "permanent";
        const prizeTagDurationValue = prizeTagDurationUnit === "permanent" ? undefined : Math.max(1, interaction.options.getInteger("tagduracao") || 1);
        if (prizeMode === "tag" && !prizeTag) {
          await safeReply(interaction, { content: "❌ Informe o texto da tag.", ephemeral: true });
          return;
        }
        const maxTeams = interaction.options.getInteger("maxtimes") || 200;
        const mapsInput = interaction.options.getString("mapas") || "Block Dash";
        const phasesInput = interaction.options.getString("fases");
        const roundEmotesInput = interaction.options.getString("emotesporround");
        const emote1 = interaction.options.getString("emote");
        const emote2 = interaction.options.getString("emote2");
        const img =
          interaction.options.getString("imagem") ||
          "https://i.imgur.com/0ZQZ0ZQ.png";
        const color = interaction.options.getString("cor") || "#daef20";
        const inviteOnly = interaction.options.getBoolean("convite") || false;

        // Rounds automáticos conforme players + party + tipo
        const rounds = CalculateRoundCount(max, formatInput, typeStr);

        const phaseType =
          typeStr === "arena" ? 1 : typeStr === "bracket" ? 2 : 3;

        const maps = mapsInput
          .split(",")
          .map((m) => {
            const trimmed = m.trim();
            return Scenes[trimmed as keyof typeof Scenes] || trimmed;
          })
          .filter(Boolean);

        // Emotes selecionados (nomes pra embed + IDs permitidos)
        const selectedEmoteNames = [emote1, emote2].filter(Boolean) as string[];
        const allowedEmoteIds = parseEmotes(emote1, emote2);

        // Blacklist = todos os emotes MENOS os que o usuário escolheu
        const disabledEmotes = buildDisabledEmotes(
          allowedEmoteIds,
          selectedEmoteNames
        );

        // MaxTeams sempre = players / partySize (ex: 4 vagas 2v2 → 2 teams)
        const correctMaxTeams = party >= 2 ? Math.floor(max / party) : max;
        const finalMaxTeams =
          maxTeams !== 200
            ? Math.min(maxTeams, correctMaxTeams)
            : correctMaxTeams;

        const baseRoundEmotes = parseRoundEmotesInput(roundEmotesInput);

        let phases: any[] = [
          {
            PhaseType: phaseType,
            IsPhase: phaseType === 3,
            RoundCount: rounds,
            MaxTeams: finalMaxTeams,
            GroupCount: 1,
            Maps: maps,
            ...(baseRoundEmotes.length ? { RoundEmotes: baseRoundEmotes } : {}),
          },
        ];

        if (phasesInput) {
          const phasesList = phasesInput.split("|").slice(0, 3);
          phases = [];
          for (const phaseStr of phasesList) {
            const [type, rds, mt, mps, ems] = phaseStr.split(",");
            if (!type || !rds) continue;

            const pType =
              type.trim() === "arena"
                ? 1
                : type.trim() === "bracket"
                  ? 2
                  : 3;
            const pRounds = parseInt(rds.trim());
            const pMaxTeams = mt ? parseInt(mt.trim()) : 200;
            const pMaps = mps
              ? mps
                  .split(";")
                  .map((m) => {
                    const t = m.trim();
                    return Scenes[t as keyof typeof Scenes] || t;
                  })
                  .filter(Boolean)
              : maps;
            const pRoundEmotes = parseRoundEmotesInput(ems);

            phases.push({
              PhaseType: pType,
              IsPhase: pType === 3,
              RoundCount: pRounds,
              MaxTeams: pMaxTeams,
              GroupCount: 1,
              Maps: pMaps,
              ...(pRoundEmotes.length ? { RoundEmotes: pRoundEmotes } : {}),
            });
          }
        }

        if (phases.length === 0) {
          phases = [{ PhaseType: 2, IsPhase: false, RoundCount: CalculateRoundCount(max, formatInput, "bracket"), MaxTeams: finalMaxTeams, GroupCount: 1, Maps: maps }];
        }
        // A última fase é sempre a final de bracket; WO automático só é permitido nela.
        if (phases.length > 1) {
          phases[phases.length - 1].PhaseType = 2;
          phases[phases.length - 1].IsPhase = false;
        }

        // ID cabe em int32 (client Unity estoura com Date.now() ~1.7e12)
        // range seguro: 100000 .. 2000000000
        const id = await GetSmallestAvailableTournamentId();
        const startTime = new Date(Date.now() + start * 60000);
        const creditCharge = await chargeTournamentCreationCredit(String(interaction.user.id), String(id));
        if (!creditCharge.ok) {
          await safeReply(interaction, { content: `❌ ${creditCharge.error || "Créditos insuficientes para criar torneio"}${creditCharge.balance != null ? ` (saldo: ${creditCharge.balance})` : ""}`, ephemeral: true });
          return;
        }

        // type 0..4: 1 card por type no client. Conta só ATIVOS (não finished)
        // pra não “gastar” slot com torneio morto e limitar ativos a 3.
        const activeCount = await Tournament.countDocuments({
          Status: { $nin: [3, 4] }, // 3=Finished, 4=Canceled
          $or: [
            { Winners: { $exists: false } },
            { Winners: { $size: 0 } },
            { Winners: null },
          ],
        });
        const tournamentType = (activeCount % 10) + 1; // tipos 1..10, sem colisão no limite ampliado

        await CreateTournament({
          CurrentInvites: 0,
          MaxInvites: max,
          TournamentId: id,
          TournamentName: name,
          CreatedByDiscordId: String(interaction.user.id),
          CreatedByDiscordTag: interaction.user.tag || interaction.user.username,
          TournamentImage: img,
          TournamentColor: color,
          StartTime: startTime,
          SignupStart: new Date(),
          EntryFee: fee,
          PrizePoolGems: prizePoolGems,
          PrizeMode: prizeMode,
          PrizeTag: prizeTag || undefined,
          PrizeTagDurationUnit: prizeMode === "tag" ? prizeTagDurationUnit : undefined,
          PrizeTagDurationValue: prizeMode === "tag" ? prizeTagDurationValue : undefined,
          Prizes: prizeMode === "gems" ? BuildPrizeDistribution(prizePoolGems, max, formatInput) : [],
          PrizepoolId: GeneratePrizepoolId().toString(),
          PartySize: party,
          Status: 1,
          TournamentType: tournamentType,
          Phases: phases,
          Region: region,
          RoundCount: phases.reduce((total, phase) => total + Math.max(1, Number(phase.RoundCount) || 1), 0),
          CurrentPhaseId: 0,
          MinPlayersPerMatch: 2,
          MaxPlayersPerMatch: matchCapacity,
          ...formatFields,
          Properties: {
            Mode: mode,
            IsInvitationOnly: inviteOnly,
            InvitedIds: [],
            DisabledEmotes: disabledEmotes,
            SelectedEmotes:
              selectedEmoteNames.length > 0 ? selectedEmoteNames : [],
            AdminIds: [],
            StreamURL: "",
            PrizeMode: prizeMode,
            PrizeTag: prizeTag || "",
            PrizeTagDurationUnit: prizeMode === "tag" ? prizeTagDurationUnit : "",
            PrizeTagDurationValue: prizeMode === "tag" ? prizeTagDurationValue : 0,
          } as any,
        });

        const e = new EmbedBuilder()
          .setTitle("✅ Torneio criado")
          .setColor(color as any)
          .setDescription(`**${name}**`)
          .addFields(
            { name: "ID", value: `\`${id}\``, inline: false },
            { name: "Jogadores", value: max.toString(), inline: true },
            { name: "Party", value: isSolo ? "Solo (1v1v1v1)" : party.toString(), inline: true },
            { name: "Região", value: region.toUpperCase(), inline: true },
            { name: "Tipo", value: typeStr, inline: true },
            { name: "Rounds", value: rounds.toString(), inline: true },
            { name: "Taxa", value: fee.toString(), inline: true },
            { name: "Prêmio", value: prizeMode === "tag" ? `Tag: ${prizeTag} (${prizeTagDurationUnit})` : prizePoolGems.toString(), inline: true },
            { name: "Fases", value: phases.length.toString(), inline: true },
            {
              name: "Começa",
              value: `<t:${Math.floor(startTime.getTime() / 1000)}:R>`,
              inline: false,
            }
          )
          .setTimestamp();

        if (selectedEmoteNames.length > 0) {
          e.addFields({
            name: "emotes liberados",
            value: selectedEmoteNames.join(", "),
            inline: false,
          });
        } else if (disabledEmotes.length === 0) {
          e.addFields({
            name: "emotes",
            value: "Todos liberados",
            inline: false,
          });
        }

        if (img) e.setThumbnail(img);

        await interaction.editReply({ embeds: [e] });
        setImmediate(() => {
          refreshListBoard("create").catch(() => {});
        });
      } catch (err) {
        console.error("create error:", err);
        await interaction.editReply({ content: `failed: ${err}` });
      }
    }

    if (cmd === "list") {
      if (!hasPermission(interaction)) {
        await interaction.reply({
          content: "❌ Você não tem permissão para usar este comando",
          ephemeral: true,
        });
        return;
      }

      try {
        await interaction.deferReply();
        const components = await buildListBoardComponents();
        const sent = await interaction.editReply({
          components,
          flags: MessageFlags.IsComponentsV2,
        });
        // Painel público: salva canal+msg para atualizar em create/delete
        try {
          const messageId = (sent as any)?.id || interaction.channelId;
          // editReply returns Message in most cases
          const msgId = String((sent as any)?.id || "");
          const chId = String(interaction.channelId || "");
          if (msgId && chId) {
            saveListBoard({ channelId: chId, messageId: msgId });
            console.log(`[listboard] saved channel=${chId} message=${msgId}`);
          }
        } catch (e) {
          console.error("[listboard] save after /list failed:", e);
        }
      } catch (err) {
        console.error("list error:", err);
        try {
          await safeReply(interaction, {
            content: `❌ Falha ao listar (Components V2): ${err}`,
          });
        } catch {
          // ignore
        }
      }
    }

    if (cmd === "delete") {
      if (!hasPermission(interaction)) {
        await safeReply(interaction, {
          content: "❌ Você não tem permissão para usar este comando",
          ephemeral: true,
        });
        return;
      }

      try {
        const id = interaction.options.getString("id", true);
        const res = await Tournament.deleteOne({ TournamentId: id });
        // limpa matches do torneio também
        try {
          await Match.deleteMany({ tournamentid: id });
        } catch (e) {
          console.error("delete matches:", e);
        }

        if (res.deletedCount === 0) {
          await safeReply(interaction, {
            content: "❌ Torneio não encontrado",
            ephemeral: true,
          });
          return;
        }

        const e = new EmbedBuilder()
          .setTitle("🗑️ Torneio deletado")
          .setDescription(`Deletado: \`${id}\``)
          .setColor("#ff4444")
          .setTimestamp();

        await safeReply(interaction, { embeds: [e] });
        setImmediate(() => {
          refreshListBoard("delete").catch(() => {});
        });
      } catch (err) {
        console.error("delete error:", err);
        await safeReply(interaction, {
          content: "❌ Falha ao deletar",
          ephemeral: true,
        });
      }
    }

    if (cmd === "deleteall") {
      if (!hasPermission(interaction)) {
        await safeReply(interaction, {
          content: "❌ Você não tem permissão para usar este comando",
          ephemeral: true,
        });
        return;
      }

      try {
        await safeDefer(interaction, true);

        const res = await Tournament.deleteMany({});
        const count = res.deletedCount || 0;
        let matchCount = 0;
        try {
          const mres = await Match.deleteMany({});
          matchCount = mres.deletedCount || 0;
        } catch (e) {
          console.error("deleteall matches:", e);
        }

        const e = new EmbedBuilder()
          .setTitle("🗑️ Todos os torneios deletados")
          .setDescription(
            `Foram removidos **${count}** torneio(s) e **${matchCount}** partida(s).`
          )
          .setColor("#ff4444")
          .setTimestamp();

        await safeReply(interaction, { embeds: [e] });
        setImmediate(() => {
          refreshListBoard("deleteall").catch(() => {});
        });
      } catch (err) {
        console.error("deleteall error:", err);
        await safeReply(interaction, {
          content: `❌ Falha ao deletar todos: ${err}`,
          ephemeral: true,
        });
      }
    }

    if (cmd === "reset") {
      const subcommand = interaction.options.getSubcommand(false);
      if (subcommand !== "tours") return;
      if (!hasPermission(interaction)) {
        await safeReply(interaction, {
          content: "❌ Você não tem permissão para usar este comando",
          ephemeral: true,
        });
        return;
      }

      try {
        await safeDefer(interaction, true);
        const result = await resetAllTournamentState(interaction.user?.id || "unknown");
        await safeReply(interaction, {
          content: `✅ Reset global concluído. Torneios: **${result.tournaments}** · partidas: **${result.matches}** · usuários limpos: **${result.users}** · sessões de espectador: **${result.spectators}**.`,
          ephemeral: true,
        });
        setImmediate(() => {
          refreshListBoard("reset tours").catch(() => {});
        });
      } catch (err) {
        console.error("reset tours error:", err);
        await safeReply(interaction, {
          content: "❌ Falha no reset global; nenhuma nova operação será iniciada automaticamente.",
          ephemeral: true,
        });
      }
    }

    if (cmd === "edit") {
      if (!hasPermission(interaction)) {
        await interaction.reply({
          content: "❌ Você não tem permissão para usar este comando",
          ephemeral: true,
        });
        return;
      }

      try {
        const id = interaction.options.getString("id", true);
        const u: any = {};

        const name = interaction.options.getString("nome");
        const max = interaction.options.getInteger("jogadores");
        const fee = interaction.options.getInteger("taxa");
        const emote1 = interaction.options.getString("emote");
        const emote2 = interaction.options.getString("emote2");

        if (name) u.TournamentName = name;
        if (max) u.MaxInvites = max;
        if (fee !== null) u.EntryFee = fee;

        if (emote1 || emote2) {
          const selected = [emote1, emote2].filter(Boolean) as string[];
          const allowedIds = parseEmotes(emote1, emote2);
          const disabled = buildDisabledEmotes(allowedIds, selected);

          u["Properties.DisabledEmotes"] = disabled;
          u["Properties.SelectedEmotes"] = selected; // SelectedEmotes
        }

        if (!Object.keys(u).length) {
          await interaction.reply({ content: "no changes", ephemeral: true });
          return;
        }

        const res = await Tournament.updateOne({ TournamentId: id }, { $set: u });

        if (res.matchedCount === 0) {
          await interaction.reply({ content: "not found", ephemeral: true });
          return;
        }

        const e = new EmbedBuilder()
          .setTitle("updated")
          .setDescription(`updated \`${id}\``)
          .setColor("#43b581")
          .setTimestamp();

        for (const [k, v] of Object.entries(u)) {
          if (k === "Properties.DisabledEmotes") {
            // mostra os liberados (SelectedEmotes) em vez da blacklist gigante
            const selected = (u["Properties.SelectedEmotes"] as string[] | undefined) || [];
            e.addFields({
              name: "emotes liberados",
              value:
                selected.length > 0
                  ? selected.join(", ")
                  : "Todos liberados",
              inline: true,
            });
          } else if (k === "Properties.SelectedEmotes") {
            // já mostrado acima
          } else {
            e.addFields({ name: k, value: String(v), inline: true });
          }
        }

        await interaction.reply({ embeds: [e] });
      } catch (err) {
        console.error("edit error:", err);
        await interaction.reply({ content: "failed", ephemeral: true });
      }
    }

    if (cmd === "wo") {
      if (!hasPermission(interaction)) {
        await interaction.reply({
          content: "❌ Você não tem permissão para usar este comando",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();

      try {
        const tournamentId = interaction.options.getString("torneio", true).trim();
        const playerId = interaction.options.getString("jogador", true).trim();

        const tour = await Tournament.findOne({ TournamentId: tournamentId });
        if (!tour) {
          await interaction.editReply({ content: "❌ Torneio não encontrado." });
          return;
        }

        let playerUser = await BackboneUser.findOne({ UserId: playerId });
        if (!playerUser) {
          await interaction.editReply({ content: "❌ Jogador não encontrado." });
          return;
        }

        // 1) Tenta pelo UserMatch do jogador
        // 2) Se não tiver, busca qualquer partida ativa do torneio onde o user está
        let match: any = null;
        const info = playerUser.Tournaments?.get?.(tournamentId)
          ?? (playerUser.Tournaments as any)?.[tournamentId];

        if (info?.UserMatch?.id) {
          match = await Match.findOne({ id: info.UserMatch.id });
        }

        if (
          !match ||
          match.status === TournamentMatchStatus.Closed ||
          match.status === TournamentMatchStatus.GameFinished
        ) {
          match = await Match.findOne({
            tournamentid: tournamentId,
            "users.@user-id": playerId,
            status: {
              $nin: [
                TournamentMatchStatus.Closed,
                TournamentMatchStatus.GameFinished,
              ],
            },
          }).sort({ roundid: -1, matchid: -1 });
        }

        if (!match) {
          await interaction.editReply({
            content:
              "❌ Jogador não tem partida ativa neste torneio. Confira se o torneio está rodando e o ID do jogador está certo.",
          });
          return;
        }

        if (
          match.status === TournamentMatchStatus.Closed ||
          match.status === TournamentMatchStatus.GameFinished
        ) {
          await interaction.editReply({
            content: "❌ Partida já está encerrada.",
          });
          return;
        }

        const userInMatch = match.users.find(
          (u: any) => u["@user-id"] === playerId
        );
        if (!userInMatch) {
          await interaction.editReply({
            content: "❌ Jogador não encontrado dentro da partida.",
          });
          return;
        }

        const userTeamId = userInMatch["@team-id"];
        const winners: string[] = [];
        const losers: string[] = [];

        for (const u of match.users) {
          if (u["@team-id"] === userTeamId) {
            u["@match-winner"] = "1";
            u["@match-points"] = "1";
            u["@team-score"] = "1";
            u["@user-score"] = "1";
            u["@checked-in"] = "1";
            winners.push(u["@user-id"]);
          } else {
            u["@match-winner"] = "0";
            u["@match-points"] = "0";
            u["@team-score"] = "0";
            u["@user-score"] = "0";
            losers.push(u["@user-id"]);
          }
        }

        const ClosedMatch = await TransitionMatch(
          String(match.id),
          [match.status],
          TournamentMatchStatus.Closed,
          {
            users: match.users,
            playedgamecount: Math.max(1, Number(match.playedgamecount) || 0),
          }
        );
        if (!ClosedMatch) {
          await interaction.editReply({ content: "❌ A partida já foi encerrada por outro processo." });
          return;
        }

        // Sincroniza UserMatch de todos os usuários da partida com o resultado
        const matchPayload = {
          id: ClosedMatch.id,
          secret: ClosedMatch.secret,
          deadline: ClosedMatch.deadline,
          matchid: ClosedMatch.matchid,
          phaseid: ClosedMatch.phaseid,
          groupid: ClosedMatch.groupid,
          roundid: ClosedMatch.roundid,
          playedgamecount: ClosedMatch.playedgamecount,
          status: ClosedMatch.status,
          tournamentid: ClosedMatch.tournamentid,
          users: ClosedMatch.users,
        };

        const allIds = [...winners, ...losers];
        if (allIds.length > 0) {
          await BackboneUser.updateMany(
            {
              UserId: { $in: allIds },
              [`Tournaments.${tournamentId}`]: { $exists: true },
            },
            {
              $set: {
                [`Tournaments.${tournamentId}.UserMatch`]: matchPayload,
              },
            }
          );
        }

        // Recarrega o jogador e aplica Qualify (avança no bracket / marca eliminação)
        playerUser = (await BackboneUser.findOne({ UserId: playerId }))!;
        if (playerUser) {
          await Qualify(playerUser as any, tour as any);
        }

        const e = new EmbedBuilder()
          .setTitle("✅ WO aplicado com sucesso")
          .setColor("#43b581")
          .addFields(
            { name: "Torneio", value: `\`${tournamentId}\``, inline: true },
            {
              name: "Jogador",
              value: `\`${playerId}\` — **${playerUser?.Username || "?"}**`,
              inline: true,
            },
            { name: "Partida", value: `\`${match.id}\``, inline: false },
            { name: "Round", value: `${match.roundid}`, inline: true },
            { name: "Phase", value: `${match.phaseid}`, inline: true },
            {
              name: "Time vencedor",
              value: winners.map((id) => `\`${id}\``).join(", ") || "—",
              inline: false,
            }
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [e] });
      } catch (err) {
        console.error("wo error:", err);
        await interaction.editReply({
          content: `❌ Erro ao aplicar WO: ${err}`,
        });
      }
    }
  }

  if (interaction.isButton()) {
    const id = interaction.customId || "";
    if (id.startsWith("tour_del:")) {
      if (!hasPermission(interaction)) {
        await interaction.reply({
          content: "❌ Sem permissão para excluir torneios",
          ephemeral: true,
        });
        return;
      }
      const tourId = id.slice("tour_del:".length).trim();
      await interaction.deferReply({ ephemeral: true });
      try {
        const result = await deleteTournamentById(tourId);
        if (!result.ok) {
          await interaction.editReply({ content: `❌ Torneio \`${tourId}\` não encontrado.` });
          return;
        }
        await interaction.editReply({
          content: `🗑️ Torneio \`${tourId}\` excluído do jogo (${result.matchCount} partida(s) removidas).`,
        });
        await refreshListBoard("button-delete");
      } catch (err) {
        console.error("button delete error:", err);
        await interaction.editReply({ content: `❌ Falha ao excluir: ${err}` });
      }
      return;
    }
  }

  } catch (err) {
    console.error("[bot] interactionCreate error:", err);
    try {
      const anyI = interaction as any;
      if (anyI?.isRepliable?.()) {
        if (anyI.deferred || anyI.replied) {
          await anyI.editReply({ content: "❌ Erro interno no bot." }).catch(() => {});
        } else {
          await anyI.reply({ content: "❌ Erro interno no bot.", ephemeral: true }).catch(() => {});
        }
      }
    } catch { /* */ }
  }
});


process.on("unhandledRejection", (err) => {
  console.error("[bot] unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[bot] uncaughtException:", err);
});
