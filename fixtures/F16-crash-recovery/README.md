# F16 crash-recovery

Six source files (plus config) used by the seven SIGKILL injection points of
`docs/12-indexing.md` 12.3.3. The fixture is intentionally small; the crash is
injected through `NEXUS_CRASH_AT`, never by a product flag.

Recovery matrix expected after each injection is documented in
`expected/recovery-matrix.md`.
