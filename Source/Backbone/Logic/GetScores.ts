import { BackboneUser } from "../../Models/BackboneUser";
import { Match } from "../../Models/Matches";
import { Tournament } from "../../Models/Tournament";
import { TournamentMatchStatus, TournamentStatus, TournamentPhaseType } from "../Config";
import { GetTournamentFormat } from "./TournamentRules";
import { AwardTournamentMedal } from "./GetMatches";
import { AwardTournamentPrize, ResolveTournamentPrize } from "./TournamentEconomy";

interface ScoreUser {
  "@user-id": string;
  "@status": string;
  "@checked-in": string;
  "@is-party-leader": string;
  "@nick": string;
}

interface Score {
  partyid: string;
  phaseid: number;
  groupid: number;
  checkin: boolean;
  position: number;
  totalpoints: number;
  matchwins: number;
  matchloses: number;
  gamewins: number;
  gameloses: number;
  stat1sum: number;
  stat2sum: number;
  loseweight: number;
  totalrounds: number;
  seed: number;
  users: ScoreUser[];
}

export async function GetScores(
  TournamentId: string,
  PhaseId: number,
  GroupId: number,
  MaxResults: number,
  Page: number
) {
  try {
    const Skip = (Page - 1) * MaxResults;
    const ActualPhaseId = PhaseId || 1;
    const TournamentIdStr = TournamentId.toString();

    const TournamentDoc = await Tournament.findOne({ TournamentId: TournamentIdStr }).lean();
    if (!TournamentDoc) {
      // Não crasha o processo — retorna lista vazia (torneio já foi deletado)
      console.warn(`[GetScores] tournament not found: ${TournamentIdStr}`);
      return {
        pagination: {
          totalResultCount: 0,
          maxResults: MaxResults,
          currentPage: Page,
        },
        scores: [],
      };
    }

    const IsFinalPhase = ActualPhaseId === TournamentDoc.Phases.length;
    const IsTournamentEnded = TournamentDoc.Status === TournamentStatus.Finished;
    const PhaseConfig = TournamentDoc.Phases[ActualPhaseId - 1];
    const PhaseTypeNum = Number(PhaseConfig?.PhaseType) || TournamentPhaseType.SingleEliminationBracket;
    const PhaseType = TournamentPhaseType[PhaseTypeNum] as keyof typeof TournamentPhaseType;
    const IsPointBasedPhase = PhaseType === "RoundRobin" || PhaseType === "Arena";

    const AllMatches = await Match.find({
      tournamentid: TournamentIdStr,
      phaseid: ActualPhaseId,
      groupid: GroupId,
    }).lean();

    const AllBackboneUsers = await BackboneUser.find({
      [`Tournaments.${TournamentIdStr}`]: { $exists: true },
    })
      .select("UserId Username Tournaments TournamentsWon")
      .lean();

    const UserMap = new Map<string, any>();
    for (const BBUser of AllBackboneUsers) {
      try {
        const TournamentData = (BBUser.Tournaments as any).get
          ? (BBUser.Tournaments as any).get(TournamentIdStr)
          : (BBUser.Tournaments as any)[TournamentIdStr];
        if (TournamentData) {
          UserMap.set(BBUser.UserId, {
            user: BBUser,
            tournamentData: TournamentData,
          });
        }
      } catch (err) {
        console.error(`error while getting ${BBUser.Username} data:`, err);
        continue;
      }
    }

    const TeamScoreMap = new Map<string, any>();
    let LastRoundNumber = 0;
    for (const MatchDoc of AllMatches) {
      if (MatchDoc.roundid > LastRoundNumber) {
        LastRoundNumber = MatchDoc.roundid;
      }
    }
    const LastRoundMatches = AllMatches.filter((m) => m.roundid === LastRoundNumber);
    const AllLastRoundClosed = LastRoundMatches.every(
      (m) => m.status === TournamentMatchStatus.Closed || m.status === TournamentMatchStatus.GameFinished
    );

    for (const MatchDoc of AllMatches) {
      if (!MatchDoc.users || MatchDoc.users.length === 0) continue;
      const TeamMap = new Map<string, any[]>();
      for (const User of MatchDoc.users) {
        const TeamId = User["@team-id"];
        if (!TeamId) continue;
        if (!TeamMap.has(TeamId)) {
          TeamMap.set(TeamId, []);
        }
        TeamMap.get(TeamId)!.push(User);
      }
      for (const [TeamId, TeamUsers] of TeamMap.entries()) {
        if (TeamUsers.length === 0) continue;
        const TeamUserIds = TeamUsers
          .map((TeamUser) => String(TeamUser["@user-id"] || ""))
          .filter(Boolean)
          .sort();
        if (TeamUserIds.length === 0) continue;
        const PartyLeaderUserId = TeamUserIds[0];
        // A equipe do torneio pode ser formada automaticamente por jogadores
        // avulsos de parties diferentes. A composição da match é a identidade
        // estável do grupo para o placar, não o InviteId de um único jogador.
        const PartyId = TeamUserIds.join("|");
        if (!TeamScoreMap.has(PartyId)) {
          const SortedUsers = [...TeamUsers].sort((a, b) => {
            const aUserId = a["@user-id"];
            const bUserId = b["@user-id"];
            const aIsLeader = aUserId === PartyLeaderUserId;
            const bIsLeader = bUserId === PartyLeaderUserId;
            if (aIsLeader !== bIsLeader) {
              return aIsLeader ? -1 : 1;
            }
            return aUserId.localeCompare(bUserId);
          });
          TeamScoreMap.set(PartyId, {
            partyid: PartyId,
            phaseid: ActualPhaseId,
            groupid: GroupId,
            checkin: false,
            position: 0,
            totalpoints: 0,
            matchwins: 0,
            matchloses: 0,
            gamewins: 0,
            gameloses: 0,
            stat1sum: 0,
            stat2sum: 0,
            loseweight: 0,
            totalrounds: 0,
            seed: 0,
            users: SortedUsers.map((u) => ({
              "@user-id": u["@user-id"],
              "@status": "1",
              "@checked-in": u["@checked-in"],
              "@is-party-leader": u["@user-id"] === PartyLeaderUserId ? "1" : "0",
              "@nick": u["@nick"],
            })),
          });
        }
        const ScoreEntry = TeamScoreMap.get(PartyId);
        const IsCheckedIn = TeamUsers.some((u) => u["@checked-in"] === "1");
        if (IsCheckedIn) {
          ScoreEntry.checkin = true;
        }
        if (
          MatchDoc.status === TournamentMatchStatus.Closed ||
          MatchDoc.status === TournamentMatchStatus.GameFinished
        ) {
          const IsWinner = TeamUsers.some((u) => u["@match-winner"] === "1");
          if (IsWinner) {
            ScoreEntry.checkin = true;
          }
          ScoreEntry.totalrounds += 1;
          let IsWinnerFinal = TeamUsers.some((u) => u["@match-winner"] === "1");
          if (!IsWinnerFinal) {
            for (const TeamUser of TeamUsers) {
              const UserId = TeamUser["@user-id"];
              const UserData = UserMap.get(UserId);
              if (UserData && UserData.tournamentData.UserMatches) {
                const UserMatch = UserData.tournamentData.UserMatches.find((um: any) => um.id === MatchDoc.id);
                if (UserMatch && UserMatch.users) {
                  const MatchUser = UserMatch.users.find((u: any) => u["@user-id"] === UserId);
                  if (MatchUser && MatchUser["@match-winner"] === "1") {
                    IsWinnerFinal = true;
                    break;
                  }
                }
              }
            }
          }
          const TeamScore = parseInt(TeamUsers[0]["@team-score"] || "0");
          const UserScore = parseInt(TeamUsers[0]["@user-score"] || "0");
          const ActualScore = Math.max(TeamScore, UserScore);
          const MatchPoints = parseInt(TeamUsers[0]["@match-points"] || "0");
          if (IsWinnerFinal) {
            ScoreEntry.matchwins += 1;
            ScoreEntry.totalpoints += MatchPoints > 0 ? MatchPoints : 1;
            ScoreEntry.gamewins += ActualScore > 0 ? ActualScore : 1;
          } else {
            ScoreEntry.matchloses += 1;
            let OpponentScore = 0;
            for (const [OtherTeamId, OtherTeamUsers] of TeamMap.entries()) {
              if (OtherTeamId !== TeamId) {
                const OtherIsWinner = OtherTeamUsers.some((u) => u["@match-winner"] === "1");
                if (OtherIsWinner) {
                  const OtherTeamScore = parseInt(OtherTeamUsers[0]["@team-score"] || "0");
                  const OtherUserScore = parseInt(OtherTeamUsers[0]["@user-score"] || "0");
                  OpponentScore = Math.max(OtherTeamScore, OtherUserScore);
                  break;
                }
              }
            }
            ScoreEntry.gameloses += OpponentScore > 0 ? OpponentScore : 1;
            ScoreEntry.loseweight += ScoreEntry.totalrounds;
          }
        }
      }
    }

    // Mostra também inscritos que ainda não possuem partida fechada. Isso é
    // necessário para o grupo aparecer logo após a inscrição.
    for (const [UserId, UserData] of UserMap.entries()) {
      if (!UserData.tournamentData?.SignedUp) continue;
      const PartyId = UserData.tournamentData.InviteId?.toString() || UserId;
      if (TeamScoreMap.has(PartyId)) continue;
      const members = Array.isArray(UserData.tournamentData.PartyMembers) && UserData.tournamentData.PartyMembers.length
        ? UserData.tournamentData.PartyMembers
        : [{ UserId, Username: UserData.user.Username, IsPartyLeader: true }];
      const leader = members.find((member: any) => member.IsPartyLeader)?.UserId || UserId;
      TeamScoreMap.set(PartyId, {
        partyid: PartyId,
        phaseid: ActualPhaseId,
        groupid: GroupId,
        checkin: false,
        position: 0,
        totalpoints: 0,
        matchwins: 0,
        matchloses: 0,
        gamewins: 0,
        gameloses: 0,
        stat1sum: 0,
        stat2sum: 0,
        loseweight: 0,
        totalrounds: 0,
        seed: 0,
        users: members.map((member: any) => ({
          "@user-id": String(member.UserId),
          "@status": "1",
          "@checked-in": "0",
          "@is-party-leader": String(member.UserId) === String(leader) ? "1" : "0",
          "@nick": member.Username || member.Nickname || member.UserId,
        })),
      });
    }

    const Scores: Score[] = Array.from(TeamScoreMap.values());
    Scores.sort((a, b) => {
      if (b.totalpoints !== a.totalpoints) return b.totalpoints - a.totalpoints;
      if (b.matchwins !== a.matchwins) return b.matchwins - a.matchwins;
      if (a.matchloses !== b.matchloses) return a.matchloses - b.matchloses;
      if (b.gamewins !== a.gamewins) return b.gamewins - a.gamewins;
      if (a.gameloses !== b.gameloses) return a.gameloses - b.gameloses;
      if (a.loseweight !== b.loseweight) return a.loseweight - b.loseweight;
      return 0;
    });
    for (let i = 0; i < Scores.length; i++) {
      Scores[i].position = i + 1;
    }

    if (IsFinalPhase && AllLastRoundClosed && LastRoundMatches.length > 0) {
      const TopScore = Scores[0];
      if (TopScore && TopScore.matchwins > 0) {
        const Winners = [];
        const WinnerUserIds = new Set<string>();
        for (const User of TopScore.users) {
          const UserId = User["@user-id"];
          const UserData = UserMap.get(UserId);
          if (UserData) {
            const award = ResolveTournamentPrize(TournamentDoc, 1);
            Winners.push({ nick: User["@nick"], userId: UserId, rewardType: award.mode, rewardAmount: award.amount, rewardTag: award.tag, rewardExpiresAt: award.expiresAt ? new Date(award.expiresAt) : null });
            WinnerUserIds.add(UserId);
            if (GetTournamentFormat(TournamentDoc).playersPerTeam > 1) {
              const TournamentData = UserData.tournamentData;
              if (TournamentData?.PartyMembers && Array.isArray(TournamentData.PartyMembers)) {
                for (const Member of TournamentData.PartyMembers) {
                  if (Member.UserId && Member.UserId !== UserId) {
                    const MemberBBUser = AllBackboneUsers.find((u) => u.UserId === Member.UserId);
                    if (MemberBBUser && !WinnerUserIds.has(Member.UserId)) {
                      const memberAward = ResolveTournamentPrize(TournamentDoc, 1);
                      Winners.push({ nick: MemberBBUser.Username, userId: Member.UserId, rewardType: memberAward.mode, rewardAmount: memberAward.amount, rewardTag: memberAward.tag, rewardExpiresAt: memberAward.expiresAt ? new Date(memberAward.expiresAt) : null });
                      WinnerUserIds.add(Member.UserId);
                    }
                  }
                }
              }
            }
          }
        }
        if (Winners.length > 0) {
          try {
            const FinishUpdate = await Tournament.updateOne(
              {
                TournamentId: TournamentIdStr,
                Status: { $ne: TournamentStatus.Finished },
              },
              {
                $set: {
                  Winners: Winners,
                  Status: TournamentStatus.Finished,
                  "Properties.FinishedAt": new Date(),
                },
              }
            );
            if (FinishUpdate.modifiedCount > 0) {
              const WinnerUpdatePromises = Array.from(WinnerUserIds).map(async (WinnerUserId) => {
                const winner = AllBackboneUsers.find((u) => u.UserId === WinnerUserId);
                const nick = String(winner?.Username || WinnerUserId);
                await AwardTournamentPrize(WinnerUserId, nick, TournamentDoc, 1);
                await AwardTournamentMedal(WinnerUserId, nick, TournamentIdStr, Boolean((TournamentDoc as any).CountForLeaderboard ?? (TournamentDoc as any).Properties?.CountForLeaderboard));
              });
              await Promise.all(WinnerUpdatePromises);
            }
          } catch (err) {
            console.error("error while setting tour winners:", err);
          }
        }
      }
    }

    const UpdatePromises: Promise<any>[] = [];
    const ProcessedParties = new Set<string>();
    for (const Score of Scores) {
      if (ProcessedParties.has(Score.partyid)) continue;
      ProcessedParties.add(Score.partyid);
      const PartyUserIds = new Set<string>();
      for (const User of Score.users) {
        const UserId = User["@user-id"];
        if (!UserId) continue;
        PartyUserIds.add(UserId);
        const UserData = UserMap.get(UserId);
        if (UserData && GetTournamentFormat(TournamentDoc).playersPerTeam > 1) {
          const TournamentData = UserData.tournamentData;
          if (TournamentData?.PartyMembers && Array.isArray(TournamentData.PartyMembers)) {
            for (const Member of TournamentData.PartyMembers) {
              if (Member?.UserId) {
                PartyUserIds.add(Member.UserId);
              }
            }
          }
        }
      }
      for (const UserId of PartyUserIds) {
        UpdatePromises.push(
          BackboneUser.updateOne(
            {
              UserId: UserId,
              [`Tournaments.${TournamentIdStr}.UserPosition.phaseid`]: ActualPhaseId,
            },
            {
              $set: {
                [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].rankposition`]: Score.position,
                [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].sameposition`]: 0,
                [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].totalpoints`]: Score.totalpoints,
                [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].matchloses`]: Score.matchloses,
                [`Tournaments.${TournamentIdStr}.UserPosition.$[pos].totalrounds`]: Score.totalrounds,
              },
            },
            {
              arrayFilters: [{ "pos.phaseid": ActualPhaseId, "pos.groupid": GroupId }],
            }
          ).catch((err) => {
            return null;
          })
        );
      }
    }

    if (IsFinalPhase && IsTournamentEnded) {
      const ProcessedFinalPlace = new Set<string>();
      for (const Score of Scores) {
        for (const User of Score.users) {
          const UserId = User["@user-id"];
          if (!UserId || ProcessedFinalPlace.has(UserId)) continue;
          const UserData = UserMap.get(UserId);
          if (UserData) {
            ProcessedFinalPlace.add(UserId);
            UpdatePromises.push(
              BackboneUser.updateOne(
                { UserId: UserId },
                { $set: { [`Tournaments.${TournamentIdStr}.FinalPlace`]: Score.position } }
              ).catch((err) => {
                return null;
              })
            );
            if (GetTournamentFormat(TournamentDoc).playersPerTeam > 1) {
              const TournamentData = UserData.tournamentData;
              if (TournamentData?.PartyMembers && Array.isArray(TournamentData.PartyMembers)) {
                const IsLeader = TournamentData.PartyMembers.some((m: any) => m.IsPartyLeader && m.UserId === UserId);
                if (IsLeader) {
                  for (const Member of TournamentData.PartyMembers) {
                    if (Member?.UserId && Member.UserId !== UserId && !ProcessedFinalPlace.has(Member.UserId)) {
                      ProcessedFinalPlace.add(Member.UserId);
                      UpdatePromises.push(
                        BackboneUser.updateOne(
                          { UserId: Member.UserId },
                          { $set: { [`Tournaments.${TournamentIdStr}.FinalPlace`]: Score.position } }
                        ).catch((err) => {
                          return null;
                        })
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    if (UpdatePromises.length > 0) {
      try {
        await Promise.all(UpdatePromises);
      } catch (err) {}
    }

    const TotalCount = Scores.length;
    const PaginatedScores = Scores.slice(Skip, Skip + MaxResults);
    return {
      pagination: {
        totalResultCount: TotalCount,
        maxResults: MaxResults,
        currentPage: Page,
      },
      scores: PaginatedScores,
    };
  } catch (err) {
    console.error("Hey, there was an error while fetching GetScores:", err);
    // Nunca deixa o erro derrubar o processo
    return {
      pagination: {
        totalResultCount: 0,
        maxResults: MaxResults,
        currentPage: Page,
      },
      scores: [],
    };
  }
}
