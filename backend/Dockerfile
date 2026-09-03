# syntax=docker/dockerfile:1.7
# ── Stage 1: build ──────────────────────────────────────────────────────────
# Dependencies are resolved in their own layer so a source-only change does
# not re-download the world. Tests run in CI, not in the image build.
FROM eclipse-temurin:21-jdk-alpine AS build
WORKDIR /workspace
COPY mvnw pom.xml ./
RUN chmod +x mvnw
COPY .mvn .mvn
RUN --mount=type=cache,target=/root/.m2 ./mvnw -q -B dependency:go-offline
COPY src src
# Release builds pass the git tag (release.yml → APP_VERSION) so the jar and /actuator/info carry it;
# local and CI-on-main builds leave it empty and keep the pom's SNAPSHOT version.
ARG APP_VERSION=
RUN --mount=type=cache,target=/root/.m2 \
    if [ -n "$APP_VERSION" ]; then ./mvnw -q -B versions:set -DnewVersion="$APP_VERSION" -DgenerateBackupPoms=false; fi \
 && ./mvnw -q -B -DskipTests package \
 && java -Djarmode=tools -jar target/*.jar extract --layers --launcher --destination extracted

# ── Stage 2: runtime ────────────────────────────────────────────────────────
# JRE only, non-root, layered jar (dependencies / spring-boot-loader /
# snapshot-dependencies / application) so a redeploy pushes only the app layer.
FROM eclipse-temurin:21-jre-alpine AS runtime
# apk upgrade pulls OS security fixes published after the base image was built (OpenSSL et al.).
RUN apk upgrade --no-cache \
 && addgroup -S cipherchat && adduser -S -G cipherchat cipherchat \
 && apk add --no-cache curl \
 && mkdir -p /data/uploads && chown -R cipherchat:cipherchat /data
WORKDIR /app
COPY --from=build --chown=cipherchat:cipherchat /workspace/extracted/dependencies/ ./
COPY --from=build --chown=cipherchat:cipherchat /workspace/extracted/spring-boot-loader/ ./
COPY --from=build --chown=cipherchat:cipherchat /workspace/extracted/snapshot-dependencies/ ./
COPY --from=build --chown=cipherchat:cipherchat /workspace/extracted/application/ ./
USER cipherchat
ARG APP_VERSION=
LABEL org.opencontainers.image.title="cipherchat-backend" \
      org.opencontainers.image.description="CipherChat Messenger — Spring Boot backend" \
      org.opencontainers.image.source="https://github.com/simran1002/CipherChat_Messenger" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV PORT=8080 \
    UPLOAD_DIR=/data/uploads \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+UseZGC -XX:+ZGenerational -Duser.timezone=UTC -Djava.security.egd=file:/dev/./urandom"
EXPOSE 8080
# Liveness only; readiness (DB/Redis/Kafka) is /actuator/health/readiness, checked by the orchestrator.
HEALTHCHECK --interval=15s --timeout=3s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/actuator/health/liveness || exit 1
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
