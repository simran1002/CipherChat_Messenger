#!/usr/bin/env bash
# End-to-end runtime verification of CipherChat on one machine with Docker.
#
#   bash scripts/verify-all.sh            # writes docs/VERIFICATION-RUN.md and exits non-zero on any failure
#
# Phases (each records PASS/FAIL into the report):
#   1. build both images from an empty cache and start the single-instance stack; wait for health
#   2. contract + chaos checks   (scripts/verify-stack.py --chaos: auth, exactly-once, 403s, E2EE replay,
#                                 Kafka notification, Redis paused, Kafka stopped/restarted)
#   3. database checks           (constraints, indexes, EXPLAIN ANALYZE of the hot queries)
#   4. observability checks      (readiness/liveness, Prometheus series, X-Request-Id echo, JSON logs)
#   5. load test                 (load/k6-stomp.js — REST + STOMP ACK/broadcast latency)
#   6. scale-out                 (nginx least_conn → 2 replicas; scripts/verify-fanout.py; kill-a-pod)
#   7. image vulnerability scan  (Trivy on the built backend image, HIGH/CRITICAL, fixed only)
# Requires: docker (Compose v2), python3 with websocket-client, curl. Needs ~6 GB free in the Docker VM.
set -uo pipefail
cd "$(dirname "$0")/.."
REPORT=docs/VERIFICATION-RUN.md
BASE=${BASE_URL:-http://localhost:8080}
HOST_BASE=${HOST_BASE_URL:-http://host.docker.internal:8080}   # what containers use to reach the LB/backend
fail=0
: > "$REPORT"
say() { echo "$*" | tee -a "$REPORT"; }
result() { if [ "$2" -eq 0 ]; then say "- PASS  $1"; else say "- FAIL  $1"; fail=1; fi; }

say "# Verification run — $(date -u +%Y-%m-%dT%H:%MZ)"
say ""
say "Host: $(uname -srm 2>/dev/null); Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null); $(docker info --format 'CPUs={{.NCPU}} MemBytes={{.MemTotal}}' 2>/dev/null)"
say ""

say "## 1. Build and start"
docker compose down -v --remove-orphans >/dev/null 2>&1
docker compose build --no-cache > /tmp/vr-build.log 2>&1; result "images build from an empty cache" $?
docker compose up -d > /tmp/vr-up.log 2>&1; result "stack starts" $?
healthy=1
for i in $(seq 1 60); do
  s=$(docker compose ps --format '{{.Service}}={{.Health}}' 2>/dev/null | tr '\n' ' ')
  if echo "$s" | grep -q "backend=healthy" && echo "$s" | grep -q "postgres=healthy" && echo "$s" | grep -q "redis=healthy" && echo "$s" | grep -q "kafka=healthy"; then healthy=0; break; fi
  sleep 5
done
result "postgres, redis, kafka, backend healthy within 5 min ($s)" $healthy
say "\`\`\`"; docker compose ps --format '{{.Service}} {{.Status}}' | tee -a "$REPORT"; say "\`\`\`"
say ""

say "## 2. Contract and chaos drills (scripts/verify-stack.py --chaos)"
say "\`\`\`"
BASE_URL=$BASE python scripts/verify-stack.py --chaos 2>&1 | tee -a "$REPORT"; rc=${PIPESTATUS[0]}
say "\`\`\`"
result "verify-stack.py --chaos" $rc
say ""

say "## 3. Database: constraints, indexes, query plans"
say "\`\`\`"
docker compose exec -T postgres psql -U cipherchat -d cipherchat -v ON_ERROR_STOP=1 <<'SQL' 2>&1 | tee -a "$REPORT"; rc=${PIPESTATUS[0]}
\pset pager off
\echo === Flyway history
select installed_rank, version, description, success from flyway_schema_history order by installed_rank;
\echo === Unique indexes / constraints that carry the guarantees
select tablename, indexname from pg_indexes where schemaname='public' and indexdef ilike 'create unique%' order by 1,2;
\echo === Foreign keys
select conrelid::regclass, conname from pg_constraint where contype='f' and connamespace='public'::regnamespace order by 1,2;
\echo === CHECK constraints
select conrelid::regclass, conname, pg_get_constraintdef(oid) from pg_constraint where contype='c' and connamespace='public'::regnamespace order by 1,2;
\echo === Row counts
select 'messages' t, count(*) from messages union all select 'dm_messages', count(*) from dm_messages
 union all select 'event_publication(incomplete)', count(*) from event_publication where completion_date is null
 union all select 'processed_events', count(*) from processed_events union all select 'notifications', count(*) from notifications
 union all select 'audit_logs', count(*) from audit_logs;
\echo === EXPLAIN room history page
explain (analyze, buffers, costs off) select * from messages where chatroom_id = (select chatroom_id from messages order by id desc limit 1) and sequence_number < 1000000 order by sequence_number desc limit 51;
\echo === EXPLAIN unread count (grouped, joined to watermark)
explain (analyze, buffers, costs off) select m.chatroom_id, count(*) from messages m left join room_read_state r on r.chatroom_id = m.chatroom_id and r.user_id = (select sender_id from messages limit 1) where m.chatroom_id in (select chatroom_id from messages) and m.sender_id <> (select sender_id from messages limit 1) and m.sequence_number > coalesce(r.last_read_sequence, 0) group by m.chatroom_id;
\echo === EXPLAIN conversation lookup
explain (analyze, buffers, costs off) select * from conversations where user_low = (select user_low from conversations limit 1) and user_high = (select user_high from conversations limit 1);
\echo === EXPLAIN latest message per conversation
explain (analyze, buffers, costs off) select distinct on (conversation_id) * from dm_messages where conversation_id in (select id from conversations limit 50) order by conversation_id, id desc;
\echo === EXPLAIN full-text search
explain (analyze, buffers, costs off) select id from messages where chatroom_id = (select chatroom_id from messages order by id desc limit 1) and to_tsvector('english', body) @@ plainto_tsquery('english', 'hello') order by created_at desc limit 50;
\echo === EXPLAIN dedup lookup by client id
explain (analyze, buffers, costs off) select id from messages where client_message_id = '00000000-0000-0000-0000-000000000000'::uuid;
\echo === EXPLAIN E2EE replay probe
explain (analyze, buffers, costs off) select id from dm_messages where conversation_id = (select id from conversations limit 1) and sender_id = (select user_low from conversations limit 1) and (envelope->>'sessionId') = 'x' and ((envelope->>'ctr')::bigint) = 0;
SQL
say "\`\`\`"
result "schema and query-plan report produced" $rc
say ""

say "## 4. Observability"
rid="verify-$(date +%s)"
hdr=$(curl -s -m 10 -D - -o /dev/null -H "X-Request-Id: $rid" "$BASE/actuator/health/liveness")
echo "$hdr" | grep -qi "x-request-id: $rid"; result "X-Request-Id is echoed on responses" $?
sleep 1
docker compose logs --no-log-prefix backend 2>/dev/null | grep -q "$rid"; result "the same request id appears in the backend log" $?
docker compose logs --no-log-prefix backend 2>/dev/null | tail -200 | grep -qE '^\{.*"@timestamp"|^\{.*"log.level"|^\{'; if [ $? -eq 0 ]; then say "- INFO  backend logs are JSON (LOG_FORMAT set)"; else say "- INFO  backend logs are plain text (set LOG_FORMAT=ecs for JSON; this is the documented default for local runs)"; fi
prom=$(curl -s -m 10 "$BASE/actuator/prometheus")
for m in http_server_requests_seconds cipherchat_send_latency_seconds cipherchat_ws_sessions cipherchat_send_accepted_total hikaricp_connections_active kafka_consumer_ lettuce_command_completion; do
  echo "$prom" | grep -q "$m"; result "Prometheus exposes $m" $?
done
say ""

say "## 5. Load (k6, 60 s, 30 chat VUs + 5 REST VUs)"
say "\`\`\`"
docker run --rm -i -e BASE_URL="$HOST_BASE" -e VUS=${VUS:-30} -e ROOMS=${ROOMS:-5} -e MSGS_PER_VU=${MSGS_PER_VU:-20} -e DURATION=${DURATION:-60s} grafana/k6 run - < load/k6-stomp.js 2>&1 | tee /tmp/vr-k6.log | grep -E "stomp_ack_ms|stomp_broadcast_ms|rest_ms|messages_sent|messages_acked|duplicate_acks|errors|checks|✓|✗|threshold" | tee -a "$REPORT"; rc=${PIPESTATUS[0]}
say "\`\`\`"
result "k6 thresholds (ack p95<500 ms, broadcast p95<750 ms, rest p95<400 ms, errors<1 %)" $rc
say ""

say "## 6. Scale-out: nginx least_conn → 2 replicas, cross-replica fan-out, kill a replica"
docker compose down > /dev/null 2>&1
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --scale backend=2 > /tmp/vr-scale.log 2>&1; result "scale-out profile starts" $?
ok=1
for i in $(seq 1 60); do
  n=$(docker compose -f docker-compose.yml -f docker-compose.scale.yml ps --format '{{.Service}}={{.Health}}' 2>/dev/null | grep -c "backend=healthy")
  l=$(docker compose -f docker-compose.yml -f docker-compose.scale.yml ps --format '{{.Service}}={{.Health}}' 2>/dev/null | grep -c "lb=healthy")
  if [ "$n" -ge 2 ] && [ "$l" -ge 1 ]; then ok=0; break; fi; sleep 5
done
result "two backend replicas and the LB healthy" $ok
say "\`\`\`"
BASE_URL=$BASE python scripts/verify-fanout.py 2>&1 | tee -a "$REPORT"; rc=${PIPESTATUS[0]}
say "\`\`\`"
result "verify-fanout.py (ACK + cross-replica broadcast, duplicate absorbed, outsider refused)" $rc
victim=$(docker compose -f docker-compose.yml -f docker-compose.scale.yml ps --format '{{.Name}}' backend | head -1)
docker kill "$victim" > /dev/null 2>&1; result "killed replica $victim" $?
sleep 3
st=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/auth/register" -H 'Content-Type: application/json' -d "{\"name\":\"After Kill\",\"email\":\"afterkill-$RANDOM-$RANDOM@stack.test\",\"password\":\"correct horse battery staple\"}")
[ "$st" = "201" ]; result "the LB keeps serving from the surviving replica (register → $st)" $?
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --scale backend=2 > /dev/null 2>&1
say ""

say "## 7. Image vulnerability scan (Trivy, HIGH/CRITICAL, fixed only)"
say "\`\`\`"
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache/trivy aquasec/trivy:latest image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --format table cipherchat-backend:latest 2>&1 | grep -E "Total:|Library|│ [a-zA-Z0-9.@:/_-]+ +│ CVE" | tee -a "$REPORT"
say "\`\`\`"
say ""

docker compose -f docker-compose.yml -f docker-compose.scale.yml down > /dev/null 2>&1
if [ $fail -eq 0 ]; then say "**Overall: all phases passed.**"; else say "**Overall: at least one phase FAILED — see the lines above.**"; fi
exit $fail
