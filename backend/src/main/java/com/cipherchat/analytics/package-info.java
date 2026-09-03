/**
 * Analytics module — content-free operational metrics. Consumes the event
 * stream into Micrometer counters (scraped by Prometheus) and serves the
 * admin overview from aggregate SQL. Never reads message bodies.
 */
@org.springframework.modulith.ApplicationModule(displayName = "Analytics")
package com.cipherchat.analytics;
