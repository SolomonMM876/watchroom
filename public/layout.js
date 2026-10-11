/** Browser-local watch panel layout. Media elements are never replaced or reparented. */
const STORAGE_KEY = 'watchroom:beta-layout:v1';
const PANEL_NAMES = ['screen', 'partner', 'self', 'chat'];
let instance = null;

export function initWatchLayout() {
  if (instance) return instance;
  const workspace = document.getElementById('watch-workspace');
  const room = document.getElementById('room');
  if (!workspace || !room) throw new Error('The watch workspace is missing.');
  const panels = Object.fromEntries(PANEL_NAMES.map(name => [name, workspace.querySelector(`[data-panel="${name}"]`)]));
  if (Object.values(panels).some(panel => !panel)) throw new Error('A watch panel is missing.');
  const handles = [...workspace.querySelectorAll('[data-drag-panel], [data-resize-panel]')];
  const mobileQuery = matchMedia('(max-width: 759px)');
  const listeners = new AbortController();
  let active = false;
  let layout = null;
  let saved = readSaved();
  let gesture = null;
  let frame = 0;
  let topLayer = 4;

  function readSaved() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (data?.version !== 1 || !data.panels || !PANEL_NAMES.every(name => {
        const rect = data.panels[name];
        return rect && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(rect[key])) && rect.x >= 0 && rect.x <= 1 && rect.y >= 0 && rect.y <= 1 && rect.w > 0 && rect.w <= 1 && rect.h > 0 && rect.h <= 1;
      })) return null;
      return data;
    } catch { return null; }
  }

  function bounds() { return { w: workspace.clientWidth, h: workspace.clientHeight }; }
  function disabled() { return !active || mobileQuery.matches || document.body.classList.contains('theater-mode') || !!document.fullscreenElement; }
  function clamp(value, min, max) { return Math.min(max, Math.max(Math.min(min, max), value)); }

  function constrain(name, rect, area = bounds()) {
    const minimum = name === 'screen' ? [320, 210] : name === 'partner' ? [180, 128] : name === 'self' ? [115, 86] : [340, rect.w <= 650 ? 270 : 142];
    const w = clamp(rect.w, minimum[0], area.w);
    const h = clamp(rect.h, minimum[1], area.h);
    return {
      x: clamp(rect.x, 0, Math.max(0, area.w - w)),
      y: clamp(rect.y, 0, Math.max(0, area.h - h)),
      w, h,
      z: name === 'screen' ? 1 : clamp(Number(rect.z) || 3, 2, 50),
    };
  }

  function defaults(area) {
    const chatH = Math.min(156, Math.max(142, area.h * .22));
    const screenH = area.h - chatH - 8;
    const partnerW = Math.min(330, Math.max(220, area.w * .235));
    const selfW = Math.round(partnerW * .54);
    const partnerH = Math.round(partnerW * .625 + 26);
    const selfH = Math.round(selfW * .625 + 26);
    const cameraBottom = screenH - 48;
    return {
      screen: { x: 0, y: 0, w: area.w, h: screenH, z: 1 },
      partner: { x: area.w - partnerW - selfW - 24, y: cameraBottom - partnerH, w: partnerW, h: partnerH, z: 3 },
      self: { x: area.w - selfW - 12, y: cameraBottom - selfH, w: selfW, h: selfH, z: 4 },
      chat: { x: 0, y: area.h - chatH, w: area.w, h: chatH, z: 2 },
    };
  }

  function apply(name) {
    const rect = layout[name];
    const panel = panels[name];
    panel.style.left = `${rect.x}px`;
    panel.style.top = `${rect.y}px`;
    panel.style.width = `${rect.w}px`;
    panel.style.height = `${rect.h}px`;
    panel.style.zIndex = String(rect.z);
    if (name === 'chat') panel.classList.toggle('compact-chat', rect.w <= 650);
  }

  function announce(text) {
    const status = document.getElementById('layout-status');
    if (status) status.textContent = text;
  }

  function syncHandles() {
    const isDisabled = disabled();
    for (const handle of handles) {
      handle.disabled = isDisabled;
      handle.title = mobileQuery.matches ? 'Panel positioning is available on larger screens.' : handle.dataset.resizePanel ? 'Drag to resize, or use arrow keys.' : 'Drag to move. Arrow keys move; Shift + arrow keys resize.';
    }
  }

  function reflow() {
    if (!active || room.hidden) return;
    syncHandles();
    if (mobileQuery.matches) return;
    const area = bounds();
    if (area.w < 1 || area.h < 1) return;
    const next = saved ? Object.fromEntries(PANEL_NAMES.map(name => {
      const rect = saved.panels[name];
      return [name, { x: rect.x * area.w, y: rect.y * area.h, w: rect.w * area.w, h: rect.h * area.h, z: rect.z }];
    })) : defaults(area);
    layout = Object.fromEntries(PANEL_NAMES.map(name => [name, constrain(name, next[name], area)]));
    for (const name of PANEL_NAMES) apply(name);
    topLayer = Math.max(4, ...PANEL_NAMES.map(name => layout[name].z));
  }

  function queueReflow() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(reflow);
  }

  function persist() {
    if (!layout || mobileQuery.matches) return;
    const area = bounds();
    if (!area.w || !area.h) return;
    saved = {
      version: 1,
      panels: Object.fromEntries(PANEL_NAMES.map(name => {
        const rect = layout[name];
        return [name, { x: rect.x / area.w, y: rect.y / area.h, w: rect.w / area.w, h: rect.h / area.h, z: rect.z }];
      })),
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); }
    catch { announce('Layout updated. This browser could not save it.'); }
  }

  function raise(name) {
    if (name === 'screen') return;
    if (topLayer >= 49) {
      ['chat', 'partner', 'self'].sort((a, b) => layout[a].z - layout[b].z).forEach((key, index) => {
        layout[key].z = index + 2;
        apply(key);
      });
      topLayer = 4;
    }
    layout[name].z = ++topLayer;
  }

  function begin(event) {
    if (disabled() || event.button !== 0 || !layout) return;
    const handle = event.currentTarget;
    const name = handle.dataset.dragPanel || handle.dataset.resizePanel;
    gesture = { name, handle, pointerId: event.pointerId, resize: !!handle.dataset.resizePanel, startX: event.clientX, startY: event.clientY, rect: { ...layout[name] } };
    raise(name);
    gesture.rect.z = layout[name].z;
    apply(name);
    document.body.classList.add('layout-editing');
    handle.focus({ preventScroll: true });
    try { handle.setPointerCapture(event.pointerId); } catch { /* Window listeners still receive pointer movement. */ }
    event.preventDefault();
  }

  function move(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const rect = { ...gesture.rect };
    if (gesture.resize) { rect.w += dx; rect.h += dy; }
    else { rect.x += dx; rect.y += dy; }
    layout[gesture.name] = constrain(gesture.name, rect);
    apply(gesture.name);
    event.preventDefault();
  }

  function finish(event) {
    if (!gesture || event && event.pointerId !== gesture.pointerId) return;
    const current = gesture;
    gesture = null;
    try { current.handle.releasePointerCapture(current.pointerId); } catch { /* The browser can release capture first. */ }
    document.body.classList.remove('layout-editing');
    persist();
    announce(`${current.name === 'self' ? 'Your camera' : current.name[0].toUpperCase() + current.name.slice(1)} panel ${current.resize ? 'resized' : 'moved'}. Layout saved.`);
  }

  function keyboard(event) {
    if (disabled() || !layout || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const handle = event.currentTarget;
    const name = handle.dataset.dragPanel || handle.dataset.resizePanel;
    const resize = !!handle.dataset.resizePanel || event.shiftKey;
    const step = event.altKey ? 1 : event.ctrlKey || event.metaKey ? 40 : 10;
    const rect = { ...layout[name] };
    const negative = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const delta = negative ? -step : step;
    if (resize) rect[event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 'w' : 'h'] += delta;
    else rect[event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 'x' : 'y'] += delta;
    raise(name);
    rect.z = layout[name].z;
    layout[name] = constrain(name, rect);
    apply(name);
    persist();
    announce(`${name === 'self' ? 'Your camera' : name[0].toUpperCase() + name.slice(1)} panel ${resize ? 'resized' : 'moved'}. Layout saved.`);
    event.preventDefault();
  }

  function activate() {
    active = true;
    document.body.classList.add('room-active');
    reflow();
    queueReflow();
  }

  function deactivate() {
    finish();
    active = false;
    cancelAnimationFrame(frame);
    document.body.classList.remove('room-active');
    syncHandles();
  }

  function reset() {
    finish();
    saved = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* In-memory reset works without storage. */ }
    reflow();
    announce('Layout reset.');
  }

  for (const handle of handles) {
    handle.addEventListener('pointerdown', begin, { signal: listeners.signal });
    handle.addEventListener('keydown', keyboard, { signal: listeners.signal });
  }
  window.addEventListener('pointermove', move, { signal: listeners.signal });
  window.addEventListener('pointerup', finish, { signal: listeners.signal });
  window.addEventListener('pointercancel', finish, { signal: listeners.signal });
  window.addEventListener('resize', queueReflow, { signal: listeners.signal });
  mobileQuery.addEventListener('change', queueReflow, { signal: listeners.signal });
  document.addEventListener('fullscreenchange', syncHandles, { signal: listeners.signal });
  document.getElementById('reset-layout')?.addEventListener('click', reset, { signal: listeners.signal });
  const observer = new ResizeObserver(queueReflow);
  observer.observe(workspace);
  const bodyObserver = new MutationObserver(syncHandles);
  bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  instance = {
    activate, deactivate, reset,
    getLayout() { return layout ? Object.fromEntries(PANEL_NAMES.map(name => [name, { ...layout[name] }])) : null; },
    destroy() {
      deactivate();
      observer.disconnect();
      bodyObserver.disconnect();
      listeners.abort();
      instance = null;
    },
  };
  syncHandles();
  if (!room.hidden) activate();
  return instance;
}
