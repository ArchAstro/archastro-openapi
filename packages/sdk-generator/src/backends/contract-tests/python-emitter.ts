import type { SdkSpec } from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython } from "../../utils/codegen.js";
import { snakeCase } from "../../utils/naming.js";
import { pythonParameterName, uniquePythonParameterNames } from "../python/identifiers.js";
import {
  pythonInlineResponseName,
  pythonResponseShape,
} from "../python/response-type.js";
import {
  buildMethodCalls,
  groupByTopLevelResource,
  type MethodCallInfo,
} from "./method-chain-builder.js";
import {
  emitPythonChannelContractTestFile,
  pythonChannelTestFileStem,
} from "./channel-emitter-python.js";

type GeneratedFiles = Record<string, string>;

/**
 * Generate Python (pytest) contract test files from the SdkSpec AST.
 *
 * Produces:
 * - tests/contract/{version}/test_{resource}.py  — per-resource REST tests (Prism-backed)
 * - tests/contract/channels/test_{channel}.py    — per-channel harness tests
 * - tests/contract/conftest.py                   — Prism + harness-service lifecycle
 */
export function emitPythonContractTests(
  spec: SdkSpec,
  options: { outDir: string }
): GeneratedFiles {
  const files: GeneratedFiles = {};
  const testDir = `${options.outDir}/tests/contract`;
  let restCallCount = 0;

  // Generate REST contract tests for every version
  for (const versionSet of spec.versions) {
    const calls = buildMethodCalls(spec, versionSet, "python");
    restCallCount += calls.length;
    const groups = groupByTopLevelResource(calls);

    for (const [resourceName, resourceCalls] of groups) {
      const filePath = `${testDir}/${versionSet.version}/test_${snakeCase(resourceName)}.py`;
      files[filePath] = emitResourceTestFile(resourceName, resourceCalls);
    }
  }

  // Generate per-channel harness tests. Channel classes aren't versioned, so
  // they live under tests/contract/channels/, parallel to the version dirs.
  for (const channel of spec.channels) {
    const stem = pythonChannelTestFileStem(channel);
    const modulePath = `archastro.platform.channels.${snakeCase(channel.name)}`;
    const filePath = `${testDir}/channels/${stem}.py`;
    files[filePath] = emitPythonChannelContractTestFile(channel, modulePath);
  }

  // Conftest drives lifecycle for both backends. We only spawn Prism when
  // the spec actually has REST operations (Prism refuses to mock a spec with
  // no paths) and only spawn the harness service when the spec has channels.
  files[`${testDir}/conftest.py`] = emitConftest({
    includePrism: restCallCount > 0,
    includeHarness: spec.channels.length > 0,
  });

  return files;
}

function emitResourceTestFile(
  _resourceName: string,
  calls: MethodCallInfo[]
): string {
  const cb = new CodeBuilder("    ");

  for (const line of generatedHeaderPython().trim().split("\n")) {
    cb.line(line);
  }
  cb.line();
  cb.line("import pytest");
  cb.line("from archastro.platform import AsyncPlatformClient, PlatformClient");
  cb.line("from archastro.platform.runtime.http_client import ApiError");
  const needsBaseModel = calls.some((call) =>
    ["model", "model_list"].includes(pythonResponseShape(call.operation))
  );
  if (needsBaseModel) {
    cb.line("from pydantic import BaseModel");
  }
  cb.line();
  cb.line();
  cb.line('PRISM_URL = "http://127.0.0.1:4040"');
  cb.line();
  cb.line();
  cb.line("def _client() -> PlatformClient:");
  cb.line('    return PlatformClient(');
  cb.line("        base_url=PRISM_URL,");
  cb.line('        default_headers={"x-archastro-api-key": "pk_test-key"},');
  cb.line('        access_token="test-token",');
  cb.line("    )");
  cb.line();
  cb.line();
  cb.line("def _error_client(code: int) -> PlatformClient:");
  cb.line("    return PlatformClient(");
  cb.line("        base_url=PRISM_URL,");
  cb.line('        default_headers={"x-archastro-api-key": "pk_test-key", "Prefer": f"code={code}"},');
  cb.line('        access_token="test-token",');
  cb.line("    )");
  cb.line();
  cb.line();
  cb.line("def _async_client() -> AsyncPlatformClient:");
  cb.line("    return AsyncPlatformClient(");
  cb.line("        base_url=PRISM_URL,");
  cb.line('        default_headers={"x-archastro-api-key": "pk_test-key"},');
  cb.line('        access_token="test-token",');
  cb.line("    )");
  cb.line();
  cb.line();
  cb.line("def _async_error_client(code: int) -> AsyncPlatformClient:");
  cb.line("    return AsyncPlatformClient(");
  cb.line("        base_url=PRISM_URL,");
  cb.line('        default_headers={"x-archastro-api-key": "pk_test-key", "Prefer": f"code={code}"},');
  cb.line('        access_token="test-token",');
  cb.line("    )");
  cb.line();

  for (const call of calls) {
    emitHappyPathTest(cb, call);
    emitErrorTests(cb, call);
    emitAsyncHappyPathTest(cb, call);
    emitAsyncErrorTests(cb, call);
  }

  return cb.toString();
}

