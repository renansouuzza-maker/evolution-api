/**
 * Page Screenshot Capture - Content Script
 *
 * Detects all page sections, identifies CSS animations/transitions,
 * captures screenshots section by section (and frame-by-frame for animations),
 * then packages everything into a .zip for download.
 */

(() => {
  'use strict';

  // Prevent multiple injections
  if (window.__pageCapture) return;
  window.__pageCapture = true;

  let captureInProgress = false;

  // ─── Section Detection ───────────────────────────────────────────

  function detectSections() {
    const sectionSelectors = [
      'section',
      'header',
      'footer',
      'main',
      'article',
      'nav',
      '[role="banner"]',
      '[role="main"]',
      '[role="contentinfo"]',
      '[role="navigation"]',
    ];

    const candidateElements = new Set();

    // Gather semantic elements
    for (const sel of sectionSelectors) {
      document.querySelectorAll(sel).forEach(el => candidateElements.add(el));
    }

    // Also gather large top-level divs that act as sections
    const body = document.body;
    for (const child of body.children) {
      if (child.tagName === 'DIV' || child.tagName === 'ASIDE') {
        const rect = child.getBoundingClientRect();
        if (rect.height >= 100) {
          candidateElements.add(child);
        }
      }
    }

    // If no semantic sections found, split page into viewport-sized chunks
    if (candidateElements.size === 0) {
      return buildViewportChunks();
    }

    // Filter out sections nested inside other sections and sort by position
    const sections = [...candidateElements]
      .filter(el => {
        // Keep only if not a child of another candidate
        let parent = el.parentElement;
        while (parent && parent !== body) {
          if (candidateElements.has(parent)) return false;
          parent = parent.parentElement;
        }
        return true;
      })
      .map(el => ({
        element: el,
        rect: el.getBoundingClientRect(),
        top: el.getBoundingClientRect().top + window.scrollY,
      }))
      .sort((a, b) => a.top - b.top);

    return sections;
  }

  function buildViewportChunks() {
    const totalHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    const viewportHeight = window.innerHeight;
    const chunks = [];

    for (let y = 0; y < totalHeight; y += viewportHeight) {
      chunks.push({
        element: null,
        rect: null,
        top: y,
        height: Math.min(viewportHeight, totalHeight - y),
        isChunk: true,
      });
    }

    return chunks;
  }

  // ─── Animation Detection ─────────────────────────────────────────

  function detectAnimations(sectionElement) {
    if (!sectionElement) return [];

    const animated = [];
    const allElements = sectionElement.querySelectorAll('*');

    for (const el of allElements) {
      const style = getComputedStyle(el);
      const animInfo = getAnimationInfo(el, style);
      if (animInfo) {
        animated.push(animInfo);
      }
    }

    // Also check the section element itself
    const sectionStyle = getComputedStyle(sectionElement);
    const sectionAnim = getAnimationInfo(sectionElement, sectionStyle);
    if (sectionAnim) {
      animated.push(sectionAnim);
    }

    return animated;
  }

  function getAnimationInfo(el, style) {
    const animName = style.animationName;
    const animDuration = parseFloat(style.animationDuration) || 0;
    const animIterations = style.animationIterationCount;
    const transitionDuration = parseFloat(style.transitionDuration) || 0;

    // Check CSS animations
    if (animName && animName !== 'none' && animDuration > 0) {
      const iterations = animIterations === 'infinite' ? 1 : (parseFloat(animIterations) || 1);
      return {
        element: el,
        type: 'css-animation',
        name: animName,
        duration: animDuration * iterations,
        delay: parseFloat(style.animationDelay) || 0,
      };
    }

    // Check CSS transitions (detect elements that have transition set with meaningful duration)
    if (transitionDuration > 0) {
      const transitionProp = style.transitionProperty;
      if (transitionProp && transitionProp !== 'none') {
        return {
          element: el,
          type: 'css-transition',
          name: `transition-${transitionProp}`,
          duration: transitionDuration,
          delay: parseFloat(style.transitionDelay) || 0,
        };
      }
    }

    // Check Web Animations API
    const webAnimations = el.getAnimations ? el.getAnimations() : [];
    if (webAnimations.length > 0) {
      const longestAnim = webAnimations.reduce((longest, anim) => {
        const dur = (anim.effect?.getTiming?.()?.duration || 0) / 1000;
        return dur > (longest?.duration || 0) ? { anim, duration: dur } : longest;
      }, null);

      if (longestAnim && longestAnim.duration > 0) {
        return {
          element: el,
          type: 'web-animation',
          name: 'web-animation',
          duration: longestAnim.duration,
          delay: (longestAnim.anim.effect?.getTiming?.()?.delay || 0) / 1000,
        };
      }
    }

    return null;
  }

  // ─── Scroll-based Animation Detection ────────────────────────────

  function detectScrollAnimations(sectionElement) {
    if (!sectionElement) return false;

    const allElements = [sectionElement, ...sectionElement.querySelectorAll('*')];

    for (const el of allElements) {
      const style = getComputedStyle(el);

      // Elements with opacity 0 that might animate in on scroll
      if (parseFloat(style.opacity) === 0 && style.transitionDuration !== '0s') {
        return true;
      }

      // Elements with transform that might animate
      if (
        style.transform !== 'none' &&
        style.transitionDuration !== '0s' &&
        style.transitionProperty?.includes('transform')
      ) {
        return true;
      }

      // Intersection observer patterns (data attributes often used)
      if (
        el.hasAttribute('data-aos') ||
        el.hasAttribute('data-animate') ||
        el.hasAttribute('data-scroll') ||
        el.classList.contains('animate-on-scroll') ||
        el.classList.contains('fade-in') ||
        el.classList.contains('slide-in') ||
        el.classList.contains('reveal')
      ) {
        return true;
      }
    }

    return false;
  }

  // ─── Screenshot Capture ──────────────────────────────────────────

  function takeScreenshot() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'take-screenshot' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response.dataUrl);
      });
    });
  }

  function dataUrlToBlob(dataUrl) {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const raw = atob(parts[1]);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      arr[i] = raw.charCodeAt(i);
    }
    return new Blob([arr], { type: mime });
  }

  async function cropScreenshot(dataUrl, cropRect, viewportRect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;

        // Calculate crop coordinates relative to viewport
        const sx = Math.max(0, (cropRect.left - viewportRect.left) * dpr);
        const sy = Math.max(0, (cropRect.top - viewportRect.top) * dpr);
        const sw = Math.min(cropRect.width * dpr, img.width - sx);
        const sh = Math.min(cropRect.height * dpr, img.height - sy);

        canvas.width = sw;
        canvas.height = sh;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

        resolve(canvas.toDataURL('image/png'));
      };
      img.src = dataUrl;
    });
  }

  // ─── Progress Reporting ──────────────────────────────────────────

  function sendProgress(percent, text, extraStats) {
    chrome.runtime.sendMessage({
      type: 'capture-progress',
      percent: Math.round(percent),
      text,
      ...extraStats,
    });
  }

  function sendDone(totalFiles, sectionCount) {
    chrome.runtime.sendMessage({
      type: 'capture-done',
      totalFiles,
      sections: sectionCount,
    });
  }

  function sendError(error) {
    chrome.runtime.sendMessage({
      type: 'capture-error',
      error,
    });
  }

  // ─── Animation Frame Capture ─────────────────────────────────────

  async function captureAnimationFrames(sectionTop, sectionHeight, durationMs, fps) {
    const frames = [];
    const totalFrames = Math.ceil((durationMs / 1000) * fps);
    const frameInterval = 1000 / fps;

    for (let i = 0; i < totalFrames; i++) {
      await new Promise(r => setTimeout(r, frameInterval));

      try {
        const dataUrl = await takeScreenshot();
        frames.push(dataUrl);
      } catch {
        // Skip failed frames
      }
    }

    return frames;
  }

  async function triggerScrollAnimations(sectionElement) {
    // Scroll slightly away and back to trigger intersection observers
    const rect = sectionElement.getBoundingClientRect();
    const sectionTop = rect.top + window.scrollY;

    // Scroll above the section first
    window.scrollTo({ top: Math.max(0, sectionTop - window.innerHeight - 100), behavior: 'instant' });
    await sleep(100);

    // Now scroll to the section to trigger animations
    sectionElement.scrollIntoView({ behavior: 'instant', block: 'start' });
    await sleep(50);
  }

  // ─── Main Capture Logic ──────────────────────────────────────────

  async function startCapture(options) {
    if (captureInProgress) return;
    captureInProgress = true;

    const { fps = 24, quality = 0.85 } = options;

    try {
      sendProgress(0, 'Analisando estrutura da página...');

      // Save original scroll position
      const originalScrollX = window.scrollX;
      const originalScrollY = window.scrollY;

      const sections = detectSections();
      const totalSections = sections.length;

      sendProgress(5, `Encontradas ${totalSections} seções. Iniciando captura...`, {
        sections: totalSections,
        animations: 0,
        frames: 0,
      });

      const zip = new JSZip();
      let totalAnimations = 0;
      let totalFrames = 0;
      let fileIndex = 0;

      for (let i = 0; i < totalSections; i++) {
        const section = sections[i];
        const sectionName = getSectionName(section, i);
        const sectionFolder = zip.folder(sectionName);
        const progressBase = 5 + (i / totalSections) * 90;

        sendProgress(
          progressBase,
          `Capturando seção ${i + 1}/${totalSections}: ${sectionName}`,
          { sections: totalSections, animations: totalAnimations, frames: totalFrames }
        );

        // Scroll to section
        if (section.isChunk) {
          window.scrollTo({ top: section.top, behavior: 'instant' });
        } else {
          section.element.scrollIntoView({ behavior: 'instant', block: 'start' });
        }

        await sleep(300); // Wait for scroll and any lazy-loaded content

        // Take the main screenshot of the section
        try {
          const dataUrl = await takeScreenshot();
          sectionFolder.file(`${sectionName}.png`, dataUrlToBlob(dataUrl));
          fileIndex++;
          totalFrames++;
        } catch (err) {
          console.warn(`Failed to capture section ${sectionName}:`, err);
        }

        // Detect and capture animations for this section
        if (section.element) {
          // Check for CSS animations
          const animations = detectAnimations(section.element);
          const hasScrollAnims = detectScrollAnimations(section.element);

          if (animations.length > 0 || hasScrollAnims) {
            totalAnimations += animations.length + (hasScrollAnims ? 1 : 0);

            sendProgress(
              progressBase + 2,
              `Capturando animações da seção ${sectionName}...`,
              { sections: totalSections, animations: totalAnimations, frames: totalFrames }
            );

            // For CSS animations: capture frame by frame
            for (const anim of animations) {
              const animFolder = sectionFolder.folder(`anim_${anim.name}`);
              const durationMs = Math.min(anim.duration * 1000, 5000); // Cap at 5s
              const framesToCapture = Math.ceil((durationMs / 1000) * fps);

              // Restart animation if possible
              if (anim.element) {
                restartAnimation(anim.element);
              }

              await sleep(anim.delay * 1000);

              const frameInterval = durationMs / framesToCapture;
              for (let f = 0; f < framesToCapture; f++) {
                try {
                  const frameData = await takeScreenshot();
                  animFolder.file(
                    `frame_${String(f).padStart(4, '0')}.png`,
                    dataUrlToBlob(frameData)
                  );
                  totalFrames++;
                  fileIndex++;
                } catch {
                  // Skip failed frame
                }
                await sleep(frameInterval);
              }
            }

            // For scroll-triggered animations
            if (hasScrollAnims) {
              const scrollAnimFolder = sectionFolder.folder('scroll_animation');

              await triggerScrollAnimations(section.element);

              // Capture frames during the animation reveal
              const scrollFrameCount = Math.ceil(fps * 1.5); // 1.5s of capture
              const scrollInterval = 1000 / fps;

              for (let f = 0; f < scrollFrameCount; f++) {
                try {
                  const frameData = await takeScreenshot();
                  scrollAnimFolder.file(
                    `frame_${String(f).padStart(4, '0')}.png`,
                    dataUrlToBlob(frameData)
                  );
                  totalFrames++;
                  fileIndex++;
                } catch {
                  // Skip failed frame
                }
                await sleep(scrollInterval);
              }
            }
          }
        }

        sendProgress(
          progressBase + (90 / totalSections),
          `Seção ${i + 1}/${totalSections} concluída`,
          { sections: totalSections, animations: totalAnimations, frames: totalFrames }
        );
      }

      // Restore scroll position
      window.scrollTo({ top: originalScrollY, left: originalScrollX, behavior: 'instant' });

      sendProgress(95, 'Gerando arquivo ZIP...', {
        sections: totalSections,
        animations: totalAnimations,
        frames: totalFrames,
      });

      // Generate and download the zip
      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      const siteName = window.location.hostname.replace(/\./g, '_');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `screenshots_${siteName}_${timestamp}.zip`;

      // Create object URL and trigger download via background
      const blobUrl = URL.createObjectURL(zipBlob);

      chrome.runtime.sendMessage({
        type: 'download-zip',
        url: blobUrl,
        filename,
      }, () => {
        // Clean up blob URL after a delay
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      });

      sendDone(fileIndex, totalSections);

    } catch (err) {
      console.error('Capture error:', err);
      sendError(err.message || 'Erro desconhecido durante a captura');
    } finally {
      captureInProgress = false;
    }
  }

  // ─── Utility Functions ───────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getSectionName(section, index) {
    const prefix = String(index + 1).padStart(2, '0');

    if (section.isChunk) {
      return `${prefix}_viewport_chunk`;
    }

    const el = section.element;

    // Try tag name
    const tag = el.tagName.toLowerCase();
    if (['header', 'footer', 'nav', 'main', 'article', 'aside'].includes(tag)) {
      return `${prefix}_${tag}`;
    }

    // Try ID
    if (el.id) {
      return `${prefix}_${sanitizeName(el.id)}`;
    }

    // Try class name
    const className = el.className;
    if (typeof className === 'string' && className.trim()) {
      const mainClass = className.trim().split(/\s+/)[0];
      return `${prefix}_${sanitizeName(mainClass)}`;
    }

    // Try aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      return `${prefix}_${sanitizeName(ariaLabel)}`;
    }

    return `${prefix}_section`;
  }

  function sanitizeName(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40);
  }

  function restartAnimation(element) {
    const animName = getComputedStyle(element).animationName;
    if (animName && animName !== 'none') {
      element.style.animation = 'none';
      // Force reflow
      void element.offsetHeight;
      element.style.animation = '';
    }

    // Also restart Web Animations
    if (element.getAnimations) {
      for (const anim of element.getAnimations()) {
        anim.cancel();
        anim.play();
      }
    }
  }

  // ─── Message Listener ────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'start-capture') {
      startCapture(message.options || {});
      sendResponse({ started: true });
    }
    return false;
  });
})();
