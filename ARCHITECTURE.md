# Arquitetura — JG Backend Challenge

## Visão executiva

O sistema é uma API transacional de processamento de apostas, implementada em TypeScript com NestJS, TypeORM e PostgreSQL, com integração assíncrona via Amazon SQS. A aplicação expõe operações HTTP para carteiras e transações e consome mensagens de entrada por um worker SQS. Os casos de uso coordenam as regras de domínio e a persistência; o domínio representa valores com `Decimal`, enquanto o PostgreSQL armazena quantias em `NUMERIC(20,2)`.

O processamento financeiro executa em transações PostgreSQL. O bloqueio de linha da carteira serializa alterações concorrentes sobre o mesmo saldo; constraints e índices únicos persistem as garantias de unicidade. A transação de negócio grava, de forma atômica, o resultado da operação, o saldo materializado, os lançamentos imutáveis do ledger e os eventos pendentes na Outbox, quando aplicável. A idempotência de requisições é verificada por chave e hash do payload; mensagens SQS usam Inbox persistente para distinguir redelivery concluída de conflito de conteúdo.

O `OutboxPublisher` envia eventos confirmados no banco para SQS com tentativas e backoff. Como a publicação externa e o commit PostgreSQL não formam uma transação distribuída, a entrega é recuperável, mas pode ocorrer mais de uma vez. Consumidores devem ser idempotentes. Assim, as garantias financeiras dependem do estado persistente no PostgreSQL, não de memória local nem da semântica FIFO da fila.

## 1. Contexto do sistema

O serviço recebe comandos financeiros por dois adaptadores de entrada: endpoints HTTP do NestJS e mensagens SQS consumidas por `WagerTransactionConsumer`. Ambos delegam o processamento de apostas ao caso de uso `ProcessWagerTransaction`, que aplica validações de domínio e coordena as alterações persistentes. O sistema assume entrega *at-least-once*: requisições e mensagens podem ser repetidas, dependências podem chegar fora de ordem e múltiplas instâncias podem operar simultaneamente sobre uma mesma carteira.

PostgreSQL é a fonte de verdade para carteiras, transações, ledger, Inbox e Outbox. As operações financeiras usam transações SQL, constraints e bloqueios por linha para manter o saldo materializado e o histórico financeiro consistentes. A deduplicação de comandos HTTP usa a chave de idempotência e o hash do payload; o caminho SQS registra o identificador e o hash da mensagem na Inbox, na mesma transação que os efeitos financeiros.

Eventos de integração são gravados na Outbox como parte da transação de negócio e publicados posteriormente pelo `OutboxPublisher`. O envio ao SQS é uma operação externa ao commit do banco: falhas são recuperadas por retries, mas uma publicação repetida continua possível. Por isso, o serviço oferece processamento financeiro idempotente com estado durável, não uma garantia de entrega externa exatamente uma vez.

## 2. Módulo principal e composição

`AppModule` é o módulo raiz e o composition root atual da aplicação. Ele registra configuração, persistência, controllers e providers diretamente; ainda não há módulos NestJS separados por domínio ou feature.

### Inicialização e configuração

- `ConfigModule.forRoot({ isGlobal: true })` carrega `.env` e disponibiliza `ConfigService` globalmente.
- `TypeOrmModule.forRootAsync(...)` configura PostgreSQL com as variáveis `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` e `DB_DATABASE`.
- `autoLoadEntities` registra as entidades declaradas com TypeORM; `synchronize` e `migrationsRun` ficam desativados. O schema deve ser evoluído por migrations executadas explicitamente.
- `TypeOrmModule.forFeature(...)` registra `WalletEntity`, `LedgerEntryEntity` e `WagerTransactionEntity` para injeção de repositories.
- `ObserveModule` só é inicializado quando `OBSERVE_APP_KEY` e `OBSERVE_APP_SECRET` estão configurados. Sem essas credenciais, os providers opcionais de observabilidade não são adicionados.

### Adaptadores HTTP

