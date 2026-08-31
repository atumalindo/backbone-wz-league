"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BuildPrizeDistribution = BuildPrizeDistribution;
exports.ChargeTournamentEntry = ChargeTournamentEntry;
exports.RefundTournamentEntry = RefundTournamentEntry;
exports.ResolveTournamentPrize = ResolveTournamentPrize;
exports.AwardTournamentPrize = AwardTournamentPrize;
const tslib_1 = require("tslib");
const axios_1 = tslib_1.__importDefault(require("axios"));
const TournamentRules_1 = require("./TournamentRules");
/** Distribui o pool total entre as colocações, sempre preservando a soma integral. */
function BuildPrizeDistribution(totalGems, maxInvites, tournamentOrParty) {
    return (0, TournamentRules_1.BuildPrizeBands)(totalGems, maxInvites, tournamentOrParty);
}
function EconomyBases() {
    return [process.env.ECONOMY_API_URL, process.env.GEMS_API_URL, process.env.BACKEND_URL, process.env.UNIVERSAL_BACKEND_URL, process.env.API_URL]
        .filter(Boolean)
        .map((url) => String(url).replace(/\/$/, ""));
}
/** Debita a taxa de entrada no serviço de economia configurado. Sem serviço configurado, taxa zero continua gratuita. */
async function ChargeTournamentEntry(userId, tournamentId, amount, eventId = `signup:${String(tournamentId)}:${String(userId)}`) {
    const gems = Math.max(0, Math.floor(Number(amount) || 0));
    if (gems === 0)
        return { ok: true };
    const bases = [...new Set(EconomyBases())];
    if (bases.length === 0)
        return { ok: false };
    const paths = (process.env.GEMS_CHARGE_PATH || "/user/gems/charge,/user/gems/debit").split(",").map((path) => path.trim()).filter(Boolean);
    let lastError;
    for (const base of bases) {
        for (const path of paths) {
            try {
                const response = await axios_1.default.post(`${base}${path.startsWith("/") ? path : `/${path}`}`, { userId: String(userId), tournamentId: String(tournamentId), amount: gems, gems, eventId }, { timeout: 8000, headers: { "Content-Type": "application/json", ...(process.env.ECONOMY_INTERNAL_SECRET ? { "X-Economy-Secret": process.env.ECONOMY_INTERNAL_SECRET } : {}) } });
                const body = response.data || {};
                if (body.ok === false || body.success === false || body.status === "insufficient_funds" || body.status === "not_enough_gems")
                    continue;
                return { ok: true, balance: Number(body.balance ?? body.gems ?? body.gemBalance) || undefined };
            }
            catch (error) {
                lastError = error;
            }
        }
    }
    console.error(`[economy] Falha ao debitar ${gems} gemas do usuário ${userId}`, lastError);
    return { ok: false };
}
async function RefundTournamentEntry(userId, tournamentId, amount, eventId = `refund:${String(tournamentId)}:${String(userId)}`) {
    const gems = Math.max(0, Math.floor(Number(amount) || 0));
    if (gems === 0)
        return;
    const base = EconomyBases()[0];
    if (!base)
        return;
    const path = process.env.GEMS_REFUND_PATH || "/user/gems/refund";
    await axios_1.default.post(`${base}${path.startsWith("/") ? path : `/${path}`}`, { userId: String(userId), tournamentId: String(tournamentId), amount: gems, gems, eventId }, { timeout: 8000, headers: { "Content-Type": "application/json", ...(process.env.ECONOMY_INTERNAL_SECRET ? { "X-Economy-Secret": process.env.ECONOMY_INTERNAL_SECRET } : {}) } }).catch((error) => console.error("[economy] Falha ao estornar gemas", error));
}
function addMonths(date, months) {
    const result = new Date(date);
    result.setMonth(result.getMonth() + Math.max(1, months));
    return result;
}
function ResolveTournamentPrize(tournament, position) {
    const mode = tournament?.PrizeMode === "tag" ? "tag" : "gems";
    if (mode === "tag") {
        const value = Math.max(1, Number(tournament.PrizeTagDurationValue) || 1);
        const unit = tournament.PrizeTagDurationUnit || "permanent";
        let expiresAt = null;
        if (unit !== "permanent") {
            const now = new Date();
            const expires = unit === "hours" ? new Date(now.getTime() + value * 60 * 60 * 1000) : unit === "days" ? new Date(now.getTime() + value * 24 * 60 * 60 * 1000) : addMonths(now, value);
            expiresAt = expires.toISOString();
        }
        return { mode, tag: String(tournament.PrizeTag || "").trim(), expiresAt, position };
    }
    const prize = (tournament.Prizes || []).find((item) => position >= Number(item.position || 0) && position <= Number(item.endPosition || item.position || 0)) || (tournament.Prizes || [])[0];
    return { mode, amount: Math.max(0, Number(prize?.amount) || 0), position };
}
async function AwardTournamentPrize(userId, nick, tournament, position) {
    const award = ResolveTournamentPrize(tournament, position);
    if (award.mode === "tag" && !award.tag)
        return false;
    if (award.mode === "gems" && !award.amount)
        return false;
    const base = EconomyBases()[0];
    if (!base)
        return false;
    const path = award.mode === "tag" ? "/user/tags/award" : "/user/gems/payout";
    const body = award.mode === "tag"
        ? { userId: String(userId), nick, tagName: award.tag, expiresAt: award.expiresAt, tournamentId: String(tournament.TournamentId), position, eventId: `payout:tag:${String(tournament.TournamentId)}:${String(userId)}:${position}` }
        : { userId: String(userId), nick, amount: award.amount, gems: award.amount, tournamentId: String(tournament.TournamentId), position, eventId: `payout:gems:${String(tournament.TournamentId)}:${String(userId)}:${position}` };
    try {
        const response = await axios_1.default.post(`${base}${path}`, body, { timeout: 10000, headers: { "Content-Type": "application/json", "X-Economy-Secret": process.env.ECONOMY_INTERNAL_SECRET || "" } });
        const data = response.data || {};
        return data.ok !== false && data.success !== false;
    }
    catch (error) {
        console.error(`[economy] Falha no payout ${award.mode} user=${userId} tournament=${tournament.TournamentId}`, error);
        return false;
    }
}
//# sourceMappingURL=TournamentEconomy.js.map