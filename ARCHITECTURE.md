
# Arquitetura — JG Backend Challenge

## 1. Objetivo

Este documento descreve a arquitetura, as decisões técnicas, as invariantes financeiras e as estratégias de consistência do JG Backend Challenge.

O sistema processa transações de apostas, mantém saldos de carteiras, registra um histórico financeiro auditável e integra processamento síncrono via HTTP com processamento assíncrono via Amazon SQS, utilizando PostgreSQL como fonte persistente de verdade.

O README principal é a especificação funcional e técnica de referência. Em caso de divergência, seus requisitos prevalecem sobre este documento.

## 2. Tecnologias

- **Bun:** execução de scripts, instalação de dependências e testes.
- **TypeScript:** tipagem estática e compilação em modo estrito.
- **NestJS:** composição da aplicação, injeção de dependências e ciclo de vida dos componentes.
- **PostgreSQL:** persistência transacional, constraints, índices e controle de concorrência.
- **TypeORM:** mapeamento das entidades, transações e migrations.
- **Amazon SQS:** transporte assíncrono de mensagens.
- **LocalStack:** implementação local dos serviços AWS necessários para desenvolvimento e integração.
- **Vitest:** testes unitários e de integração.

O PostgreSQL é a fonte de verdade para saldos, transações financeiras, ledger, Inbox e Outbox. A fila SQS não substitui as garantias de persistência e idempotência do banco de dados.

## 3. Organização em camadas

O projeto separa regras de negócio, casos de uso e detalhes de infraestrutura.

### Domain

Contém conceitos e regras que não devem depender de HTTP, SQS ou detalhes específicos do banco.

Responsabilidades:

- Representar valores monetários com precisão decimal.
- Modelar lançamentos financeiros e suas invariantes.
- Representar eventos e conceitos de integração.
- Impedir estados inválidos sempre que possível na própria modelagem.

### Application

Orquestra os casos de uso e define a sequência das operações.

Responsabilidades:

- Processar transações de apostas.
- Criar carteiras.
- Resolver transações pendentes de referência.
- Coordenar idempotência e persistência atômica dos efeitos financeiros.

O caso de uso de processamento de apostas é compartilhado pelos caminhos HTTP e SQS, evitando a duplicação das regras de negócio.

### Infrastructure

Implementa integrações e mecanismos operacionais.

Responsabilidades:

- Consumir mensagens SQS.
- Publicar eventos persistidos na Outbox.
- Adaptar componentes externos aos casos de uso.
- Implementar a comunicação com os serviços de infraestrutura.

### Database

Contém entidades persistentes, configurações de acesso ao PostgreSQL e migrations.

As migrations versionam as alterações estruturais do banco e devem possuir operações de reversão coerentes com a alteração realizada.

### Testes

Os testes unitários verificam regras e comportamentos isolados. Os testes de integração utilizam PostgreSQL e LocalStack para validar interações entre componentes reais.

A existência de um teste unitário não substitui a validação de concorrência e recuperação em ambiente de integração.

## 4. Fluxo de processamento financeiro

### 4.1 Entrada HTTP

1. A requisição é recebida pelo controller.
2. Os dados são validados.
3. O caso de uso processa a transação.
4. O PostgreSQL persiste a transação, os efeitos financeiros e os eventos de integração dentro da transação SQL apropriada.
5. A resposta HTTP é construída a partir do resultado persistido.

### 4.2 Entrada SQS

1. O consumidor recebe uma mensagem da fila `wager-transactions.fifo`.
2. O envelope e o conteúdo são validados.
3. O consumidor chama o mesmo caso de uso utilizado pelo caminho HTTP.
4. A Inbox participa da transação SQL que registra o processamento e seus efeitos.
5. A mensagem é excluída da fila somente após o processamento persistente bem-sucedido ou após a identificação de uma duplicata já concluída.
6. Se ocorrer uma falha transitória, a mensagem não é excluída e pode ser entregue novamente.

A exclusão da mensagem SQS não participa da transação PostgreSQL. Portanto, pode ocorrer uma falha entre o commit no banco e o ACK na fila. A Inbox persistente torna a redelivery segura quando o processamento já foi confirmado no banco.

## 5. Precisão monetária

Valores monetários devem manter precisão decimal exata.

A coluna `NUMERIC(20,2)` do PostgreSQL é utilizada para armazenar valores monetários. Como o driver pode devolver valores `NUMERIC` como strings, essa representação deve ser preservada até que uma operação decimal explícita seja realizada.

Regras:

- Não converter dinheiro para `number` para realizar cálculos financeiros.
- Não utilizar ponto flutuante binário como representação monetária.
- Validar valores, escala e sinais conforme a operação.
- Manter coerência entre o valor da transação, a alteração do saldo e o lançamento no ledger.

## 6. Carteiras e concorrência

Uma carteira é identificada pelo jogador e pela moeda, conforme a restrição de unicidade do banco.