- `AppController` e `AppService` mantêm a rota básica da aplicação.
- `WalletsController` expõe criação, consulta, ledger e reconciliação de carteiras.
- `WageringController` expõe processamento e consulta de transações de aposta.
- `ProviderWageringTransactionsController` consulta transações pelo identificador externo do provedor.
- `HealthController` expõe liveness (`/health/live`) e readiness (`/health/ready`); a readiness verifica dependências por meio de `HealthService`.

### Casos de uso e workers

Os casos de uso de carteira e apostas (`CreateWallet`, `GetWallet`, `GetWalletLedger`, `ReconcileWallet`, `ProcessWagerTransaction` e `GetWagerTransaction`) são registrados como providers do módulo raiz. `RetryPendingReferences` também é provider e inicia um worker de ciclo de vida que verifica referências pendentes a cada 5 segundos.

`WagerTransactionConsumer` e `OutboxPublisher` são providers com hooks de ciclo de vida do NestJS:

- `WagerTransactionConsumer` só inicia polling quando `SQS_CONSUMER_ENABLED=true`; nesse modo exige `SQS_QUEUE_URL`.
- O timeout de visibilidade solicitado pelo consumer é configurável por `SQS_VISIBILITY_TIMEOUT_SECONDS` (padrão de 60 segundos; intervalo de 0 a 43200).
- `OutboxPublisher` inicia por padrão e só é desabilitado explicitamente com `OUTBOX_PUBLISHER_ENABLED=false`.

Essa composição mantém a inicialização simples para o desafio, mas implica que API HTTP, worker SQS, retry de referências e publisher da Outbox compartilham o mesmo processo e ciclo de deploy. Uma evolução operacional seria separar API e workers em processos/deployments dedicados, mantendo os mesmos casos de uso e garantias persistentes.

### Decisões técnicas de persistência e dinheiro

O projeto usa TypeORM, opção permitida pelo desafio, em vez de MikroORM. A escolha mantém a integração com NestJS e PostgreSQL simples no escopo atual e permite combinar repositories com SQL explícito quando é necessário usar recursos específicos do PostgreSQL, como `SELECT ... FOR UPDATE` e `FOR UPDATE SKIP LOCKED`. A estratégia transacional é `DataSource.transaction(...)`; todas as consultas que precisam participar da unidade de trabalho usam o `EntityManager` fornecido pelo callback.

`Money` é um value object de domínio baseado em `Decimal` (`decimal.js`). A API recebe e devolve `amount` como string decimal; a persistência usa colunas PostgreSQL `NUMERIC(20,2)`, mapeadas pelo TypeORM como strings para evitar conversões para ponto flutuante binário. A serialização do value object usa `toFixed(2)`. O limite de precisão aceito na entrada também é validado antes da persistência. Assim, `number` pode aparecer em metadados operacionais, como duração em milissegundos, mas não deve ser usado para calcular valores monetários.

### Observabilidade

Os logs do consumer e do publisher são serializados como JSON e incluem os identificadores disponíveis em cada fluxo (`correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` quando aplicáveis), sem incluir o payload financeiro. As métricas usam `@nestjs/observe` e `TracerService` e só são registradas se `OBSERVE_APP_KEY` e `OBSERVE_APP_SECRET` contiverem credenciais válidas.

As métricas cobrem especialmente:

- conflitos de lock;
- latência de processamento de apostas;
- retries de mensagem;
- mensagens duplicadas;
- lag da Outbox.

## 3. Estrutura de diretórios e papel de cada camada

O repositório separa código por camadas, mas essa separação ainda não é uma arquitetura hexagonal estrita: os casos de uso em `src/application` acessam `DataSource`, repositories e entidades do TypeORM diretamente. Isso torna a persistência explícita e prática para o escopo atual, mas acopla a aplicação ao ORM.

### src/domain

Contém os agregados, valores e regras de negócio sem depender de NestJS, HTTP ou filas.

Principais responsabilidades:

