package com.cipherchat;

import org.slf4j.LoggerFactory;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.output.Slf4jLogConsumer;
import org.testcontainers.kafka.KafkaContainer;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@TestConfiguration(proxyBeanMethods = false)
class TestcontainersConfiguration {

	@Bean
	@ServiceConnection
	// Pinned by digest: the JVM apache/kafka image trips Testcontainers' listener setup (advertised.listeners 0.0.0.0);
	// this kafka-native build is the one verified to start under Testcontainers 2.x on Docker Desktop.
	// Native-image Kafka occasionally exits during KRaft recovery on shared CI runners; retry the start
	// and stream the container's own output so a failure explains itself in the job log.
	KafkaContainer kafkaContainer() {
		return new KafkaContainer(DockerImageName.parse("apache/kafka-native@sha256:2885898ba17065023f1bd605f3a81efcfa986014f062b73b91ef5462485f9060"))
				.withStartupAttempts(3)
				.withLogConsumer(new Slf4jLogConsumer(LoggerFactory.getLogger("testcontainers.kafka")));
	}

	@Bean
	@ServiceConnection
	PostgreSQLContainer postgresContainer() {
		return new PostgreSQLContainer(DockerImageName.parse("postgres:17-alpine"));
	}

	@Bean
	@ServiceConnection(name = "redis")
	GenericContainer<?> redisContainer() {
		return new GenericContainer<>(DockerImageName.parse("redis:7-alpine")).withExposedPorts(6379);
	}

}
