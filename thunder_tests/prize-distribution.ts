import { BuildPrizeDistribution } from "../Source/Backbone/Logic/TournamentEconomy";

for (const slots of [1, 2, 3, 4, 8, 16, 32, 64, 128]) {
  const prizes = BuildPrizeDistribution(10000, slots, 1);
  const labels = prizes.map((prize) => prize.label).join(" | ");
  const total = prizes.reduce((sum, prize) => sum + prize.amount * (prize.endPosition - prize.position + 1), 0);
  if (total !== 10000) throw new Error(`pool mismatch for ${slots}: ${total}`);
  if (prizes.length > 6) throw new Error(`too many bands for ${slots}`);
  console.log(`${slots}: ${labels} => ${total}`);
}
