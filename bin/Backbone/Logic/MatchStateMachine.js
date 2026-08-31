"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CanTransitionMatch = CanTransitionMatch;
exports.IsTerminalMatchStatus = IsTerminalMatchStatus;
exports.TransitionMatch = TransitionMatch;
exports.ClaimQualification = ClaimQualification;
const Matches_1 = require("../../Models/Matches");
const Config_1 = require("../Config");
const AllowedTransitions = {
    [Config_1.TournamentMatchStatus.Unkown]: new Set([Config_1.TournamentMatchStatus.Created]),
    [Config_1.TournamentMatchStatus.Created]: new Set([
        Config_1.TournamentMatchStatus.WaitingForOpponent,
        Config_1.TournamentMatchStatus.GameReady,
        Config_1.TournamentMatchStatus.Closed,
    ]),
    [Config_1.TournamentMatchStatus.WaitingForOpponent]: new Set([
        Config_1.TournamentMatchStatus.GameReady,
        Config_1.TournamentMatchStatus.Closed,
    ]),
    [Config_1.TournamentMatchStatus.GameReady]: new Set([
        Config_1.TournamentMatchStatus.GameInProgress,
        Config_1.TournamentMatchStatus.Closed,
    ]),
    [Config_1.TournamentMatchStatus.GameInProgress]: new Set([
        Config_1.TournamentMatchStatus.GameFinished,
        Config_1.TournamentMatchStatus.MatchFinished,
        Config_1.TournamentMatchStatus.Closed,
    ]),
    [Config_1.TournamentMatchStatus.GameFinished]: new Set([
        Config_1.TournamentMatchStatus.MatchFinished,
        Config_1.TournamentMatchStatus.Closed,
    ]),
    [Config_1.TournamentMatchStatus.MatchFinished]: new Set([Config_1.TournamentMatchStatus.Closed]),
    [Config_1.TournamentMatchStatus.Closed]: new Set(),
};
function CanTransitionMatch(from, to) {
    return from === to || Boolean(AllowedTransitions[from]?.has(to));
}
function IsTerminalMatchStatus(status) {
    return [
        Config_1.TournamentMatchStatus.Closed,
        Config_1.TournamentMatchStatus.MatchFinished,
    ].includes(Number(status));
}
/** Fecha/resove uma match somente se ela ainda estiver em um estado permitido. */
async function TransitionMatch(matchId, fromStatuses, toStatus, set = {}, unset = {}) {
    if (!fromStatuses.some((status) => CanTransitionMatch(status, toStatus)))
        return null;
    return Matches_1.Match.findOneAndUpdate({ id: matchId, status: { $in: fromStatuses } }, {
        $set: { ...set, status: toStatus, ...(toStatus === Config_1.TournamentMatchStatus.Closed ? { closedAt: new Date() } : {}) },
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
        $inc: { stateVersion: 1 },
    }, { new: true }).lean();
}
/** Marca qualificação uma única vez; chamadas concorrentes retornam null na segunda execução. */
async function ClaimQualification(matchId) {
    return Matches_1.Match.findOneAndUpdate({
        id: matchId,
        qualificationApplied: { $ne: true },
        status: { $in: [Config_1.TournamentMatchStatus.Closed, Config_1.TournamentMatchStatus.GameFinished, Config_1.TournamentMatchStatus.MatchFinished] },
    }, { $set: { qualificationApplied: true, qualificationClaimedAt: new Date() }, $inc: { stateVersion: 1 } }, { new: true }).lean();
}
//# sourceMappingURL=MatchStateMachine.js.map