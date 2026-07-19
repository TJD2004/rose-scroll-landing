/* =========================================================================
   A NEW BEGINNING — main.js
   -------------------------------------------------------------------------
   Overview of the scroll-sync logic (search "SCROLL SYNC" to jump there):

   1. We preload a sequence of 240 JPEG stills exported from the growth
      video (24fps x 10s) instead of scrubbing an actual <video> element.
      Seeking an HTML5 video's currentTime on every scroll tick is
      unreliable across browsers (keyframe snapping, decode latency,
      Safari throttling), which produces exactly the flicker/jump the
      brief asks us to avoid. A canvas + image array gives us a frame we
      can paint synchronously and deterministically, so "scroll position
      -> exact frame" holds pixel-for-pixel every time.

   2. GSAP's ScrollTrigger pins the hero for a fixed scroll distance and
      reports a 0-1 `progress` value as the user scrolls that distance.
      We never animate the frame with easing/tweening — we map progress
      directly to a frame index. Any smoothing would desync the video
      from the scrollbar, which is the one thing that must never drift.

   3. Scrolling up simply decreases `progress`, which decreases the frame
      index — reverse playback falls out of the mapping for free.
   ========================================================================= */

(() => {
  'use strict';

  const TOTAL_FRAMES = 240;
  const FRAME_PATH = (i) => `assets/frames/frame_${String(i).padStart(3, '0')}.jpg`;
  const TOTAL_WEEKS = 10; // narrative duration used for the T+ readout

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ----------------------------------------------------------------------
     1. NAV — background on scroll, mobile menu toggle
     ---------------------------------------------------------------------- */
  const nav = document.querySelector('[data-nav]');
  const navToggle = document.querySelector('[data-nav-toggle]');
  const mobileMenu = document.querySelector('[data-mobile-menu]');

  const onScrollNav = () => {
    nav.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  onScrollNav();
  window.addEventListener('scroll', onScrollNav, { passive: true });

  navToggle.addEventListener('click', () => {
    const isOpen = navToggle.getAttribute('aria-expanded') === 'true';
    navToggle.setAttribute('aria-expanded', String(!isOpen));
    mobileMenu.classList.toggle('is-open', !isOpen);
  });
  mobileMenu.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      navToggle.setAttribute('aria-expanded', 'false');
      mobileMenu.classList.remove('is-open');
    });
  });

  /* ----------------------------------------------------------------------
     2. PRELOADER — fetch every frame, report progress, unlock scroll
     ---------------------------------------------------------------------- */
  const preloaderEl = document.querySelector('[data-preloader]');
  const preloaderFill = document.querySelector('[data-preloader-fill]');
  const preloaderPct = document.querySelector('[data-preloader-pct]');

  const frames = new Array(TOTAL_FRAMES);
  let loadedCount = 0;

  function loadFrame(index) {
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        frames[index - 1] = img;
        loadedCount += 1;
        const pct = Math.round((loadedCount / TOTAL_FRAMES) * 100);
        if (preloaderFill) preloaderFill.style.width = pct + '%';
        if (preloaderPct) preloaderPct.textContent = pct + '%';
        resolve();
      };
      img.onerror = () => { loadedCount += 1; resolve(); }; // don't block the page on one bad frame
      img.src = FRAME_PATH(index);
    });
  }

  async function preloadAll() {
    // Load the first frame with priority so the canvas has something to
    // paint immediately, then bring in the rest in small concurrent batches
    // (a single Promise.all(240) works, but chunking keeps memory/network
    // pressure smoother on low-end mobile devices).
    await loadFrame(1);
    drawFrame(1);

    const BATCH = 12;
    const remaining = [];
    for (let i = 2; i <= TOTAL_FRAMES; i++) remaining.push(i);

    for (let i = 0; i < remaining.length; i += BATCH) {
      const batch = remaining.slice(i, i + BATCH).map(loadFrame);
      await Promise.all(batch);
    }
  }

  /* ----------------------------------------------------------------------
     3. CANVAS — cover-fit drawing of the current frame
     ---------------------------------------------------------------------- */
  const canvas = document.querySelector('[data-hero-canvas]');
  const ctx = canvas.getContext('2d', { alpha: false });
  const heroPin = document.querySelector('[data-hero-pin]');

  let currentFrameIndex = 1;
  // Cap the backing-store DPR: full retina resolution across 240 frames of
  // full-bleed video is wasted fidelity for a background layer and costs
  // real paint time on scroll — 1.5x keeps it crisp without the tax.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

  function resizeCanvas() {
    const rect = heroPin.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    drawFrame(currentFrameIndex, true);
  }

  function drawFrame(index, force) {
    if (!force && index === currentFrameIndex && frames[index - 1]) {
      // already painted
    }
    const img = frames[index - 1];
    if (!img) return; // frame not loaded yet — keep last painted frame on screen
    currentFrameIndex = index;

    const cw = canvas.width, ch = canvas.height;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const canvasRatio = cw / ch;
    const imgRatio = iw / ih;

    let sx, sy, sw, sh;
    if (imgRatio > canvasRatio) {
      // image is wider than canvas -> crop left/right
      sh = ih;
      sw = ih * canvasRatio;
      sy = 0;
      sx = (iw - sw) / 2;
    } else {
      // image is taller than canvas -> crop top/bottom
      sw = iw;
      sh = iw / canvasRatio;
      sx = 0;
      sy = (ih - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
  }

  window.addEventListener('resize', () => {
    clearTimeout(window.__hero_resize_t);
    window.__hero_resize_t = setTimeout(resizeCanvas, 120);
  });

  /* ----------------------------------------------------------------------
     4. SCROLL SYNC — GSAP ScrollTrigger drives frame index + chapter text
     ---------------------------------------------------------------------- */
  const railFill = document.querySelector('[data-rail-fill]');
  const timecodeEl = document.querySelector('[data-timecode]');
  const scrollCue = document.querySelector('[data-scrollcue]');
  const chapters = Array.from(document.querySelectorAll('[data-chapter]')).map((el) => {
    const [min, max] = el.dataset.range.split(',').map(Number);
    return { el, min, max, active: false };
  });

  // ---- Kinetic typography ------------------------------------------------
  // Bricolage Grotesque is a VARIABLE font (weight axis 200-800). We split
  // each headline into per-line spans and, on reveal, animate both a
  // slide/rotate-in AND the font-weight itself sliding from a hairline 220
  // up to a confident 640 — a type of motion a static font simply cannot
  // do. This is purely additive: if GSAP fails to load for any reason the
  // lines are still readable, just unanimated.
  function splitTitleIntoLines(titleEl) {
    if (titleEl.dataset.split) return;
    const html = titleEl.innerHTML;
    const parts = html.split(/<br\s*\/?>/i);
    titleEl.innerHTML = parts
      .map((part) => `<span class="line"><span class="line-inner">${part}</span></span>`)
      .join('');
    titleEl.dataset.split = 'true';
  }

  chapters.forEach(({ el }) => {
    const titleEl = el.querySelector('.chapter-title');
    if (titleEl) splitTitleIntoLines(titleEl);
  });

  function animateChapterReveal(chapter, activate) {
    if (typeof gsap === 'undefined') return;
    const titleEl = chapter.el.querySelector('.chapter-title');
    const lineInners = chapter.el.querySelectorAll('.line-inner');
    if (!lineInners.length) return;

    gsap.killTweensOf(lineInners);
    if (titleEl) gsap.killTweensOf(titleEl);

    if (activate) {
      gsap.fromTo(
        lineInners,
        { yPercent: 115, opacity: 0, rotate: 4 },
        { yPercent: 0, opacity: 1, rotate: 0, duration: 0.85, ease: 'power3.out', stagger: 0.07 }
      );
      if (titleEl) {
        gsap.fromTo(
          titleEl,
          { fontWeight: 220 },
          { fontWeight: 620, duration: 0.9, ease: 'power2.out' }
        );
      }
    } else {
      gsap.to(lineInners, { yPercent: -55, opacity: 0, duration: 0.3, ease: 'power1.in', stagger: 0.03 });
    }
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function updateTimecode(progress) {
    const totalWeekFraction = progress * TOTAL_WEEKS;
    const weeks = Math.floor(totalWeekFraction);
    const days = Math.round((totalWeekFraction - weeks) * 7);
    if (timecodeEl) timecodeEl.textContent = `T+${pad(weeks)}w ${pad(days)}d`;
  }

  function updateChapters(progress) {
    chapters.forEach((chapter) => {
      const { el, min, max } = chapter;
      const isActive = (progress >= min && progress < max) || (max === 1 && progress >= min);
      if (isActive !== chapter.active) {
        chapter.active = isActive;
        el.classList.toggle('is-active', isActive);
        animateChapterReveal(chapter, isActive);
      }
    });
  }

  // This is the single source of truth: given a 0-1 scroll progress value,
  // paint the matching frame and update every dependent readout.
  function syncToProgress(progress) {
    const clamped = Math.min(1, Math.max(0, progress));
    const frameIndex = Math.min(
      TOTAL_FRAMES,
      Math.max(1, Math.round(clamped * (TOTAL_FRAMES - 1)) + 1)
    );
    drawFrame(frameIndex);
    if (railFill) railFill.style.height = (clamped * 100) + '%';
    updateTimecode(clamped);
    updateChapters(clamped);
    if (scrollCue) scrollCue.classList.toggle('is-hidden', clamped > 0.02);
  }

  function initScrollTrigger() {
    gsap.registerPlugin(ScrollTrigger);

    ScrollTrigger.create({
      trigger: heroPin,
      start: 'top top',
      end: '+=400%',
      pin: true,
      pinSpacing: true,
      scrub: 0, // 0 = no smoothing lag; frame must match scrollbar position exactly
      anticipatePin: 1,
      onUpdate: (self) => syncToProgress(self.progress),
      onRefresh: (self) => syncToProgress(self.progress),
    });

    // Gentle reveal for every subsequent section as it enters the viewport.
    gsap.utils.toArray('.story, .journal, .care, .preorder').forEach((section) => {
      gsap.fromTo(
        section.querySelectorAll('.section-eyebrow, .section-title, .section-sub, .story-quote, .story-body, .journal-card, .care-card, .preorder-title, .preorder-sub, .preorder-form, .preorder-note'),
        { opacity: 0, y: 28 },
        {
          opacity: 1, y: 0, duration: 0.9, ease: 'power2.out', stagger: 0.06,
          scrollTrigger: { trigger: section, start: 'top 78%', once: true },
        }
      );
    });
  }

  /* ----------------------------------------------------------------------
     5. REDUCED MOTION FALLBACK — static hero, no pin/scrub, content in flow
     ---------------------------------------------------------------------- */
  function initReducedMotion() {
    document.documentElement.classList.add('reduced-motion');
    // Show the finished bloom as a calm, static hero image.
    drawFrame(TOTAL_FRAMES, true);
    chapters.forEach((chapter, i) => {
      const isLast = i === chapters.length - 1;
      chapter.active = isLast;
      chapter.el.classList.toggle('is-active', isLast);
      // No GSAP reveal here on purpose — reduced motion means the line
      // splits stay put, fully visible, at their resting font-weight.
    });
    if (scrollCue) scrollCue.classList.add('is-hidden');
    updateTimecode(1);
    if (railFill) railFill.style.height = '100%';
  }

  /* ----------------------------------------------------------------------
     6. PREORDER FORM — client-side confirmation (no backend wired up)
     ---------------------------------------------------------------------- */
  const preorderForm = document.querySelector('[data-preorder-form]');
  const preorderNote = document.querySelector('[data-preorder-note]');
  if (preorderForm) {
    preorderForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = preorderForm.querySelector('input[type="email"]').value;
      if (preorderNote) {
        preorderNote.textContent = `You're on the list at ${email}. We'll email the moment your bed is planted.`;
      }
      preorderForm.reset();
    });
  }

  /* ----------------------------------------------------------------------
     BOOTSTRAP
     ---------------------------------------------------------------------- */
  async function init() {
    resizeCanvas();

    if (prefersReducedMotion) {
      // Skip the heavy preload entirely — one frame is enough for a static hero.
      await loadFrame(TOTAL_FRAMES);
      initReducedMotion();
      if (preloaderEl) preloaderEl.classList.add('is-hidden');
      return;
    }

    await preloadAll();
    resizeCanvas();
    initScrollTrigger();
    if (preloaderEl) preloaderEl.classList.add('is-hidden');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
