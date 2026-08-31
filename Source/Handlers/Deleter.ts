import { Tournament } from "../Models/Tournament";
import { Match } from "../Models/Matches";
import { BackboneUser } from "../Models/BackboneUser";
import { TournamentStatus } from "../Backbone/Config";

/**
 * Limpa torneios finalizados após 5 minutos de terem ganhador.
 * Roda a cada 60 segundos para a lista atualizar rápido quando o jogador
 * sai e volta na aba de torneios.
 */
export class TournamentCleaner {
  private static IsRunning = false;

  private static async Clean(): Promise<void> {
    const FiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
    const TwoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    // A remoção por idade é independente do status: torneios ativos também expiram após 2h.
    const ExpiredByAge = await Tournament.find({ CreatedAt: { $lte: TwoHoursAgo } }).lean();
    const Finished = await Tournament.find({ Status: TournamentStatus.Finished }).lean();
    const Candidates = Array.from(
      new Map([...ExpiredByAge, ...Finished].map((tour: any) => [String(tour.TournamentId), tour])).values()
    );

    for (const Tour of Candidates) {
      try {
        const TournamentId = Tour.TournamentId.toString();
        const props = (Tour as any).Properties || {};
        const finishedAtRaw = props.FinishedAt;

        let shouldDelete = Boolean((Tour as any).CreatedAt && new Date((Tour as any).CreatedAt) <= TwoHoursAgo);

        if (shouldDelete) {
          // A regra de duas horas tem prioridade e não depende de vencedor/status.
        } else if (finishedAtRaw) {
          const finishedAt = new Date(finishedAtRaw);
          if (finishedAt < FiveMinsAgo) {
            shouldDelete = true;
          }
        } else {
          // Fallback: usa o deadline da última partida da última fase
          const LastPhaseId = Tour.Phases?.length || 1;
          const LastMatch = await Match.findOne({
            tournamentid: TournamentId,
            phaseid: LastPhaseId,
          })
            .sort({ roundid: -1 })
            .select("deadline status")
            .lean();

          if (
            !LastMatch ||
            (new Date(LastMatch.deadline) < FiveMinsAgo &&
              (LastMatch.status === 8 || LastMatch.status === 7))
          ) {
            shouldDelete = true;
          }
        }

        if (!shouldDelete) continue;

        console.log(
          `[cleaner] Deleting tournament ${TournamentId} (${shouldDelete && (Tour as any).CreatedAt ? "older than 2 hours" : "finished cleanup"})`
        );

        // Remove partidas
        await Match.deleteMany({ tournamentid: TournamentId });

        // Remove referência do torneio em todos os usuários
        await BackboneUser.updateMany(
          { [`Tournaments.${TournamentId}`]: { $exists: true } },
          { $unset: { [`Tournaments.${TournamentId}`]: "" } }
        );

        // Remove o torneio (mesmo efeito do /delete do bot)
        await Tournament.deleteOne({ TournamentId });

        console.log(`[cleaner] ✅ Deleted ${TournamentId}`);
      } catch (err) {
        console.error(`cleaner error for ${Tour.TournamentId}:`, err);
      }
    }
  }

  public static async Start(): Promise<void> {
    if (this.IsRunning) return;
    this.IsRunning = true;

    // Roda a cada 60 segundos para a lista refletir exclusões rapidamente
    while (this.IsRunning) {
      try {
        await this.Clean();
      } catch (err) {
        console.error("cleaner error:", err);
      }
      await new Promise((r) => setTimeout(r, 60 * 1000));
    }
  }

  public static Stop(): void {
    this.IsRunning = false;
  }
}
