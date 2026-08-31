"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetRulesSettings = GetRulesSettings;
exports.GetRoundConfig = GetRoundConfig;
exports.GetRoundConfigs = GetRoundConfigs;
const Config_1 = require("../Config");
const TournamentRules_1 = require("../Logic/TournamentRules");
function GetRulesSettings(DatabaseTournament) {
    const AllPhases = [];
    const TournamentFormat = (0, TournamentRules_1.GetTournamentFormat)(DatabaseTournament);
    const TeamsPerMatch = TournamentFormat.maxTeamsPerMatch;
    const IsFFATournament = TournamentFormat.mode === "solo";
    for (let PhaseIndex = 0; PhaseIndex < DatabaseTournament.Phases.length; PhaseIndex++) {
        const PhaseDataObject = DatabaseTournament.Phases[PhaseIndex];
        const Rounds = [];
        const PhaseTypeNum = Number(PhaseDataObject.PhaseType) || Config_1.TournamentPhaseType.SingleEliminationBracket;
        const PhaseType = Config_1.TournamentPhaseType[PhaseTypeNum];
        let RoundsForPhase = PhaseDataObject.RoundCount || DatabaseTournament.RoundCount;
        const IsLastPhase = PhaseIndex === DatabaseTournament.Phases.length - 1;
        const IsPhaseFormat = PhaseType === "RoundRobin" || PhaseType === "Arena";
        if (IsLastPhase) {
            if (PhaseType === "SingleEliminationBracket" || PhaseType === "DoubleEliminationBracket") {
                RoundsForPhase = PhaseDataObject.RoundCount || DatabaseTournament.RoundCount;
                if (RoundsForPhase < 1)
                    RoundsForPhase = 1;
            }
        }
        else {
            if (PhaseType === "RoundRobin" || PhaseType === "Arena") {
                RoundsForPhase = PhaseDataObject.RoundCount || DatabaseTournament.RoundCount;
            }
        }
        let FFANonFinalDist = "";
        if (IsFFATournament) {
            const PassCount = Math.ceil(TeamsPerMatch / 2);
            const PointsArray = [];
            for (let i = 0; i < TeamsPerMatch; i++) {
                if (i < PassCount) {
                    PointsArray.push(TeamsPerMatch - i * 2);
                }
                else {
                    PointsArray.push(-(i - PassCount + 1));
                }
            }
            FFANonFinalDist = PointsArray.join(",");
        }
        for (let I = 1; I <= RoundsForPhase; I++) {
            const IsFinals = IsLastPhase && I === RoundsForPhase && !IsPhaseFormat;
            const Config = GetRoundConfig(DatabaseTournament, PhaseIndex + 1, I);
            const Round = {
                "@id": I.toString(),
                "@win-score": "1",
                "@max-game-count": Config.MaxGameCount.toString(),
                "@min-length": Config.MinGameLength.toString(),
                "@max-length": Config.MaxLength.toString(),
            };
            if (IsFinals) {
                if (IsFFATournament) {
                    const FinalPointsArray = [];
                    for (let i = 0; i < TeamsPerMatch; i++) {
                        if (i === 0) {
                            FinalPointsArray.push(TeamsPerMatch);
                        }
                        else {
                            FinalPointsArray.push(-i);
                        }
                    }
                    Round["@match-point-distribution"] = FinalPointsArray.join(",");
                }
                else {
                    Round["@match-point-distribution"] = "2,-1";
                }
            }
            else if (IsFFATournament && !IsPhaseFormat) {
                Round["@match-point-distribution"] = FFANonFinalDist;
            }
            Rounds.push(Round);
        }
        const CurrentPlayers = PhaseDataObject.MaxTeams || DatabaseTournament.MaxInvites;
        const Phase = {
            "@id": (PhaseIndex + 1).toString(),
            "@type": PhaseDataObject.PhaseType?.toString() ?? "2",
            "@max-players": CurrentPlayers.toString(),
            "@min-teams-per-match": TournamentFormat.minTeamsPerMatch.toString(),
            "@max-teams-per-match": TournamentFormat.maxTeamsPerMatch.toString(),
            "@min-checkins-per-team": "1",
            "@allow-skip": "0",
            "@game-point-distribution": "1",
            "@match-point-distribution": "1",
            "@allow-tiebreakers": IsFFATournament ? "1" : "0",
            round: Rounds,
        };
        if (PhaseDataObject.IsPhase) {
            Phase["@score-tiebreaker-stats"] = "1";
            Phase["@fill-groups-vertically"] = "0";
            Phase["@force-unique-matches"] = "0";
            Phase["@preferred-rematch-gap"] = "0";
            Phase["@match-point-distribution-custom"] = "1";
            Phase["@group-count"] = PhaseDataObject.GroupCount?.toString() || "1";
            Phase["@allow-tiebreakers"] = "1";
        }
        else {
            Phase["@max-loses"] = PhaseDataObject?.MaxLoses?.toString() || "1";
        }
        AllPhases.push(Phase);
    }
    return { phase: AllPhases };
}
function GetRoundConfig(DatabaseTournament, PhaseId, RoundId) {
    // Tempo de WO / max-length POR NÚMERO DO ROUND — nunca por "final/semi".
    // R1 (com gente) = 1 min; R2 = 5; R3 = 7; R4+ = 10.
    // Mesmo se R2 for a final num bracket de 2 rounds, usa tempo de R2.
    void DatabaseTournament;
    void PhaseId;
    // MinGameLength = buffer que o client subtrai do deadline.
    // MaxLength = tempo de espera solo/WO.
    // Partidas cheias usam 5 min de WO via BuildActiveMatchDeadline (GetMatches).
    // Buffer baixo no R1 → GO libera na hora (antes: min=6 max=8 → esperava ~2 min).
    // min-length 0 → client não segura o GO nos primeiros segundos
    if (RoundId <= 1) {
        return { MinGameLength: 0, MaxLength: 6, MaxGameCount: 1 }; // R1
    }
    if (RoundId === 2) {
        return { MinGameLength: 0, MaxLength: 8, MaxGameCount: 1 }; // R2
    }
    if (RoundId === 3) {
        return { MinGameLength: 0, MaxLength: 10, MaxGameCount: 1 }; // R3
    }
    return { MinGameLength: 0, MaxLength: 12, MaxGameCount: 1 }; // R4+
}
function GetRoundConfigs(DatabaseTournament, PhaseId) {
    const RoundConfigs = new Map();
    const CurrentPhaseId = PhaseId || DatabaseTournament.CurrentPhaseId || 1;
    const PhaseConfig = DatabaseTournament.Phases[CurrentPhaseId - 1];
    for (let I = 1; I <= 50; I++) {
        RoundConfigs.set(I, GetRoundConfig(DatabaseTournament, CurrentPhaseId, I));
    }
    return RoundConfigs;
}
//# sourceMappingURL=Rules.js.map