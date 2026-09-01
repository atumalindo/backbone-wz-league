"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TournamentCleaner = void 0;
const Tournament_1 = require("../Models/Tournament");
const Matches_1 = require("../Models/Matches");
const BackboneUser_1 = require("../Models/BackboneUser");
const Config_1 = require("../Backbone/Config");
/**
 * Limpa torneios finalizados após 5 minutos de terem ganhador.
 * Roda a cada 60 segundos para a lista atualizar rápido quando o jogador
 * sai e volta na aba de torneios.
 */
class TournamentCleaner {
    static IsRunning = false;
    static async Clean() {
        const FiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
        const TwoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        // A idade só pode ser usada como critério adicional para estados encerrados.
        // Torneios ativos não devem desaparecer da lista depois de duas horas.
        const ExpiredByAge = await Tournament_1.Tournament.find({
            Status: { $in: [Config_1.TournamentStatus.Finished, Config_1.TournamentStatus.Canceled] },
            CreatedAt: { $lte: TwoHoursAgo },
        }).lean();
        const Finished = await Tournament_1.Tournament.find({ Status: Config_1.TournamentStatus.Finished }).lean();
        const Candidates = Array.from(new Map([...ExpiredByAge, ...Finished].map((tour) => [String(tour.TournamentId), tour])).values());
        for (const Tour of Candidates) {
            try {
                const TournamentId = Tour.TournamentId.toString();
                const props = Tour.Properties || {};
                const finishedAtRaw = props.FinishedAt;
                let shouldDelete = Boolean(Tour.CreatedAt &&
                    Tour.CreatedAt <= TwoHoursAgo &&
                    (Tour.Status === Config_1.TournamentStatus.Finished || Tour.Status === Config_1.TournamentStatus.Canceled));
                if (shouldDelete) {
                    // Estados encerrados antigos podem ser removidos por idade.
                }
                else if (finishedAtRaw && (Tour.Status === Config_1.TournamentStatus.Finished || Tour.Status === Config_1.TournamentStatus.Canceled)) {
                    const finishedAt = new Date(finishedAtRaw);
                    if (finishedAt < FiveMinsAgo) {
                        shouldDelete = true;
                    }
                }
                else {
                    // Fallback: usa o deadline da última partida da última fase
                    const LastPhaseId = Tour.Phases?.length || 1;
                    const LastMatch = await Matches_1.Match.findOne({
                        tournamentid: TournamentId,
                        phaseid: LastPhaseId,
                    })
                        .sort({ roundid: -1 })
                        .select("deadline status")
                        .lean();
                    if (Tour.Status === Config_1.TournamentStatus.Finished &&
                        (!LastMatch ||
                            (new Date(LastMatch.deadline) < FiveMinsAgo &&
                                (LastMatch.status === 8 || LastMatch.status === 7)))) {
                        shouldDelete = true;
                    }
                }
                if (!shouldDelete)
                    continue;
                console.log(`[cleaner] Deleting tournament ${TournamentId} (${shouldDelete && Tour.CreatedAt ? "older than 2 hours" : "finished cleanup"})`);
                // Remove partidas
                await Matches_1.Match.deleteMany({ tournamentid: TournamentId });
                // Remove referência do torneio em todos os usuários
                await BackboneUser_1.BackboneUser.updateMany({ [`Tournaments.${TournamentId}`]: { $exists: true } }, { $unset: { [`Tournaments.${TournamentId}`]: "" } });
                // Remove o torneio (mesmo efeito do /delete do bot)
                await Tournament_1.Tournament.deleteOne({ TournamentId });
                console.log(`[cleaner] ✅ Deleted ${TournamentId}`);
            }
            catch (err) {
                console.error(`cleaner error for ${Tour.TournamentId}:`, err);
            }
        }
    }
    static async Start() {
        if (this.IsRunning)
            return;
        this.IsRunning = true;
        // Roda a cada 60 segundos para a lista refletir exclusões rapidamente
        while (this.IsRunning) {
            try {
                await this.Clean();
            }
            catch (err) {
                console.error("cleaner error:", err);
            }
            await new Promise((r) => setTimeout(r, 60 * 1000));
        }
    }
    static Stop() {
        this.IsRunning = false;
    }
}
exports.TournamentCleaner = TournamentCleaner;
//# sourceMappingURL=Deleter.js.map
