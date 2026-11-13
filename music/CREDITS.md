# Dancing Cats — music credits

The dancing cats' tunes are **generated in the browser with WebAudio** (`lib/cats/music.js`): short loops played by
oscillators. **No recording, audio file or sample is used or downloaded**: there is no audio file in the site. Each loop
is a short, simplified arrangement (4 bars) of the main theme of a composition that is in the public domain worldwide
(each composer died more than 100 years ago). The arrangements were written for ParaFree.

The sound is kept soft on purpose: a plucked, marimba-like lead, a round "tuba" oom-pah bass and a very quiet off-beat
tick, at 15 % volume. The meow on the first sound-on click is also synthesized (a sawtooth oscillator through a moving
band-pass filter). It is not a recording.

| # | Title | Composer (dates) | Composition | Source of the sound | Licence |
|---|-------|------------------|-------------|---------------------|---------|
| 1 | The Entertainer (1902) | Scott Joplin (1868–1917) | Public domain | Generated in code (`music.js`, tune `entertainer`) | No recording used; the arrangement is part of ParaFree's code |
| 2 | Piano Sonata No. 11, K. 331, 3rd movement "Rondo alla Turca" (1783) | Wolfgang Amadeus Mozart (1756–1791) | Public domain | Generated in code (tune `turca`) | No recording used |
| 3 | Galop infernal ("Can-Can"), from *Orphée aux enfers* (1858) | Jacques Offenbach (1819–1880) | Public domain | Generated in code (tune `cancan`) | No recording used |
| 4 | Entry of the Gladiators, Op. 68 (1897) | Julius Fučík (1872–1916) | Public domain | Generated in code (tune `gladiators`) | No recording used |
| 5 | William Tell Overture, finale (1829) | Gioachino Rossini (1792–1868) | Public domain | Generated in code (tune `williamtell`) | No recording used |

Earlier versions also used *Flight of the Bumblebee* (Rimsky-Korsakov) and *In the Hall of the Mountain King* (Grieg).
Both were dropped as too frantic for a study page.

## Why no recordings (Option A)

Option A (Public Domain / CC0 recordings from Musopen, Wikimedia Commons or the Internet Archive, trimmed to 8–15 s) was
not used. The build machine has no audio tool (no ffmpeg / sox) to trim and re-encode a recording to a loop of 150 KB or
less. A full-length file would break the size budget, and an untrimmed recording would not loop.

The licence rule stays the same if recordings are added later. Use only a recording whose own file page states
**Public Domain or CC0 for the recording** (for example a US military band performance marked PD-USGov, or a Musopen
upload marked CC0). Add a row here with its title, performer, source URL and licence. If a recording's licence is
unclear, keep the generated tune for that slot.
