#pragma once

// Arduino shims for the SDL desktop preview (env:native).
#include <M5Unified.h>
#include <cstdarg>
#include <cstdio>

using lgfx::delay;
using lgfx::millis;

struct NativeSerial {
    void begin(unsigned long) {}
    void println(const char* s) { std::puts(s); }
    void printf(const char* fmt, ...) {
        va_list args;
        va_start(args, fmt);
        std::vprintf(fmt, args);
        va_end(args);
    }
};
inline NativeSerial Serial;

// Keyboard stand-ins for hardware input: hold P to simulate a table punch.
float nativeAccelMagnitude();
// Returns 1/2/3 on the press edge of the A/S/D keys, otherwise 0.
int nativeButtonPressed();
