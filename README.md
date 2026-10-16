# Watchroom Beta

[Open Watchroom](https://SolomonMM876.github.io/watchroom/)

Direct shared links, screen and tab audio sharing, camera and microphone calls, and reactions for two people in desktop Brave or Chrome.

Open a link lets either person send a movie, episode or webpage address. Each device loads that page directly inside Watchroom. Cross-origin browsing stays local, so paste a new movie or episode link to change it for both. The countdown cues manual playback. Open in new tab is always available if a site blocks embedding or its player does not work inside the room. YouTube and Vimeo links use their official embed players; direct MP4/WebM/OGV files use a native player. Links stay in room memory and are shared with a joining or reconnecting partner.

Make a room and send its private invitation link to your partner. Keep the host tab open. Choose a browser tab and enable tab audio when sharing.

Molomon can open one reusable shared room automatically after Google sign-in. Its private Firebase access document supplies the room ID and key at runtime. The shared invitation uses shared=1 in its fragment: the first arrival hosts, the second joins, and setup is skipped. Camera and microphone begin off. After a host leaves or refreshes, the remaining person tries to reopen the same room. Keep the private room key out of this public repository.

The webpage fills the workspace. Two compact camera tiles float above the lower-right toolbars; text chat has been removed. Fullscreen with cameras expands the whole Watchroom, keeping both webcams and room controls visible. Press Escape or Exit fullscreen to return. Focus view also keeps the cameras visible. Drag panel headers and resize from a corner in normal desktop view. Layouts are saved in your browser; Reset layout restores the default. Reactions and their sound setting are available from the compact Reactions menu.

## Updates

Edit the source files in public and push to main. GitHub Actions builds the static website and publishes it to GitHub Pages. Once deployment finishes, refresh the website. Refreshing the host tab ends the current room, so update between watch sessions.

For a local build, run node scripts/build-website.mjs with Node.js 22 or newer. Serve the website folder on localhost to preview it. No npm packages or server are required for the static build.

## Connection

GitHub Pages hosts the website files. Public PeerJS Cloud provides connection signaling; media and room controls travel over WebRTC. Both people need internet access. Connected means both media transport and the message channel are ready. Reconnect remains available if controls or media stop responding, and capture permissions are preserved during reconnection. A TURN relay may be required on some networks; none is included. Camera, mic and sharing require browser permission and HTTPS or localhost. Protected video can prevent capture.

PeerJS 1.5.5 is bundled under its MIT license in public/vendor/PEERJS-LICENSE.txt.
