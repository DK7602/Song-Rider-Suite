/* CRP ↔ SRP link failsafe v2.2.9
   Runs independently of the large SRP app init so Link SRP still works even if
   an unrelated SRP initializer throws before the legacy bridge binds its button. */
(() => {
  const qs = new URLSearchParams(location.search);
  if (qs.get('crpMode') !== '1') return;

  const HANDOFF_KEY = 'crp-srp-handoff-v2';
  const LINKS_KEY = 'crp-srp-links-v1';

  const readJson = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) ?? fallback) : fallback;
    } catch { return fallback; }
  };
  const writeJson = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  function recoverPayload() {
    const h = readJson(HANDOFF_KEY, {});
    if (h?.payload?.crpProjectId) return h.payload;

    const projects = readJson('crp-projects', []);
    const activeId = String(localStorage.getItem('crp-active-project-id') || '');
    let p = activeId ? projects.find(x => String(x?.id || '') === activeId) : null;
    if (!p) {
      p = [...projects].sort((a,b) => (Number(b?.updatedAt)||0) - (Number(a?.updatedAt)||0))[0];
    }
    if (!p?.id) return null;

    const payload = {
      crpProjectId: p.id,
      name: p.name || 'Untitled',
      bpm: Number(p.bpm) || 92,
      beats: Number(p.beats) || 4,
      key: String(p.key || ''),
      rows: (Array.isArray(p.rows) ? p.rows : []).map((row, rowIndex) => ({
        lineId: `crp-line-${rowIndex + 1}`,
        cards: (Array.isArray(row) ? row : []).map(c => ({
          type: c?.type || 'chord', value: c?.value || ''
        }))
      }))
    };
    writeJson(HANDOFF_KEY, { payload, rec: readJson(LINKS_KEY, {})[p.id] || null, ts: Date.now() });
    return payload;
  }

  function importIntoCurrentSrp(payload) {
    if (!payload?.crpProjectId) throw new Error('No saved CRP project found');
    if (typeof loadAllProjects !== 'function' || typeof upsertProject !== 'function' ||
        typeof normalizeProject !== 'function' || typeof defaultProject !== 'function') {
      throw new Error('SRP project engine is not ready');
    }

    let all = loadAllProjects().map(normalizeProject).filter(Boolean);
    let p = null;

    // Prefer an already-linked project for this CRP song.
    p = all.find(x => String(x?.linkedCrpProjectId || '') === String(payload.crpProjectId));

    // Otherwise link the SRP project currently visible on screen. This preserves
    // the user's existing lyrics instead of silently creating a mystery duplicate.
    if (!p && typeof state !== 'undefined' && state?.project?.id) {
      p = all.find(x => String(x.id) === String(state.project.id)) || normalizeProject(state.project);
    }

    // Last resort: make a new SRP project named after the CRP project.
    if (!p) p = defaultProject(payload.name || 'Linked Song');

    p.linkedCrpProjectId = payload.crpProjectId;
    p.name = p.name || payload.name || 'Linked Song';
    p.bpm = Number(payload.bpm) || p.bpm || 95;
    p.crpKey = String(payload.key || '');
    p.crpBeatsPerChord = Number(payload.beats) || 4;
    p.crpChordRows = Array.isArray(payload.rows) ? payload.rows : [];

    // Mirror CRP chord lines into PAGE 1 without deleting the SRP lyrics that
    // already exist on those lines.
    p.sections = p.sections || {};
    const sectionName = 'PAGE 1';
    const oldLines = Array.isArray(p.sections[sectionName]) ? p.sections[sectionName] : [];
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (rows.length) {
      p.sections[sectionName] = rows.map((r, i) => {
        const prev = oldLines[i] || (typeof newLine === 'function' ? newLine() : { lyrics:'', notes:Array(8).fill(''), beats:Array(4).fill('') });
        const chords = (r.cards || []).filter(c => c?.type === 'chord').map(c => String(c?.value || '')).filter(Boolean);
        const slots = Array(8).fill('');
        if (chords.length) chords.forEach((ch, j) => { slots[Math.min(7, Math.floor(j * 8 / chords.length))] = ch; });
        return {
          ...prev,
          id: prev.id || String(r.lineId || (typeof uuid === 'function' ? uuid() : `${Date.now()}-${i}`)),
          notes: slots,
          lyrics: String(prev.lyrics || ''),
          beats: Array.isArray(prev.beats) ? prev.beats : Array(4).fill('')
        };
      });
    }
    p.enabledSections = Array.from(new Set([sectionName, ...(p.enabledSections || [])]));
    p.updatedAt = Date.now();

    upsertProject(p);
    if (typeof state !== 'undefined') {
      state.project = normalizeProject(p);
      state.bpm = p.bpm;
    }
    try {
      if (typeof getStorageScope === 'function' && typeof setCurrentProjectIdForScope === 'function') {
        setCurrentProjectIdForScope(getStorageScope(), p.id);
      }
    } catch {}
    try { if (typeof applyProjectSettingsToUI === 'function') applyProjectSettingsToUI(); } catch {}
    try { if (typeof renderAll === 'function') renderAll(); } catch {}

    const links = readJson(LINKS_KEY, {});
    const rec = {
      srpProjectId: p.id,
      srpName: p.name || payload.name || 'Song Rider project',
      linkedAt: Date.now()
    };
    links[payload.crpProjectId] = rec;
    writeJson(LINKS_KEY, links);
    writeJson(HANDOFF_KEY, { payload, rec, ts: Date.now() });
    return { p, rec };
  }

  function paintLinked(rec) {
    const linkBtn = document.getElementById('crpSrpLinkBtn');
    const unlinkBtn = document.getElementById('crpSrpUnlinkBtn');
    const status = document.getElementById('crpSrpLinkStatus');
    if (status) status.textContent = `Linked • ${rec?.srpName || 'Song Rider project'}`;
    if (linkBtn) {
      linkBtn.hidden = false;
      linkBtn.disabled = true;
      linkBtn.textContent = 'Linked ✓';
      linkBtn.classList.add('is-linked');
    }
    if (unlinkBtn) unlinkBtn.hidden = false;
  }

  function handleLink(ev) {
    const btn = ev.target?.closest?.('#crpSrpLinkBtn');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation?.();

    const status = document.getElementById('crpSrpLinkStatus');
    btn.disabled = true;
    btn.textContent = 'Linking…';
    if (status) status.textContent = 'Linking CRP project…';

    try {
      const payload = recoverPayload();
      if (!payload) throw new Error('Save the CRP project first, then return to Song Rider.');
      const { rec } = importIntoCurrentSrp(payload);
      paintLinked(rec);
    } catch (err) {
      console.error('CRP/SRP failsafe link failed', err);
      btn.disabled = false;
      btn.textContent = 'Link SRP';
      if (status) status.textContent = err?.message || 'Link failed — try again.';
      // Visible feedback even if the status line is hidden in the compact UI.
      btn.title = err?.message || 'Link failed';
    }
  }

  // Capture phase intentionally beats any stale/failed legacy handler.
  document.addEventListener('click', handleLink, true);
  document.addEventListener('pointerup', ev => {
    if (ev.pointerType === 'touch' && ev.target?.closest?.('#crpSrpLinkBtn')) handleLink(ev);
  }, true);

  // Restore visible linked state after navigation/reload.
  setTimeout(() => {
    const payload = recoverPayload();
    const rec = payload ? readJson(LINKS_KEY, {})[payload.crpProjectId] : null;
    if (rec) paintLinked(rec);
  }, 100);
})();
