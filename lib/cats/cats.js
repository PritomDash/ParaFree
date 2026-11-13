// ParaFree — Dancing Cats widget (lib/cats/cats.js). Fetched by lib/cats/loader.js once the page is idle.
// Two original cartoon cats (ginger + grey-striped) in the bottom-right corner, dancing to public-domain tunes.
//   • Renderer slot: the cats are drawn by ONE renderer (PFCats.renderers.svg by default). A transparent WebM loop can
//     replace them without touching the widget: <script src="/lib/cats/loader.js" data-renderer="video"
//     data-src="/lib/cats/cats.webm" defer> (or PFCats.setRenderer('video', { src, srcs: { sway, hop, kick } })).
//   • Sound is OFF until the user clicks 🔊; lib/cats/music.js (WebAudio, no audio files) loads only then.
//   • Layout: on the home page (wide screens) one cat stands on each side of the hero text; on other tool pages the
//     bottom-right corner; on screens of 768 px or less nothing (the loader doesn't even fetch this file there).
//   • Never covers anything clickable: in the corner it checks what is under it and moves up (or hides).
//   • Hidden while a tool is working, while a menu / dialog / consent banner is open, and when closed (remembered).
//   • No network calls except its own two scripts, no cookies, no tracking. localStorage only, always in try/catch.
(function () {
  'use strict';
  if (window.PFCats) return;
  var me = document.currentScript;
  var BASE = me && me.src ? me.src.replace(/cats\.js(\?.*)?$/, '') : '/lib/cats/';
  var VOLUME = 0.15;
  var BUBBLE_EVERY = window.PF_CATS_BUBBLE_MS || 5 * 60 * 1000;    // at most one bubble per ~5 minutes (all pages)
  var BUBBLE_FIRST = window.PF_CATS_BUBBLE_FIRST_MS || 90 * 1000;  // …and not before 90 s on the site
  var BUBBLE_SHOW = 4000;
  var CELEBRATE_MS = 3000;
  var MESSAGES = ['Take a little break! 🐱', 'Study hard, dance harder!', "Keep going, you're doing great!",
    'Even cats need study breaks!', 'Your assignment is waiting! 😂'];
  // Five dance + tune pairs ("next dance" switches both). Tunes: lib/cats/music.js — all public-domain compositions.
  var COMBOS = [
    { tune: 'entertainer', dance: 'sway', bpm: 104, title: 'The Entertainer (Joplin)' },
    { tune: 'turca', dance: 'hop', bpm: 126, title: 'Rondo alla Turca (Mozart)' },
    { tune: 'cancan', dance: 'kick', bpm: 132, title: 'Can-Can (Offenbach)' },
    { tune: 'gladiators', dance: 'sway', bpm: 116, title: 'Entry of the Gladiators (Fučík)' },
    { tune: 'williamtell', dance: 'hop', bpm: 126, title: 'William Tell Overture finale (Rossini)' },
  ];

  // ── storage (every read / write in try/catch — private windows and blocked storage just forget) ──
  function load(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } }
  function save(k, v) { try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, String(v)); } catch (_) {} }

  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}

  // ── renderers: mount(slot, opts) → { setDance(name, beatSeconds), celebrate(ms), pause(), resume(), destroy() } ──
  function catSvg(main, dark, belly) {
    var ink = '#2b2622';
    return '<g class="pfc-cat">' +
      '<path class="pfc-tail" d="M62 104C86 100 90 76 80 60" fill="none" stroke="' + dark + '" stroke-width="7" stroke-linecap="round"/>' +
      '<ellipse class="pfc-fl" cx="33" cy="117" rx="10" ry="5.5" fill="' + main + '"/>' +
      '<ellipse class="pfc-fr" cx="57" cy="117" rx="10" ry="5.5" fill="' + main + '"/>' +
      '<ellipse cx="45" cy="94" rx="24" ry="25" fill="' + main + '"/>' +
      '<ellipse cx="45" cy="99" rx="13" ry="16" fill="' + belly + '"/>' +
      '<path d="M23 87q6 2 9-1M67 87q-6 2-9-1M22 97q6 2 9-1M68 97q-6 2-9-1" fill="none" stroke="' + dark + '" stroke-width="3" stroke-linecap="round"/>' +
      '<g class="pfc-pl"><path d="M29 82L15 100" stroke="' + main + '" stroke-width="9" stroke-linecap="round"/><circle cx="15" cy="100" r="5.5" fill="' + belly + '"/></g>' +
      '<g class="pfc-pr"><path d="M61 82L75 100" stroke="' + main + '" stroke-width="9" stroke-linecap="round"/><circle cx="75" cy="100" r="5.5" fill="' + belly + '"/></g>' +
      '<g class="pfc-head">' +
        '<path d="M23 42L21 14L40 31Z" fill="' + main + '"/><path d="M26 36L25 21L35 30Z" fill="#f6b6c1"/>' +
        '<path d="M67 42L69 14L50 31Z" fill="' + main + '"/><path d="M64 36L65 21L55 30Z" fill="#f6b6c1"/>' +
        '<ellipse cx="45" cy="50" rx="27" ry="22" fill="' + main + '"/>' +
        '<path d="M45 29v8M38 31l2 6M52 31l-2 6" stroke="' + dark + '" stroke-width="2.6" stroke-linecap="round"/>' +
        '<ellipse cx="36" cy="50" rx="3.4" ry="4.4" fill="' + ink + '"/><ellipse cx="54" cy="50" rx="3.4" ry="4.4" fill="' + ink + '"/>' +
        '<circle cx="37.2" cy="48.4" r="1.1" fill="#fff"/><circle cx="55.2" cy="48.4" r="1.1" fill="#fff"/>' +
        '<circle cx="30" cy="58" r="4" fill="#f6a5b5" opacity=".55"/><circle cx="60" cy="58" r="4" fill="#f6a5b5" opacity=".55"/>' +
        '<path d="M42.5 56h5l-2.5 3z" fill="#e2747f"/>' +
        '<path d="M45 59q-3 4-7 1M45 59q3 4 7 1" fill="none" stroke="' + ink + '" stroke-width="1.4" stroke-linecap="round"/>' +
        '<path d="M28 55H16M28 58l-11 3M62 55h12M62 58l11 3" stroke="' + ink + '" stroke-width="1" opacity=".55"/>' +
      '</g></g>';
  }
  // one cat (viewBox 100×130) or the pair (200×130); each stands on a soft ground shadow that stays on the floor
  var GINGER = ['#f2a65a', '#d9822b', '#fde3c4'], GREY = ['#a3adb8', '#5f6b78', '#e6e9ed'];
  var svgN = 0;
  function svgFor(which) {
    var id = 'pfcSh' + (++svgN);
    var defs = '<defs><radialGradient id="' + id + '"><stop offset="0" stop-color="#000" stop-opacity=".34"/><stop offset=".6" stop-color="#000" stop-opacity=".16"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs>';
    var g = function (c, x) { return '<g transform="translate(' + x + ' 2)"><ellipse class="pfc-shadow" cx="45" cy="122" rx="34" ry="6" fill="url(#' + id + ')"/>' + catSvg(c[0], c[1], c[2]) + '</g>'; };
    var spark = function (w) { return '<g class="pfc-spark" font-size="14" fill="#2d6a4f"><text x="' + (w / 2 - 4) + '" y="16">♪</text><text x="6" y="22">✨</text><text x="' + (w - 22) + '" y="20">♫</text></g>'; };
    if (which === 'both') return '<svg viewBox="0 0 200 130" width="100%" focusable="false" aria-hidden="true">' + defs + g(GINGER, 6) + g(GREY, 104) + spark(200) + '</svg>';
    return '<svg viewBox="0 0 100 130" width="100%" focusable="false" aria-hidden="true">' + defs + g(which === 'grey' ? GREY : GINGER, 5) + spark(100) + '</svg>';
  }

  var renderers = {
    // opts.which: 'both' (corner) | 'ginger' | 'grey' (one per side of the home-page hero)
    svg: function (slot, opts) {
      slot.innerHTML = svgFor(opts.which || 'both');
      var t = null;
      return {
        setDance: function (name) { slot.setAttribute('data-dance', name); },
        celebrate: function (ms) { slot.classList.add('pfc-celebrate'); clearTimeout(t); t = setTimeout(function () { slot.classList.remove('pfc-celebrate'); }, ms); },
        pause: function () {}, resume: function () {},   // CSS animations follow the widget's pfc-paused class
        destroy: function () { clearTimeout(t); slot.innerHTML = ''; slot.removeAttribute('data-dance'); },
      };
    },
    // Transparent WebM loop (VP9 with alpha). opts.src = one loop for every dance, or opts.srcs = { sway, hop, kick };
    // per side of the hero: opts.left / opts.right (same shape) — otherwise both sides play opts.src.
    video: function (slot, opts) {
      var o = (opts.which === 'ginger' && opts.left) || (opts.which === 'grey' && opts.right) || opts;
      var v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true');
      v.preload = 'auto'; v.style.cssText = 'display:block;width:100%;height:auto';
      v.src = (o.srcs && o.srcs.sway) || o.src;
      slot.appendChild(v);
      var play = function () { if (!reduced) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } };
      play();
      var t = null;
      return {
        setDance: function (name, beat) {
          var s = (o.srcs && o.srcs[name]) || o.src;
          if (s && v.getAttribute('src') !== s) { v.src = s; play(); }
          v.playbackRate = Math.max(0.5, Math.min(2, (o.beat || 0.5) / beat));
        },
        celebrate: function (ms) { var r = v.playbackRate; v.playbackRate = Math.min(2, r * 1.6); clearTimeout(t); t = setTimeout(function () { v.playbackRate = r; }, ms); },
        pause: function () { v.pause(); }, resume: play,
        destroy: function () { clearTimeout(t); v.pause(); v.remove(); },
      };
    },
  };

  // ── styles ──
  var CSS = '' +
    '#pfc{pointer-events:none;font:12px/1.25 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1814;transition:opacity .25s,bottom .3s;--b:.45s}' +
    // corner (desktop tool pages): fixed, bottom-right
    '#pfc.pfc-corner{position:fixed;right:20px;bottom:15px;width:160px;z-index:150}' +
    // hero (home page, wide screens): one cat on each side of the hero text, standing on the hero's bottom edge
    '#pfc.pfc-hero{position:absolute;inset:0;z-index:1}' +
    '#pfc.pfc-hero .pfc-side{position:absolute;bottom:10px;width:var(--cw,150px)}' +
    '#pfc.pfc-hero .pfc-left{left:var(--gap,24px)}#pfc.pfc-hero .pfc-right{right:var(--gap,24px)}' +
    '#pfc.pfc-hero .pfc-ctrl{justify-content:center}' +
    // a hero cat fades out while it would sit under the fixed header or any floating button (e.g. "Open Tool")
    '#pfc .pfc-side{transition:opacity .2s}#pfc .pfc-dodge{opacity:0;visibility:hidden}' +
    '#pfc.pfc-none{display:none}' +
    '#pfc.pfc-off{opacity:0;visibility:hidden}' +
    '#pfc button{all:unset;box-sizing:border-box;cursor:pointer;pointer-events:auto;-webkit-tap-highlight-color:transparent}' +
    '#pfc button:focus-visible{outline:2px solid #2d6a4f;outline-offset:2px;border-radius:8px}' +
    '#pfc.pfc-hero button:focus-visible{outline-color:#d8f3dc}' +
    '#pfc .pfc-ctrl{display:flex;justify-content:flex-end;gap:4px;height:26px;align-items:center;margin-bottom:16px}' +
    '#pfc .pfc-ctrl button{width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.94);border:1px solid rgba(0,0,0,.14);box-shadow:0 1px 3px rgba(0,0,0,.15);font-size:12px;line-height:22px;text-align:center}' +
    '#pfc .pfc-ctrl button:hover{background:#fff}' +
    '#pfc .pfc-stage{display:block;width:100%}' +
    '#pfc .pfc-stage svg{display:block;width:100%;height:auto;overflow:visible}' +
    '#pfc .pfc-restore{display:none;width:36px;height:36px;border-radius:50%;background:#fff;border:1px solid rgba(0,0,0,.14);box-shadow:0 2px 6px rgba(0,0,0,.18);padding:5px}' +
    '#pfc.pfc-corner.pfc-closed{width:36px}#pfc.pfc-closed .pfc-ctrl,#pfc.pfc-closed .pfc-stage,#pfc.pfc-closed .pfc-bubble{display:none}' +
    '#pfc.pfc-closed .pfc-restore{display:block}#pfc.pfc-hero.pfc-closed .pfc-right{width:36px}' +
    '#pfc .pfc-bubble{position:absolute;right:34px;bottom:100%;margin-bottom:-18px;max-width:150px;width:max-content;background:#fff;border:1px solid #e2ddd4;border-radius:12px;padding:6px 9px;box-shadow:0 3px 10px rgba(0,0,0,.12);opacity:0;transform:translateY(4px);transition:opacity .25s,transform .25s;pointer-events:none}' +
    '#pfc.pfc-hero .pfc-bubble{right:auto;left:50%;margin:0 0 4px -75px;width:150px;text-align:center}' +
    '#pfc .pfc-bubble.pfc-show{opacity:1;transform:none}' +
    '#pfc .pfc-bubble:after{content:"";position:absolute;right:18px;bottom:-6px;width:10px;height:10px;background:#fff;border-right:1px solid #e2ddd4;border-bottom:1px solid #e2ddd4;transform:rotate(45deg)}' +
    '#pfc.pfc-hero .pfc-bubble:after{right:auto;left:70px}' +
    // parts of each cat turn around their own box (fill-box), so both cats share the same keyframes
    '#pfc .pfc-cat,#pfc .pfc-head,#pfc .pfc-pl,#pfc .pfc-pr,#pfc .pfc-tail,#pfc .pfc-fl,#pfc .pfc-fr{transform-box:fill-box}' +
    '#pfc .pfc-cat{transform-origin:50% 100%}#pfc .pfc-head{transform-origin:50% 85%}#pfc .pfc-pl{transform-origin:100% 0}#pfc .pfc-pr{transform-origin:0 0}#pfc .pfc-tail{transform-origin:0 100%}#pfc .pfc-fl,#pfc .pfc-fr{transform-origin:50% 50%}' +
    '#pfc .pfc-spark{opacity:0}' +
    '#pfc .pfc-shadow{transform-box:fill-box;transform-origin:50% 50%}' +
    '#pfc [data-dance=hop] .pfc-shadow{animation:pfc-shh var(--b) ease-in-out infinite}' +
    '#pfc [data-dance=sway] .pfc-shadow,#pfc [data-dance=kick] .pfc-shadow{animation:pfc-shs calc(var(--b)*2) ease-in-out infinite}' +
    '#pfc .pfc-celebrate .pfc-shadow{animation:pfc-shh .5s ease-in-out infinite}' +
    // sway: lean side to side, heads bob, paws wave in turn
    '#pfc [data-dance=sway] .pfc-cat{animation:pfc-sway calc(var(--b)*2) ease-in-out infinite}' +
    '#pfc [data-dance=sway] .pfc-head{animation:pfc-bob var(--b) ease-in-out infinite}' +
    '#pfc [data-dance=sway] .pfc-pl{animation:pfc-wl calc(var(--b)*2) ease-in-out infinite}' +
    '#pfc [data-dance=sway] .pfc-pr{animation:pfc-wr calc(var(--b)*2) ease-in-out infinite;animation-delay:calc(var(--b)*-1)}' +
    '#pfc [data-dance] .pfc-tail{animation:pfc-swish calc(var(--b)*2) ease-in-out infinite}' +
    // hop: small hops on every beat, both paws up
    '#pfc [data-dance=hop] .pfc-cat{animation:pfc-hop var(--b) ease-in-out infinite}' +
    '#pfc [data-dance=hop] .pfc-head{animation:pfc-bob var(--b) ease-in-out infinite}' +
    '#pfc [data-dance=hop] .pfc-pl{animation:pfc-ul var(--b) ease-in-out infinite}' +
    '#pfc [data-dance=hop] .pfc-pr{animation:pfc-ur var(--b) ease-in-out infinite}' +
    // kick: paws on hips, feet kick in turn
    '#pfc [data-dance=kick] .pfc-cat{animation:pfc-lean calc(var(--b)*2) ease-in-out infinite}' +
    '#pfc [data-dance=kick] .pfc-head{animation:pfc-tilt calc(var(--b)*2) ease-in-out infinite}' +
    '#pfc [data-dance=kick] .pfc-pl{transform:rotate(-28deg)}#pfc [data-dance=kick] .pfc-pr{transform:rotate(28deg)}' +
    '#pfc [data-dance=kick] .pfc-fl{animation:pfc-kl calc(var(--b)*2) ease-in-out infinite}' +
    '#pfc [data-dance=kick] .pfc-fr{animation:pfc-kr calc(var(--b)*2) ease-in-out infinite;animation-delay:calc(var(--b)*-1)}' +
    // celebration (3 s): jumps, fast waves, sparkles
    '#pfc .pfc-celebrate .pfc-cat{animation:pfc-jump .5s ease-in-out infinite}' +
    '#pfc .pfc-celebrate .pfc-pl{animation:pfc-ul .25s ease-in-out infinite}#pfc .pfc-celebrate .pfc-pr{animation:pfc-ur .25s ease-in-out infinite}' +
    '#pfc .pfc-celebrate .pfc-spark{animation:pfc-float 1s ease-out infinite}' +
    '@keyframes pfc-sway{0%,100%{transform:translateX(-3px) rotate(-12deg)}50%{transform:translateX(3px) rotate(12deg)}}' +
    '@keyframes pfc-lean{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(8deg)}}' +
    '@keyframes pfc-bob{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(5px) rotate(-9deg)}}' +
    '@keyframes pfc-tilt{0%,100%{transform:rotate(-13deg)}50%{transform:rotate(13deg)}}' +
    '@keyframes pfc-wl{0%,100%{transform:rotate(0)}50%{transform:rotate(115deg)}}' +
    '@keyframes pfc-wr{0%,100%{transform:rotate(0)}50%{transform:rotate(-115deg)}}' +
    '@keyframes pfc-ul{0%,100%{transform:rotate(140deg)}50%{transform:rotate(115deg)}}' +
    '@keyframes pfc-ur{0%,100%{transform:rotate(-140deg)}50%{transform:rotate(-115deg)}}' +
    '@keyframes pfc-swish{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(10deg)}}' +
    '@keyframes pfc-hop{0%,100%{transform:translateY(0) scale(1.08,.92)}18%{transform:translateY(0) scale(1)}50%{transform:translateY(-24px) scale(.96,1.05)}82%{transform:translateY(0) scale(1)}}' +
    '@keyframes pfc-kl{0%,45%,100%{transform:none}22%{transform:translate(-6px,-22px) rotate(-42deg)}}' +
    '@keyframes pfc-kr{0%,45%,100%{transform:none}22%{transform:translate(6px,-22px) rotate(42deg)}}' +
    '@keyframes pfc-jump{0%,100%{transform:translateY(0)}50%{transform:translateY(-28px) rotate(10deg)}}' +
    '@keyframes pfc-shh{0%,18%,82%,100%{transform:scale(1);opacity:1}50%{transform:scale(.55);opacity:.45}}' +
    '@keyframes pfc-shs{0%,100%{transform:translateX(-5px) scaleX(1.08)}50%{transform:translateX(5px) scaleX(1.08)}}' +
    '@keyframes pfc-float{0%{opacity:0;transform:translateY(6px)}30%{opacity:1}100%{opacity:0;transform:translateY(-14px)}}' +
    '#pfc.pfc-paused *{animation-play-state:paused!important}' +
    // reduced motion: still cats, no hops, no sliding; the celebration just shows the sparkles
    '@media (prefers-reduced-motion:reduce){#pfc,#pfc *{animation:none!important;transition:none!important}#pfc .pfc-celebrate .pfc-spark{opacity:1}}';

  // ── markup (rebuilt when the layout changes: hero sides / corner / none) ──
  var style = document.createElement('style');
  style.id = 'pfc-style';
  style.textContent = CSS;
  document.head.appendChild(style);
  var root = document.createElement('div');
  root.id = 'pfc';
  root.className = 'pfc-off';
  var CTRL = '<div class="pfc-ctrl">' +
      '<button type="button" class="pfc-sound" aria-pressed="false" aria-label="Turn the cats\' music on" title="Music on">🔇</button>' +
      '<button type="button" class="pfc-next" aria-label="Next dance" title="Next dance">🔄</button>' +
      '<button type="button" class="pfc-close" aria-label="Hide the dancing cats" title="Hide the cats">✕</button>' +
    '</div>';
  var BUBBLE = '<div class="pfc-bubble" role="status" aria-live="polite"></div>';
  var RESTORE = '<button type="button" class="pfc-restore" aria-label="Show the dancing cats" title="Show the cats">' +
      '<svg viewBox="0 0 90 70" width="100%" aria-hidden="true" focusable="false"><path d="M15 34L13 4L34 22ZM75 34L77 4L56 22Z" fill="#f2a65a"/><ellipse cx="45" cy="42" rx="32" ry="26" fill="#f2a65a"/><ellipse cx="34" cy="40" rx="4" ry="5" fill="#2b2622"/><ellipse cx="56" cy="40" rx="4" ry="5" fill="#2b2622"/><path d="M42 48h6l-3 3.5z" fill="#e2747f"/></svg>' +
    '</button>';
  var STAGE = function (which, label) { return '<button type="button" class="pfc-stage" data-which="' + which + '" aria-label="' + label + '"></button>'; };
  var $ = function (c) { return root.querySelector(c); };

  // ── state ──
  var st = { closed: load('pfCatsClosed') === '1', busy: false, blocked: false, hiddenTab: document.hidden, offscreen: false, sound: false,
             combo: Math.max(0, Math.min(COMBOS.length - 1, parseInt(load('pfCatsCombo') || '0', 10) || 0)), bottom: 15, mode: null };
  var cfg = { renderer: (me && me.dataset.renderer) || 'svg', opts: { src: me && me.dataset.src } };
  var views = [];

  // Which layout fits: none on phones / small tablets (≤ 768 px); on the home page, one cat each side of the hero text
  // when both side gaps are wide enough; otherwise the bottom-right corner.
  var hero = document.getElementById('mainHero'), heroText = hero && hero.querySelector('.hero-content');
  var HERO_MIN_CAT = 100, HERO_MAX_CAT = 170;
  function heroFit() {
    if (!heroText) return null;
    var vw = document.documentElement.clientWidth, h = hero.getBoundingClientRect(), c = heroText.getBoundingClientRect();
    var pad = parseFloat(getComputedStyle(heroText).paddingLeft) || 0;
    var side = Math.min(c.left - h.left, h.right - c.right) + pad;      // empty background beside the text column
    var byHeight = (h.height - 72 - 10 - 42 - 40) * (100 / 130);          // below the fixed header, room for controls + bubble
    // keep an 84 px lane clear at the screen edges (floating buttons sit there) when the cats can stay ≥ 120 px wide
    var gap = Math.min(HERO_MAX_CAT, side - 96, byHeight) >= 120 ? 84 : Math.max(12, Math.min(40, side * 0.12));
    var cw = Math.floor(Math.min(HERO_MAX_CAT, side - gap - 12, byHeight));
    if (vw <= 768 || cw < HERO_MIN_CAT) return null;
    return { cw: cw, gap: Math.round(gap) };
  }
  function modeFor() {
    if (document.documentElement.clientWidth <= 768) return 'none';
    return heroFit() ? 'hero' : 'corner';
  }
  function build(mode) {
    views.forEach(function (v) { v.destroy(); }); views = [];
    st.mode = mode;
    var keep = root.className.match(/pfc-(off|closed|paused)/g) || [];
    root.className = ['pfc-' + mode].concat(keep).join(' ');
    root.style.removeProperty('bottom');
    if (mode === 'none') { root.innerHTML = ''; if (root.parentNode !== document.body) document.body.appendChild(root); return; }
    if (mode === 'hero') {
      root.innerHTML = '<div class="pfc-side pfc-left">' + STAGE('ginger', 'A ginger cartoon cat dancing — click for a celebration') + '</div>' +
        '<div class="pfc-side pfc-right">' + BUBBLE + CTRL + STAGE('grey', 'A grey striped cartoon cat dancing — click for a celebration') + RESTORE + '</div>';
      if (root.parentNode !== hero) hero.appendChild(root);   // absolutely placed inside the hero: no layout shift
    } else {
      root.innerHTML = BUBBLE + CTRL + STAGE('both', 'Two cartoon cats dancing — click for a celebration') + RESTORE;
      if (root.parentNode !== document.body) document.body.appendChild(root);
    }
    var make = renderers[cfg.renderer] || renderers.svg;
    root.querySelectorAll('.pfc-stage').forEach(function (slot) { views.push(make(slot, Object.assign({}, cfg.opts, { which: slot.getAttribute('data-which') }))); });
    sizeHero();
    applyCombo();
    setSoundButton();
  }
  function sizeHero() {
    if (st.mode !== 'hero') return;
    var f = heroFit();
    if (!f) return;
    root.style.setProperty('--cw', f.cw + 'px');
    root.style.setProperty('--gap', f.gap + 'px');
  }
  function mountRenderer(name, opts) { cfg.renderer = name; cfg.opts = opts || {}; build(st.mode || modeFor()); render(); }
  function beat() { return 60 / COMBOS[st.combo].bpm; }
  function applyCombo() {
    var c = COMBOS[st.combo];
    root.style.setProperty('--b', beat().toFixed(3) + 's');
    views.forEach(function (v) { v.setDance(c.dance, beat()); });
    var nb = $('.pfc-next'); if (nb) nb.title = 'Next dance — now: ' + c.title;
  }

  // ── music (lib/cats/music.js, fetched on the first 🔊 click; the AudioContext is made inside the click itself) ──
  var actx = null, musicP = null, meowed = false;
  function music() {
    if (!musicP) musicP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = BASE + 'music.js';
      s.async = true;
      s.onload = function () { window.PFCatsMusic ? resolve(window.PFCatsMusic) : reject(new Error('music missing')); };
      s.onerror = function () { musicP = null; reject(new Error('music failed to load')); };
      document.head.appendChild(s);
    });
    return musicP;
  }
  function playing() { return st.sound && st.mode !== 'none' && !st.closed && !st.busy && !st.blocked && !st.hiddenTab && !(st.offscreen && st.mode === 'hero'); }
  function syncMusic() {
    if (!st.sound || !actx) return;
    music().then(function (M) {
      if (playing()) {
        if (actx.state === 'suspended') actx.resume();
        if (!meowed) { meowed = true; M.meow(actx, VOLUME); }
        M.play(actx, COMBOS[st.combo].tune, VOLUME);
      } else M.stop();
    }, function () {});
  }
  function setSoundButton() {
    var b = $('.pfc-sound'); if (!b) return;
    var on = st.sound;
    b.textContent = on ? '🔊' : '🔇';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.setAttribute('aria-label', on ? "Turn the cats' music off" : "Turn the cats' music on");
    b.title = on ? 'Music off' : 'Music on';
  }
  function setSound(on) {
    st.sound = on;
    if (on && !actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      try { actx = AC ? new AC() : null; } catch (_) { actx = null; }
      if (!actx) st.sound = false;
    }
    setSoundButton();
    if (st.sound && actx.state === 'suspended') actx.resume();
    if (!st.sound && musicP) musicP.then(function (M) { M.stop(); }, function () {});
    syncMusic();
  }

  // ── render the visible state ──
  function render() {
    var off = !st.closed && (st.busy || st.blocked);
    root.classList.toggle('pfc-off', off || (st.closed && st.blocked));
    root.classList.toggle('pfc-closed', st.closed);
    var still = st.hiddenTab || (st.offscreen && st.mode === 'hero') || off || st.closed || st.mode === 'none';
    root.classList.toggle('pfc-paused', still);
    if (st.mode === 'corner') root.style.bottom = st.bottom + 'px';
    views.forEach(function (v) { if (still) v.pause(); else v.resume(); });
    syncMusic();
  }

  // ── placement (corner only — the hero sides are empty background): never over anything clickable ──
  var INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,iframe,video,[role=button],[role=link],[role=tab],[role=checkbox],' +
    '[role=switch],[role=slider],[role=menuitem],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"]),[data-pf-avoid]';
  // open menus, dialogs, overlays and consent / cookie banners: the cats step aside completely
  var OVERLAYS = '#mobileMenu,#pageOverlay,#blogModal,#pf-pin-modal.pf-pin-open,#pf-viewer-modal.pf-viewer-open,#pf-feedback-card.pf-card-open,' +
    '#sheetOverlay,.fc-consent-root,.fc-dialog-container,[id*=cookie-banner],[class*=cookie-banner],[id*=consent-banner],[aria-modal=true]';
  function shown(el) {
    if (!el || !el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05;
  }
  function overlayOpen() {
    if (document.body.classList.contains('pf-cv-open')) return true;
    var list = document.querySelectorAll(OVERLAYS);
    for (var i = 0; i < list.length; i++) if (!root.contains(list[i]) && shown(list[i])) return true;
    return false;
  }
  // Clickable things inside the corner the cats may use (the right-hand column, bottom half of the screen): their boxes.
  // Hidden ones (visibility:hidden, pointer-events:none — e.g. the scroll-to-top button before it appears) don't count.
  function obstacles(l, t, r, b) {
    var out = [], list = document.querySelectorAll(INTERACTIVE);
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (root.contains(el)) continue;
      var x = el.getBoundingClientRect();
      if (x.width < 1 || x.height < 1 || x.right <= l || x.left >= r || x.bottom <= t || x.top >= b) continue;
      var cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
      out.push(x);
    }
    return out;
  }
  function place() {
    if (!root.isConnected) return;
    var m = modeFor();
    if (m !== st.mode) build(m);
    else sizeHero();
    if (st.mode === 'none') { st.blocked = false; return render(); }
    if (overlayOpen()) { st.blocked = true; return render(); }
    if (st.mode === 'hero') { st.blocked = false; dodge(true); return render(); }
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var rr = root.getBoundingClientRect(), w = rr.width, h = rr.height || 40, M = 6;
    var left = vw - 20 - w, right = vw - 20, top = vh * 0.5;
    var obs = obstacles(left - M, top - M, right + M, vh);
    var found = null;
    for (var b = 15; b + h <= vh * 0.5; b += 10) {
      var ct = vh - b - h - M, cb = vh - b + M, hit = false;
      for (var k = 0; k < obs.length && !hit; k++) hit = obs[k].bottom > ct && obs[k].top < cb && obs[k].right > left - M && obs[k].left < right + M;
      if (!hit) { found = b; break; }
    }
    st.blocked = found === null;
    if (found !== null) st.bottom = found;
    render();
  }
  // Hero mode: as the page scrolls the hero slides under the fixed header ("Open Tool →" on the right) — a cat whose
  // box touches the header, or any visible clickable element outside the cats, fades out until it is clear again.
  var nav = document.getElementById('mainNav') || document.querySelector('body > nav, body > header');
  function navBottom() {
    if (!nav) return 0;
    var cs = getComputedStyle(nav);
    return (cs.position === 'fixed' || cs.position === 'sticky') && cs.display !== 'none' ? nav.getBoundingClientRect().bottom : 0;
  }
  function dodge(full) {
    if (st.mode !== 'hero') return;
    var nb = navBottom();
    root.querySelectorAll('.pfc-side').forEach(function (side) {
      var r = side.getBoundingClientRect(), hide = r.top < nb + 6;
      if (!hide && full) hide = obstacles(r.left - 4, r.top - 4, r.right + 4, r.bottom + 4).length > 0;
      if (hide || full) side.classList.toggle('pfc-dodge', hide);
    });
  }
  var dodgeRaf = 0, dodgeT = null;
  function onHeroScroll() {
    if (!dodgeRaf) dodgeRaf = requestAnimationFrame(function () { dodgeRaf = 0; dodge(false); });
    clearTimeout(dodgeT); dodgeT = setTimeout(function () { dodge(true); }, 120);
  }
  var placeT = null;
  function placeSoon(ms) { clearTimeout(placeT); placeT = setTimeout(place, ms == null ? 180 : ms); }

  // ── busy: a tool is working (paraphrase / upload / flashcards / PDF) ──
  function isBusy() {
    if (window.PFCats && window.PFCats._busy) return true;
    try { if (typeof isLoading !== 'undefined' && isLoading === true) return true; } catch (_) {}   // index.html's tool runs
    return !!document.querySelector('#loadingDots.show,#spGo:disabled,#spProgress:not([hidden]),[data-role=progress]:not([hidden]),[aria-busy=true]');
  }
  function checkBusy() {
    var b = isBusy();
    if (b !== st.busy) { st.busy = b; if (!b) place(); else render(); }
  }

  // ── speech bubble: at most once every ~5 minutes across pages, shown ~4 s ──
  var started = Date.now();
  function maybeBubble() {
    var bubble = $('.pfc-bubble');
    if (!bubble || st.closed || st.busy || st.blocked || st.hiddenTab || (st.offscreen && st.mode === 'hero') || st.mode === 'none') return;
    var now = Date.now(), last = parseInt(load('pfCatsBubbleAt') || '0', 10) || 0;
    if (now - started < BUBBLE_FIRST || now - last < BUBBLE_EVERY) return;
    save('pfCatsBubbleAt', now);
    bubble.textContent = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
    bubble.classList.add('pfc-show');
    setTimeout(function () { bubble.classList.remove('pfc-show'); }, BUBBLE_SHOW);
  }

  // ── controls (one delegated listener: the markup is rebuilt when the layout changes) ──
  root.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (!b || !root.contains(b)) return;
    if (b.classList.contains('pfc-sound')) setSound(!st.sound);
    else if (b.classList.contains('pfc-next')) {
      st.combo = (st.combo + 1) % COMBOS.length;
      save('pfCatsCombo', st.combo);
      applyCombo();
      syncMusic();
    } else if (b.classList.contains('pfc-close')) {
      st.closed = true; save('pfCatsClosed', '1');
      if (musicP) musicP.then(function (M) { M.stop(); }, function () {});
      render(); placeSoon(30);
      var rb = $('.pfc-restore'); if (rb) rb.focus({ preventScroll: true });
    } else if (b.classList.contains('pfc-restore')) {
      st.closed = false; save('pfCatsClosed', null);
      render(); placeSoon(30);
    } else if (b.classList.contains('pfc-stage')) views.forEach(function (v) { v.celebrate(CELEBRATE_MS); });
  });

  // ── page events ──
  document.addEventListener('visibilitychange', function () {
    st.hiddenTab = document.hidden;
    if (actx) { try { st.hiddenTab ? actx.suspend() : actx.resume(); } catch (_) {} }
    render();
  });
  window.addEventListener('scroll', function () { if (st.mode === 'corner') placeSoon(); else if (st.mode === 'hero') onHeroScroll(); }, { passive: true });
  window.addEventListener('resize', function () { placeSoon(); }, { passive: true });
  // hero cats pause their animation while the hero is scrolled out of view (the music keeps playing)
  if (hero && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      var off = !es[es.length - 1].isIntersecting;
      if (off !== st.offscreen) { st.offscreen = off; render(); }
    }).observe(hero);
  }
  var tick = 0;
  setInterval(function () {
    if (document.hidden) return;
    checkBusy();
    if (++tick % 4 === 0 && st.mode === 'hero' && !st.offscreen) dodge(true);   // floating buttons that appear later
    if (tick % 4 === 0 && st.mode === 'corner') place();   // things appear under the corner (scroll-to-top button, banners)
    if (tick % 40 === 0) maybeBubble();                       // every ~30 s
  }, 700);

  // ── public API (tests, and a future WebM renderer) ──
  window.PFCats = {
    renderers: renderers,
    setRenderer: function (name, opts) { mountRenderer(name, opts); },
    setBusy: function (on) { window.PFCats._busy = !!on; checkBusy(); },
    _busy: false,
    combos: COMBOS,
    state: function () { return { mode: st.mode, closed: st.closed, busy: st.busy, blocked: st.blocked, sound: st.sound, combo: st.combo, tune: COMBOS[st.combo].tune,
      dance: COMBOS[st.combo].dance, bottom: st.bottom, audio: actx ? actx.state : null, musicLoaded: !!window.PFCatsMusic,
      playing: !!(window.PFCatsMusic && window.PFCatsMusic.playing()) }; },
    bubble: function () { save('pfCatsBubbleAt', 0); started = 0; maybeBubble(); },
    place: place,
  };

  build(modeFor());
  st.busy = isBusy();
  place();
})();
