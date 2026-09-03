package com.cipherchat;

import org.junit.jupiter.api.Test;
import org.springframework.modulith.core.ApplicationModules;
import org.springframework.modulith.docs.Documenter;

/**
 * The module boundaries are a compile-time promise enforced at test time:
 * a dependency that violates {@code @ApplicationModule(allowedDependencies)}
 * or reaches into another module's internals fails the build. The second
 * test regenerates the C4/PlantUML module diagrams under
 * {@code target/spring-modulith-docs} so the architecture docs never drift.
 */
class ModularityTests {

    static final ApplicationModules modules = ApplicationModules.of(CipherchatApplication.class);

    @Test
    void moduleBoundariesAreRespected() {
        modules.verify();
    }

    @Test
    void writeDocumentation() {
        new Documenter(modules).writeDocumentation();
    }
}
