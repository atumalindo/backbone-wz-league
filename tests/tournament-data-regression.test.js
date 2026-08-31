const assert = require("node:assert/strict");

// Regressão documentada do contrato de status: 3 é GameInProgress;
// Closed é 8. O código antigo confundia os dois durante o polling.
const TournamentMatchStatus = {
  GameInProgress: 3,
  GameFinished: 4,
  MatchFinished: 5,
  Closed: 8,
};

function shouldNormalizeAsCompleted(match) {
  const status = match.status;
  const numericStatus = Number(status);
  const isTerminalStatus =
    numericStatus === TournamentMatchStatus.Closed ||
    numericStatus === TournamentMatchStatus.GameFinished ||
    numericStatus === TournamentMatchStatus.MatchFinished ||
    numericStatus === 7 ||
    status === "Closed" ||
    status === "GameFinished" ||
    status === "MatchFinished";
  const hasWinner = (match.users || []).some(
    (user) => user && (user["@match-winner"] === "1" || user["@match-winner"] === 1)
  );
  const isRoundOneBye = Number(match.roundid) === 1 && new Set(
    (match.users || []).map((user) => user && user["@team-id"]).filter(Boolean)
  ).size <= 1;
  return isRoundOneBye || (isTerminalStatus && hasWinner);
}

assert.equal(
  shouldNormalizeAsCompleted({ status: 3, roundid: 2, users: [{ "@team-id": "1", "@match-winner": "0" }] }),
  false,
  "GameInProgress não pode virar partida concluída"
);
assert.equal(
  shouldNormalizeAsCompleted({ status: 8, roundid: 2, users: [{ "@team-id": "1", "@match-winner": "1" }] }),
  true,
  "Closed com vencedor deve continuar sendo concluída"
);
assert.equal(
  shouldNormalizeAsCompleted({ status: 1, roundid: "1", users: [{ "@team-id": "1", "@match-winner": "0" }] }),
  true,
  "bye da rodada 1 deve continuar sendo normalizado"
);
console.log("tournament-data-regression.test.js: OK");
