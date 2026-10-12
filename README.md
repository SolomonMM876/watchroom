# Watchroom Beta

[Open Watchroom](https://SolomonMM876.github.io/watchroom/)

Screen and tab audio sharing, camera and microphone chat, text chat and reactions for two people in desktop Brave or Chrome.

Make a room and send its private invitation link to your partner. Keep the host tab open. Choose a browser tab and enable tab audio when sharing.

The compact top bar leaves more space for the shared screen. The cameras start at the bottom left, directly left of chat and slightly overlapping the screen. Your smaller camera is nested in the partner camera’s bottom-right corner. Drag panel headers and resize from a corner. Layouts are saved in your browser; Reset layout restores the default. Reaction sounds can be disabled by either person.

## Updates

Edit the source files in public and push to main. GitHub Actions builds the static website and publishes it to GitHub Pages. Once deployment finishes, refresh the website. Refreshing the host tab ends the current room, so update between watch sessions.

For a local build, run node scripts/build-website.mjs with Node.js 22 or newer. Serve the website folder on localhost to preview it. No npm packages or server are required for the static build.

## Connection

GitHub Pages hosts the website files. Public PeerJS Cloud provides connection signaling; media and chat travel over WebRTC. Both people need internet access. A TURN relay may be required on some networks; none is included. Camera, mic and sharing require browser permission and HTTPS or localhost. Protected video can prevent capture.

PeerJS 1.5.5 is bundled under its MIT license in public/vendor/PEERJS-LICENSE.txt.
