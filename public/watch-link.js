const MAX_URL_LENGTH = 4096;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTUBE_EMBED_HOSTS = new Set(['youtube-nocookie.com', 'www.youtube-nocookie.com']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function invalid(message) {
  return new TypeError(message);
}

function parseAppOrigin(value) {
  if (value === undefined || value === null) return null;
  let parsed;
  try { parsed = new URL(value); } catch { throw invalid('Watchroom could not validate its page address.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw invalid('Watchroom could not validate its page address.');
  }
  return parsed;
}

function timestamp(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : null;
  }
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!parts || !parts.slice(1).some(Boolean)) return null;
  const seconds = Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0);
  return Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : null;
}

function youtubeEmbed(link) {
  // A different port or a lookalike hostname is an ordinary webpage, never a
  // request to transform another site's address into a YouTube embed.
  if (link.port) return null;
  let id;
  let alreadyEmbedded = false;
  if (link.hostname === 'youtu.be') {
    const path = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(link.pathname);
    id = path?.[1];
  } else if (YOUTUBE_HOSTS.has(link.hostname)) {
    if (link.pathname === '/watch') id = link.searchParams.get('v');
    else {
      const path = /^\/(shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(link.pathname);
      id = path?.[2];
      alreadyEmbedded = path?.[1] === 'embed';
    }
  } else if (YOUTUBE_EMBED_HOSTS.has(link.hostname)) {
    const path = /^\/embed\/([A-Za-z0-9_-]{11})\/?$/.exec(link.pathname);
    id = path?.[1];
    alreadyEmbedded = Boolean(path);
  }
  if (!id || !VIDEO_ID.test(id)) return null;
  if (alreadyEmbedded) return link.href;

  const embed = new URL(`https://www.youtube.com/embed/${id}`);
  const fragment = new URLSearchParams(link.hash.slice(1));
  const start = timestamp(link.searchParams.get('start') || link.searchParams.get('t') || fragment.get('t'));
  if (start !== null) embed.searchParams.set('start', String(start));
  const end = timestamp(link.searchParams.get('end'));
  if (end !== null) embed.searchParams.set('end', String(end));
  const list = link.searchParams.get('list');
  if (list && /^[A-Za-z0-9_-]{1,128}$/.test(list)) embed.searchParams.set('list', list);
  return embed.href;
}

function vimeoEmbed(link) {
  if (link.port) return null;
  if (link.hostname === 'player.vimeo.com' && /^\/video\/[1-9]\d{0,19}\/?$/.test(link.pathname)) {
    return link.href;
  }
  if (!VIMEO_HOSTS.has(link.hostname)) return null;
  const path = /^\/([1-9]\d{0,19})(?:\/([A-Za-z0-9]+))?\/?$/.exec(link.pathname);
  if (!path) return null;
  const embed = new URL(`https://player.vimeo.com/video/${path[1]}`);
  // Vimeo's unlisted-video hash is required to view the video. Preserve the
  // supplied query, and translate an unlisted path hash to its embed parameter.
  embed.search = link.search;
  if (path[2]) embed.searchParams.set('h', path[2]);
  embed.hash = link.hash;
  return embed.href;
}

/**
 * Describe a shared link without fetching it or changing a site's embed rules.
 * Only direct video files use a native video element. Provider players and all
 * other webpages use an iframe with the original URL available as a fallback.
 */
export function parseWatchLink(value, { appOrigin = globalThis.location?.origin } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid('Paste the HTTPS link you want to watch.');
  }
  if (value.length > MAX_URL_LENGTH) throw invalid('That link is too long.');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value) || value.includes('\\')) {
    throw invalid('That link contains an invalid character.');
  }
  const url = value.trim();
  if (!/^https?:\/\//i.test(url)) throw invalid('Use a complete HTTPS link.');
  let link;
  try { link = new URL(url); } catch { throw invalid('That link is not a valid webpage address.'); }
  // Reject even empty userinfo such as https://@example.com rather than relying
  // on URL.username, which normalizes empty credentials away.
  const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1];
  if (!authority || !link.hostname) throw invalid('That link is not a valid webpage address.');
  if (link.username || link.password || authority.includes('@')) {
    throw invalid('Use a link without a username or password in its address.');
  }
  const app = parseAppOrigin(appOrigin);
  const localFixture = app?.protocol === 'http:' && LOCAL_HOSTS.has(app.hostname)
    && link.protocol === 'http:' && LOCAL_HOSTS.has(link.hostname);
  if (link.protocol !== 'https:' && !localFixture) throw invalid('Use an HTTPS link.');
  if (app && link.origin === app.origin) throw invalid('Choose a link outside Watchroom.');

  const kind = /\.(?:mp4|webm|ogv)$/i.test(link.pathname) ? 'video' : 'page';
  const embedUrl = kind === 'video' ? url : (youtubeEmbed(link) || vimeoEmbed(link) || url);
  if (app && new URL(embedUrl).origin === app.origin) throw invalid('Choose a link outside Watchroom.');
  return { url, embedUrl, kind, hostname: link.hostname };
}
