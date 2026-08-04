# Pi Agent downstream integration

Pi Agent is maintained as a private downstream provider. It is not an external plugin: T3 currently
requires providers to implement its driver and adapter contracts and to be registered in the built-in
driver list.

The provider launches `pi --mode rpc` in the thread working directory. Sessions use Pi's persistent
session IDs, while metadata generation uses an ephemeral, tool-free RPC process. The adapter maps Pi
JSONL events to T3's canonical runtime events so local, remote, and tunnel clients continue to use the
normal WebSocket protocol.

## Vanilla boundary

T3 intentionally exposes only the Pi binary path and ordinary T3 provider-instance fields. Each Pi
session disables extension, skill, prompt-template, and theme discovery. This also prevents extension
packages from registering custom tools or providers. Built-in tools and project context-file discovery
remain enabled. Pi authentication and its built-in model inventory remain owned by the normal Pi
installation.

Pi 0.80.4 or newer is required. The health probe verifies the executable version, starts a short-lived
RPC process, and checks state and available models before marking an instance ready.

## Pi Mode

Pi Mode is a local web presentation policy, not a second UI or backend mode. The policy module filters
provider instances and thread references while the existing layouts, sidebars, composer, settings,
diff, git, and routing components remain shared. Projects are never filtered out. Threads whose
effective provider instance cannot be resolved to the Pi driver are hidden without being mutated.

Entering the mode temporarily selects a ready Pi model for title and source-control writing. The local
restore record changes each value back only when it still equals the Pi selection that was applied;
newer changes from another client are preserved.

## Patch series

Keep the integration on `pi/main` as five ordered commits. Each commit must contain its matching trailer:

1. Pi contracts and settings — `Pi-Patch: 1`
2. Pi RPC transport — `Pi-Patch: 2`
3. Pi provider driver and text generation — `Pi-Patch: 3`
4. Pi Mode web policy and settings switch — `Pi-Patch: 4`
5. Tests, docs, and release automation — `Pi-Patch: 5`

The compatibility workflow discovers the five trailers after the merge base with upstream main and
cherry-picks them onto an exact stable tag. Duplicate or missing ordinals fail the release.
