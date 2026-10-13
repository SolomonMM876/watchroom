const MAX_ELECTIONS = 4;

function cancelled() {
  return Object.assign(new Error('This room connection was cancelled.'), { name: 'AbortError' });
}

async function dispose(client) {
  try { await client?.leave(); } catch { /* Preserve the connection or cancellation error. */ }
}

/**
 * Open a reusable two-person room using a capability supplied at runtime.
 * The broker's unique host ID elects one host even when both people arrive
 * together. A timeout does not establish that the existing host is gone.
 */
export async function joinSharedRoom({ roomId, roomSecret, name, iceServers, createClient, isCurrent = () => true } = {}) {
  if (typeof roomId !== 'string' || roomId.length !== 32 || !/^[a-f0-9]{32}$/.test(roomId)
    || typeof roomSecret !== 'string' || roomSecret.length !== 48 || !/^[a-f0-9]{48}$/.test(roomSecret)) {
    throw Object.assign(new Error('This shared room invitation is not valid.'), { status: 403 });
  }
  if (typeof createClient !== 'function' || typeof isCurrent !== 'function') {
    throw new TypeError('A shared room needs a client factory and a connection guard.');
  }

  const options = { roomId, roomSecret, name, iceServers, shared: true };
  const assertCurrent = () => { if (!isCurrent()) throw cancelled(); };
  async function attempt(action) {
    let client;
    try {
      assertCurrent();
      client = await createClient();
      assertCurrent();
      const data = await client[action]({ ...options });
      assertCurrent();
      return { client, data };
    } catch (error) {
      await dispose(client);
      assertCurrent();
      throw error;
    }
  }

  for (let election = 0; election < MAX_ELECTIONS; election++) {
    try {
      return await attempt('create');
    } catch (error) {
      // Only an occupied broker ID warrants entering as a guest. An auth or
      // capacity rejection has a different meaning even if its status is 409.
      if (error?.type !== 'unavailable-id') throw error;
    }

    try {
      return await attempt('join');
    } catch (error) {
      // The host can leave between our failed claim and the guest connection.
      // Re-elect only when the broker confirms that host no longer exists.
      if (error?.type !== 'peer-unavailable' || election === MAX_ELECTIONS - 1) throw error;
    }

    const delay = 200 * 2 ** election + Math.floor(Math.random() * 200);
    await new Promise((resolve) => setTimeout(resolve, delay));
    assertCurrent();
  }
}
