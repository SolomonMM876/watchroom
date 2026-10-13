// Show the watch workspace immediately for the reusable room entry.
const entry = new URLSearchParams(location.hash.slice(1));
const directRooms = location.protocol === 'chrome-extension:'
  || document.querySelector('meta[name="watchroom-transport"]')?.content === 'peerjs'
  || new URLSearchParams(location.search).get('portable') === '1';
if (directRooms && entry.get('shared') === '1') document.documentElement.classList.add('shared-room-entry');