function buildPythonArgs(call: MethodCallInfo): string {
  // Python SDK: positional args for scope/path params and body, keyword args for query
  const positional = call.args
    .filter((a) => a.kind !== "query")
    .map((a) => a.value);
  const queryArgs = call.args.filter((a) => a.kind === "query");

  const parts = [...positional];

  // Unpack query dict as keyword arguments
  if (queryArgs.length > 0) {
    const queryNameMap = buildPythonQueryNameMap(call);
    // The value is already a dict like {"q": "test-value"} — extract key/value pairs
    for (const qa of queryArgs) {
      // Parse the dict literal to extract individual kwargs
      const match = qa.value.match(/\{(.+)\}/);
      if (match) {
        const inner = match[1]!;
        // Convert "key": value pairs to keyword args: key=value
        const pairs = inner.split(/,\s*/).map((pair) => {
          const [k, v] = pair.split(/:\s*/);
          const key = k!.replace(/"/g, "").trim();
          return `${queryNameMap.get(key) ?? pythonParameterName(key)}=${v!.trim()}`;
        });
        parts.push(...pairs);
      }
    }
  }

  return parts.join(", ");
}

function buildPythonQueryNameMap(call: MethodCallInfo): Map<string, string> {
  const entries: Array<{ kind: "scope" | "path" | "body" | "query"; name: string }> = [];
  for (const param of call.resource.scopeParams) {
    entries.push({ kind: "scope", name: param.name });
  }
  for (const param of call.operation.pathParams) {
    entries.push({ kind: "path", name: param.name });
  }
  if (call.operation.body) {
    entries.push({ kind: "body", name: "input" });
  }
  for (const param of call.operation.queryParams) {
    entries.push({ kind: "query", name: param.name });
  }

  const names = uniquePythonParameterNames(entries.map((entry) => entry.name));
  const queryNames = new Map<string, string>();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.kind === "query") {
      queryNames.set(entries[i]!.name, names[i]!);
    }
  }
  return queryNames;
}

function emitHappyPathTest(cb: CodeBuilder, call: MethodCallInfo): void {
  const testName = buildTestName(call, "success");
  const argStr = buildPythonArgs(call);
  const chainPy = call.accessorChain.replace("client.", "");
  const methodCall = `client.${chainPy}.${pythonParameterName(call.methodName)}(${argStr})`;

  cb.line();
  cb.line(`def ${testName}():`);
  cb.indent();
  cb.line("client = _client()");
  cb.pyBlock("try", () => {
    emitResultAssertions(cb, call, methodCall);
  });
  cb.pyBlock("finally", () => {
    cb.line("client.close()");
  });
  cb.dedent();
}

/**
 * Assert the response shape the generated SDK promises: deserialized
 * Pydantic models for typed responses, raw payloads everywhere else.
 * The shape decision is shared with the resource emitter via
 * pythonResponseShape so assertions and behavior cannot drift. Concrete
 * class names are asserted via type(...).__name__ — strictly stronger than
 * an isinstance(BaseModel) check (a miswired all-optional model would
 * still validate) without needing cross-module imports in the test file.
 */
function emitResultAssertions(
  cb: CodeBuilder,
  call: MethodCallInfo,
  methodCall: string
): void {
  cb.line(`result = ${methodCall}`);
  switch (pythonResponseShape(call.operation)) {
    case "void":
      cb.line("assert result is None");
      break;
    case "raw":
      cb.line('assert result["content"] is not None');
      cb.line('assert result["mime_type"]');
      break;
    case "model": {
      cb.line("assert isinstance(result, BaseModel)");
      cb.line(`assert type(result).__name__ == "${modelClassName(call)}"`);
      if (returnTypeHasDataArray(call.operation.returnType)) {
        cb.line("assert isinstance(result.data, list)");
      }
      break;
    }
    case "model_list": {
      const itemName = listItemClassName(call);
      cb.line("assert isinstance(result, list)");
      cb.line(
        `assert all(type(item).__name__ == "${itemName}" for item in result)`
      );
      break;
    }
    case "untyped":
      cb.line("assert result is not None");
      break;
  }
}

