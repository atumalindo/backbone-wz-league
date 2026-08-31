# Ecossistema de torneios — mudanças finais

## Escopo dos projetos

O **Atuma Backbone** permanece como motor de torneios, bot Discord e backend do WebAdmin. O **StumbleNexus** continua sendo o cliente/lobby Unity com MelonLoader responsável por inserir ações na interface nativa e acionar o fluxo de spectator. O **Baqui Endi** continua reservado aos dados e à economia do jogo; não foi alterado nesta etapa.

## Arquitetura de regras

As decisões de modo, capacidade, rounds, classificação e prêmios foram centralizadas em `Source/Backbone/Logic/TournamentRules.ts`. O contrato novo grava `Properties.Mode` como `teams` ou `solo`, `PlayersPerTeam` como jogadores por equipe, `MaxTeamsPerMatch` como equipes/competidores por partida e `MatchCapacity` como jogadores totais.

O Solo é sempre `1v1v1v1`: quatro jogadores individuais em uma mesma partida, com `PlayersPerTeam = 1`, `MaxTeamsPerMatch = 4` e `MatchCapacity = 4`. Em uma fase de bracket, os dois melhores avançam em rounds intermediários e somente o primeiro vence a final. O Round Robin utiliza a mesma capacidade central para calcular os confrontos.

Dados legados com `times`, `PartySize` e `MaxPlayersPerMatch` continuam sendo lidos durante a compatibilidade, mas novas criações do bot, scheduler, painel e backend persistem somente o contrato canônico.

## Máquina de estados e operações atômicas

`Source/Backbone/Logic/MatchStateMachine.ts` define as transições de match e aplica atualizações condicionais no Mongo. O fechamento grava `closedAt` quando necessário e incrementa `stateVersion`. O par `qualificationApplied`/`qualificationClaimedAt` é reivindicado por operação condicional, de modo que poll repetido, worker de resolução, resultado duplicado, bye, campeão automático e WO manual não possam qualificar ou pagar a mesma partida duas vezes.

O deadline persistido não é renovado a cada poll. A abertura de sessão, check-in, promoção de partida, resultado, resolução de WO e ativação do torneio foram revisados para não gravar snapshots obsoletos por `save()` depois de uma corrida concorrente.

## WO, presença e não jogada

A entrada real em sessão grava presença e heartbeat; apenas consultar o lobby não conta como jogador conectado. Depois que o relógio chega a zero, um lado conectado recebe WO conforme as regras de presença. Se ambos iniciaram e caíram, ou se nenhum iniciou, a partida aguarda mais um minuto e depois é marcada como **não jogada** para os envolvidos. No Solo, a mesma regra funciona por participante/equipe individual, sem exigir líder de party.

## Sistema de espectador

O cliente adiciona **Assistir** abaixo dos itens nativos de Arena, Bracket e Round Robin enquanto a match está aberta, aguardando adversários, pronta ou em andamento. Matches encerradas não exibem a ação. O clique abre o caminho nativo e define `TournamentMatchHandler.isSpectator` antes da conexão, reaplicando a flag durante o bind e acionando o controlador de câmera ghost quando a instalação disponibiliza um dos métodos nativos conhecidos.

O spectator é tratado como eliminado localmente e não como participante: não faz check-in, não envia resultado, não recebe estado de jogador e não altera a partida. Ao retornar ao lobby, o cliente limpa o estado para impedir que uma partida normal herde a flag de espectador. O `LobbyButtonsFix` continua sem reposicionar a UI enquanto a tela de match está aberta.

O Atuma expõe `POST /api/v1/tournamentSpectator` para consulta pública de estado, presença recente, check-ins, equipes, fase, round, prazo e situação live. O modo `join` cria uma sessão separada em `SpectatorSession`, armazenando apenas o hash do token e expirando em quinze minutos. `POST /api/v1/tournamentSpectatorHeartbeat` renova essa sessão e `POST /api/v1/tournamentSpectatorLeave` encerra o acompanhamento. O contrato retorna as flags `countsAsPlayer: false`, `canSubmitResult: false`, `canCheckIn: false`, `canChangeMatch: false` e `appearsEliminatedLocally: true`; nenhum secret de match é exposto.

## Gemas e webhook

O pool de gemas configurado permanece integral. A distribuição usa no máximo cinco faixas agrupadas da fase final, conforme o número de participantes: **Top 1**, **Top 2**, **Top 3-4**, **Top 5-8** e **Top 9-16**. A soma do valor entregue é exatamente igual ao pool, inclusive quando há arredondamento; a sobra é devolvida à primeira faixa. A implementação única é `BuildPrizeBands` em `TournamentRules.ts`.

Na última fase, emotes diferentes por round aparecem junto do mapa e o topo da embed informa `Emotes: Custom`. Quando mapa e emote são iguais, os rounds são agrupados e o emote permanece no topo. Fases anteriores continuam usando o agrupamento normal e não transformam o torneio inteiro em `Custom`.

## Dez torneios ativos

`TournamentList` agora entrega até dez torneios ativos com tipos estáveis de `1` a `10`, sem ocupar as vagas ativas com finalizados. A camada administrativa também foi alinhada a esse limite. A lista nativa antiga do jogo pode continuar exibindo menos cards caso o prefab não seja rolável; o backend não descarta os registros, mas a renderização de dez itens depende de um prefab/scroll que suporte a quantidade.

## WebAdmin premium

O painel recebeu uma reformulação visual completa, mantendo todas as IDs e ações existentes. A nova interface usa uma direção dark glass editorial com acentos ácido/ciano/violeta, topbar operacional, status de Backbone, sidebar responsiva, cards de métricas, tabelas que viram cards no mobile, estados de botão mais claros, builder de criação em duas colunas e preview sticky de torneio. O gate Discord também recebeu uma apresentação própria de control room, com hierarquia de acesso e indicador de sessão segura.

A prévia visual foi aberta em viewport desktop e verificada no shell principal e no builder. Os assets agora usam `?v=15` para evitar que browsers mantenham o CSS/JS anterior em cache.

## Validação

Foram executados:

| Verificação | Resultado |
| --- | --- |
| `npm run check` | Passou |
| `npm run build` | Passou |
| `npm run test:rules` | Passou; cobre teams 2v2, Solo 1v1v1v1, rounds, Round Robin, faixas e transições |
| `node --check WebAdmin/server.js` | Passou |
| `node --check WebAdmin/public/app.js` | Passou |
| Compilação isolada de `TournamentSpectator.cs` | Passou com as assemblies IL2CPP disponíveis |
| Build integral Mono/xbuild do StumbleNexus | Não confiável no Linux por duplicatas pré-existentes e importação de módulos Unity |

A captura e os achados da revisão visual ficam registrados em `WEBADMIN_VISUAL_VALIDATION.md`. Os testes determinísticos executáveis ficam em `tests/tournament-rules.test.js` e podem ser repetidos com `npm run test:rules`.
