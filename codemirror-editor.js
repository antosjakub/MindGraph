(function () {
  const host = document.getElementById('modalEditorCm');
  const fallback = document.getElementById('modalEditor');
  const badge = document.getElementById('editorModeBadge');

  if (!host || !fallback) return;

  let editor = null;
  let changeHandler = null;

  function setBadge(text, kind) {
    if (!badge) return;
    badge.textContent = text;
    badge.dataset.mode = kind;
  }

  function emitChange() {
    const value = editor ? editor.getValue() : fallback.value;
    fallback.value = value;
    if (changeHandler) changeHandler(value);
  }

  function createEditor() {
    if (editor || !window.CodeMirror) return editor;

    editor = window.CodeMirror(host, {
      value: fallback.value || '',
      mode: 'markdown',
      keyMap: 'vim',
      lineNumbers: false,
      lineWrapping: true,
      theme: 'default',
      viewportMargin: Infinity,
      scrollbarStyle: 'null'
    });

    editor.on('change', emitChange);
    editor.on('keydown', (_, event) => event.stopPropagation());
    editor.getWrapperElement().classList.add('mindgraph-cm-wrapper');
    fallback.classList.add('cm-fallback-hidden');
    setBadge('CodeMirror • Vim', 'vim');
    return editor;
  }

  window.MindGraphCodeEditor = {
    isReady() {
      return !!editor;
    },
    onChange(fn) {
      changeHandler = fn;
    },
    setValue(value) {
      const text = value ?? '';
      fallback.value = text;
      const instance = createEditor();
      if (instance && instance.getValue() !== text) instance.setValue(text);
    },
    getValue() {
      return editor ? editor.getValue() : fallback.value;
    },
    focus() {
      const instance = createEditor();
      if (instance) instance.focus();
    },
    refresh() {
      if (editor) editor.refresh();
    }
  };

  if (window.CodeMirror) {
    createEditor();
    window.dispatchEvent(new CustomEvent('mindgraph:editor-ready'));
  } else {
    setBadge('Fallback textarea', 'fallback');
  }
})();
