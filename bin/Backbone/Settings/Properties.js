"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetProperties = GetProperties;
exports.GetNextPhaseStarted = GetNextPhaseStarted;
const Config_1 = require("../Config");
const Rules_1 = require("./Rules");
const TournamentRules_1 = require("../Logic/TournamentRules");
function GetProperties(DatabaseTournament) {
    let DisabledEmotes = DatabaseTournament.Properties?.DisabledEmotes || [];
    if (DisabledEmotes.includes(0)) {
        DisabledEmotes = Array.from({ length: 255 }, (_, i) => i + 1);
    }
    const SpecialEmotesNames = [
        "Hug",
        "Charged Hug",
        "Kick",
        "Wet Kick",
        "Punch",
        "Fire Punch",
        "Banana",
        "Golden Banana",
        "MrBeast Case",
        "Ball",
        "Invisibility",
        "Beast Lightning",
        "Toss a Block",
        "Snowball Throw",
        "Spatula Slap",
        "Karate Chop",
        "Force Shield",
    ];
    if (DisabledEmotes.includes(-1)) {
        DisabledEmotes = DisabledEmotes.filter((id) => id !== -1);
        for (const EmoteName of SpecialEmotesNames) {
            const EmoteId = Config_1.Emotes[EmoteName];
            if (EmoteId != null && !DisabledEmotes.includes(EmoteId)) {
                DisabledEmotes.push(EmoteId);
            }
        }
    }
    if (DisabledEmotes.includes(-2)) {
        DisabledEmotes = DisabledEmotes.filter((id) => id !== -2);
        const SpecialEmotesWithoutPunch = SpecialEmotesNames.filter((name) => name !== "Punch" && name !== "Fire Punch");
        for (const EmoteName of SpecialEmotesWithoutPunch) {
            const EmoteId = Config_1.Emotes[EmoteName];
            if (EmoteId != null && !DisabledEmotes.includes(EmoteId)) {
                DisabledEmotes.push(EmoteId);
            }
        }
    }
    if (DisabledEmotes.includes(-3)) {
        DisabledEmotes = DisabledEmotes.filter((id) => id !== -3);
        const SpecialEmotesWithoutPunchAndKick = SpecialEmotesNames.filter((name) => name !== "Punch" && name !== "Fire Punch" && name !== "Kick" && name !== "Wet Kick");
        for (const EmoteName of SpecialEmotesWithoutPunchAndKick) {
            const EmoteId = Config_1.Emotes[EmoteName];
            if (EmoteId != null && !DisabledEmotes.includes(EmoteId)) {
                DisabledEmotes.push(EmoteId);
            }
        }
    }
    if (DisabledEmotes.includes(-4)) {
        DisabledEmotes = DisabledEmotes.filter((id) => id !== -4);
        const SpecialEmotesWithoutPunch = SpecialEmotesNames.filter((name) => name !== "Banana" && name !== "Golden Banana");
        for (const EmoteName of SpecialEmotesWithoutPunch) {
            const EmoteId = Config_1.Emotes[EmoteName];
            if (EmoteId != null && !DisabledEmotes.includes(EmoteId)) {
                DisabledEmotes.push(EmoteId);
            }
        }
    }
    if (DisabledEmotes.includes(-5)) {
        DisabledEmotes = DisabledEmotes.filter((id) => id !== -5);
        const SpecialEmotesWithoutPunch = SpecialEmotesNames.filter((name) => name !== "Hug" && name !== "Charged Hug");
        for (const EmoteName of SpecialEmotesWithoutPunch) {
            const EmoteId = Config_1.Emotes[EmoteName];
            if (EmoteId != null && !DisabledEmotes.includes(EmoteId)) {
                DisabledEmotes.push(EmoteId);
            }
        }
    }
    const OverrideQualified = (0, TournamentRules_1.GetQualificationCount)(DatabaseTournament, false);
    const Properties = [
        { "@name": "max_wait_time", "@value": "0" },
        { "@name": "override_max_qualified", "@value": OverrideQualified.toString() },
        /*{ "@name": "minimum_version", "@value": "0.59" },
        { "@name": "required_version", "@value": "0.59" },*/
    ];
    for (let PhaseIndex = 0; PhaseIndex < DatabaseTournament.Phases.length; PhaseIndex++) {
        const PhaseConfig = DatabaseTournament.Phases[PhaseIndex];
        const MapsForPhase = PhaseConfig.Maps;
        if (MapsForPhase && MapsForPhase.length > 0) {
            if (MapsForPhase && MapsForPhase.length > 0) {
                const RoundCount = PhaseConfig.RoundCount || DatabaseTournament.RoundCount;
                if (MapsForPhase.length === 1) {
                    Properties.push({
                        "@name": `phase${PhaseIndex + 1}_override_level`,
                        "@value": MapsForPhase[0],
                    });
                }
                else {
                    for (let RoundIndex = 0; RoundIndex < RoundCount; RoundIndex++) {
                        const MapName = MapsForPhase[RoundIndex % MapsForPhase.length];
                        if (RoundIndex === 0) {
                            Properties.push({
                                "@name": `phase${PhaseIndex + 1}_override_level`,
                                "@value": MapName,
                            });
                        }
                        else {
                            Properties.push({
                                "@name": `phase${PhaseIndex + 1}_round${RoundIndex + 1}_override_level`,
                                "@value": MapName,
                            });
                        }
                    }
                }
            }
        }
    }
    if (DisabledEmotes.length > 0) {
        Properties.push({
            "@name": "disable_emotes",
            "@value": DisabledEmotes.join(","),
        });
    }
    return [
        {
            properties: [
                {
                    property: Properties,
                },
            ],
        },
    ];
}
async function GetNextPhaseStarted(Tournament, Phase) {
    if (!Tournament || Tournament.RoundCount <= 0)
        return 0;
    const CurrentPhase = Phase || Tournament.CurrentPhaseId || 1;
    const PhaseConfig = Tournament.Phases[CurrentPhase - 1];
    if (!PhaseConfig)
        return 0;
    const Configs = (0, Rules_1.GetRoundConfigs)(Tournament);
    let totalMinutes = 0;
    const RoundCount = PhaseConfig.RoundCount || Tournament.RoundCount;
    for (let i = 1; i <= RoundCount; i++) {
        const Config = Configs.get(i) || { MaxLength: 12 };
        totalMinutes += Config.MaxLength;
    }
    totalMinutes += 5;
    return totalMinutes * 60 * 1000;
}
//# sourceMappingURL=Properties.js.map