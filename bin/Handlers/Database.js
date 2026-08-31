"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateTournamentWebhook = UpdateTournamentWebhook;
exports.CreateTournament = CreateTournament;
exports.CreateSignedUpUser = CreateSignedUpUser;
exports.OnPlayerSignedUp = OnPlayerSignedUp;
exports.GetSmallestAvailableTournamentId = GetSmallestAvailableTournamentId;
const BackboneUser_1 = require("../Models/BackboneUser");
const Tournament_1 = require("../Models/Tournament");
const uuid_1 = require("uuid");
const Logger_1 = require("../Modules/Logger");
const Extensions_1 = require("../Modules/Extensions");
const TournamentRules_1 = require("../Backbone/Logic/TournamentRules");
const Config_1 = require("../Backbone/Config");
const WEBHOOK_URI = process.env.WEBHOOK_URI ||
    "https://discord.com/api/webhooks/1532549805526749344/v9RKDZE9bpaT_Np-sX-MOU821luyAb1-Y_8MpJJWdW98Kel39Ze0WxmqcAp3sSV2s9mr";
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
const PING_ROLE_ID = "1532483676653355183";
// Fire primeiro, depois punch
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
    const mapName = Object.keys(Config_1.Scenes).find((key) => Config_1.Scenes[key] === sceneId);
    if (!mapName)
        return sceneId;
    return mapName.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
}
function getEmoteFriendlyName(emoteId) {
    const emoteName = Object.keys(Config_1.Emotes).find((key) => Config_1.Emotes[key] === emoteId);
    return emoteName || `${emoteId}`;
}
function emoteIdsToDisplay(ids) {
    const parts = ids
        .map((id) => {
        if (id === -2)
            return `${EMOJI.punch_fire} ${EMOJI.punch}`;
        if (id === -3)
            return EMOJI.emotes_none;
        const name = getEmoteFriendlyName(id).toLowerCase();
        for (const [key, emoji] of Object.entries(EMOTE_DISPLAY)) {
            if (name.includes(key) || key.includes(name))
                return emoji;
        }
        if (name.includes("punch"))
            return `${EMOJI.punch_fire} ${EMOJI.punch}`;
        if (name.includes("banana"))
            return `${EMOJI.banana} ${EMOJI.banana_gold}`;
        if (name.includes("slide") || name.includes("kick"))
            return `${EMOJI.slide} ${EMOJI.slide_water}`;
        return null;
    })
        .filter(Boolean);
    // remove duplicados mantendo ordem
    return [...new Set(parts)].join(" ");
}
function buildEmotesText(tournament) {
    // 1) nomes salvos do /create (SelectedEmotes) — prioridade
    let selected = [];
    const raw = tournament.SelectedEmotes ||
        tournament.Properties?.SelectedEmotes ||
        tournament.Properties?.selectedEmotes;
    if (Array.isArray(raw)) {
        selected = raw.map((s) => String(s)).filter(Boolean);
    }
    else if (typeof raw === "string" && raw.length) {
        selected = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }
    if (selected.length > 0) {
        const parts = selected
            .map((name) => {
            const key = name.toLowerCase().trim();
            return EMOTE_DISPLAY[key] || null;
        })
            .filter(Boolean);
        if (parts.length > 0)
            return parts.join(" ");
    }
    const disabledEmotes = tournament.Properties?.DisabledEmotes || [];
    if (!disabledEmotes.length) {
        return "All Emotes";
    }
    // presets negativos
    if (disabledEmotes.length === 1 && disabledEmotes[0] < 0) {
        if (disabledEmotes[0] === -2)
            return `${EMOJI.punch_fire} ${EMOJI.punch}`;
        if (disabledEmotes[0] === -1)
            return "Special Emotes Disabled";
        if (disabledEmotes[0] === -3)
            return EMOJI.emotes_none;
        return `Preset ${disabledEmotes[0]}`;
    }
    // 2) Se a blacklist é GRANDE, estamos no modo whitelist invertido:
    //    os emotes LIBERADOS = todos - disabled
    const allIds = Object.values(Config_1.Emotes).filter((v) => typeof v === "number" && v >= 0);
    if (disabledEmotes.length >= 3 && allIds.length > 0) {
        const allowed = allIds.filter((id) => !disabledEmotes.includes(id));
        if (allowed.length > 0 && allowed.length <= 8) {
            const text = emoteIdsToDisplay(allowed);
            if (text)
                return text;
        }
        // se sobrou 0 allowed → nenhum
        if (allowed.length === 0)
            return EMOJI.emotes_none;
    }
    // 3) blacklist pequena (poucos emotes desabilitados) — mostra os desabilitados
    //    (comportamento antigo; raramente usado agora)
    const fromIds = emoteIdsToDisplay(disabledEmotes);
    return fromIds || "All Emotes";
}
function getPhaseTypeName(phaseType) {
    switch (phaseType) {
        case Config_1.TournamentPhaseType.RoundRobin:
            return "Round Robin";
        case Config_1.TournamentPhaseType.Arena:
            return "Arena";
        case Config_1.TournamentPhaseType.SingleEliminationBracket:
            return "Bracket (Single Elimination)";
        default:
            return "Phase";
    }
}
function getRoundEmoteNames(tournament, phaseIndex, roundIndex) {
    const roundEmotes = tournament.Properties?.RoundEmotes || tournament.RoundEmotes || [];
    const phase = tournament.Phases?.[phaseIndex];
    const phaseEmotes = phase?.RoundEmotes || phase?.EmotesByRound || [];
    const raw = Array.isArray(phaseEmotes) && phaseEmotes.length
        ? phaseEmotes[roundIndex]
        : (phaseIndex === 0 ? roundEmotes[roundIndex] : undefined);
    if (Array.isArray(raw))
        return raw.map((item) => String(item)).filter(Boolean);
    return raw ? String(raw).split(",").map((item) => item.trim()).filter(Boolean) : [];
}
function getPhaseRoundMaps(tournament, phase, phaseIndex) {
    const phaseMaps = phase?.RoundMaps || phase?.MapsByRound;
    if (Array.isArray(phaseMaps) && phaseMaps.length)
        return phaseMaps.map(String);
    const allMaps = tournament.Properties?.RoundMaps || tournament.RoundMaps || [];
    if (phaseIndex === 0 && Array.isArray(allMaps) && allMaps.length)
        return allMaps.map(String);
    const maps = Array.isArray(phase?.Maps) ? phase.Maps.map(String) : [];
    return maps.length ? maps : ["Block Dash"];
}
function emoteNamesToDisplay(names) {
    const parts = names
        .map((name) => EMOTE_DISPLAY[String(name).toLowerCase().trim()] || null)
        .filter(Boolean);
    return parts.join(" ");
}
function buildPhaseRoundLines(tournament, phase, phaseIndex, isLastPhase = false) {
    const count = Math.max(1, Number(phase?.RoundCount) || getPhaseRoundMaps(tournament, phase, phaseIndex).length || 1);
    const maps = getPhaseRoundMaps(tournament, phase, phaseIndex);
    const rounds = Array.from({ length: count }, (_, index) => ({
        map: maps[index] || maps[index % maps.length] || "Block Dash",
        emotes: getRoundEmoteNames(tournament, phaseIndex, index),
    }));
    const distinctEmotes = new Set(rounds.map((round) => JSON.stringify(round.emotes)));
    // Custom é uma regra exclusiva da última fase e só existe quando o emote
    // muda entre rounds. Se mapa e emote são iguais, a linha é agrupada e o
    // emote permanece somente no topo da embed.
    const customEmotes = isLastPhase && rounds.length > 1 && distinctEmotes.size > 1;
    const lines = [];
    let start = 0;
    const keyOf = (round) => customEmotes
        ? `${round.map}\u0000${JSON.stringify(round.emotes)}`
        : round.map;
    for (let index = 1; index <= rounds.length; index++) {
        if (index < rounds.length && keyOf(rounds[index]) === keyOf(rounds[start]))
            continue;
        const first = rounds[start];
        const label = start === index - 1 ? `Round ${start + 1}` : `Round ${start + 1}-${index}`;
        const emoteDisplay = customEmotes ? emoteNamesToDisplay(first.emotes) : "";
        const mapText = getMapFriendlyName(first.map);
        // No modo Custom o emote fica na frente do mapa, como pedido.
        lines.push(`${label}: ${emoteDisplay ? `${emoteDisplay} ` : ""}${mapText}`);
        start = index;
    }
    return { lines, customEmotes };
}
function buildPayload(tournament) {
    const decimalColor = 0xff4444;
    const format = (0, TournamentRules_1.GetTournamentFormat)(tournament);
    const modeText = format.mode === "solo"
        ? Array(format.maxTeamsPerMatch).fill("1").join("v")
        : `${format.playersPerTeam}v${format.playersPerTeam}`;
    const emotesText = buildEmotesText(tournament);
    const lastPhaseIndex = Array.isArray(tournament.Phases) && tournament.Phases.length > 0 ? tournament.Phases.length - 1 : -1;
    const lastPhaseFirstEmotes = lastPhaseIndex >= 0 ? getRoundEmoteNames(tournament, lastPhaseIndex, 0) : [];
    const stableLastPhaseEmotes = emoteNamesToDisplay(lastPhaseFirstEmotes);
    const customRoundEmotes = lastPhaseIndex >= 0
        ? buildPhaseRoundLines(tournament, tournament.Phases[lastPhaseIndex], lastPhaseIndex, true).customEmotes
        : false;
    const webhookEmotesText = customRoundEmotes
        ? "Custom"
        : (stableLastPhaseEmotes || emotesText);
    const startTimestamp = Math.floor(new Date(tournament.StartTime).getTime() / 1000);
    const currentSigned = tournament.CurrentInvites || 0;
    const maxPlayers = tournament.MaxInvites || format.matchPlayerCapacity * 100;
    const showTeams = format.mode === "teams";
    const maxTeams = showTeams ? Math.floor(maxPlayers / format.playersPerTeam) : 0;
    const currentTeams = showTeams ? Math.floor(currentSigned / format.playersPerTeam) : 0;
    const countForLeaderboard = tournament.CountForLeaderboard ??
        tournament.Properties?.CountForLeaderboard ??
        false;
    const leaderboardText = countForLeaderboard ? "Yes" : "No";
    const signedUpsValue = showTeams
        ? `**${currentSigned}/${maxPlayers} - (${currentTeams}/${maxTeams} Teams)**`
        : `**${currentSigned}/${maxPlayers}**`;
    const titleLine = `## ${EMOJI.trophy} ${tournament.TournamentName}`;
    const streamUrl = tournament.Properties?.StreamURL || tournament.StreamURL || "";
    const contentComponents = [
        { type: 10, content: titleLine },
        {
            type: 10,
            content: `${EMOJI.region} Region: **${tournament.Region.toUpperCase()}**\n${EMOJI.region} Emotes: **${webhookEmotesText}**`,
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
            content: `${EMOJI.clock} **Start Time**\n${EMOJI.region} **<t:${startTimestamp}:R> (<t:${startTimestamp}:f>)**`,
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
        tournament.Phases.forEach((phase, index) => {
            const phaseLabel = phase.Name || phase.name || `Phase ${index + 1}`;
            phasesContent += `${EMOJI.region} **${phaseLabel}:**\n`;
            const grouped = buildPhaseRoundLines(tournament, phase, index, index === lastPhaseIndex);
            for (const line of grouped.lines)
                phasesContent += `${EMOJI.region} ${line}\n`;
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
                    content: `${titleLine}\n${EMOJI.region} Region: **${tournament.Region.toUpperCase()}**\n${EMOJI.region} Emotes: **${webhookEmotesText}**`,
                },
            ],
            accessory: {
                type: 11,
                media: { url: tournament.TournamentImage },
            },
        });
        containerComponents.push(...contentComponents.slice(2));
    }
    else {
        containerComponents.push(...contentComponents);
    }
    return {
        flags: 32768,
        allowed_mentions: {
            parse: [],
            roles: [PING_ROLE_ID],
        },
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
    if (!WEBHOOK_URI)
        return null;
    return WEBHOOK_URI.replace("https://discord.com/api/webhooks/", "https://discord.com/api/v10/webhooks/");
}
async function SendWebhook(tournament) {
    const base = getWebhookBase();
    if (!base)
        return null;
    try {
        const payload = buildPayload(tournament);
        const webhookUrl = `${base}?wait=true&with_components=true`;
        const response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Webhook failed: ${response.status} - ${errorText}`);
        }
        const data = (await response.json());
        return data.id || null;
    }
    catch (err) {
        throw err;
    }
}
/** Atualiza a mensagem da embed com os números atuais de signed-ups/teams */
async function UpdateTournamentWebhook(tournament) {
    const anyT = tournament;
    const messageId = anyT.WebhookMessageId || anyT.Properties?.WebhookMessageId;
    const base = getWebhookBase();
    if (!base) {
        console.error("[webhook] WEBHOOK_URI ausente");
        return;
    }
    if (!messageId) {
        console.error(`[webhook] Torneio ${anyT.TournamentId} sem WebhookMessageId — embed não pode ser atualizada`);
        return;
    }
    try {
        const payload = buildPayload(tournament);
        const url = `${base}/messages/${messageId}?with_components=true`;
        const response = await fetch(url, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[webhook] update failed: ${response.status} - ${errorText}`);
        }
        else {
            console.log(`[webhook] ✅ updated ${anyT.TournamentId} → ${anyT.CurrentInvites}/${anyT.MaxInvites} (msg ${messageId})`);
        }
    }
    catch (err) {
        console.error("[webhook] update error:", err);
    }
}
async function CreateTournament(tournamentData) {
    // Normaliza uma única vez no ponto de gravação. Leitura continua aceitando
    // aliases legados, mas documentos novos usam somente `teams`/`solo`.
    const input = tournamentData;
    const mode = (0, TournamentRules_1.NormalizeTournamentMode)(input);
    const format = (0, TournamentRules_1.GetTournamentFormat)({ ...input, Properties: { ...(input.Properties || {}), Mode: mode } });
    const formatFields = (0, TournamentRules_1.BuildFormatFields)({ ...input, Properties: { ...(input.Properties || {}), Mode: mode } });
    // Sempre força inscrição a abrir exatamente 1h antes do start
    const startMs = new Date(tournamentData.StartTime).getTime();
    const signupStart = new Date(startMs - 60 * 60 * 1000);
    const partySize = format.playersPerTeam;
    const maxPlayers = tournamentData.MaxInvites || 0;
    if (tournamentData.Phases?.length) {
        const correctMaxTeams = partySize >= 2 ? Math.floor(maxPlayers / partySize) : maxPlayers;
        for (const phase of tournamentData.Phases) {
            if (!phase.MaxTeams || phase.MaxTeams > correctMaxTeams) {
                phase.MaxTeams = correctMaxTeams || phase.MaxTeams;
            }
        }
    }
    const tournament = new Tournament_1.Tournament({
        ...tournamentData,
        ...formatFields,
        MaxPlayersPerMatch: format.maxTeamsPerMatch,
        PartySize: partySize,
        Properties: {
            ...(input.Properties || {}),
            Mode: mode,
        },
        SignupStart: signupStart,
    });
    const saved = await tournament.save();
    try {
        const messageId = await SendWebhook(saved);
        if (messageId) {
            await Tournament_1.Tournament.updateOne({ TournamentId: saved.TournamentId }, {
                $set: {
                    WebhookMessageId: messageId,
                    "Properties.WebhookMessageId": messageId,
                },
            });
            console.log(`[webhook] created message ${messageId} for tournament ${saved.TournamentId}`);
        }
    }
    catch (err) {
        console.error("Webhook failed:", err);
    }
    return saved;
}
async function GenerateUserId() {
    const UsersCollection = BackboneUser_1.BackboneUser.collection;
    let unique = false;
    let userId = "";
    while (!unique) {
        userId = Math.floor(10000 + Math.random() * 90000).toString();
        const exists = await UsersCollection.findOne({ UserId: userId });
        if (!exists)
            unique = true;
    }
    return userId;
}
async function CreateSignedUpUser(Times, TournamentId) {
    const users = [];
    const DBTour = await Tournament_1.Tournament.findOne({ TournamentId });
    if (!DBTour) {
        (0, Logger_1.msg)("Please provide a valid tournamentid :)");
        return;
    }
    const partySize = (0, TournamentRules_1.GetTournamentFormat)(DBTour).playersPerTeam;
    for (let i = 0; i < Times / partySize; i++) {
        const partyCode = (0, uuid_1.v4)();
        const partyMembers = [];
        const AcceptedAt = new Date();
        for (let j = 0; j < partySize; j++) {
            const UserId = await GenerateUserId();
            const Username = `TournamentSDK #${Math.random().toString(36).substring(2, 8)}`;
            const IsPartyLeader = j === 0;
            partyMembers.push({
                UserId,
                Username,
                Status: 1,
                IsPartyLeader,
            });
        }
        for (const member of partyMembers) {
            const user = new BackboneUser_1.BackboneUser({
                Username: member.Username,
                UserId: member.UserId,
                Tournaments: {
                    [TournamentId]: {
                        SignedUp: true,
                        InviteId: (0, Extensions_1.GenerateInviteId)(),
                        Status: 1,
                        AcceptedAt,
                        PartyCode: partyCode,
                        KnockedOut: false,
                        PartyMembers: partyMembers,
                        UserMatch: null,
                        UserMatches: [],
                        UserPosition: [],
                        FinalPlace: 0,
                    },
                },
            });
            users.push(user.save());
        }
    }
    const result = await Promise.all(users);
    try {
        const added = Times;
        const updated = await Tournament_1.Tournament.findOneAndUpdate({ TournamentId }, { $inc: { CurrentInvites: added } }, { new: true });
        if (updated) {
            await UpdateTournamentWebhook(updated);
        }
    }
    catch (err) {
        console.error("Failed to update tournament webhook after signup:", err);
    }
    return result;
}
async function OnPlayerSignedUp(TournamentId, playersAdded = 1) {
    const updated = await Tournament_1.Tournament.findOneAndUpdate({ TournamentId }, { $inc: { CurrentInvites: playersAdded } }, { new: true });
    if (updated) {
        await UpdateTournamentWebhook(updated);
    }
}
/** Retorna o menor ID inteiro positivo ainda não usado por um torneio. */
async function GetSmallestAvailableTournamentId() {
    const used = new Set((await Tournament_1.Tournament.find({}, { TournamentId: 1 }).lean()).map((row) => Number(row.TournamentId)).filter((id) => Number.isInteger(id) && id > 0));
    let id = 1;
    while (used.has(id))
        id++;
    return String(id);
}
//# sourceMappingURL=Database.js.map