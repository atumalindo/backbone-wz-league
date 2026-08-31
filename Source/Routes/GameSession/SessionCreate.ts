import { Router } from "express";
import { ForService, ServiceType } from "../../Modules/Service";
import { XMLParser } from "fast-xml-parser";
import { Match } from "../../Models/Matches";
import { Tournament } from "../../Models/Tournament";
import { LPUser } from "../../Models/LPUser";
import { TouchMatchPresence } from "../../Backbone/Logic/MatchPresence";
import { TournamentMatchStatus } from "../../Backbone/Config";
import { GetTournamentFormat } from "../../Backbone/Logic/TournamentRules";
import { TransitionMatch } from "../../Backbone/Logic/MatchStateMachine";

const App = Router();
App.use(ForService(ServiceType.Public));
// gonna add joi validation at some point

App.post("/gameSessionCreate", async (req, res) => {
  try {
    const { gameSessionData } = req.body;
    const AccessToken = req.body?.accessToken;

    if (!AccessToken || !gameSessionData) {
      return res.status(400).json({});
    }

    let DecodedXML: string;
    try {
      DecodedXML = Buffer.from(gameSessionData, "base64").toString("utf-8");
      if (!DecodedXML.trim().startsWith("<")) {
        DecodedXML = decodeURIComponent(gameSessionData);
      }
    } catch {
      return res.status(400).json({});
    }

    const Parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseAttributeValue: true,
    });

    const ParsedXML = Parser.parse(DecodedXML);

    if (!ParsedXML?.data?.["game-session"]) {
      return res.status(400).json({});
    }

    const SessionData = Array.isArray(ParsedXML.data["game-session"])
      ? ParsedXML.data["game-session"][0]
      : ParsedXML.data["game-session"];
    const RawMatchId = SessionData["tournament-match-id"];
    const MatchId = String(
      RawMatchId && typeof RawMatchId === "object"
        ? RawMatchId["#text"] ?? RawMatchId.value ?? RawMatchId.id ?? RawMatchId["@id"] ?? ""
        : RawMatchId ?? ""
    ).trim();
    if (!MatchId) return res.status(400).json({});
    const NumericMatchId = Number(MatchId);
    let DatabaseMatch = await Match.findOne({ id: MatchId });

    if (!DatabaseMatch && Number.isFinite(NumericMatchId)) {
      // Fallback só quando o client manda o matchid numérico truncado em vez
      // do id composto. PERIGO: "matchid" é só o número da partida DENTRO da
      // rodada (reinicia em 1 a cada rodada), então um jogador que avançou
      // por WO tem, por exemplo, matchid=1 fechado (Closed) na R1 E matchid=1
      // ativo na R2 — sem esse filtro, o findOne podia pegar a partida velha
      // (já fechada/vencida) e devolver a sessão dela, deixando o client
      // preso "carregando" pra sempre tentando entrar numa partida encerrada,
      // enquanto a bracket mostra "já ganhei" (da partida antiga errada).
      DatabaseMatch = await Match.findOne({
        matchid: NumericMatchId,
        status: {
          $nin: [
            TournamentMatchStatus.Closed,
            TournamentMatchStatus.GameFinished,
            TournamentMatchStatus.MatchFinished,
          ],
        },
      }).sort({ roundid: -1, deadline: -1 });
    }

    if (!DatabaseMatch) {
      return res.status(404).json({});
    }

    // A sessão é a fonte de presença real. O check-in continua sendo preservado
    // para o cliente, mas a resolução de WO também passa a saber quem entrou e
    // depois ficou desconectado.
    const LoginUser = await LPUser.findOne({ AccessToken }).lean();
    const LoginUserId = LoginUser?.UserId != null ? String(LoginUser.UserId) : "";
    if (LoginUserId && DatabaseMatch.users.some((u) => String(u["@user-id"]) === LoginUserId)) {
      await TouchMatchPresence(String(DatabaseMatch.id), LoginUserId, true).catch((error) => {
        console.error("[gameSessionCreate] presence update failed:", error);
      });
      DatabaseMatch = await Match.findOne({ id: DatabaseMatch.id });
      if (!DatabaseMatch) return res.status(404).json({});
    }

    const CheckedInUsers = DatabaseMatch.users.filter((u) => u["@checked-in"] === "1");
    const CheckedInTeams = new Set(CheckedInUsers.map((u) => String(u["@team-id"])).filter(Boolean));
    const TournamentData = await Tournament.findOne({ TournamentId: String(DatabaseMatch.tournamentid) }).lean();
    const TournamentFormat = GetTournamentFormat(TournamentData);
    const RequiredTeams = TournamentFormat.maxTeamsPerMatch;

    // Nunca remove usuários da partida. Assim, o primeiro cliente pode criar a
    // sessão enquanto os demais ainda estão carregando. Solo só começa quando
    // as quatro equipes individuais tiverem confirmado a entrada. Todas as
    // mudanças de estado são condicionais para não sobrescrever uma resolução
    // concorrente do worker de WO/resultado.
    if (CheckedInTeams.size >= RequiredTeams) {
      if (
        DatabaseMatch.status === TournamentMatchStatus.Created ||
        DatabaseMatch.status === TournamentMatchStatus.WaitingForOpponent
      ) {
        await TransitionMatch(
          String(DatabaseMatch.id),
          [TournamentMatchStatus.Created, TournamentMatchStatus.WaitingForOpponent],
          TournamentMatchStatus.GameReady
        );
      }
      if (DatabaseMatch.status === TournamentMatchStatus.GameReady || DatabaseMatch.status === TournamentMatchStatus.WaitingForOpponent) {
        await TransitionMatch(
          String(DatabaseMatch.id),
          [TournamentMatchStatus.GameReady],
          TournamentMatchStatus.GameInProgress
        );
      }
      DatabaseMatch = await Match.findOne({ id: DatabaseMatch.id });
      if (!DatabaseMatch) return res.status(404).json({});
    }

    // O cliente precisa receber exatamente o ID persistido; parseInt pode truncar IDs compostos ou UUIDs.
    const SessionId = String(DatabaseMatch.id ?? MatchId);
    const Response = { id: SessionId, secret: DatabaseMatch.secret || "" };

    return res.status(200).json(Response);
  } catch {
    return res.status(500).json({});
  }
});

export default {
  App,
  DefaultAPI: "/api/v1",
};
