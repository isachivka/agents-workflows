---
worth: low
added: 2026-10-19
---
Each flowd has its own UI, so a person running flows on two machines (a laptop and a home server)
has two UIs, two logins and two conversations' worth of setup. An idea: one controlling host with the
UI, and "pods" — the machines where agents actually run — connecting to it: the controller keeps
the list of runs and the UI, a pod runs the steps (terminals, agents, `sh`) and reports back. Large
and unclear: what lives where (definitions, the store, plugins, the messenger, reports), how a pod
connects (outbound, so it needs no public address), what happens when one is offline, and whether a
run can move between pods. Not designed; worth deciding only once flowd runs on more than one host.
