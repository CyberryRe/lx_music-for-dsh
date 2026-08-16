// 插件 UI 样式（注入 <style>，类名 lxm- 前缀）。使用 DSH 主题 CSS 变量融入现有样式。

export const STYLE_TAG = 'lx-music-for-dsh/styles'

export const CSS = `
.lxm-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08)) 60%, transparent);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15));
  cursor: pointer;
  user-select: none;
}
.lxm-card:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.lxm-card-head { display: flex; gap: 8px; align-items: center; min-width: 0; }
.lxm-cover {
  width: 42px; height: 42px; border-radius: 8px; object-fit: cover; flex: none;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.15));
}
.lxm-title { min-width: 0; flex: 1; }
.lxm-name {
  font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.lxm-singer {
  font-size: 11px; color: var(--dsw-alias-label-tertiary, #999);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.lxm-progress { display: flex; align-items: center; gap: 6px; }
.lxm-progress input[type="range"] {
  flex: 1; margin: 0; height: 4px; cursor: pointer;
  accent-color: var(--dsw-alias-state-business-primary, #4c8dff);
}
.lxm-time { font-size: 10px; color: var(--dsw-alias-label-tertiary, #999); font-variant-numeric: tabular-nums; }
.lxm-controls { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.lxm-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: none; border-radius: 6px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-secondary, #bbb); font-size: 14px;
  padding: 0;
}
.lxm-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.15)); color: var(--dsw-alias-label-primary, #e6e6e6); }
.lxm-btn-primary { color: var(--dsw-alias-state-business-primary, #4c8dff); }
.lxm-btn:disabled { opacity: 0.4; cursor: default; }
.lxm-btn-mode { width: auto; min-width: 26px; padding: 0 2px; font-size: 12px; }
.lxm-btn-row { display: flex; gap: 2px; }
.lxm-modes {
  display: inline-flex; gap: 2px; padding: 2px; flex: none;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08));
  border-radius: 8px;
}
.lxm-mode-btn {
  display: inline-flex; align-items: center; gap: 3px;
  border: none; background: transparent; color: var(--dsw-alias-label-tertiary, #999);
  font-size: 11px; padding: 3px 7px; border-radius: 6px; cursor: pointer;
  white-space: nowrap; line-height: 1;
}
.lxm-mode-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }
.lxm-mode-btn[data-active="true"] {
  background: var(--dsw-alias-state-business-primary, #4c8dff); color: #fff;
}

.lxm-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center;
}
.lxm-window {
  position: fixed; z-index: 10000; display: flex; flex-direction: column;
  background: var(--dsw-specific-sidebar-fill, #1e1e1e);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25));
  border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  color: var(--dsw-alias-label-primary, #e6e6e6);
  font-size: 13px; overflow: hidden;
}
.lxm-window-titlebar {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  cursor: move; flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15));
  background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.06)) 50%, transparent);
}
.lxm-window-title { font-weight: 600; font-size: 13px; flex: 1; }
.lxm-window-close {
  width: 24px; height: 24px; border: none; border-radius: 6px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-tertiary, #999); font-size: 14px;
}
.lxm-window-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.15)); color: var(--dsw-alias-label-primary); }
.lxm-window-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.lxm-window-resize {
  position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize;
}
.lxm-tabs { display: flex; gap: 4px; padding: 8px 12px 0; flex: none; }
.lxm-tab {
  border: none; background: transparent; color: var(--dsw-alias-label-tertiary, #999);
  font-size: 13px; padding: 6px 12px; border-radius: 8px 8px 0 0; cursor: pointer;
  border-bottom: 2px solid transparent;
}
.lxm-tab[data-active="true"] { color: var(--dsw-alias-label-primary, #e6e6e6); border-bottom-color: var(--dsw-alias-state-business-primary, #4c8dff); }
.lxm-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px 12px; gap: 8px; overflow: hidden; }

.lxm-input, .lxm-select, .lxm-textarea {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.1));
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2));
  border-radius: 8px; color: var(--dsw-alias-label-primary, #e6e6e6);
  padding: 6px 10px; font-size: 13px; outline: none; min-width: 0;
}
.lxm-input:focus, .lxm-select:focus, .lxm-textarea:focus { border-color: var(--dsw-alias-state-business-primary, #4c8dff); }
.lxm-searchbar { display: flex; gap: 6px; flex: none; }
.lxm-searchbar .lxm-input { flex: 1; }
.lxm-search-btn {
  border: none; border-radius: 8px; padding: 6px 14px; cursor: pointer;
  background: var(--dsw-alias-state-business-primary, #4c8dff); color: #fff; font-size: 13px;
}
.lxm-search-btn:disabled { opacity: 0.5; cursor: default; }
.lxm-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 2px; }
.lxm-row {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px;
  cursor: pointer; min-width: 0;
}
.lxm-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.lxm-row[data-active="true"] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4c8dff) 14%, transparent); }
.lxm-row-cover { width: 34px; height: 34px; border-radius: 6px; object-fit: cover; flex: none; background: var(--dsw-alias-interactive-bg-hover); }
.lxm-row-main { flex: 1; min-width: 0; }
.lxm-row-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lxm-row-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lxm-badge {
  font-size: 10px; padding: 1px 5px; border-radius: 4px; flex: none;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4c8dff) 16%, transparent);
  color: var(--dsw-alias-state-business-primary, #4c8dff);
}
.lxm-badge-gray {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.15));
  color: var(--dsw-alias-label-tertiary, #999);
}
.lxm-dur { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); flex: none; font-variant-numeric: tabular-nums; }
.lxm-empty { color: var(--dsw-alias-label-tertiary, #999); font-size: 12px; text-align: center; padding: 24px 0; }
.lxm-toolbar { display: flex; gap: 6px; align-items: center; flex: none; flex-wrap: wrap; }
.lxm-toolbar .lxm-btn { width: auto; padding: 4px 10px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2)); border-radius: 6px; }
.lxm-error {
  flex: none; font-size: 12px; color: #ff7b72; background: color-mix(in srgb, #ff7b72 10%, transparent);
  border: 1px solid color-mix(in srgb, #ff7b72 30%, transparent); border-radius: 8px; padding: 6px 10px;
}
.lxm-drag-handle { cursor: grab; color: var(--dsw-alias-label-tertiary, #666); font-size: 12px; flex: none; padding: 0 2px; }
.lxm-dragging { opacity: 0.4; }
.lxm-drop-hint { border-top: 2px solid var(--dsw-alias-state-business-primary, #4c8dff); }

.lxm-settings-grid { display: flex; flex-direction: column; gap: 14px; overflow-y: auto; flex: 1; min-height: 0; padding: 2px; }
.lxm-field { display: flex; flex-direction: column; gap: 4px; }
.lxm-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary, #bbb); }
.lxm-field-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); }
.lxm-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.lxm-switch {
  position: relative; width: 34px; height: 20px; border-radius: 10px; border: none; cursor: pointer;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.3)); transition: background 0.15s;
}
.lxm-switch[data-on="true"] { background: var(--dsw-alias-state-business-primary, #4c8dff); }
.lxm-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; transition: left 0.15s;
}
.lxm-switch[data-on="true"]::after { left: 16px; }
.lxm-source-row { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15)); border-radius: 10px; }
.lxm-source-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.lxm-source-meta { flex: 1; min-width: 0; }
.lxm-source-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lxm-source-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); }
.lxm-source-status { font-size: 10px; padding: 1px 6px; border-radius: 4px; }
.lxm-source-status[data-ok="true"] { color: #3fb950; background: color-mix(in srgb, #3fb950 14%, transparent); }
.lxm-source-status[data-ok="false"] { color: #ff7b72; background: color-mix(in srgb, #ff7b72 14%, transparent); }
.lxm-prio-list { display: flex; flex-direction: column; gap: 2px; }
.lxm-prio-item { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 4px; border-radius: 6px; }
.lxm-prio-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.1)); }
.lxm-section-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #bbb); margin: 4px 0 0; }
`
