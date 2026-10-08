#include "DuckAnimation.h"

void DuckAnimation::begin(int16_t x, int16_t y, int16_t w, int16_t h) {
    _x = x;
    _y = y;
    _sprite.setPsram(true);
    _sprite.createSprite(w, h);
}

void DuckAnimation::setBackgroundColor(uint16_t color565) {
    _bgColor = color565;
}

void DuckAnimation::setFrames(const DuckFrame* frames, size_t count, uint16_t frameDelayMs) {
    _frames = frames;
    _frameCount = count;
    _frameDelayMs = frameDelayMs;
    _currentFrame = 0;
    _lastFrameMs = 0;
}

void DuckAnimation::update() {
    if (_frameCount == 0 || _frames == nullptr) {
        return; // no artwork loaded yet
    }

    uint32_t now = millis();
    if (_lastFrameMs != 0 && now - _lastFrameMs < _frameDelayMs) {
        return;
    }
    _lastFrameMs = now;

    const DuckFrame& frame = _frames[_currentFrame];
    _sprite.fillSprite(_bgColor);
    _sprite.drawPng(frame.data, frame.len, 0, 0);
    _sprite.pushSprite(_x, _y);

    _currentFrame = (_currentFrame + 1) % _frameCount;
}
