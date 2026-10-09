# Stressed Duck Agent

- Use Node.js 22+, TypeScript, and focused `node:test` coverage.
- Keep the serial wire format compatible with the firmware: 115200 baud, `EVENT:FIST_SLAM`, and the ordered `RESP|MOOD|COMMENT|FIX|EXPLAIN` response.
- Never send code, diagnostics, diffs, or secrets to the duck. Hardware receives only a validated mood and short comment.
- Keep credentials and per-user runtime state outside the repository.
- Do not add firmware, PlatformIO, or generated-image changes from this project.
