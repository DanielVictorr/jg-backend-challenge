# JG Backend Challenge

API de processamento distribuído de transações de apostas, construída com NestJS, TypeScript, Bun, PostgreSQL e AWS SQS. O projeto prioriza consistência financeira, idempotência persistente, concorrência segura por carteira e recuperação após falhas.

> Este arquivo documenta o estado atual do repositório. Consulte também o [README.md](./README.md) para o enunciado original do desafio e o [ARCHITECTURE.md](./ARCHITECTURE.md) para decisões, trade-offs e limitações arquiteturais.

## Conteúdo

- [Capacidades](#capacidades)
- [Tecnologias](#tecnologias)
- [Arquitetura resumida](#arquitetura-resumida)
- [Requisitos locais](#requisitos-locais)
- [Configuração](#configuração)
- [Executar localmente](#executar-localmente)
- [Migrations](#migrations)
- [API HTTP](#api-http)
- [Processamento SQS](#processamento-sqs)
- [Testes e qualidade](#testes-e-qualidade)
- [Observabilidade e health checks](#observabilidade-e-health-checks)
- [Autenticação e segurança](#autenticação-e-segurança)
- [Limitações conhecidas](#limitações-conhecidas)

## Capacidades

- Criação e consulta de carteiras e consulta paginada do ledger.
- Processamento de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- Valores monetários tratados como strings decimais no contrato HTTP e com `Decimal` no domínio; PostgreSQL persiste valores em `NUMERIC(20,2)`.
- Idempotência baseada em chave e hash do payload, persistida no PostgreSQL.
- Serialização de operações sobre a mesma carteira com lock de linha PostgreSQL.
- Inbox persistente para deduplicação de mensagens recebidas do SQS.
- Outbox transacional para publicar eventos somente após os efeitos financeiros serem confirmados no banco.
- Retry de referências ainda não recebidas e redrive da fila de entrada para DLQ, conforme a política configurada no LocalStack.
- Reconciliação entre o saldo persistido e o saldo reconstruído a partir do ledger.

## Tecnologias

| Área | Tecnologia |
|---|---|
| Runtime e package manager | Bun 1.x |
| Linguagem e framework | TypeScript estrito, NestJS |
| Persistência | PostgreSQL e TypeORM |
| Mensageria | AWS SQS, com LocalStack no ambiente local de integração |
| Testes | Vitest |
| Lint | Oxlint |
| Migrações | TypeORM migrations versionadas |

## Arquitetura resumida

O processo NestJS reúne os adaptadores HTTP, o consumidor SQS, o publisher da Outbox e o worker de referências pendentes. Os controllers validam e encaminham chamadas aos casos de uso; o domínio contém as regras de carteira, dinheiro, transações e ledger; PostgreSQL é a fonte persistente de verdade.

O processamento financeiro ocorre em uma transação do PostgreSQL. O lock `SELECT ... FOR UPDATE` na carteira protege atualizações concorrentes do saldo. Quando aplicável, transação, carteira, ledger, Inbox e eventos de Outbox são persistidos atomicamente. O publisher envia os eventos à fila de saída depois do commit; como SQS e PostgreSQL não participam de uma transação distribuída, consumidores precisam tolerar entrega repetida.

```text
HTTP ───────────────┐
                    ├── casos de uso ── PostgreSQL
SQS de entrada ─────┘                    ├── carteiras e transações
                                         ├── ledger e Inbox
                                         └── Outbox ── publisher ── SQS de eventos
```

## Requisitos locais

- Bun 1.x.
- Docker com Docker Compose.
- Acesso às portas locais `55432` (PostgreSQL de integração) e `4566` (LocalStack).

O único compose incluído é `compose.integration.yml`: ele sobe dependências destinadas às suítes de integração, não um ambiente completo de produção. O script `.integration/localstack/init/01-create-queues.sh` cria as filas FIFO de entrada, DLQ e saída.

## Configuração

Crie o arquivo local de variáveis:

```powershell
Copy-Item .env.example .env
```

Configure pelo menos `DB_PASSWORD` com um valor local não vazio. Para usar os serviços do compose de integração, configure no `.env`:

```dotenv
DB_HOST=127.0.0.1
DB_PORT=55432
DB_USERNAME=postgres
DB_PASSWORD=defina-uma-senha-local
DB_DATABASE=jg_backend_integration

SQS_ENDPOINT=http://localhost:4566
SQS_QUEUE_URL=http://localhost:4566/000000000000/wager-transactions.fifo
SQS_OUTBOX_QUEUE_URL=http://localhost:4566/000000000000/wager-transaction-events.fifo
SQS_VISIBILITY_TIMEOUT_SECONDS=60
SQS_CONSUMER_ENABLED=true
OUTBOX_PUBLISHER_ENABLED=true
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

O valor de `DB_PASSWORD` precisa ser o mesmo usado pelo PostgreSQL iniciado pelo Compose. As credenciais AWS acima são valores locais para o LocalStack; use credenciais apropriadas fora desse ambiente.

`OBSERVE_APP_KEY` e `OBSERVE_APP_SECRET` são opcionais. Quando ambos estão definidos com credenciais válidas do serviço de observabilidade, o módulo é carregado e as métricas instrumentadas são emitidas; sem eles, as métricas não ficam disponíveis. Os logs estruturados continuam disponíveis sem essas credenciais.

## Executar localmente

Na raiz do repositório:

```powershell
bun install --frozen-lockfile
docker compose -f compose.integration.yml up -d
bun run build
bun run migration:run
bun run start:dev
```

O servidor escuta na porta `3000` por padrão; defina `PORT` para usar outra porta. Com o `.env` acima, a aplicação compartilha o banco de integração do Compose. Para desenvolvimento persistente ou dados não descartáveis, use um banco local separado e ajuste as variáveis de conexão.

Com o servidor em execução:

```powershell
Invoke-RestMethod http://localhost:3000/health/live
Invoke-RestMethod http://localhost:3000/health/ready
```

Para iniciar a aplicação compilada:

```powershell
bun run build
bun run start:prod
```

Para parar os containers locais:

```powershell
docker compose -f compose.integration.yml down
```

O comando acima para os serviços sem remover o volume persistente do PostgreSQL.

## Migrations

O TypeORM está configurado com `synchronize=false` e `migrationsRun=false`: a aplicação não altera automaticamente o schema ao iniciar. Compile antes de executar as migrations, pois os comandos apontam para os arquivos JavaScript em `dist/database/migrations`.

```powershell
bun run build
bun run migration:show
bun run migration:run
```

Para reverter a migration mais recente:

```powershell
bun run migration:revert
```

As migrations implementam o schema, constraints, índices, imutabilidade do ledger, regras de reversão e metadados de retry/Inbox. Execute migrations apenas contra o banco configurado em `DB_DATABASE`.

## API HTTP

O servidor não usa prefixo global de API.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/` | Rota básica da aplicação |
| `GET` | `/health/live` | Verifica se o processo está respondendo |
| `GET` | `/health/ready` | Verifica a conectividade com PostgreSQL e SQS |
| `POST` | `/wallets` | Cria uma carteira |
| `GET` | `/wallets/:walletId` | Consulta uma carteira |
| `GET` | `/wallets/:walletId/ledger?cursor=...&limit=50` | Consulta o ledger com paginação por cursor |
| `POST` | `/wallets/:walletId/reconciliation` | Compara saldo persistido e saldo do ledger |
| `POST` | `/wagering/transactions` | Processa uma transação; exige `Idempotency-Key` |
| `GET` | `/wagering/transactions/:transactionId` | Consulta uma transação pelo ID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por identificador externo do provedor |

### Criar carteira

```http
POST /wallets
Content-Type: application/json
```

```json
{
  "playerId": "player-123",
  "initialBalance": {
    "amount": "1000.00",
    "currency": "BRL"
  }
}
```

Quando o saldo inicial é positivo, a criação também grava uma transação interna `OPENING` e o crédito correspondente no ledger na mesma transação SQL. Não é permitido enviar `OPENING` pelo endpoint de apostas.

### Processar uma aposta

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
Content-Type: application/json
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "player-123",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  }
}
```

O valor deve ser enviado como string decimal com duas casas. Uma repetição equivalente da chave e do conteúdo reutiliza o resultado persistido; reutilizar a mesma chave com conteúdo diferente resulta em conflito. `REFUND` e `ROLLBACK` também recebem `referenceExternalTransactionId`.

Os códigos HTTP distinguem erros de validação, conflitos e outros erros definidos pelos casos de uso. Consulte o `code` e a mensagem do corpo de erro, além do status HTTP.

### Reconciliação

```http
POST /wallets/0192f291-27dd-7d3f-8071-5f8685deef37/reconciliation
```

A resposta informa saldo persistido, saldo calculado pelo ledger, diferença, indicador de consistência e quantidade de lançamentos examinados. Uma divergência é reportada; o saldo não é corrigido automaticamente.

## Processamento SQS

O consumidor de entrada inicia polling quando `SQS_CONSUMER_ENABLED=true` e `SQS_QUEUE_URL` está configurada. Ele valida o envelope `WagerTransactionRequested` e reutiliza o caso de uso HTTP para processar a transação. A chave `(consumerName, messageId)` e o hash do conteúdo são guardados na Inbox, dentro da transação financeira.

A mensagem só é removida após o processamento confirmado. Falhas transitórias ficam disponíveis para redelivery após o timeout de visibilidade; erros terminais de negócio são reconhecidos. Mensagens inválidas são deixadas para novas tentativas e podem ser encaminhadas à DLQ pela política do SQS.

O publisher da Outbox inicia por padrão e pode ser desativado com `OUTBOX_PUBLISHER_ENABLED=false`. Eventos são publicados na fila indicada por `SQS_OUTBOX_QUEUE_URL`, com retries e backoff persistidos no PostgreSQL. A confirmação de publicação pode ser repetida em caso de falha entre o envio ao SQS e a gravação do estado publicado no banco.

## Testes e qualidade

Os comandos principais definidos no projeto são:

```powershell
bun run test
bun run test:e2e
bun run test:integration
bun run lint
bun run build
```

- `test`: testes unitários Vitest em `src`.
- `test:e2e`: testes E2E.
- `test:integration`: testes de integração em PostgreSQL e LocalStack reais; exige os serviços locais e migrations aplicadas.
- `lint`: Oxlint com análise de tipos.
- `build`: compilação NestJS.

Para rodar as suítes E2E e de integração com os containers do projeto:

```powershell
docker compose -f compose.integration.yml up -d
bun run build
bun run migration:run
$env:SQS_CONSUMER_ENABLED = "false"
$env:OUTBOX_PUBLISHER_ENABLED = "false"
bun run test:e2e
bun run test:integration
```

Os toggles desligam os workers de background iniciados pelo módulo NestJS durante os testes; os cenários de integração SQS iniciam o consumer explicitamente quando necessário. Use o banco dedicado `jg_backend_integration` na porta `55432` para os testes. Não aponte suítes de integração para um banco com dados que precise preservar. Algumas suítes necessitam de acesso ao SQS local e validam as filas configuradas pelo script de inicialização do LocalStack.

## Observabilidade e health checks

- `/health/live` responde se o processo está ativo; não verifica dependências.
- `/health/ready` verifica PostgreSQL e a fila SQS de entrada configurada.
- Métricas opcionais incluem transações por status, duplicatas, replay idempotente, conflitos de lock, duração do processamento, retries e lag da Outbox.
- Logs JSON de consumer, publisher, reconciliação e readiness incluem contexto operacional disponível sem registrar o payload financeiro.
- Para emitir métricas, configure credenciais válidas `OBSERVE_APP_KEY` e `OBSERVE_APP_SECRET`; variáveis vazias no `.env.example` não habilitam métricas.

## Autenticação e segurança

A aplicação ainda não valida tokens nem integra um Identity Provider. Um `ProviderAuthenticationGuard` está aplicado às rotas HTTP que não são de health como ponto explícito de extensão, mas atualmente permite todas as requisições. Substitua seu comportamento por validação OIDC/JWT e autorização do provedor antes de expor a API publicamente. Os endpoints de health permanecem sem esse guard.

Mensagens SQS são tratadas como canal interno, conforme o escopo do desafio. Em ambiente real, proteja as filas com IAM e configure as permissões e credenciais AWS fora do código e do repositório.

## Limitações conhecidas

- API HTTP, consumidor SQS, publisher da Outbox e worker de referências pendentes são inicializados no mesmo processo NestJS.
- Os testes de três processos concorrentes executam o caso de uso em processos Bun separados, mas não inicializam três instâncias NestJS completas.
- O cenário de recuperação após commit encerra um processo Bun com `SIGKILL` antes do ACK e valida redelivery pelo consumer.
- O teste de DLQ usa o consumer de produção contra uma fila de teste no LocalStack e valida o redrive de uma mensagem inválida.
- Publicadores concorrentes são testados em integração, mas o envio SQS ocorre enquanto a transação e os locks das linhas da Outbox estão abertos.
- A documentação não afirma entrega externa exatamente uma vez: Outbox/SQS fornece recuperação com possibilidade de duplicatas.

Para decisões técnicas e descrição detalhada dos fluxos, consulte [ARCHITECTURE.md](./ARCHITECTURE.md). Para os critérios completos do desafio e a avaliação, consulte [README.md](./README.md).
