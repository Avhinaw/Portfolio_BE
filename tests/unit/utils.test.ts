import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../src/utils/duration';
import { ROOM_ID_REGEX, generateRoomId, generateVisitorToken, hashToken, safeEqualHex, safeStringEqual } from '../../src/utils/roomId';
import { sanitizeText } from '../../src/utils/sanitize';

describe('roomId / tokens', () => {
  it('generates unique, unguessable 32-char room ids', () => {
    const ids = new Set(Array.from({ length: 2000 }, generateRoomId));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(ROOM_ID_REGEX);
  });

  it('generates long visitor tokens and compares hashes in constant time', () => {
    const token = generateVisitorToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(safeEqualHex(hashToken(token), hashToken(token))).toBe(true);
    expect(safeEqualHex(hashToken(token), hashToken(`${token}x`))).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
    expect(safeStringEqual('a', 'a')).toBe(true);
    expect(safeStringEqual('a', 'b')).toBe(false);
  });
});

describe('sanitizeText', () => {
  it('normalises whitespace and removes control / bidi characters', () => {
    expect(sanitizeText('  a \t b\n\nc ')).toBe('a b c');
    expect(sanitizeText('x\u0000y\u202Ez')).toBe('x y z');
    expect(sanitizeText('<b>kept as text</b>')).toBe('<b>kept as text</b>'); // output encoding is the client's job
  });
});

describe('parseDuration', () => {
  it.each([
    ['90', 90],
    ['90s', 90],
    ['15m', 900],
    ['4h', 14_400],
    ['1d', 86_400],
  ])('parses %s', (input, seconds) => expect(parseDuration(input)).toBe(seconds));

  it.each(['', 'abc', '-5m', '1.5h', '10x'])('rejects %j', (input) => expect(parseDuration(input)).toBeNull());
});
