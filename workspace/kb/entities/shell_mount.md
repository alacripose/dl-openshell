# Entity — Shell mount / attribute publisher (`src/Openlock/Shell/ShellMount.cs`)

**Availability tier:** STANDARD (client shell availability; the game itself keeps running).

## Purpose

Owns the runtime bridge: loads the shell package, registers console commands, and publishes JSON
payloads to players as attributes on the `openlock-shell` panel. Also serializes observer notices,
build status, update records, addon payloads and layout payloads.

## Trust role

The producer side of the plugin→client boundary (F4). Whatever it publishes is what every connected
client's shell will render. Its inputs include the parsed packages and the layout profile store.

## Inputs

- `ShellPackage` (from `shell/alpha-shell`), `AddonPackages`, `LayoutProfiles`, `BuildStatus`.
- Console command arguments (player- or server-issued).
- Recipient lists (`controller.Recipients`).

## Outputs

- Panel attributes: `layout`, `addons`, `build`, `update`, `observer`, `paths`, `active`, `view`,
  `layoutrequest`, `layoutexport`.
- Console replies and log lines.

## Controls observed in the KB

- Payloads are serialized with `System.Text.Json` (structured), not string-concatenated.
- Size budget enforced before publishing (`AddonPackages` refuses an over-budget candidate).
- Layout save/load/reset/export validate the scheme before touching disk.
- Tick publishes only when the payload actually changed (signature comparison), bounding chatter.

## Constraints

- Attribute values are strings; a client cannot be trusted to re-validate, so the plugin is the only
  place where server-side truth can be enforced.
- Must not block the game thread: publishing is spread across `Tick()`.