As operações financeiras precisam permanecer corretas mesmo quando requisições concorrentes tentam modificar a mesma carteira.

As garantias devem ser apoiadas por mecanismos persistentes, como transações SQL, constraints e estratégias adequadas de bloqueio ou atualização atômica.

Não é suficiente ler o saldo, calcular um novo valor em memória e atualizá-lo sem proteção contra concorrência.

Invariantes:

- O saldo não pode ficar negativo.
- Uma transação concorrente não pode sobrescrever silenciosamente outra atualização.
- A idempotência não pode depender apenas da memória do processo.
- A solução deve continuar correta com múltiplas instâncias da aplicação.

## 7. Transações de apostas

As operações de negócio incluem `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.

| Operação | Efeito esperado no saldo | Ledger |
|---|---|---|
| `BET` | Débito, se houver saldo suficiente | Um débito |
| `WIN` | Crédito | Um crédito |
| `LOSS` | Nenhuma alteração | Nenhum lançamento |
| `REFUND` | Crédito da reversão válida | Um crédito |
| `ROLLBACK` | Efeito inverso da transação referenciada | Um lançamento correspondente |

As regras específicas de referência, elegibilidade e estado devem ser validadas pelo caso de uso.

Regras gerais:

- Uma transação financeira não pode produzir lançamentos duplicados.
- Uma reversão válida só pode ser efetivada uma vez.
- Referências inexistentes podem exigir processamento pendente e nova tentativa.
- Uma transação rejeitada não pode alterar o saldo nem produzir um lançamento financeiro indevido.
- Estados terminais não devem sofrer transições incompatíveis com as regras de negócio.

## 8. Ledger financeiro

O ledger é o registro auditável das alterações financeiras.

Cada lançamento deve permitir verificar o valor movimentado, o tipo de operação e os saldos anterior e posterior.

As invariantes incluem:

- Débito: `balance_after = balance_before - amount`.
- Crédito: `balance_after = balance_before + amount`.
- Os saldos não podem ficar negativos.
- Os lançamentos registrados não podem ser alterados ou excluídos por operações normais.
- O saldo da carteira deve ser reconciliável com o histórico financeiro.

O ledger não deve ser tratado como um log descartável. É parte da integridade financeira do sistema.

## 9. Idempotência

A idempotência protege contra reenvios HTTP, redelivery SQS e tentativas repetidas após falhas.

A garantia deve ser persistente e reforçada por constraints de unicidade e transações no banco.

A aplicação deve distinguir:

- Repetição da mesma operação com o mesmo conteúdo: retornar o resultado idempotente apropriado.
- Reutilização de uma chave com conteúdo diferente: rejeitar o conflito.
- Redelivery de uma mensagem já processada: não repetir os efeitos financeiros.
- Falha antes do commit: permitir uma nova tentativa segura.

A deduplicação SQS não substitui a Inbox. A fila pode entregar uma mensagem mais de uma vez, e a aplicação deve continuar correta nessas condições.

## 10. Inbox

A Inbox registra o processamento persistente de mensagens recebidas.

A identidade da mensagem é composta por `consumerName` e `messageId`. O hash do conteúdo permite detectar a reutilização do mesmo identificador com payload diferente.

O registro da Inbox e os efeitos financeiros devem ser confirmados na mesma transação SQL.

Consequências:

- Se a transação falhar, o registro e os efeitos daquela transação devem sofrer rollback.
- Se o commit ocorrer e a exclusão SQS falhar, a redelivery não deve repetir o efeito financeiro.
- Se um identificador persistido for reutilizado com conteúdo diferente, a mensagem deve ser tratada como conflito, não como duplicata legítima.

## 11. Outbox

A Outbox desacopla a confirmação financeira da publicação de eventos externos.

Os eventos são persistidos no PostgreSQL dentro da mesma transação que confirma as alterações de negócio correspondentes.

Um publisher consulta os eventos pendentes e tenta publicá-los no SQS.

O registro de publicação é atualizado após a confirmação de envio. Em caso de falha, o evento permanece recuperável e pode receber nova tentativa, com controle de tentativas e agendamento.

### Garantias e trade-offs

- O evento não deve ser publicado antes do commit da operação financeira.
- Uma falha após o commit e antes da publicação não deve perder o evento persistido.
- Uma falha após o envio e antes da atualização de `published_at` pode causar publicação duplicada.
- Consumidores de eventos devem tolerar duplicatas.
- Publishers concorrentes precisam de uma estratégia de reivindicação de registros que evite conflitos e preserve a recuperação após falhas.

A Outbox fornece publicação recuperável, não entrega externa exatamente uma vez.

## 12. SQS, retry e DLQ

O ambiente de integração configura:

- Fila principal: `wager-transactions.fifo`.
- Fila de mensagens mortas: `wager-transactions-dlq.fifo`.
- Fila de eventos publicados pela Outbox: `wager-transaction-events.fifo`.

A fila principal utiliza uma política de redrive para a DLQ, configurada com limite de recebimentos.

### Classificação de falhas

**Sucesso ou duplicata concluída:** a mensagem pode ser excluída após a confirmação do resultado persistente.

**Falha transitória:** a mensagem não é excluída; pode ser entregue novamente quando a visibilidade expirar.

**Erro terminal de negócio:** quando identificado como definitivo pelo processamento, a mensagem é tratada sem repetir indefinidamente o mesmo erro.

**Mensagem inválida:** uma mensagem que não pode ser processada não deve ser confirmada como sucesso. A política de redrive pode encaminhá-la à DLQ após as tentativas configuradas.

### Encerramento gracioso

O consumidor deve interromper o polling ao receber o sinal de encerramento e aguardar o término do ciclo em andamento.

Mensagens recebidas, mas ainda não processadas, devem ser devolvidas à fila quando possível. Caso isso falhe, a expiração da visibilidade permite nova entrega.

O encerramento gracioso não elimina a necessidade de Inbox: uma interrupção pode ocorrer em qualquer ponto entre o commit SQL e o ACK SQS.

## 13. Migrations e integridade do banco

As alterações de schema devem ser versionadas por migrations do TypeORM.

Constraints e índices devem proteger, quando aplicável:

- Unicidade das chaves de idempotência.
- Unicidade de transações externas por provedor.
- Integridade dos valores e snapshots do ledger.
- Imutabilidade dos lançamentos financeiros.
- Unicidade do processamento de mensagens na Inbox.
- Consulta eficiente de registros pendentes da Outbox.

Migrations devem ser revisadas quanto à compatibilidade com dados existentes. Uma reversão não deve ser considerada segura quando puder destruir dados que não podem ser reconstruídos.

## 14. Configuração operacional

As variáveis relevantes incluem:

- `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`: conexão PostgreSQL.
- `SQS_ENDPOINT`: endpoint SQS.
- `SQS_QUEUE_URL`: fila de entrada.
- `SQS_OUTBOX_QUEUE_URL`: fila de eventos da Outbox.
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: configuração do cliente AWS.
- `SQS_CONSUMER_ENABLED`: habilita ou desabilita o consumidor.
- `OUTBOX_PUBLISHER_ENABLED`: habilita ou desabilita o publisher.

Os consumidores e publishers devem permanecer desabilitados por padrão quando a execução não deve iniciar processamento em background.

Credenciais reais e arquivos `.env` locais não devem ser versionados. `.env.example` deve conter apenas valores ilustrativos e configurações não secretas.

## 15. Testes e critérios de validação

Os testes unitários devem cobrir regras de negócio, validação de mensagens, idempotência e classificação de falhas.

Os testes de integração devem utilizar PostgreSQL e LocalStack para verificar os efeitos persistentes e os limites transacionais.

Cenários importantes exigidos pelo desafio:

- A mesma aposta enviada repetidamente em paralelo produz um único efeito financeiro.
- Operações concorrentes não provocam saldo negativo nem perda de atualização.
- Instâncias independentes mantêm a consistência.
- Uma mensagem reenviada após o commit não repete o efeito financeiro.
- Publishers concorrentes não perdem eventos.
- Falhas após o commit são recuperáveis.
- Transações de reversão recebidas antes da referência são tratadas corretamente.
- Após reinício, o saldo pode ser reconciliado com o ledger.

A execução bem-sucedida de uma suíte não comprova automaticamente todos esses cenários. A cobertura deve ser verificada pelos casos de teste existentes e pelos resultados de execução.

## 16. Limitações e evolução

Antes de considerar a implementação concluída, devem ser avaliados explicitamente:

- Testes de integração do consumidor com LocalStack, incluindo redelivery e encaminhamento para DLQ.
- Concorrência entre múltiplas instâncias reais do publisher e do consumidor.
- Recuperação após interrupção entre commit e ACK ou publicação e confirmação.
- Reconciliação do saldo das carteiras com o ledger.
- Observabilidade de tentativas, falhas, mensagens pendentes e atraso da Outbox.
- Cobertura de todos os cenários de concorrência e recuperação exigidos pelo README.

Não se deve inferir uma garantia operacional apenas porque o componente está registrado no NestJS ou porque testes unitários passaram.

## 17. Princípios arquiteturais

1. PostgreSQL é a fonte de verdade financeira.
2. Valores monetários mantêm precisão decimal.
3. A integridade financeira é protegida no banco e na aplicação.
4. Inbox e Outbox são persistentes e participam das transações SQL apropriadas.
5. SQS oferece transporte assíncrono, mas não substitui idempotência persistente.
6. A aplicação deve continuar correta com redelivery, concorrência e reinício.
7. Falhas devem ser recuperáveis e observáveis.
8. Testes e documentação devem refletir o comportamento efetivamente implementado.