function modelClassName(call: MethodCallInfo): string {
  const ret = call.operation.returnType;
  if (ret.kind === "ref") return ret.schema;
  return pythonInlineResponseName(call.resource.className, call.operation.name);
}

function listItemClassName(call: MethodCallInfo): string {
  const ret = call.operation.returnType;
  if (ret.kind === "array" && ret.items.kind === "ref") return ret.items.schema;
  throw new Error(
    `[sdk-generator] ${call.operation.operationId}: model_list response ` +
      `without a $ref item type`
  );
}

/** Check if return type is an object with a `data` field that is an array. */
function returnTypeHasDataArray(returnType: import("../../ast/types.js").TypeRef): boolean {
  if (returnType.kind !== "object") return false;
  const dataField = returnType.fields.find((f) => f.name === "data");
  if (!dataField) return false;
  return dataField.type.kind === "array";
}

function emitErrorTests(cb: CodeBuilder, call: MethodCallInfo): void {
  for (const code of call.errorCodes) {
    if (code < 400) continue;

    const testName = buildTestName(call, `error_${code}`);
    const argStr = buildPythonArgs(call);
    const chainPy = call.accessorChain.replace("client.", "");
    const methodCall = `ec.${chainPy}.${pythonParameterName(call.methodName)}(${argStr})`;

    cb.line();
    cb.line(`def ${testName}():`);
    cb.indent();
    cb.line(`ec = _error_client(${code})`);
    cb.pyBlock("try", () => {
      cb.line("with pytest.raises(ApiError) as exc_info:");
      cb.indent();
      cb.line(methodCall);
      cb.dedent();
      cb.line(`assert exc_info.value.status == ${code}`);
    });
    cb.pyBlock("finally", () => {
      cb.line("ec.close()");
    });
    cb.dedent();
  }
}

function emitAsyncHappyPathTest(cb: CodeBuilder, call: MethodCallInfo): void {
  const testName = buildAsyncTestName(call, "success");
  const argStr = buildPythonArgs(call);
  const chainPy = call.accessorChain.replace("client.", "");
  const methodCall = `client.${chainPy}.${pythonParameterName(call.methodName)}(${argStr})`;

  cb.line();
  cb.line("@pytest.mark.asyncio");
  cb.line(`async def ${testName}():`);
  cb.indent();
  cb.line("client = _async_client()");
  cb.pyBlock("try", () => {
    emitResultAssertions(cb, call, `await ${methodCall}`);
  });
  cb.pyBlock("finally", () => {
    cb.line("await client.close()");
  });
  cb.dedent();
}

function emitAsyncErrorTests(cb: CodeBuilder, call: MethodCallInfo): void {
  for (const code of call.errorCodes) {
    if (code < 400) continue;

    const testName = buildAsyncTestName(call, `error_${code}`);
    const argStr = buildPythonArgs(call);
    const chainPy = call.accessorChain.replace("client.", "");
    const methodCall = `ec.${chainPy}.${pythonParameterName(call.methodName)}(${argStr})`;

    cb.line();
    cb.line("@pytest.mark.asyncio");
    cb.line(`async def ${testName}():`);
    cb.indent();
    cb.line(`ec = _async_error_client(${code})`);
    cb.pyBlock("try", () => {
      cb.line("with pytest.raises(ApiError) as exc_info:");
      cb.indent();
      cb.line(`await ${methodCall}`);
      cb.dedent();
      cb.line(`assert exc_info.value.status == ${code}`);
    });
    cb.pyBlock("finally", () => {
      cb.line("await ec.close()");
    });
    cb.dedent();
  }
}

function buildTestName(call: MethodCallInfo, suffix: string): string {
  // e.g., "test_agents_create_success" or "test_agents_schedules_list_error_404"
  const parts = call.groupLabel
    .split(" > ")
    .map((s) => snakeCase(s));
  return `test_${parts.join("_")}_${snakeCase(call.methodName)}_${suffix}`;
}

