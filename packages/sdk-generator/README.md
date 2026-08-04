# @archastro/sdk-generator

Generate typed TypeScript, Python, Swift, and Go SDKs — plus cross-language
contract tests — from an OpenAPI spec produced by the ArchAstro API DSL.

## Install

```bash
# ad-hoc
npx @archastro/sdk-generator --spec ./openapi.json --lang typescript --out ./sdk

# global
npm install -g @archastro/sdk-generator
sdk-generator --spec ./openapi.json --lang python --out ./sdk
```

## CLI

```
sdk-generator --spec <openapi.json> \
                  [--lang typescript|python|swift|go|contract-tests-ts|contract-tests-py|contract-tests-swift|contract-tests-go] \
                  [--out <dir>] \
                  [--config <config.json>] \
                  [--ast-only]
```

Targets:

| `--lang` | Emits |
| --- | --- |
| `typescript` | TS SDK: resources, channel classes, auth, client, zod schemas |
| `python` | Python SDK: Pydantic models, resources, channels |
| `swift` | Swift SDK: Codable models, resources, channels, async client |
| `go` | Go SDK: JSON-tagged structs, context-taking resources, channels, client |
| `contract-tests-ts` | TS contract tests that drive `@archastro/channel-harness` |
| `contract-tests-py` | Python contract tests (pytest + Prism mock server) |
| `contract-tests-swift` | Swift contract tests (swift-testing + Prism + harness) |
| `contract-tests-go` | Go contract tests (`go test` + Prism + harness) |

### Go target configuration

Go resolves types *and* functions from one package-level namespace, and it
compiles one package per directory, so the Go backend needs the package name
and the import path callers reach it by. Both live in the config file under
`go`:

```jsonc
{
  "go": {
    "packageName": "platform",
    "importPath": "github.com/ArchAstro/archastro-go/platform"
  }
}
```

The SDK lands flat in `<out>/<packageName>/` (`types_*.go`, `v1_*.go`,
`channels_*.go`, `client.go`, `auth.go`) and the contract tests in
`<out>/contracttests/`, which imports the SDK by that path. The emitter
writes structurally correct Go, not column-aligned Go — run `gofmt -w` over
the output as part of regeneration.

## Generated SDK documentation

The generator preserves OpenAPI documentation as idiomatic source docs in each
language. Use standard OpenAPI fields as the source of truth:

- Operation `summary` and `description` become TypeScript JSDoc, Python
  method docstrings, and Swift/Go `//` documentation comments.
- Parameter and request-body field `description` values become parameter docs
  and input object field docs.
- Success response descriptions become return-value docs.
- Schema `description` values become TypeScript interface/schema docs and
  Python model docstrings.
- Schema property `description` values become TypeScript field docs, Zod
  `.describe(...)` metadata, and Pydantic `Field(description=...)` metadata.

For consuming SDK repos, keep docs generation next to the generated package:

- TypeScript: add TypeDoc, point `entryPoints` at the public generated entry
  points, and publish the generated `docs/` directory with GitHub Pages.
- Python: add pdoc, point it at the generated package, and publish the rendered
  HTML with GitHub Pages.
- Run the docs build in CI after SDK regeneration so broken doc comments fail
  before release.

### `--config`

Shared codegen metadata consumed by both backends:

```json
{
  "name": "@archastro/platform-sdk",
  "version": "0.1.0",
  "baseUrl": "https://platform.archastro.ai",
  "apiBase": "/api",
  "defaultVersion": "v1",
  "description": "ArchAstro Platform API SDK"
}
```

### TypeScript client extensions

Generated `PlatformClient` classes expose a typed class-expression mixin seam:

```ts
const RealtimePlatformClient = PlatformClient.extend(
  withCustomObjectSubscriptions,
);
const client = RealtimePlatformClient.withToken("pk_live_...", accessToken);
```

`extend` returns a subclass rather than modifying `PlatformClient`. Extensions
therefore retain generated resources, can be chained, and are preserved by the
generated static factories. A hand-maintained extension uses the standard
TypeScript mixin shape:

```ts
const withDiagnostics = <TBase extends PlatformClientConstructor>(Base: TBase) =>
  class extends Base {
    diagnosticLabel() {
      return "ready";
    }
  };
```

Consuming SDKs can keep those modules public across regeneration without
teaching the generator their methods:

```jsonc
{
  "typescript": {
    "clientExtensionModules": ["./custom-object-subscriptions.js"]
  }
}
```

Each configured module is emitted as an `export *` entry in the generated
package barrel. The module itself remains hand-maintained.

## Programmatic use

```ts
import {
  parseOpenApiSpec,
  generateTypeScript,
  generatePython,
  generateContractTests,
} from "@archastro/sdk-generator";

const spec = JSON.parse(readFileSync("openapi.json", "utf-8"));
const ast = parseOpenApiSpec(spec, { name: "@archastro/platform-sdk" });
const files = generateTypeScript(ast, { outDir: "./sdk" });
```

## Development

This package lives inside the
[`archastro-openapi`](https://github.com/archastro/archastro-openapi)
workspace. See the root README for build / test / release instructions.
