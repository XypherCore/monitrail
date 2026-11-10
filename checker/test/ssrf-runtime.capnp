using Workerd = import "/workerd/workerd.capnp";

# Test-only isolate without listening sockets, production bindings or outbound network.
const tests :Workerd.Config = (
  services = [
    (name = "ssrf-runtime", worker = (
      modules = [(name = "ssrf-runtime.mjs", esModule = embed "ssrf-runtime.mjs")],
      compatibilityDate = "2026-10-30",
      compatibilityFlags = ["global_fetch_strictly_public"],
      globalOutbound = "fixture",
    )),
    (name = "fixture", worker = (
      modules = [(name = "fixture.mjs", esModule = embed "ssrf-upstream.mjs")],
      compatibilityDate = "2026-10-23",
    )),
    (name = "internet", network = (allow = [])),
  ],
);
