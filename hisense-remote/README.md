# Hisense phone remote

A remote control for a Hisense (VIDAA) TV that runs in your phone's browser.

Phones cannot talk to the TV directly from a web page, so this comes in two parts:

1. **The bridge** (`server.js`): a tiny Node program that runs on any computer on your home
   Wi‑Fi (a laptop, a Mac mini, a Raspberry Pi, a NAS). It talks to the TV over the TV's
   own local control service (MQTT over TLS on port 36669, the same thing the official
   VIDAA app uses) and serves the remote web page.
2. **The remote page** (`public/index.html`): open it on your phone, tap **Share → Add to
   Home Screen** and it behaves like an app: full screen, dark, with a D‑pad, volume and
   channel rockers, playback keys, app shortcuts, number pad and colour keys.

No cloud, no account, nothing leaves your network.

## Quick start

You need Node.js 18 or newer on the computer that will run the bridge.

```bash
cd hisense-remote
npm install
node server.js
```

The bridge prints the address to open on your phone, for example `http://192.168.1.20:8585/`.
Open it, tap the **gear**, tap **Scan for TVs on the network**, pick your TV and tap
**Save and connect**. If the scan finds nothing, type the TV's IP address (on the TV:
Settings → Network → Network information).

The first time, the TV shows a **4‑digit PIN** on screen. Type it into the banner at the top
of the remote. The TV then issues a token that the bridge saves in `data/tokens.json`, so you
only pair once (the TV renews the token automatically for about 30 days of use).

You can also pass the TV address on the command line or in the environment:

```bash
node server.js --tv 192.168.1.50                      # MAC is looked up automatically
node server.js --tv 192.168.1.50 --mac A8:B1:2C:3D:4E:5F --port 8585
HISENSE_TV_HOST=192.168.1.50 node server.js
```

## Buttons

| Area | Keys sent to the TV |
|---|---|
| Top row | Power, Input picker (TV / HDMI 1‑4 / AV, or the TV's own source list), Home |
| D‑pad | Up, Down, Left, Right, OK (hold an arrow to repeat) |
| Below the pad | Back, Menu, Exit |
| Rockers | Volume up/down (hold to repeat), Mute, Info, Channel up/down |
| Playback | Rewind, Play, Pause, Stop, Fast forward |
| Apps | Netflix, YouTube, Prime Video, Disney+, plus "Apps on the TV" to load the full list |
| Folded away | Red/Green/Yellow/Blue, digits 0‑9, Subtitles, channel dot |
| Lightning icon | Wake‑on‑LAN, for when the TV is fully off and not answering |

## Keeping it running

Run the bridge somewhere that stays on. Two easy options:

* **pm2**: `npx pm2 start server.js --name tv-remote -- --tv 192.168.1.50`
* **systemd** (Raspberry Pi / Linux):

  ```ini
  [Unit]
  Description=Hisense phone remote
  After=network-online.target

  [Service]
  ExecStart=/usr/bin/node /path/to/hisense-remote/server.js --quiet
  WorkingDirectory=/path/to/hisense-remote
  Restart=always
  User=pi

  [Install]
  WantedBy=multi-user.target
  ```

Give the TV a fixed IP address in your router (DHCP reservation) so the address never changes.

## Troubleshooting

* **"TV not reachable"**: the TV is off, on a different network, or the address is wrong.
  Many Hisense TVs keep the control service running in standby; if yours does not, enable
  *Wake on LAN* / *Wake on Wireless Network* in the TV's network settings and use the
  lightning button.
* **No PIN appears**: tap the gear → **Pair again**. Older TVs never show a PIN; the buttons
  simply work.
* **"TV refused the connection"**: the login scheme depends on the TV's firmware. The bridge
  tries all four known schemes (modern, middle, legacy and the old static password). If every
  one fails, update the TV's firmware and try **Forget pairing**. The gear sheet shows which
  scheme and protocol version were detected.
* **Phone can't open the page**: the phone must be on the same Wi‑Fi as the bridge. Some
  routers isolate guest or IoT networks from each other.
* **Wrong TV picked up by scan**: the scan lists any UPnP media renderer; Hisense TVs are
  marked, others say "probably not a Hisense".

## How it works

* The TV's control protocol was reverse engineered by the community. The bridge connects with
  the client certificate the official app uses (`certs/`, from the MIT‑licensed
  [vidaa-control](https://pypi.org/project/vidaa-control/) project) and a username/password
  derived from the TV's MAC address and the current time (`lib/credentials.js`).
* Pairing: `vidaa_app_connect` → PIN on screen → `authenticationcode` → `gettoken` →
  the TV sends access/refresh tokens. Later connections use the access token as the password.
* Buttons publish `KEY_*` names to `/remoteapp/tv/remote_service/<client>/actions/sendkey`.
* `lib/net.js` handles UPnP discovery, protocol-version detection on port 38400, ARP lookup
  of the TV's MAC address and Wake‑on‑LAN.

## Development

```bash
npm test
```

`test/mock-tv.js` is a fake TV (an MQTT broker over TLS that insists on the client certificate,
checks the derived login, shows a PIN and issues tokens). `test/bridge.test.js` pairs with it,
sends keys, restarts the bridge and checks it reconnects with the saved token.

The bridge has no login of its own: anyone on your Wi‑Fi who knows the address can press
buttons on your TV. Do not expose the port to the internet.