function buildAsyncTestName(call: MethodCallInfo, suffix: string): string {
  return buildTestName(call, suffix).replace(/^test_/, "test_async_");
}

function emitConftest(opts: {
  includePrism: boolean;
  includeHarness: boolean;
}): string {
  const { includePrism, includeHarness } = opts;
  const lines: string[] = [
    generatedHeaderPython().trim(),
    "",
  ];
  if (includeHarness) lines.push("import json");
  lines.push("import os");
  if (includeHarness) lines.push("import selectors");
  lines.push(
    "import signal",
    "import subprocess",
    "import time",
    ""
  );
  if (includePrism) lines.push("import httpx");
  lines.push("import pytest", "");

  if (includePrism) {
    lines.push(
      'PRISM_PORT = os.environ.get("PRISM_PORT", "4040")',
      'PRISM_URL = f"http://127.0.0.1:{PRISM_PORT}"'
    );
  }
  lines.push(
    'SPEC_PATH = os.environ.get(',
    '    "OPENAPI_SPEC_PATH",',
    '    os.path.join(os.path.dirname(__file__), "../../specs/platform-openapi.json"),',
    ")",
    ""
  );
  if (includePrism) {
    lines.push(
      'PRISM_BIN = os.environ.get(',
      '    "PRISM_BIN",',
      '    os.path.join(os.path.dirname(__file__), "../../node_modules/.bin/prism"),',
      ")",
      ""
    );
  }
  if (includePrism) lines.push("_prism_process = None");
  if (includeHarness) lines.push(...harnessGlobals());

  if (includeHarness) {
    lines.push(
      "",
      "",
      "def _channel_tests_enabled() -> bool:",
      '    """Channel contract tests are opt-in — set ARCHASTRO_RUN_CHANNEL_CONTRACT_TESTS=1 to run."""',
      '    return os.environ.get("ARCHASTRO_RUN_CHANNEL_CONTRACT_TESTS", "") in ("1", "true", "yes")',
      "",
      "",
      "# Skip the channel test tree entirely at collection time when the env var",
      "# is not set, so CI runs REST tests without pulling in the harness service.",
      'collect_ignore_glob = [] if _channel_tests_enabled() else ["channels/*"]'
    );
  }

  // pytest_configure: start whatever the spec needs.
  lines.push("", "", "def pytest_configure(config):");
  if (!includePrism && !includeHarness) {
    lines.push("    pass");
  } else {
    if (includePrism) {
      lines.push(
        "    global _prism_process",
        "    if not os.path.exists(PRISM_BIN):",
        "        raise RuntimeError(",
        "            f\"Prism bin not found at {PRISM_BIN}. Set PRISM_BIN \"",
        "            f\"or run 'npm ci --ignore-scripts'.\"",
        "        )",
        "    _prism_process = subprocess.Popen(",
        '        [PRISM_BIN, "mock", SPEC_PATH,',
        '         "--port", PRISM_PORT, "--host", "127.0.0.1", "--dynamic"],',
        "        stdout=subprocess.PIPE,",
        "        stderr=subprocess.PIPE,",
        "    )",
        "    _wait_for_prism()"
      );
    }
    if (includeHarness) {
      lines.push(
        "    if _channel_tests_enabled():",
        "        _start_harness_service()"
      );
    }
  }

  // pytest_unconfigure
  lines.push("", "", "def pytest_unconfigure(config):");
  if (!includePrism && !includeHarness) {
    lines.push("    pass");
  } else {
    if (includePrism) {
      lines.push(
        "    if _prism_process:",
        "        _prism_process.send_signal(signal.SIGTERM)",
        "        try:",
        "            _prism_process.wait(timeout=10)",
        "        except subprocess.TimeoutExpired:",
        "            _prism_process.kill()"
      );
    }
    if (includeHarness) {
      lines.push(
        "    if _channel_tests_enabled():",
        "        _stop_harness_service()"
      );
    }
  }

  if (includePrism) {
    lines.push(
      "",
      "",
      "def _wait_for_prism(timeout=30):",
      "    deadline = time.time() + timeout",
      "    while time.time() < deadline:",
      "        # Fast-fail if Prism process exited (bad spec path, missing Prism, etc.)",
      "        if _prism_process.poll() is not None:",
      "            stderr = _prism_process.stderr.read().decode() if _prism_process.stderr else ''",
      '            raise RuntimeError(f"Prism exited with code {_prism_process.returncode}: {stderr}")',
      "        try:",
      "            httpx.get(f\"{PRISM_URL}/\")",
      "            return",
      "        except httpx.ConnectError:",
      "            time.sleep(0.3)",
      '    raise RuntimeError(f"Prism did not start on port {PRISM_PORT} within {timeout}s")'
    );
  }

  if (includeHarness) {
    lines.push(...harnessHelpers(), ...harnessFixture());
  }

  lines.push("");
  return lines.join("\n") + "\n";
}

