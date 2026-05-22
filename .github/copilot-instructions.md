# Copilot Instructions

This is a Nykredit developer workspace containing multiple Java microservices and shared libraries,
all under the `dk.nykredit` groupId.

## Build & Test Commands

All projects use Maven. Java/Maven versions are managed via **SDKMan** and set per-project via `.envrc`.

```bash
# Build
mvn clean package              # dev build (H2 database)
mvn clean package -Pprod       # production build (Oracle datasource)
mvn clean verify               # build + integration tests

# Run locally
mvn cargo:run -Pweblogic       # start on local WebLogic
mvn cargo:redeploy             # redeploy without restart

# Skip test flags
-DskipTests                    # skip all tests
-DskipUTs                      # skip unit tests only
-DskipITs                      # skip integration tests only

# Run a single test class
mvn test -pl <module> -Dtest=ClassName

# Run a single test method
mvn test -pl <module> -Dtest=ClassName#methodName
```

## Architecture

### Project Types

**`rs-*` services** 
— JAX-RS microservices deployed to WebLogic or WildFly. Each is a Maven multi-module project. Structure is not 100% consistent (yet).
- Each `rs-*` project has its own `repository{-root}/.github/copilot-instructions.md` and `repository{-root}/.github/code-style.md`. Refer to these when performing work in a specific project.

**`eventing`** — Custom point-to-point eventing framework used by all `rs-*` services. Provides `@EventConsumer`, `@EventPublisher`, and `event-api` annotations.

**`nic-openapitools-generator`** — Mustache templates and codegen configuration for generating JAX-RS clients/servers from OpenAPI specs. Supports: `jaxrs-javaee8` (Java 11), `microprofile-jakartaee10` (Java 17), `microprofile-jakartaee11` (Java 21).

## Jira -> project key mapping
The user is part of team 'PFT Beta'. Each `rs.*` project has that PFT Beta owns has a corresponding Jira project. The mapping is:
- NRPCON --> rs-consent
- NRPCR --> rs-consent-registry
- NRPACR --> rs-mortgage-agreement-change-request
- NRPAV --> rs-mortgage-agreement-validator
- NRPMG --> rs-mortgage-guarantee
- NRPSHOL --> rs-mortgage-transfer-agreement
- RPS --> rs-refinancing-process-summary
- NRPP --> Share by rs-rp-prepayment-offer and rs-rp-prepayment-activity-legacy

When asked to work on a Jira ticket, navigate to the appropriate repository and follow the local guidelines. 

## Key Conventions

### Maven Profiles
- `dev` (default) — H2 in-memory database, local development
- `prod` — Oracle datasource configured on the server
- `stubbed` (default) — stubs legacy services for XDT environments
- `integrated` — connects to real downstream services (Tx environments and component tests)
- `weblogic` — used with `cargo:run` for local WebLogic

### Java / SDK Versions
Each project's `.envrc` declares the required SDK via SDKMan:
- `eventing`: Java 8, Maven 3
- `rs-*` services: Java 11, Maven 3
- `nic-openapitools-generator`: Java 21, Maven 3

Always check the project's `.envrc` before assuming which Java version applies.

### SCM
All repositories are hosted on the internal Bitbucket at `git.tools.nykredit.it`.
