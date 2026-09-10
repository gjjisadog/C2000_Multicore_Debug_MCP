# F28P65x Flash loader hardening

This change hardens the MCP boundary around CPU2 Flash programming. It does
not unlock DCSM, write undocumented Flash FSM registers, retry a failed erase,
or claim that a TI Flash Plugin error is permanent target protection.

## Behavior

- The CPU2 linker-map Flash banks remain the source of the requested erase set.
- After CPU1 `ConfigureClock` and `ConfigureBanks`, the persistent DSS script
  reads back `BANKMUXSEL` and `DEVCFGLOCK2` through CPU1.
- `BANKMUXSEL` is decoded per bank. CPU1 is selector `0`; CPU2 is selector
  `3`. Only `DEVCFGLOCK2` bit `2` is treated as the BANKMUXSEL lock.
- A readable mapping mismatch or asserted lock prevents the pending CPU2 load
  from being armed. An unavailable diagnostic is retained as incomplete
  evidence and does not mask the original TI operation result.
- The boundary evidence records `verified`, `mismatch`, or `unavailable`, plus
  the actual owners and expected BankMux value.
- A TI error containing the locked-register erase signature is classified as
  `flash_programmer_state`, not as proof of permanent DCSM/Flash protection.
- A logical session is quarantined after a CPU2 F28P65x Flash load failure with
  Flash evidence. A later CPU2 program load in that session is rejected before
  target mutation; the caller must close the session and create a fresh one.

## Safety contract

The change preserves the existing explicit destructive reload authorization and
the no-automatic-retry policy. Resident-image observation should use symbol
loading after target identity verification. Hardware acceptance remains
separate from host/Mock regression evidence.

## Verification

Host tests cover BankMux decoding, the `DEVCFGLOCK2` bit mask, Bank3-only DK9
mapping, readable boundary mismatches, TI locked-register classification,
session quarantine, and existing DSS evidence behavior. No target Flash write
is performed by the host validation.