function harnessGlobals(): string[] {
  return [
    "",
    'HARNESS_BIN = os.environ.get(',
    '    "ARCHASTRO_HARNESS_BIN",',
    "    os.path.join(",
    "        os.path.dirname(__file__),",
    '        "../../node_modules/@archastro/channel-harness/dist/bin.js",',
    "    ),",
    ")",
    "_harness_process = None",
    "_harness_urls: dict[str, str] | None = None",
  ];
}

function harnessHelpers(): string[] {
  return [
    "",
    "",
    "def _start_harness_service(timeout: float = 15.0) -> None:",
    "    global _harness_process, _harness_urls",
    "    if not os.path.exists(HARNESS_BIN):",
    "        raise RuntimeError(",
    "            f\"channel-harness bin not found at {HARNESS_BIN}. Set ARCHASTRO_HARNESS_BIN \"",
    "            f\"or run 'npm ci --ignore-scripts' (or 'npm run build' in the archastro-openapi workspace).\"",
    "        )",
    "    _harness_process = subprocess.Popen(",
    "        [\"node\", HARNESS_BIN, SPEC_PATH],",
    "        stdout=subprocess.PIPE,",
    "        stderr=subprocess.PIPE,",
    "        text=True,",
    "    )",
    "    # Use selectors to bound each wait so the deadline actually fires even",
    "    # if the subprocess starts but stalls before printing a line — plain",
    "    # readline() on a blocking pipe would hang pytest_configure forever.",
    "    assert _harness_process.stdout is not None",
    "    _selector = selectors.DefaultSelector()",
    "    _selector.register(_harness_process.stdout, selectors.EVENT_READ)",
    "    deadline = time.time() + timeout",
    "    buf = ''",
    "    try:",
    "        while True:",
    "            remaining = deadline - time.time()",
    "            if remaining <= 0:",
    '                raise RuntimeError(f"harness service did not report URLs within {timeout}s")',
    "            if _harness_process.poll() is not None:",
    "                err = _harness_process.stderr.read() if _harness_process.stderr else ''",
    "                raise RuntimeError(",
    '                    f"harness service exited with code {_harness_process.returncode} before reporting URLs\\n{err}"',
    "                )",
    "            if not _selector.select(timeout=min(remaining, 0.25)):",
    "                continue",
    "            chunk = _harness_process.stdout.readline()",
    "            if not chunk:",
    "                time.sleep(0.05)",
    "                continue",
    "            buf += chunk",
    "            if '\\n' not in buf:",
    "                continue",
    "            line, _, buf = buf.partition('\\n')",
    "            parsed = json.loads(line.strip())",
    '            if "wsUrl" in parsed and "controlUrl" in parsed:',
    "                _harness_urls = parsed",
    '                os.environ["ARCHASTRO_HARNESS_WS_URL"] = parsed["wsUrl"]',
    '                os.environ["ARCHASTRO_HARNESS_CONTROL_URL"] = parsed["controlUrl"]',
    "                return",
    "    finally:",
    "        _selector.close()",
    "",
    "",
    "def _stop_harness_service() -> None:",
    "    global _harness_process",
    "    if _harness_process is None:",
    "        return",
    "    try:",
    "        _harness_process.send_signal(signal.SIGTERM)",
    "        _harness_process.wait(timeout=5)",
    "    except subprocess.TimeoutExpired:",
    "        _harness_process.kill()",
    "        _harness_process.wait(timeout=2)",
    "    finally:",
    "        _harness_process = None",
  ];
}

function harnessFixture(): string[] {
  return [
    "",
    "",
    "@pytest.fixture(scope=\"session\")",
    "def harness_service() -> dict[str, str]:",
    "    \"\"\"Resolved wsUrl + controlUrl for the running harness service.\"\"\"",
    "    if _harness_urls is None:",
    "        raise RuntimeError(\"harness service was not started by pytest_configure\")",
    "    return _harness_urls",
  ];
}
