// BILDSCHIRMTASTATUR
//
// Zweck: Eingabefelder auf Terminals ohne Hardware-Tastatur bedienbar machen -
// ausdruecklich auch auf fremden Seiten, die in einem iframe eingebettet sind.
//
// Warum in der Extension und nicht auf der Portalseite: Ein Skript der Seite
// kommt wegen der Same-Origin-Policy nicht an ein Eingabefeld in einem fremden
// iframe. Es sieht dort weder ein focus-Ereignis noch kann es value lesen oder
// schreiben; document.activeElement liefert hoechstens das iframe-Element selbst.
// Content-Scripts laufen dagegen je Frame in einer eigenen isolierten Welt mit
// vollem Zugriff auf das Dokument genau dieses Frames - auch auf das des iframes
// (manifest.json: "all_frames": true).
//
// Daraus folgt der Aufbau: Gezeichnet wird die Tastatur in dem Frame, in dem das
// fokussierte Feld liegt. Beim formatfuellenden iframe - der Normalfall auf den
// Terminals - sieht das aus wie eine Tastatur der Seite. In einem kleinen iframe
// waere sie entsprechend klein; dafuer braeuchte es eine Bruecke ueber den
// Service-Worker in den obersten Frame (chrome.tabs.sendMessage, frameId 0).
//
// Geschaltet wird ueber die Baywatch-Konfiguration: config.keyboard mit "on" oder
// "off", gepflegt im Smitrac unter Funktionen -> Baywatch. Fehlt der Schluessel,
// bleibt die Tastatur aus - aeltere Konfigurationen verhalten sich unveraendert.

