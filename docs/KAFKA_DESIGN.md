# Kafka Design

Kafka carries **everything that must happen after a message is durably stored but must never delay or fail the send**: notification inboxes, audit trail, analytics. The send path itself never talks to Kafka — it talks to PostgreSQL.

## Why an event stream at all

A user's `POST /messages` (or STOMP `SEND`) must return "persisted + ACKed" and nothing else. Every downstream concern — writing an @mention into a durable inbox, incrementing analytics, recording an audit row — is something that:

- may be slow (a cold notification store),
- may be down (consumer redeploy),
- may need to be replayed (bug in the consumer, new consumer added later).

Doing them synchronously would add their latency and their failure modes to the user's send. Doing them with fire-and-forget threads would lose them on a crash. An at-least-once log with independent consumer groups is the standard answer.

## Topics

| Topic | Key | Producers | Consumer groups | Partitions |
|---|---|---|---|---|
| `message-events` | room id / conversation id | chatroom, dm | `notifications`, `analytics` | 6 (12 in prod) |
| `presence-events` | user id | presence | `analytics` | 6 |
| `notification-events` | user id | any module requesting a notification | `notifications` | 6 |
| `audit-events` | actor id (or `anonymous`) | auth (and future: chatroom admin actions) | `audit` | 6 |
| `<topic>.DLT` | same | `DefaultErrorHandler` | operators | same as source |

Topics are declared in code (`KafkaInfrastructure.topics()`) so Testcontainers, Compose and MSK have identical layouts. Replication factor is left to the broker default (1 locally, 3 on MSK with `min.insync.replicas=2`, see `infrastructure/terraform`).

**Partition key = conversation.** All events for one room land on one partition, so a consumer sees them in order (a `MessageRead` never overtakes the `MessageSent` it refers to). Rooms are spread across partitions, which is where the parallelism comes from.

## Producer side: the transactional outbox

```
┌──────────────┐  same DB tx   ┌──────────────────────┐   after commit   ┌───────┐
│ messages row │ ───────────▶  │ event_publication row│ ───────────────▶ │ Kafka │
└──────────────┘               └──────────────────────┘                  └───────┘
```

Events are Java records annotated `@Externalized("message-events::#{#this.chatroomId()}")`. Spring Modulith writes each publication to the `event_publication` table **inside the producing transaction** and hands it to Kafka only after commit; the row is completed when the broker acknowledges (`acks=all`, idempotent producer). If the JVM dies between commit and publish, the row is still there and is republished on restart (`republish-outstanding-events-on-restart: true`).

Consequences:

- No dual-write problem — the event exists iff the message exists.
- No message is ever announced that the database did not store.
- Kafka being down does not fail a send; publications queue in Postgres.

Serialization: the Modulith serializer is bypassed (`serializeExternalization(false)`) so Spring Kafka's `JacksonJsonSerializer` is the single wire format. It stamps a `__TypeId__` header with the record class, which lets consumers get typed objects back.

## Consumer side

### Dispatch

Each consumer is one class annotated `@KafkaListener(groupId=…)` with `@KafkaHandler` methods per event type and an `isDefault` handler that ignores the rest of the shared topic:

```java
@KafkaHandler @Transactional
public void on(MessageSent e) { … }

@KafkaHandler(isDefault = true)
public void ignore(Object other) { }
```

### Exactly-once effects on an at-least-once log

Kafka redelivers on rebalance, on a crash between "side effect committed" and "offset committed", and on retry. Every consumer therefore runs

```java
if (!ledger.claim("notifications", e.eventId())) return;   // INSERT … ON CONFLICT DO NOTHING
notifications.save(…);
```

**inside one database transaction** (`processed_events(consumer, event_id)` primary key). If the transaction rolls back, the claim rolls back too and the retry proceeds normally; if it committed and the offset commit was lost, the redelivery's claim loses and the handler no-ops. `ProcessedEventLedger.claim` is `Propagation.MANDATORY` so a handler that forgets `@Transactional` fails loudly instead of duplicating silently. Ledger rows older than 7 days are swept hourly (Kafka retention bounds redelivery age).

The analytics consumer is deliberately **not** ledger-backed: a Prometheus counter is a statistic, and a DB write per message to make it exactly-once is the wrong trade. The drift is bounded by the retry policy and visible in `kafka_consumer_*` metrics.

### Offsets

`enable-auto-commit=false`, `ack-mode: record`: the container commits the offset after the handler returns without throwing. Combined with the ledger, this gives "each event's effect happens once".

### Failure policy

`DefaultErrorHandler` with `ExponentialBackOffWithMaxRetries(4)` — 0.5 s, 1 s, 2 s, 4 s — then `DeadLetterPublishingRecoverer` copies the record to `<topic>.DLT` (same partition, exception class/message/stack in headers) and **the partition moves on**. A poison record costs ~8 seconds, never a stuck consumer.

Not retried at all (straight to DLT): `ApiException` (business rejection), `IllegalArgumentException`, `JacksonException`, and `DeserializationException` (the `ErrorHandlingDeserializer` turns an undeserializable payload into a handled exception instead of a crash loop).

Operating the DLT: it is a normal topic. Inspect with `kcat -t message-events.DLT -C -f '%h\n%s\n'`; replay by producing the record back to the source topic once the bug is fixed — the ledger makes the replay safe for records that *had* been processed.

### Scaling consumers

`cipherchat.kafka.consumer-concurrency` (default 3) threads per instance per listener; total parallelism ≤ partitions. Adding an instance rebalances partitions across instances automatically. Consumers are stateless between records.

## What is *not* on Kafka

- **Real-time fan-out to WebSocket sessions** goes through Redis pub/sub (`ws:room:*`, `ws:dm:*`, `ws:user:*`). Kafka's consumer-group semantics are wrong for "every replica must see every event" (you'd need one group per replica) and its latency floor is higher. Kafka is for durable downstream work; Redis is for now.
- **Room-local UI events** (edit/delete/pin/react/typing) are in-JVM Spring events → Redis fan-out only; nothing downstream needs them durably.

## Local development

`docker compose up` starts a single-node KRaft broker (`apache/kafka:3.9.0`); host tools reach it on `localhost:29092`. Integration tests start their own via Testcontainers (`apache/kafka-native`). Nothing needs to be pre-created: topics come from `KafkaAdmin` at boot.

## Interview talking points

- Outbox pattern vs. dual writes; why "publish after commit" alone is not enough (crash window) and how the publication table closes it.
- Idempotent consumer with a ledger keyed by `(consumer, eventId)` — why the ledger write must share the side effect's transaction.
- Partition key choice: ordering *within* a conversation, parallelism *across* conversations.
- Retry vs. DLT: the retryable/non-retryable split and why a stuck partition is worse than a lost record you can replay.
- Where Kafka is the wrong tool (WS fan-out) and what was used instead.
