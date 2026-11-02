# Brain Test: 3 illusions — posting guide

**File:** `brain-test-illusions.mp4` (1080x1920, 30fps, 25.4s, H.264 + AAC, seamless loop)
**Cover:** `cover.jpg` (frame 0, the hook)

## Why this format (what the research says)

| Signal | Finding | Source |
|---|---|---|
| Faceless beats on-camera | Median 114K vs 67K views across 176K videos; 38% more likely to pass 1M | Revid study |
| Little speech wins | Videos with little speech ranked among the highest-view traits | Revid study |
| 15 to 30 s is the sweet spot | Highest engagement rate (6.0%) in a 6M-video brand study | Socialinsider |
| Hook in first 1 to 3 s | Viewers decide in ~2 s; completion rate is the top ranking signal | multiple 2026 guides |
| Shares and saves outrank likes | Ranking order: completion, watch time, saves/shares, comments, likes | multiple 2026 guides |
| Illusions are the all-time kings | Zach King's illusion is the most-viewed TikTok ever (2B+); wordless content travels globally | Dexerto, Databoks |
| Debate drives comments | "Pick A or B" and controversial opinions are the top comment drivers | Socialync |

Every one of those is built into the video: text hook on frame 0, three surprise reveals, a progress bar (completion), "stare at one dot" (watch time), "Comment 1, 2 or 3" (comments), "Send this to someone who won't believe it" (shares), and the last frame crossfades into the first (rewatch loop).

## How to post it

1. **Upload the MP4 as-is.** Do not let TikTok re-crop it; it is already 9:16.
2. **Add a trending sound at low volume** (10 to 20%) in the TikTok editor and keep "original sound" on. The built-in bed is deliberately minimal so a trending sound can sit on top. Trending sounds right now (early Nov 2026): "You're Under Arrest" (ILLIT), "Housewife" (Tate McRae).
3. **Caption** (short, question, no hashtag wall):
   > Which one broke your brain? 1, 2 or 3 👇
4. **Hashtags** (3 to 4 only; the Revid data found 4 is the sweet spot):
   `#opticalillusion #braintest #mindblown #illusion`
5. **Cover:** pick frame 0 (use `cover.jpg` or scrub to the start). The hook text must be readable in the grid.
6. **Pin a comment** within the first minute: "Be honest, which one did you get wrong?" Reply to the first 20 comments; early comment velocity is what pushes a video out of the test pool.
7. **Post time:** 7 to 9 pm local on a weekday, or 11 am to 1 pm at weekends.

## Honest expectations

No one can guarantee virality. The format is built on the best evidence available, but the For You feed tests every video on a small pool first. If it stalls below ~35% completion in the first hour, the hook is the thing to change; if completion is high but shares are low, change the ending.

## Re-rendering or tweaking

The source is in the session scratchpad (`render.html`, `render.js`, `audio/mix.sh`). Change the `T` object at the top of `render.html` to retime scenes, run `node render.js`, then re-run the ffmpeg encode.
