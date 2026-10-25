#!/usr/bin/env python3
"""Draws the app icons (a green shield with a keyhole) with the standard
library only, so they can be regenerated without any imaging dependency.

    python3 scripts/make-icons.py
"""
import os
import struct
import zlib

BG = (13, 13, 13, 255)
SHIELD = (26, 110, 60, 255)
EDGE = (76, 255, 145, 255)
KEY = (13, 13, 13, 255)
SCALE = 4  # supersampling for smooth edges


def inside_shield(x, y):
    """Shield in unit coordinates: flat top, sides curving into a point."""
    if not 0.18 <= y <= 0.92:
        return 0.0
    t = (y - 0.18) / 0.74
    half = 0.30 * (1 - max(0.0, t - 0.45) / 0.55) ** 0.8 if t > 0.45 else 0.30
    return 1.0 if abs(x - 0.5) <= half else 0.0


def keyhole(x, y):
    dx, dy = x - 0.5, y - 0.46
    if dx * dx + (y - 0.44) ** 2 <= 0.07 ** 2:
        return True
    return 0.455 <= y <= 0.66 and abs(dx) <= 0.035 * (1 + (y - 0.455) * 2)


def pixel(px, py, size):
    total = [0, 0, 0, 0]
    for sy in range(SCALE):
        for sx in range(SCALE):
            x = (px + (sx + 0.5) / SCALE) / size
            y = (py + (sy + 0.5) / SCALE) / size
            if inside_shield(x, y):
                near_edge = not all(
                    inside_shield(x + ox, y + oy)
                    for ox, oy in ((0.025, 0), (-0.025, 0), (0, 0.025), (0, -0.025)))
                colour = KEY if keyhole(x, y) else (EDGE if near_edge else SHIELD)
            else:
                colour = BG
            for i in range(4):
                total[i] += colour[i]
    n = SCALE * SCALE
    return bytes(c // n for c in total)


def png(size):
    rows = b''.join(
        b'\x00' + b''.join(pixel(px, py, size) for px in range(size))
        for py in range(size))

    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))

    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header)
            + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b''))


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend')
    for name, size in (('icon.png', 80), ('icon_large.png', 130)):
        with open(os.path.join(out, name), 'wb') as f:
            f.write(png(size))
        print('wrote', name, size)
