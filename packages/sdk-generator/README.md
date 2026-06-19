# @archastro/sdk-generator

Generate typed TypeScript and Python SDKs — plus cross-language contract
tests — from an OpenAPI spec produced by the ArchAstro API DSL.

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
                  [--lang typescript|python|contract-tests-ts|contract-tests-py] \
                  [--out <dir>] \
                  [--config <config.json>] \
                  [--ast-only]
```

Targets:

| `--lang` | Emits |
| --- | --- |
| `typescript` | TS SDK: resources, channel classes, auth, client, zod schemas |
| `python` | Python SDK: Pydantic models, resources, channels |
| `contract-tests-ts` | TS contract tests that drive `@archastro/channel-harness` |
| `contract-tests-py` | Python contract tests (pytest + Prism mock server) |

## Generated SDK documentation

The generator preserves OpenAPI documentation as idiomatic source docs in each
language. Use standard OpenAPI fields as the source of truth:

- Operation `summary` and `description` become TypeScript JSDoc and Python
  method docstrings.
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
