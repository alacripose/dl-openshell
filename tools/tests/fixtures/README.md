# Test fixtures

`proof-v1.shpkg` is an append-only **legacy** SHPKG003 fixture: its header still contains the
historical `shploingus.recipe/3` counter, and the package tests read it only through the legacy
decoder. It is not an emitter and is not a current format id.
