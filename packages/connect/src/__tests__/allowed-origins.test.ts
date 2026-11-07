// The origins `mn serve --allow-origin` takes: what a browser sends as its page's Origin.

import { describe, it, expect } from 'vitest';
import { UsageError } from '@kuiralabs/midnight-cli-core';
import { originOfPage, parseAllowedOrigin, parseAllowedOrigins } from '../lib/allowed-origins.ts';

describe('parseAllowedOrigin', () => {
  it.each([
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://localhost:5173/', 'http://localhost:5173'],
    ['HTTP://LocalHost:5173', 'http://localhost:5173'],
    ['https://app.example.com', 'https://app.example.com'],
    ['https://app.example.com:443', 'https://app.example.com'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
  ])('reads %s as the origin a browser sends, %s', (input, origin) => {
    expect(parseAllowedOrigin(input)).toBe(origin);
  });

  it.each([
    ['localhost:5173', /not an http or https origin/],
    ['not a url', /not an origin/],
    ['*', /not an origin/],
    ['null', /not an origin/],
    ['file:///tmp/app.html', /not an http or https origin/],
    ['ws://localhost:9932', /not an http or https origin/],
    ['http://localhost:5173/app', /has more than an origin: give only the scheme, host and port \(http:\/\/localhost:5173\)/],
    ['http://localhost:5173/?x=1', /has more than an origin/],
    ['http://localhost:5173/#top', /has more than an origin/],
    ['http://user@localhost:5173', /has more than an origin/],
  ])('refuses %s as a usage error naming the value', (input, reason) => {
    const refused = (() => { try { parseAllowedOrigin(input); } catch (e) { return e; } })();
    expect(refused).toBeInstanceOf(UsageError);
    expect((refused as Error).message).toContain(`--allow-origin "${input}"`);
    expect((refused as Error).message).toMatch(reason);
  });

  it('reads several, each once', () => {
    expect(parseAllowedOrigins(['http://localhost:5173', 'http://localhost:5173/', 'https://a.example'])).toEqual(['http://localhost:5173', 'https://a.example']);
    expect(parseAllowedOrigins([])).toEqual([]);
  });
});

describe('originOfPage', () => {
  it('is the scheme, host and port of the page', () => {
    expect(originOfPage('http://localhost:4173/')).toBe('http://localhost:4173');
    expect(originOfPage('http://localhost:3000/app/index.html?x=1')).toBe('http://localhost:3000');
  });
});
