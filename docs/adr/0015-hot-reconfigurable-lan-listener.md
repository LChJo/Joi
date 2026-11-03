# ADR 0015: Hot-Reconfigurable LAN Listener

Status: accepted

LAN Web remains a single optional listener alongside the always-on loopback listener. Settings persist the user's desired address, port and enabled state, while the runtime listener manager owns the effective state. A settings update serializes candidate binding, swaps the candidate only after it listens successfully, and closes the previous listener afterwards.

Invalid RFC1918 addresses, unavailable local interfaces, invalid ports and missing risk acknowledgement fail with stable application error codes. A bind failure never stops loopback. When an old LAN endpoint exists it remains active and the response reports the pending configuration error; when no endpoint exists the effective state is `blocked` while the desired enabled state remains persisted for a later retry or restart.

The manager never listens on `0.0.0.0`, never changes the firewall and never selects a different port. Settings projections may expose authenticated LAN address candidates and the effective URL; diagnostics and exported diagnostics contain only status and stable reason codes.
