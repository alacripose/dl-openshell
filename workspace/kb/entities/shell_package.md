# Entity — Shell package loader (`src/Openlock/Shell/ShellPackage.cs`)

**Availability tier:** LOW_CRITICALITY (a refused shell package means the shell does not mount).

## Purpose

Reads the shipped shell definition from `shell/alpha-shell`: the recipe (`package.shspec`), cell
grid (`package.cells`), frames directory, and declared Deadlock window list
(`deadlock.windows`), producing the windows, tabs, pins and bar the shell draws.

## Trust role

Consumes repository-shipped files, not third-party addons. It defines the chrome that frames game
panels; it also resolves `recipe["content"]` references.

## Inputs

- Files under `<plugins>/shell/alpha-shell`.
- Recipe rows with `package`, `version`, `source`, `content`, window declarations.

## Outputs

- `Windows`, `Rows`, `Tabs`, `Pins`, `Bar`, `Filed`, `Refusals`.
- Window candidate descriptors (panel refs and content targets).

## Controls observed in the KB

- Missing files are handled by the loader (`ReadRecipeText` over `File.ReadAllText` guarded by
  callers), with refusals rather than unhandled exceptions.
- Recipe parsing is line-oriented and validates required rows (`package`, canonical name/version).
- Content resolution is explicit (`resolveContent: true` for the live load).

## Constraints

- Must not require network or player input.
- Declared windows are the *only* windows that can be split by identity; discovered windows need a
  pinned identity (see the split identity module).
