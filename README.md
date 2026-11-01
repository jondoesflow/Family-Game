# Zing Quiz ⚡

A pass-the-phone family quiz for iOS. One phone, 2 to 8 players, ages 8 to 80.

Each player picks an age group once. The game then pitches every question at that player's level,
so a child and a grandparent compete on the same scoreboard and both have a fair shot.

**Question types** (picked at random every turn): multiple choice, emoji puzzles (films, flags,
places), true or false, and music rounds (a 30 second clip plays; name the song, the artist or the year).
The music bank is every UK number one since 1952 plus a hand-picked set of classics, and the host can narrow
it to genres (pop, rock, dance, soul, hip-hop, indie, country, reggae, soundtracks, jazz and classical, Christmas). The Kid level is hand-written for 8 to 12 year olds. The Family,
Grown-up and Expert levels add several thousand Trivial Pursuit-style general knowledge questions
imported from the Open Trivia Database.
Funny synthesised noises play for right and wrong answers (cheers, boings, sad trombones).

**Categories** (the host picks one or many): General knowledge, Science & nature, Geography & travel,
History, Film TV & books, Music, Sport & games, Food & drink, Famous faces (a photo sharpens slowly, or two
faces mashed together), Dingbats (picture-word puzzles), a Christmas round (opt-in), a hard Friends round
(opt-in, grown-ups only: Kid and Teen players are never given it), and eras from the 1960s to
the 2020s (news, events and music by decade).

**Ways to play**

* **Turn by turn** (default): every round, everyone in the same age group gets the same question. Answers are
  locked in without showing the result, then the round is revealed together with who got it right.
* **Classic**: each player gets their own question and sees the answer straight away.
* **Solo**: one player, 10 to 100 questions straight through, a personal best per length, and a scoreboard of
  how they are doing in each category, all kept on the phone.
* **Teams**: put players in Red, Blue, Green or Yellow. Team totals decide the winner.
* **Link phones** (iOS app only): one phone hosts, others join over Bluetooth and peer-to-peer Wi-Fi using
  Apple's Multipeer Connectivity. No internet or router is needed. Each phone holds its own players, everyone
  answers the same questions at the same time, and the scoreboard syncs after every round. Scoring is fastest
  finger first: 15, 12, 10, then 8 points for the right answers in order of speed.

Famous-face photos are Wikipedia lead images under free licences (CC BY, CC BY-SA, CC0, public domain or the UK
Open Government Licence), bundled in `web/faces/` with the photographer and licence shown on screen and listed
under Settings, Photo credits. Rebuild the set with `node tools/fetch-faces.js` after editing `tools/faces-list.json`.

Music rounds stream preview clips from Apple's iTunes Search API, so they need an internet connection; offline,
the game simply asks other kinds of question. The sound-effects switch never silences music clips.

## Built for ADHD and dyslexia

* One thing on screen at a time. A clear "pass the phone to..." screen between every turn.
* Short questions, large text, left aligned, generous line spacing, warm cream reading cards.
* Three font choices: Atkinson Hyperlegible (default), OpenDyslexic, or the phone's own font.
* Text size: Normal, Large, Huge.
* Every question can be read aloud by the phone (tap 🔊, or turn on automatic read-aloud).
* Timer is off by default. "Gentle" and "Speedy" modes show a soft shrinking bar, never a scary countdown.
* Calm mode reduces motion. Colour is never the only signal: answers carry a letter, a colour and a shape.
* Haptic feedback on iPhone for taps, right and wrong answers.

## How it is built

* `web/` is the whole game: plain HTML, CSS and JavaScript, no build step, no network needed.
  `content.js` and `content-extra.js` hold the question bank.
* `ios/` is a thin SwiftUI shell that shows the game full screen in a WKWebView and bridges
  haptics, text to speech and Multipeer phone linking to native iOS. The web folder is copied into the app bundle.
* `project.yml` describes the Xcode project. CI generates `Zing.xcodeproj` with XcodeGen.
* `fastlane/` + `.github/workflows/testflight.yml` build, sign (fastlane match, certificates
  stored encrypted on a branch of this repo) and upload to TestFlight on a GitHub-hosted Mac.

**No Mac or laptop is required at any point.** See **[SETUP.md](SETUP.md)** for the phone-only steps.

## Developing

```bash
npm install            # Playwright for the browser test
npm run validate       # checks every question: shape, answers, duplicates, readability limits
npm test               # plays a full game in headless Chromium and checks scoring and screens
npm run icon           # re-renders the app icon from tools/icon.html
```

Open `web/index.html` in any browser to play.

### Adding questions

Append to `web/content-core.js` (or `content-extra.js`) following the existing shape, then run `npm run validate`.
`level` is 1 (Kid, 8 to 12), 2 (Family), 3 (Grown-up) or 4 (Expert). Keep hand-written questions under 16 words and options under 4.

To change the music bank, edit `tools/music-list.json` (artist, title, original release year, level) and run
`node tools/resolve-music.js`, which looks up a preview clip for each track and writes `web/content-music.js`.

To refresh the imported trivia bank, run `node tools/import-opentdb.js` (about ten minutes, the API is rate limited).
It rewrites `web/content-trivia.js`, skipping the Politics, Celebrities and Anime categories and capping video games, comics and cartoons.

## Licences

Trivia questions in `web/content-trivia.js` come from the [Open Trivia Database](https://opentdb.com) and are
licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Hand-written questions are original.

Music preview clips are streamed at play time from Apple's iTunes Search API and remain Apple's and the rights
holders' property; nothing is bundled.

Fonts: Atkinson Hyperlegible (Braille Institute, OFL), OpenDyslexic (OFL), Fredoka (OFL). All bundled in `web/fonts/`.