(function() {
  'use strict';

  // Unter dieser Hoehe verdeckt eine fuenfzeilige Tastatur den Frame komplett.
  const MIN_FRAME_HEIGHT = 200;

  const TEXT_INPUT_TYPES = [
    'text', 'search', 'email', 'url', 'tel', 'password', 'number', ''
  ];

  const MOD = {
    shift:   {id: 'shift',   label: '⇧', mod: true,  flex: 1.7},
    back:    {id: 'back',    label: '⌫', mod: true,  flex: 1.7},
    symbols: {id: 'symbols', label: '?123',   mod: true,  flex: 1.7},
    letters: {id: 'letters', label: 'ABC',    mod: true,  flex: 1.7},
    space:   {id: 'space',   label: 'Leerzeichen',        flex: 6},
    enter:   {id: 'enter',   label: '⏎', mod: true,  flex: 1.7}
  };

  const LAYOUT_LETTERS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'z', 'u', 'i', 'o', 'p', 'ü'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ö', 'ä'],
    [MOD.shift, 'y', 'x', 'c', 'v', 'b', 'n', 'm', 'ß', MOD.back],
    [MOD.symbols, '@', '-', '_', MOD.space, '.', MOD.enter]
  ];

  const LAYOUT_SYMBOLS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['@', '#', '€', '%', '&', '*', '(', ')', '-', '_'],
    ['+', '=', '/', '\\', ':', ';', ',', '.', '?', '!'],
    ['"', '\'', '§', '$', '<', '>', '[', ']', MOD.back],
    [MOD.letters, MOD.space, MOD.enter]
  ];

  // 0 = aus, 1 = nur fuer das naechste Zeichen, 2 = dauerhaft. Ein Tipp auf die
  // Umschalttaste geht reihum, damit es ohne Doppeltipp-Timing auskommt.
  let shift = 0;
  let symbols = false;

  let mode = 'off';
  let host = null;
  let shadow = null;
  let keysBox = null;
  let field = null;
  let hideTimer = null;

  // --- Konfiguration ------------------------------------------------------

  function applyConfig(appConfig) {
    const value = appConfig && appConfig.config && appConfig.config.keyboard;
    mode = value === 'on' ? 'on' : 'off';
    if (mode !== 'on') {
      hide();
    }
  }

  try {
    chrome.storage.local.get(['appConfig'], function(result) {
      if (!chrome.runtime.lastError) {
        applyConfig(result.appConfig);
      }
    });

    chrome.storage.onChanged.addListener(function(changes, namespace) {
      if (namespace === 'local' && changes.appConfig) {
        applyConfig(changes.appConfig.newValue);
      }
    });
  } catch (e) {
    // Extension-Kontext weg (z. B. nach einem Reload der Extension): dann bleibt
    // es beim Standard "aus", statt die Seite mit Fehlern zu fluten.
  }

  // --- Eingabefeld --------------------------------------------------------

  function isTextField(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (element.isContentEditable) return true;

    const tag = element.tagName;
    if (tag === 'TEXTAREA') return !element.readOnly && !element.disabled;
    if (tag !== 'INPUT') return false;

    const type = (element.getAttribute('type') || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.indexOf(type) !== -1 && !element.readOnly && !element.disabled;
  }

  // Bei email, number und url liefert selectionStart null oder wirft - dort wird
  // am Ende angefuegt statt an der Einfuegemarke.
  function selection(element) {
    try {
      if (typeof element.selectionStart === 'number') {
        return [element.selectionStart, element.selectionEnd];
      }
    } catch (e) {
      // faellt unten auf das Ende zurueck
    }
    const length = element.value.length;
    return [length, length];
  }

  function setSelection(element, position) {
    try {
      element.setSelectionRange(position, position);
    } catch (e) {
      // siehe selection()
    }
  }

  // Der native Setter umgeht den Wert-Setter, den React & Co. ueber das Element
  // legen - sonst nimmt das Framework die Aenderung nicht wahr.
  function setValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
  }

  function fireInput(element, data, inputType) {
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      data: data,
      inputType: inputType
    }));
  }

  // Manche Eingabemasken haengen an keydown/keyup statt an input. Die Ereignisse
  // sind nicht vertrauenswuerdig (isTrusted false), loesen also keine
  // Browser-Standardaktion aus - Skripte der Seite sehen sie aber.
  function fireKey(element, type, key) {
    element.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      key: key
    }));
  }

  function activeField() {
    if (field && field.isConnected) return field;
    field = null;
    return null;
  }

  function insert(text) {
    const element = activeField();
    if (!element) return;

    if (element.isContentEditable) {
      element.focus();
      document.execCommand('insertText', false, text);
      return;
    }

    fireKey(element, 'keydown', text);

    const range = selection(element);
    const value = element.value;
    setValue(element, value.slice(0, range[0]) + text + value.slice(range[1]));
    setSelection(element, range[0] + text.length);

    fireInput(element, text, 'insertText');
    fireKey(element, 'keyup', text);
  }

  function backspace() {
    const element = activeField();
    if (!element) return;

    if (element.isContentEditable) {
      element.focus();
      document.execCommand('delete', false, null);
      return;
    }

    fireKey(element, 'keydown', 'Backspace');

    const range = selection(element);
    const from = range[0] === range[1] ? range[0] - 1 : range[0];
    if (from < 0) return;

    const value = element.value;
    setValue(element, value.slice(0, from) + value.slice(range[1]));
    setSelection(element, from);

    fireInput(element, null, 'deleteContentBackward');
    fireKey(element, 'keyup', 'Backspace');
  }

  function enter() {
    const element = activeField();
    if (!element) return;

    fireKey(element, 'keydown', 'Enter');
    fireKey(element, 'keyup', 'Enter');
    hide();
  }

  // --- Oberflaeche --------------------------------------------------------

  const STYLE = [
    '.kb{font-family:system-ui,"Segoe UI",Roboto,sans-serif;background:#1c1c1c;',
    'color:#fff;padding:1vh 1vw 1.6vh;box-shadow:0 -0.8vh 3vh rgba(0,0,0,.45);}',
    '.bar{display:flex;align-items:center;justify-content:space-between;',
    'padding:0 .4vw .8vh;font-size:clamp(12px,1.7vh,20px);color:#c6c6c6;}',
    '.close{background:#3a3a3a;border-radius:.6vh;padding:.5vh 1.6vw;color:#fff;}',
    '.row{display:flex;gap:.7vw;margin-top:.7vh;}',
    '.k{flex:1 1 0;display:flex;align-items:center;justify-content:center;',
    'height:8.5vh;min-height:44px;background:#3a3a3a;border-radius:.6vh;',
    'font-size:clamp(16px,3vh,34px);line-height:1;user-select:none;',
    '-webkit-user-select:none;touch-action:manipulation;}',
    '.k:active{background:#ff821c;}',
    '.mod{background:#2a2a2a;font-size:clamp(13px,2.1vh,22px);}',
    '.on{background:#ff821c;color:#fff;}',
    '.lock{background:#ff821c;color:#fff;box-shadow:inset 0 0 0 .3vh #fff;}'
  ].join('');

  function ensureHost() {
    if (host && host.isConnected) return;

    host = document.createElement('div');
    host.id = 'hi-baywatch-keyboard';
    // all:initial zuerst, damit kein Stylesheet der Seite hineinregiert; die
    // Positionierung danach gewinnt, weil sie spaeter in derselben Regel steht.
    host.style.cssText = 'all:initial;position:fixed;left:0;right:0;bottom:0;' +
      'z-index:2147483647;transform:translateY(100%);' +
      'transition:transform .25s cubic-bezier(.32,.72,0,1);';

    // Offen, damit die Tastatur per DevTools/Konsole auf dem Terminal nachvollziehbar
    // bleibt. Die Abschottung gegen die Seite leistet der Shadow-Baum ohnehin ueber
    // das Styling, nicht ueber die Sichtbarkeit fuer Skripte.
    shadow = host.attachShadow({mode: 'open'});

    const style = document.createElement('style');
    style.textContent = STYLE;

    const box = document.createElement('div');
    box.className = 'kb';

    const bar = document.createElement('div');
    bar.className = 'bar';
    const title = document.createElement('span');
    title.textContent = 'Tastatur';
    const close = document.createElement('span');
    close.className = 'close';
    close.dataset.action = 'close';
    close.textContent = 'Schließen';
    bar.appendChild(title);
    bar.appendChild(close);

    keysBox = document.createElement('div');

    box.appendChild(bar);
    box.appendChild(keysBox);
    shadow.appendChild(style);
    shadow.appendChild(box);

    // An documentElement statt an body: bei run_at document_start gibt es den
    // body noch nicht, und ein Framework, das den body ersetzt, raeumt die
    // Tastatur sonst mit weg.
    document.documentElement.appendChild(host);

    // Ein Tastendruck darf dem Eingabefeld nie den Fokus nehmen, sonst
    // verschwindet die Einfuegemarke und die Seite sieht ein blur.
    box.addEventListener('pointerdown', function(event) {
      event.preventDefault();
      handlePress(event.target);
    });
  }

  function renderKeys() {
    keysBox.textContent = '';
    const layout = symbols ? LAYOUT_SYMBOLS : LAYOUT_LETTERS;

    layout.forEach(function(row) {
      const rowElement = document.createElement('div');
      rowElement.className = 'row';

      row.forEach(function(key) {
        const element = document.createElement('span');
        element.className = 'k';

        if (typeof key === 'string') {
          const label = shift > 0 ? key.toUpperCase() : key;
          element.dataset.action = 'char';
          element.dataset.char = label;
          element.textContent = label;
        } else {
          element.classList.add('mod');
          element.dataset.action = key.id;
          element.textContent = key.label;
          element.style.flexGrow = String(key.flex);

          if (key.id === 'shift') {
            if (shift === 1) element.classList.add('on');
            if (shift === 2) element.classList.add('lock');
          }
        }

        rowElement.appendChild(element);
      });

      keysBox.appendChild(rowElement);
    });
  }

  function handlePress(node) {
    const key = node.closest ? node.closest('[data-action]') : null;
    if (!key) return;

    switch (key.dataset.action) {
      case 'char':
        insert(key.dataset.char);
        // Einmal-Umschaltung verbraucht sich mit dem Zeichen.
        if (shift === 1) {
          shift = 0;
          renderKeys();
        }
        break;
      case 'shift':
        shift = (shift + 1) % 3;
        renderKeys();
        break;
      case 'symbols':
        symbols = true;
        renderKeys();
        break;
      case 'letters':
        symbols = false;
        renderKeys();
        break;
      case 'space':
        insert(' ');
        break;
      case 'back':
        backspace();
        break;
      case 'enter':
        enter();
        break;
      case 'close':
        hide();
        break;
    }
  }

  function show(element) {
    if (mode !== 'on') return;
    if (window.innerHeight < MIN_FRAME_HEIGHT) return;

    window.clearTimeout(hideTimer);
    field = element;

    ensureHost();
    if (!host.dataset.open) {
      shift = 0;
      symbols = false;
    }
    renderKeys();

    host.dataset.open = '1';
    host.style.transform = 'translateY(0)';

    // Sonst liegt das Feld unter der Tastatur. Scrollt die Seite nicht (z. B.
    // overflow:hidden), passiert schlicht nichts.
    try {
      element.scrollIntoView({block: 'center', behavior: 'smooth'});
    } catch (e) {
      // aeltere Aufrufform, nicht kritisch
    }
  }

  function hide() {
    if (!host || !host.dataset.open) return;

    // Die Seite soll das Verlassen des Feldes mitbekommen (Validierung).
    const element = activeField();
    if (element && !element.isContentEditable) {
      element.dispatchEvent(new Event('change', {bubbles: true}));
    }

    delete host.dataset.open;
    host.style.transform = 'translateY(100%)';
    field = null;
  }

  // --- Ereignisse ---------------------------------------------------------

  document.addEventListener('focusin', function(event) {
    if (isTextField(event.target)) {
      show(event.target);
    } else {
      // Ein Klick auf irgendetwas anderes beendet die Eingabe. Tastendruecke
      // kommen hier nicht an, weil pointerdown den Fokuswechsel verhindert.
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hide, 0);
    }
  }, true);

  document.addEventListener('focusout', function() {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 0);
  }, true);

  // Wer die Tastatur schliesst und dasselbe Feld erneut antippt, loest kein
  // focusin mehr aus - das Feld hat den Fokus ja noch.
  document.addEventListener('click', function(event) {
    if (isTextField(event.target)) {
      show(event.target);
    }
  }, true);
})();
