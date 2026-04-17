# specs/

Source-of-truth OpenAPI specs consumed by `@archastro/sdk-generator` to
emit typed SDKs and contract tests.

## `platform-openapi.json`

The ArchAstro Platform API surface — REST endpoints plus Phoenix
`x-channels`. Produced by the (private) backend and published here so
downstream SDK repos — `archastro-js`, `archastro-python`, etc. — can
pull a stable spec from a known URL without depending on a backend
checkout.

Bumped whenever the API surface changes; SDKs re-run their
`regenerate_sdk.sh` (or equivalent) against the new version.
