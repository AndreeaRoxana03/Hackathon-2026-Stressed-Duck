#pragma once

#include <M5Unified.h>

// One PNG-encoded animation frame, embedded as a flash byte array.
struct DuckFrame {
    const uint8_t* data;
    size_t len;
};

// Plays a looping sequence of PNG frames into a small sprite, blitted on top
// of the full-screen mood background without flicker.
class DuckAnimation {
public:
    void begin(int16_t x, int16_t y, int16_t w, int16_t h);
    void setBackgroundColor(uint16_t color565);
    void setFrames(const DuckFrame* frames, size_t count, uint16_t frameDelayMs);
    void update();

private:
    LGFX_Sprite _sprite{&M5.Display};
    const DuckFrame* _frames = nullptr;
    size_t _frameCount = 0;
    size_t _currentFrame = 0;
    uint16_t _frameDelayMs = 120;
    uint32_t _lastFrameMs = 0;
    uint16_t _bgColor = TFT_BLACK;
    int16_t _x = 0;
    int16_t _y = 0;
};
