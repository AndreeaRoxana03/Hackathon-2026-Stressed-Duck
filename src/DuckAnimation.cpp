#include "DuckAnimation.h"

void DuckAnimation::begin(int16_t x, int16_t y, int16_t w, int16_t h) {
    _x = x;
    _targetX = x;
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

void DuckAnimation::setPosition(int16_t x) {
    _targetX = x;
}

void DuckAnimation::snapTo(int16_t x) {
    _x = x;
    _targetX = x;
}

void DuckAnimation::update() {
    if (_frameCount == 0 || _frames == nullptr) {
        return; // no artwork loaded yet
    }

    uint32_t now = millis();
    bool frameDue = _lastFrameMs == 0 || now - _lastFrameMs >= _frameDelayMs;
    if (!frameDue && _targetX == _x) {
        return;
    }

    if (frameDue) {
        _lastFrameMs = now;
        const DuckFrame& frame = _frames[_currentFrame];
        _sprite.fillSprite(_bgColor);
        _sprite.drawPng(frame.data, frame.len, 0, 0);
        _currentFrame = (_currentFrame + 1) % _frameCount;
    }

    if (_targetX != _x) {
        // The sprite is opaque, so only the strip it just left behind needs repainting.
        const int16_t w = _sprite.width();
        const int16_t h = _sprite.height();
        int16_t stripX;
        int16_t stripW;
        if (_targetX > _x) {
            stripX = _x;
            stripW = (_targetX - _x < w) ? (_targetX - _x) : w;
        } else {
            stripX = (_targetX + w > _x) ? (_targetX + w) : _x;
            stripW = _x + w - stripX;
        }
        M5.Display.fillRect(stripX, _y, stripW, h, _bgColor);
        _x = _targetX;
    }

    _sprite.pushSprite(_x, _y);
}
