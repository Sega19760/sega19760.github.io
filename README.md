# A day in the life of alex14534



## Multiplayer signaling server

To enable internet multiplayer you now need a small Node.js signaling relay:

1. Install dependencies: `npm install`
2. Start the relay: `npm start` (or `node signaling-server.js`)
3. Expose the port to the public internet. For example, with ngrok run `ngrok http 3000` and copy the generated `https://...ngrok-free.app` address.
4. In the in-game network panel paste the matching `wss://...` URL, then click **Browse Lobbies** to pick a room or **Create Lobby** to host with a custom name and capacity.

The relay now exposes `GET /rooms` for the lobby browser so every client can discover public rooms. Only WebRTC handshake data flows through the server — all gameplay packets remain peer-to-peer.

## Gamepad & touch controls

Controller users can move with the left stick, aim with the right stick, fire with RT, jump with A (double-jump and wall-climb by holding near walls), and slide or dash with B/X. Hold LT to open the weapon wheel. Press View to toggle the third-person camera.

On touchscreen devices, the on-screen joysticks handle movement and looking, while the action buttons trigger jump, dash, slide, weapon wheel, and shooting. Tap the Shoot button once for single-fire weapons or hold it to maintain the Pee Stream.

## Movement upgrades

Movement has been expanded with sprinting slides, air dashes, double jumps, and wall-climbs. Use sliding while grounded for a burst of speed, tap dash in mid-air to vault forward, and hold jump while hugging surfaces to shimmy up the Alexland house or other structures.
