# Zing Quiz ⚡

A pass-the-phone family quiz for iOS. One phone, 2 to 8 players, ages 8 to 80.

Each player picks an age group once. The game then pitches every question at that player's level,
so a child and a grandparent compete on the same scoreboard and both have a fair shot.

**Question types** (picked at random every turn): multiple choice, emoji puzzles (films, flags,
places), and true or false. The Kid level is hand-written for 8 to 12 year olds. The Family,
Grown-up and Expert levels add several thousand Trivial Pursuit-style general knowledge questions
imported from the Open Trivia Database.
Funny synthesised noises play for right and wrong answers (cheers, boings, sad trombones).

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
  haptics and text to speech to native iOS. The web folder is copied into the app bundle.
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

To refresh the imported trivia bank, run `node tools/import-opentdb.js` (about ten minutes, the API is rate limited).
It rewrites `web/content-trivia.js`, skipping the Politics, Celebrities and Anime categories and capping video games, comics and cartoons.

## Licences

Trivia questions in `web/content-trivia.js` come from the [Open Trivia Database](https://opentdb.com) and are
licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Hand-written questions are original.

Fonts: Atkinson Hyperlegible (Braille Institute, OFL), OpenDyslexic (OFL), Fredoka (OFL). All bundled in `web/fonts/`.
