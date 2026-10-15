import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWatchLink } from '../public/watch-link.js';

const appOrigin = 'https://room.example.test';
const parse = (value, options = { appOrigin }) => parseWatchLink(value, options);

test('a webpage keeps its original address for the iframe and external fallback', () => {
  const url = 'https://www.example.test/watch/movie?token=a%2Fb%2BC&expires=123#player';
  assert.deepEqual(parse(`  ${url}  `), { url, embedUrl: url, kind: 'page', hostname: 'www.example.test' });
});

test('native files preserve signed queries and fragments without rewriting their address', () => {
  for (const extension of ['mp4', 'webm', 'ogv', 'MP4']) {
    const url = `https://media.example.test/Movie.${extension}?Signature=a%2Fb%3D&key=hello+world#t=20`;
    assert.deepEqual(parse(url), { url, embedUrl: url, kind: 'video', hostname: 'media.example.test' });
  }
  assert.equal(parse('https://media.example.test/movie.mp4/page').kind, 'page');
  assert.equal(parse('https://media.example.test/watch?file=movie.mp4').kind, 'page');
});

test('YouTube watch, short, shorts, and embed links select the same official player', () => {
  const id = 'M7lc1UVf-VE';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
  ]) {
    const result = parse(url);
    assert.equal(result.url, url);
    assert.equal(result.embedUrl, `https://www.youtube.com/embed/${id}`);
    assert.equal(result.kind, 'page');
  }
});

test('YouTube timestamps, playlist IDs, and existing embed options are retained', () => {
  const id = 'M7lc1UVf-VE';
  assert.equal(parse(`https://youtu.be/${id}?t=1h2m3s`).embedUrl, `https://www.youtube.com/embed/${id}?start=3723`);
  assert.equal(parse(`https://youtube.com/watch?v=${id}#t=2m`).embedUrl, `https://www.youtube.com/embed/${id}?start=120`);
  assert.equal(parse(`https://youtube.com/watch?v=${id}&start=20&end=50&list=PL_test`).embedUrl,
    `https://www.youtube.com/embed/${id}?start=20&end=50&list=PL_test`);
  const embed = `https://www.youtube-nocookie.com/embed/${id}?start=12&rel=0`;
  assert.equal(parse(embed).embedUrl, embed);
  assert.equal(parse(`https://youtu.be/${id}?t=9007199254740991`).embedUrl, `https://www.youtube.com/embed/${id}`);
});

test('Vimeo numeric links use the official player and retain unlisted access hashes', () => {
  for (const url of ['https://vimeo.com/76979871', 'https://www.vimeo.com/76979871']) {
    assert.equal(parse(url).embedUrl, 'https://player.vimeo.com/video/76979871');
    assert.equal(parse(url).url, url);
  }
  assert.equal(parse('https://vimeo.com/76979871?quality=720p&h=private123').embedUrl,
    'https://player.vimeo.com/video/76979871?quality=720p&h=private123');
  assert.equal(parse('https://vimeo.com/76979871/private123').embedUrl,
    'https://player.vimeo.com/video/76979871?h=private123');
  const embed = 'https://player.vimeo.com/video/76979871?h=private123#t=10s';
  assert.equal(parse(embed).embedUrl, embed);
});

test('lookalike hosts and unsupported provider routes stay ordinary webpages', () => {
  for (const url of [
    'https://youtube.com.evil.test/watch?v=M7lc1UVf-VE',
    'https://evil-youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtu.be.evil.test/M7lc1UVf-VE',
    'https://player.vimeo.com.evil.test/video/76979871',
    'https://vimeo.com.evil.test/76979871',
    'https://www.youtube.com:8443/watch?v=M7lc1UVf-VE',
    'https://youtube.com/watch?v=invalid',
    'https://youtube.com/channel/M7lc1UVf-VE',
    'https://vimeo.com/channels/staffpicks/76979871',
  ]) {
    assert.equal(parse(url).embedUrl, url);
    assert.equal(parse(url).kind, 'page');
  }
});

test('unsafe schemes, malformed links, userinfo, and controls are rejected', () => {
  for (const value of [
    '', '   ', null, 123, {}, 'example.test/watch', '//example.test/watch',
    'https:example.test', 'https://', 'https:///example.test', 'https://[invalid]/',
    'javascript:alert(1)', 'data:text/html,hello', 'blob:https://example.test/id',
    'file:///private/movie.mp4', 'http://example.test/watch',
    'https://user:password@example.test/watch', 'https://user@example.test/watch',
    'https://@example.test/watch', 'https://room.example.test@evil.test/watch',
    'https://example.test/watch\n', '\thttps://example.test/watch',
    'https://example.test/a\u0000b', 'https://example.test/a\u007fb',
    'https://example.test/a\u0085b', 'https://example.test\\@evil.test/watch',
    `https://example.test/${'a'.repeat(4096)}`,
  ]) {
    assert.throws(() => parse(value), TypeError, `Expected to reject ${JSON.stringify(value)}`);
  }
});

test('the application origin cannot be embedded through case, ports, or URL normalization', () => {
  for (const value of [
    'https://room.example.test/',
    'https://ROOM.example.test/path?query=value',
    'https://room.example.test:443/../watchroom#private',
  ]) assert.throws(() => parse(value), /outside Watchroom/);
  assert.equal(parse('https://room.example.test:8443/movie').hostname, 'room.example.test');
  assert.throws(() => parse('https://youtu.be/M7lc1UVf-VE', { appOrigin: 'https://www.youtube.com' }), /outside Watchroom/);
  assert.throws(() => parse('https://vimeo.com/76979871', { appOrigin: 'https://player.vimeo.com' }), /outside Watchroom/);
});

test('HTTP fixtures require a local HTTP application and a different local origin', () => {
  const options = { appOrigin: 'http://localhost:3000' };
  for (const url of [
    'http://localhost:3001/movie.mp4',
    'http://127.0.0.1:3001/player',
    'http://[::1]:3001/player',
  ]) assert.equal(parse(url, options).url, url);
  for (const url of [
    'http://localhost:3000/player',
    'http://example.test/player',
    'http://localhost.evil.test:3001/player',
    'http://127.0.0.2:3001/player',
  ]) assert.throws(() => parse(url, options), TypeError);
  assert.throws(() => parse('http://localhost:3001/player'), /HTTPS/);
  assert.throws(() => parse('http://localhost:3001/player', { appOrigin: 'https://localhost:3000' }), /HTTPS/);
  assert.throws(() => parse('http://localhost:3001/player', { appOrigin: 'http://example.test' }), /HTTPS/);
});

test('invalid application origin configuration fails closed', () => {
  for (const value of ['not an origin', 'javascript:alert(1)', 'https://user:password@room.example.test']) {
    assert.throws(() => parse('https://movie.example.test/watch', { appOrigin: value }), TypeError);
  }
});
