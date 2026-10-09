# Serial Protocol

The host and firmware communicate at 115200 baud over USB serial.

Firmware to host:

```text
EVENT:FIST_SLAM\n
```

Host to firmware:

```text
RESP|MOOD=<HAPPY|STRESSED|COOL>|COMMENT=<short text>|FIX=|EXPLAIN=\n
```

The host ignores debug and unknown lines. Comments are printable ASCII, have serial delimiters removed, and are bounded to 160 characters. Technical details stay in VS Code; `FIX` and `EXPLAIN` are always empty.
