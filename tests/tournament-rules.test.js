const assert = require("node:assert/strict");
const {
  NormalizeTournamentMode,
  GetTournamentFormat,
  CalculateRoundCount,
  GetQualificationCount,
  BuildPrizeBands,
  BuildFormatFields,
} = require("../bin/Backbone/Logic/TournamentRules.js");
const { CanTransitionMatch } = require("../bin/Backbone/Logic/MatchStateMachine.js");
const { TournamentMatchStatus } = require("../bin/Backbone/Config.js");

function sumPrizePool(bands) {
  return bands.reduce((sum, band) => sum + band.amount * (band.endPosition - band.position + 1), 0);
}

assert.equal(NormalizeTournamentMode({ Properties: { Mode: "times" }, PartySize: 2 }), "teams");
assert.equal(NormalizeTournamentMode({ Properties: { Mode: "solo" }, PartySize: 1 }), "solo");
assert.equal(NormalizeTournamentMode({ PartySize: 1, MaxPlayersPerMatch: 4 }), "solo");

const teams2v2 = GetTournamentFormat({ Properties: { Mode: "teams" }, PlayersPerTeam: 2, MaxTeamsPerMatch: 2 });
assert.deepEqual(teams2v2, {
  mode: "teams",
  playersPerTeam: 2,
  maxTeamsPerMatch: 2,
  matchPlayerCapacity: 4,
  minTeamsPerMatch: 2,
});

const solo = GetTournamentFormat({ Properties: { Mode: "solo" } });
assert.deepEqual(solo, {
  mode: "solo",
  playersPerTeam: 1,
  maxTeamsPerMatch: 4,
  matchPlayerCapacity: 4,
  minTeamsPerMatch: 4,
});

assert.equal(CalculateRoundCount(8, teams2v2, "bracket"), 2);
assert.equal(CalculateRoundCount(16, solo, "bracket"), 3);
assert.equal(CalculateRoundCount(4, solo, "roundrobin"), 1);
assert.equal(GetQualificationCount(solo, false), 2);
assert.equal(GetQualificationCount(solo, true), 1);
assert.deepEqual(BuildFormatFields({ Properties: { Mode: "solo" } }), {
  PlayersPerTeam: 1,
  MaxTeamsPerMatch: 4,
  MatchCapacity: 4,
});

const soloPrizes = BuildPrizeBands(1000, 16, solo);
assert.deepEqual(soloPrizes.map((band) => [band.position, band.endPosition]), [
  [1, 1],
  [2, 2],
  [3, 4],
  [5, 8],
  [9, 16],
]);
assert.equal(sumPrizePool(soloPrizes), 1000);
assert.ok(soloPrizes.every((band) => band.amount > 0));

const teamPrizes = BuildPrizeBands(777, 16, teams2v2);
assert.deepEqual(teamPrizes.map((band) => [band.position, band.endPosition]), [
  [1, 1],
  [2, 2],
  [3, 4],
  [5, 8],
]);
assert.equal(sumPrizePool(teamPrizes), 777);

// 5 rounds / 32 jogadores: precisa existir a faixa Top 17-32 (antes nunca nascia).
const prizes32 = BuildPrizeBands(100000, 32, solo);
assert.deepEqual(prizes32.map((band) => [band.position, band.endPosition]), [
  [1, 1],
  [2, 2],
  [3, 4],
  [5, 8],
  [9, 16],
  [17, 32],
]);
assert.equal(sumPrizePool(prizes32), 100000);
// cada faixa deve valer estritamente menos, por pessoa, que a faixa anterior
for (let i = 1; i < prizes32.length; i++) {
  assert.ok(prizes32[i].amount < prizes32[i - 1].amount, `faixa ${prizes32[i].label} deveria pagar menos que ${prizes32[i - 1].label}`);
}

// 6 rounds / 64 jogadores: quem cai no top 33-64 (perde a 1ª rodada) não recebe gemas,
// e as faixas premiadas continuam sendo só as 5 últimas do bracket (até Top 17-32).
const prizes64 = BuildPrizeBands(100000, 64, solo);
assert.deepEqual(prizes64.map((band) => [band.position, band.endPosition]), [
  [1, 1],
  [2, 2],
  [3, 4],
  [5, 8],
  [9, 16],
  [17, 32],
]);
assert.equal(sumPrizePool(prizes64), 100000);
assert.ok(prizes64.every((band) => band.endPosition <= 32), "ninguém do top 33-64 pode receber gemas");

assert.equal(CanTransitionMatch(TournamentMatchStatus.Created, TournamentMatchStatus.WaitingForOpponent), true);
assert.equal(CanTransitionMatch(TournamentMatchStatus.GameReady, TournamentMatchStatus.GameInProgress), true);
assert.equal(CanTransitionMatch(TournamentMatchStatus.Closed, TournamentMatchStatus.GameInProgress), false);
assert.equal(CanTransitionMatch(TournamentMatchStatus.GameFinished, TournamentMatchStatus.Created), false);
assert.equal(CanTransitionMatch(TournamentMatchStatus.Closed, TournamentMatchStatus.Closed), true);

console.log("tournament-rules.test.js: OK");