- money/money.ts: representação imutável de valor monetário com Decimal e validações de escala;
- wallet/wallet.ts: agregado de carteira com regras de saldo e histórico;
- wagering/wager-transaction.ts: modelo de transação de aposta com estados, referência e regras de transição;
- ledger/ledger-entry.ts: entrada do ledger financeiro;
- events/*: eventos de domínio e integração.

O domínio é orientado por invariantes e encapsulamento. O código evita number para dinheiro e define factories estáticas e estados explícitos.

### src/application

Orquestra casos de uso e coordena transações, validações e persistência.

Exemplos concretos:

- ProcessWagerTransaction: valida payload, usa DataSource.transaction, persiste transação, saldo e ledger, integra Inbox e regras de idempotência;
- CreateWallet: cria carteira com saldo inicial e validações de negócio;
- GetWalletLedger: devolve histórico financeiro;
- ReconcileWallet: reconstitui saldo a partir da base e do ledger;
- RetryPendingReferences: reprocessa transações pendentes por referência.

### src/infrastructure

Implementa adaptações aos mecanismos externos e a infraestrutura operacional.

- sqs/wager-transaction-consumer.ts: consumidor assíncrono da fila de entrada;
- outbox/outbox-publisher.ts: publicador da Outbox para eventos externos.

### src/database

Centraliza schema, entidades e migrations.

Entidades principais:

- wallet.entity.ts
- wager-transaction.entity.ts
- ledger-entry.entity.ts

Schema persistente importante:

- wallets: saldo materializado, versionamento e unicidade por player_id + currency;
- wagering_transactions: histórico de operações de pregão/aposta e idempotência persistente;
- ledger_entries: registro auditável de débitos/créditos;
- processed_messages: deduplicação de mensagens por consumidor e messageId;
- outbox_events: fila de publicação confiável e recuperável.

## 4. Invariantes arquiteturais

A arquitetura está organizada em torno das seguintes regras:

1. PostgreSQL é a fonte de verdade financeira.
2. O saldo materializado deve ser consistente com o ledger.
3. A idempotência não é apenas lógica em memória: é reforçada por constraints de banco e payload_hash.
4. SQS não substitui persistência, apenas transporta eventos e mensagens.
5. A transação financeira e a publicação de evento devem ser desacopladas com segurança.
6. Redelivery, concorrência e falhas de processo devem ser toleradas sem duplicar efeitos.

## 5. Fluxo de processamento HTTP

As rotas HTTP são adaptadores de entrada: recebem os dados, aplicam validações próprias do protocolo HTTP e delegam o trabalho aos casos de uso. As regras financeiras e a persistência não ficam nos controllers.

Fluxo geral:

```text
Cliente
  -> Controller NestJS
  -> validação de parâmetros e cabeçalhos HTTP
  -> caso de uso
  -> validação de negócio e domínio
  -> PostgreSQL (transação, quando há escrita)
  -> resultado do caso de uso
  -> resposta HTTP
```

### 5.1 Criação de carteira

1. `POST /wallets` chega a `WalletsController.create()`, que encaminha o corpo para `CreateWallet.execute()`.
2. O caso de uso valida `playerId`, o formato de `initialBalance` e a moeda; em seguida converte o valor para `Money`.
3. `Wallet.open()` cria o agregado e o caso de uso inicia uma transação PostgreSQL.
4. A carteira é persistida. Se o saldo inicial for positivo, a mesma transação também registra a transação interna `OPENING`, o lançamento de crédito no ledger e os eventos `WalletBalanceChanged` e `WagerTransactionProcessed` na Outbox.
5. O commit confirma essas gravações juntas. Se a unicidade de jogador e moeda for violada, o caso de uso converte a constraint correspondente em conflito HTTP.
6. O controller devolve o resultado da criação, incluindo identificador, jogador, saldo e versão.

Com saldo inicial zero, a carteira é persistida sem transação `OPENING`, lançamento de ledger ou eventos de abertura.

### 5.2 Processamento de aposta

1. `POST /wagering/transactions` chega a `WageringController.process()`. O controller exige o cabeçalho `Idempotency-Key` e encaminha o corpo e a chave a `ProcessWagerTransaction.execute()`.
2. O caso de uso valida os campos e o tipo de operação, cria o valor `Money` e calcula um hash canônico do payload.
3. O caso de uso inicia uma transação PostgreSQL e bloqueia a linha da carteira com `SELECT ... FOR UPDATE`, serializando operações concorrentes sobre essa carteira.
4. Antes de aplicar efeitos, procura uma operação existente pela combinação `providerId + idempotencyKey`. Se encontrou o mesmo payload e há resultado armazenado, devolve esse resultado como replay idempotente; se a chave foi reutilizada com outro payload, responde com conflito. Também verifica a unicidade do identificador externo do provedor.
5. Aplica as regras de `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK`, incluindo a resolução de referências. Persiste a transação e, quando há movimentação financeira, atualiza a carteira e grava o lançamento do ledger com os saldos anterior e posterior.
6. Registra na Outbox o evento correspondente ao resultado. Transação, saldo, ledger e eventos são confirmados juntos no commit; uma falha antes dele desfaz as alterações da operação.
7. Após o commit, o resultado é devolvido pelo controller como resposta HTTP. A publicação SQS dos eventos é feita posteriormente pelo `OutboxPublisher`, não durante a resposta HTTP.

Neste endpoint HTTP não há contexto de Inbox; a deduplicação de mensagens recebidas aplica-se ao caminho SQS. A idempotência HTTP/provedor é baseada em `providerId + idempotencyKey` e no hash do conteúdo.

### 5.3 Consulta e demais rotas

- `GET /wagering/transactions/:transactionId` valida o UUID e delega a consulta a `GetWagerTransaction`.
- `GET /wallets/:walletId` valida o UUID e delega a consulta a `GetWallet`.
- `GET /wallets/:walletId/ledger` valida o UUID e os parâmetros de paginação antes de chamar `GetWalletLedger`.
- `POST /wallets/:walletId/reconciliation` valida o UUID e delega a reconciliação a `ReconcileWallet`.

Essas rotas de consulta e reconciliação também mantêm o controller como adaptador HTTP; a operação específica fica no caso de uso chamado.

## 6. Fluxo de processamento via SQS

O consumidor WagerTransactionConsumer realiza polling na fila wager-transactions.fifo.

### Fluxo

1. ReceiveMessageCommand busca mensagens.
2. parseWagerTransactionMessage() valida envelope e payload.
3. ProcessWagerTransaction.execute(..., inboxContext) é chamado com:
   - consumerName
   - messageId
   - payloadHash
4. O processamento usa a Inbox no mesmo banco da transação:
   - tenta registrar consumer_name + message_id em processed_messages;
   - se já existe, compara payload_hash;
   - se hash diferente => conflito;
   - se hash igual => duplicata legítima, sem reprocessamento dos efeitos.
5. Se o processamento for bem-sucedido ou reconhecido como duplicata concluída, a mensagem é removida da fila via DeleteMessageCommand.
6. Falhas transitórias não removem a mensagem; ela fica disponível para redelivery após o timeout de visibilidade.
7. Erros terminais de negócio (HttpException com status menor que 500) removem a mensagem. Mensagens inválidas no parsing são deixadas na fila para novas tentativas e possível redrive à DLQ, conforme a política da fila.

O consumidor solicita até 10 mensagens por chamada, com long polling de 20 segundos e timeout de visibilidade de 60 segundos, mas processa o lote sequencialmente em cada instância. A visibilidade começa quando o lote é recebido; portanto, mensagens no fim de um lote podem esperar enquanto as anteriores são processadas, e uma mensagem pode ser redeliverada se a espera ou o processamento ultrapassar os 60 segundos. A Inbox protege contra repetição dos efeitos financeiros, mas não evita processamento simultâneo desnecessário nem redelivery. O consumidor não estende atualmente a visibilidade; ajuste do tamanho do lote, concorrência limitada ou extensão do visibility timeout são opções para uma evolução operacional.

## 7. Modelo de idempotência e deduplicação

O código implementa idempotência em múltiplos níveis:

### 7.1 Idempotência do cliente / provedor

A transação de aposta usa:

- idempotencyKey do cliente/provedor;
- payloadHash calculado com o payload canônico.

A unicidade fica reforçada no banco:

- uq_wagering_provider_idempotency em wagering_transactions;
- uq_wagering_provider_external_transaction para impedir a repetição do identificador externo do provedor.

### 7.2 Redelivery de mensagens SQS

A Inbox mantém registro persistente da mensagem por consumidor:

- consumer_name
- message_id
- payload_hash
- processed_at

Isso impede reprocessamento físico para a mesma mensagem já confirmada.

### 7.3 Outbox

A Outbox garante que eventos de integração não sejam perdidos entre o commit financeiro e a publicação externa:

- evento é gravado no banco dentro da mesma transação de negócio;
- publisher tenta enviar em outro ciclo;
- falhas geram attempts e next_attempt_at para retry;
- evento só é marcado como publicado após envio bem-sucedido.

Na implementação atual, o publisher seleciona até 10 eventos com `FOR UPDATE SKIP LOCKED` e mantém a transação e os locks das linhas enquanto envia cada evento ao SQS, sequencialmente. Isso reduz a chance de dois publishers reivindicarem o mesmo evento ao mesmo tempo, mas mantém recursos do PostgreSQL ocupados durante chamadas de rede. Latência alta ou indisponibilidade do SQS pode prolongar a transação e aumentar contenção e consumo do pool de conexões.

Se o SQS aceitar o envio e a transação PostgreSQL falhar antes de confirmar `published_at`, o evento poderá ser enviado de novo. A FIFO e seu identificador de deduplicação não devem ser tratados como garantia durável de publicação exatamente uma vez. Em maior escala, uma evolução possível é separar a reivindicação persistente dos eventos do envio externo, usando uma lease/estado de claim com expiração e recuperação após falhas.

## 8. Contratos e regras de dados

### Wallet

- id UUID;
- player_id + currency unique;
- balance em NUMERIC(20,2);
- version para controle de concorrência / controle de mutação.

### WagerTransaction

- id
- wallet_id
- player_id
- provider_id
- external_transaction_id
- idempotency_key
- payload_hash
- round_id
- game_id
- kind
- status
- amount
- currency
- reference_transaction_id
- failure_code
- response_snapshot

### LedgerEntry

- wallet_id
- transaction_id
- entry_type (CREDIT ou DEBIT)
- amount
- currency

## 9. Concorrência e segurança transacional

O projeto considera múltiplas instâncias e acessos paralelos à mesma carteira. Por isso, a correção não depende de memória local.

No código, a concorrência é tratada em nível de banco e aplicação por:

- DataSource.transaction();
- constraints únicas;
- bloqueio SELECT ... FOR UPDATE da carteira durante o processamento financeiro;
- constraints de saldo não negativo e atualização e validação de estados;
- FOR UPDATE SKIP LOCKED na seleção dos registros pendentes da Outbox.

O bloqueio por linha protege operações concorrentes sobre a mesma carteira sem serializar carteiras diferentes. A reivindicação de registros da Outbox reduz a concorrência entre publishers, mas não garante publicação exatamente uma vez: uma falha após o envio ao SQS e antes da confirmação no banco pode gerar duplicata. Consumidores devem tolerar essa possibilidade.

## 10. Painel de tolerância a falhas

A arquitetura foi pensada para falhas em quatro momentos:

- antes do commit: a operação pode ser retryada sem efeitos duplicados;
- depois do envio SQS, antes da confirmação de publicação no banco: pode haver duplicação do evento e consumidores devem tolerá-la;
- depois do commit financeiro, antes do ACK da fila de entrada: pode haver redelivery, e a Inbox evita repetir os efeitos financeiros;
- após commit da transação financeira mas antes da publicação da Outbox: o evento permanece persistido e será encaminhado no retry.

A política do código é “persistir primeiro, confirmar depois, reprocessar com segurança”.

## 11. Decisão de autenticação

O código ainda não valida tokens nem integra um Identity Provider. `ProviderAuthenticationGuard` está aplicado aos controllers HTTP que não são de health e permite todas as requisições; é um ponto de extensão explícito, não um controle de segurança. O campo `providerId` e as demais entradas continuam sujeitos às validações de formato e de negócio, mas isso não equivale a autenticação.

O consumidor SQS é tratado como canal interno confiável pelo escopo do desafio. Essa confiança depende da configuração externa da fila e das permissões AWS; não é uma autenticação do provedor contido no payload.

Para produção ou para atender integralmente à recomendação do desafio, substitua o guard no-op por validação OIDC/JWT, associe a identidade autenticada ao provedor autorizado e não confie em `providerId` enviado livremente pelo cliente. A fila deve continuar protegida por IAM e suas mensagens devem validar a identidade do provedor de acordo com as regras de domínio.

## 12. Observabilidade e operação

Os principais sinais de operação são:

- latência de processamento de apostas;
- conflitos de lock/serialização;
- retries de processamento no consumer SQS;
- lag da Outbox;
- eventos pendentes e falhas de publicação;
- mensagens duplicadas identificadas pela Inbox.

Esses indicadores ajudam a distinguir:

- falha transitória;
- erro terminal de negócio;
- duplicata legítima;
- perda de entrega de evento.

## 13. Testes e validação arquitetural

O projeto usa Vitest para testes unitários, E2E e de integração. As suítes de integração conectam-se a PostgreSQL e LocalStack reais em containers; elas não substituem essas dependências por mocks para os cenários de persistência e mensageria.

### Cobertura implementada

- **Unidade:** regras de `Money`, invariantes da carteira e transação, payload canônico, validações, idempotência e mapeamento de erros.
- **PostgreSQL:** persistência das transações, ledger, Inbox e Outbox; constraints e imutabilidade do ledger; reconciliação e processamento de referências pendentes.
- **Concorrência na camada de aplicação:** duas apostas disputando o saldo de uma carteira, 50 requisições idênticas em paralelo, reversões concorrentes e operações paralelas em carteiras diferentes.
- **Concorrência entre processos:** três processos Bun independentes executam o caso de uso contra a mesma instância PostgreSQL; o teste verifica os resultados e compara o saldo final com o ledger.
- **SQS/LocalStack:** envio e consumo de mensagem, Inbox e redelivery sem repetir o débito; publicação da Outbox por dois publishers concorrentes; retry após falha de publicação.
- **Recuperação após commit:** um processo auxiliar recebe e processa a mensagem, confirma os efeitos no PostgreSQL e é encerrado com `SIGKILL` antes do ACK; a mensagem é então redeliverada ao consumer e os efeitos financeiros são conferidos para garantir que não sejam duplicados.
- **DLQ:** o consumer de produção recebe uma mensagem inválida e o redrive do SQS/LocalStack é verificado após exceder o limite de recebimentos.
- **HTTP/E2E:** smoke tests de liveness, readiness e validação de parâmetros das rotas principais, além do teste E2E da rota raiz.

Nos cenários de concorrência e recuperação adicionados, o saldo materializado é comparado com o saldo reconstruído a partir dos lançamentos do ledger.

### Limites da cobertura atual

- O teste de três processos inicia processos independentes que chamam diretamente `ProcessWagerTransaction`; não inicia três instâncias completas do NestJS.
- A simulação de crash executa o caso de uso e polling SQS em um processo Bun auxiliar; não inicia uma instância NestJS completa antes de encerrá-la à força.
- O teste de DLQ usa o consumer de produção com uma fila de teste dedicada, não a fila principal do ambiente.
- As provas de publisher concorrente cobrem duas instâncias do publisher no teste; não demonstram um deployment distribuído prolongado com falhas arbitrárias.

Assim, os testes existentes cobrem os principais invariantes e vários cenários obrigatórios do README, mas não equivalem a uma prova exaustiva de todas as combinações de falhas, três ou mais instâncias completas, reinicialização de deployment ou indisponibilidade prolongada dos serviços externos.

## 14. Conclusão

A arquitetura atual está bem alinhada com o problema proposto: ela aplica um desenho de backend financeiro com persistência forte, transações explícitas, idempotência no banco, fila assíncrona e Outbox para garantir recuperação.

A principal força do desenho é que ele protege a integridade financeira em vez de depender apenas de regras em memória. Isso é o que torna a solução robusta para um sistema distribuído e de alta exigência operacional.
