# Auditoria das cinco prioridades imediatas

A refatoração arquitetural foi concluída no Atuma Backbone e propagada aos pontos de criação, resolução, lista, bot, WebAdmin, webhook e sessão do cliente. Os aliases antigos continuam sendo aceitos apenas na leitura para preservar documentos históricos; novos documentos passam a escrever o contrato canônico.

| Prioridade | Estado | Implementação principal |
| --- | --- | --- |
| Regras centralizadas | Concluída | `Source/Backbone/Logic/TournamentRules.ts` concentra modo, formato, capacidade, rounds, classificação e faixas de gemas. |
| Máquina de estados | Concluída | `MatchStateMachine.ts` define transições permitidas e rejeita progressões incompatíveis. |
| Fechamentos atômicos | Concluída | WO, resultado, bye, campeão automático e promoção de match usam updates condicionais; `ClaimQualification` persiste o gate contra duplicação após restart. |
| `teams/solo` | Concluída | Novos registros gravam somente `Properties.Mode: "teams"` ou `"solo"`; `times`, `ffa` e aliases equivalentes são normalizados na entrada. |
| Jogadores/equipes | Concluída | `PlayersPerTeam`, `MaxTeamsPerMatch` e `MatchCapacity` distinguem jogadores por equipe, competidores por match e capacidade total. |

## Contrato canônico

O formato `teams` usa `PlayersPerTeam` para representar o tamanho da party e `MaxTeamsPerMatch` para representar a quantidade de equipes que compete na partida. `MatchCapacity` é sempre o produto dos dois campos. O formato `solo` fixa `PlayersPerTeam = 1`, `MaxTeamsPerMatch = 4` e `MatchCapacity = 4`, resultando em `1v1v1v1`.

O módulo central também define a quantidade de classificados por fase e o número de rounds para Bracket e Round Robin. O painel replica a mesma fórmula apenas para a prévia visual no navegador; a gravação e a execução no servidor continuam sendo a fonte de verdade.

## Idempotência e concorrência

Cada fechamento de match incrementa `stateVersion`, grava `closedAt` quando aplicável e usa o status atual como condição de atualização. A qualificação é protegida pelo par `qualificationApplied`/`qualificationClaimedAt`, reivindicado por uma operação condicional. Isso impede que poll, worker de resolução, resultado repetido, bye ou comando manual de WO paguem ou avancem a mesma partida duas vezes.

O finalizador global do torneio também condiciona a transição a `Status != Finished`, e o incremento de vitórias só ocorre quando a operação que marca o torneio como concluído realmente altera o documento. O polling não renova deadlines.

## Espectador

O backend mantém o endpoint público de consulta `POST /api/v1/tournamentSpectator`, com headers compatíveis com as rotas de torneio. O modo `join` cria uma sessão separada em `SpectatorSession`, armazenando somente o hash do token e com expiração TTL de quinze minutos. `POST /api/v1/tournamentSpectatorHeartbeat` renova a sessão e `POST /api/v1/tournamentSpectatorLeave` encerra o acompanhamento. Nenhum secret de match é devolvido.

A resposta informa quem está na partida, check-in, conexão recente, fase, round, status, prazo e regras explícitas de ghost: `countsAsPlayer: false`, `canSubmitResult: false`, `canCheckIn: false`, `canChangeMatch: false` e `appearsEliminatedLocally: true`. No cliente nativo, o botão **Assistir** aparece abaixo de matches abertas ou em andamento; o fluxo ativa `TournamentMatchHandler.isSpectator`, tenta iniciar a câmera nativa e limpa o estado ao voltar ao lobby.

## Dez torneios ativos

O payload de `TournamentList` e a rotação administrativa foram ampliados para dez slots ativos, mantendo os finalizados separados. O backend já pode entregar os dez registros; o prefab nativo antigo do StumbleNexus pode continuar limitando a quantidade de cards simultâneos na tela, portanto a expansão visual para dez itens depende de o cliente utilizar uma lista rolável ou um prefab que aceite mais registros. A entrega não declara que a UI nativa antiga renderiza dez cards sem essa adaptação.

## Validação

Foram executados `npm run check`, `npm run build`, `npm run test:rules`, `node --check WebAdmin/server.js` e `node --check WebAdmin/public/app.js`. A suíte de regras cobre aliases, `teams` 2v2, Solo 1v1v1v1, Bracket, Round Robin, classificação, faixas agrupadas e transições válidas e inválidas. O patch C# de spectator foi compilado isoladamente com as assemblies IL2CPP disponíveis; o build integral via Mono/xbuild permanece limitado por duplicatas pré-existentes e importação de módulos Unity no ambiente Linux.
